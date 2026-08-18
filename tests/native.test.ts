/**
 * The native application platform.
 *
 * Three kinds of test live here, in order of how much they need:
 *
 *  1. **Drift guards.** The TypeScript side and the Rust side describe the
 *     same things twice — which modules exist, which functions `barn` has, what
 *     the image format's version is. These compare the two lists directly and
 *     need nothing built.
 *  2. **Bundler tests.** What `baa app build` refuses, and why. Pure
 *     TypeScript.
 *  3. **Runtime tests.** These need `cargo build`, so they skip with a stated
 *     reason when the runtime is absent rather than failing a checkout that
 *     has no Rust toolchain. `npm run test:native` says what was skipped.
 *
 * The conformance run is the one that matters: it executes the same programs
 * the reference implementation is tested against and compares stdout byte for
 * byte. A native runtime that passes it is running Baa; one that does not is
 * running something else.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { bundle, BundleError, NATIVE_MODULES } from "../src/native/bundle.ts";
import { IMAGE_VERSION, MAGIC } from "../src/native/image.ts";
import { createCapturingHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";
import { NativeFunction } from "../src/runtime/values.ts";
import { BARN_FUNCTIONS } from "../src/stdlib/barn.ts";
import { loadBuiltinModule, STDLIB_MODULES } from "../src/stdlib/index.ts";
import { hostPath, runSuite } from "../tools/native-conformance.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUST = join(ROOT, "rust", "crates", "baa-native", "src");

function rust(file: string): string {
  return readFileSync(join(RUST, file), "utf8");
}

/** Names from a `const FUNCTIONS: &[(&str, usize, usize)]` table in Rust. */
function rustFunctionNames(source: string, table = "FUNCTIONS"): string[] {
  const block = new RegExp(`const ${table}[^=]*= &\\[([\\s\\S]*?)\\n\\];`).exec(source);
  assert.ok(block, `could not find ${table} in the Rust source`);
  return [...block[1]!.matchAll(/\("([a-z_0-9]+)"/g)].map((match) => match[1]!);
}

describe("native: the two implementations describe the same thing", () => {
  // Every one of these compares a list in TypeScript with the same list in
  // Rust. They exist because both lists are hand-written, and a name added to
  // one and forgotten in the other produces a runtime failure in front of a
  // user rather than an error in front of a developer.

  it("agrees on which standard modules a native application has", () => {
    const source = rust("stdlib/mod.rs");
    const declared = /pub const MODULES: &\[&str\] =\s*&\[([^\]]*)\]/.exec(source);
    assert.ok(declared, "could not find MODULES in stdlib/mod.rs");
    const fromRust = [...declared[1]!.matchAll(/"([a-z]+)"/g)].map((match) => match[1]!).sort();
    assert.deepEqual(fromRust, [...NATIVE_MODULES].sort());
  });

  it("only claims modules the language actually has", () => {
    for (const name of NATIVE_MODULES) {
      assert.ok(
        STDLIB_MODULES.includes(name),
        `\`${name}\` is offered natively but is not a standard module`,
      );
    }
  });

  it("agrees on what `barn` provides", () => {
    const fromRust = rustFunctionNames(rust("stdlib/barn.rs"));
    assert.deepEqual([...fromRust].sort(), [...BARN_FUNCTIONS].sort());
  });

  it("agrees on the image format's magic and version", () => {
    const source = rust("image.rs");
    const magic = /pub const MAGIC: &\[u8\] = b"([^"]*)"/.exec(source);
    const version = /pub const VERSION: u8 = (\d+)/.exec(source);
    assert.ok(magic && version, "could not find the format constants");
    assert.equal(magic[1]!.replace(/\\n/g, "\n"), MAGIC);
    assert.equal(Number(version[1]), IMAGE_VERSION);
  });

  // The reference cannot draw a window, so its `barn` reports that. What it
  // must not do is disagree about the arity of a function, because then a
  // program would pass `baa check` and fail when built.
  it("agrees on how many arguments each `barn` function takes", () => {
    const source = rust("stdlib/barn.rs");
    const block = /const FUNCTIONS[^=]*= &\[([\s\S]*?)\n\];/.exec(source);
    const fromRust = new Map(
      [...block![1]!.matchAll(/\("([a-z_0-9]+)", (\d+), ([^)]+)\)/g)].map((match) => [
        match[1]!,
        `${match[2]}..${match[3]!.trim().replace("usize::MAX", "many")}`,
      ]),
    );
    const barn = readFileSync(join(ROOT, "src", "stdlib", "barn.ts"), "utf8");
    const fromTs = new Map(
      [...barn.matchAll(/\["([a-z_0-9]+)", (\d+), (\d+),/g)].map((match) => [
        match[1]!,
        `${match[2]}..${match[3]}`,
      ]),
    );
    for (const [name, arity] of fromTs) {
      assert.equal(fromRust.get(name), arity, `\`barn.${name}\` has a different arity in Rust`);
    }
  });

  // `barn` had this check on its own, and `barn` is the module least likely to
  // drift, because it is the one the applications exercise. `shepherd` and
  // `meadow` arrived as ports of modules that already existed, where a
  // function quietly taking one argument fewer would compile on both sides and
  // fail only when a program called it. So every module is compared, not one.
  it("agrees on every native module's functions and how many arguments they take", () => {
    const interpreter = new Interpreter({ host: createCapturingHost() });
    for (const name of NATIVE_MODULES) {
      const source = rust(`stdlib/${name}.rs`);
      // The table is `= &[` on one line in most modules and wrapped onto the
      // next in the short ones, and it ends either at `\n];` or on the line it
      // started on.
      const block = /const FUNCTIONS[^=]*=\s*&\[([\s\S]*?)\];/.exec(source);
      assert.ok(block, `could not find the FUNCTIONS table in stdlib/${name}.rs`);
      const fromRust = new Map(
        [...block[1]!.matchAll(/\("([a-z_0-9]+)", (\d+), ([^)]+)\)/g)].map((match) => [
          match[1]!,
          `${match[2]}..${match[3]!.trim().replace("usize::MAX", "many")}`,
        ]),
      );

      const module = loadBuiltinModule(name, interpreter);
      assert.ok(module, `${name} is offered natively but the reference has no such module`);
      const fromTs = new Map<string, string>();
      for (const [key, value] of module.exports) {
        if (!(value instanceof NativeFunction)) continue;
        const max = value.maxArgs >= Number.MAX_SAFE_INTEGER ? "many" : String(value.maxArgs);
        fromTs.set(key, `${value.minArgs}..${max}`);
      }

      assert.deepEqual(
        [...fromRust.keys()].sort(),
        [...fromTs.keys()].sort(),
        `\`${name}\` has different functions in the two runtimes`,
      );
      for (const [fname, arity] of fromTs) {
        assert.equal(fromRust.get(fname), arity, `\`${name}.${fname}\` has a different arity in Rust`);
      }
    }
  });

  it("documents `barn` in the standard library listing", () => {
    const stdlib = readFileSync(join(ROOT, "docs", "stdlib.md"), "utf8");
    assert.match(stdlib, /\bbarn\b/, "docs/stdlib.md does not mention `barn`");
  });
});

describe("native: what a build refuses", () => {
  const work = mkdtempSync(join(tmpdir(), "baa-native-"));

  function write(name: string, source: string): string {
    const path = join(work, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source, "utf8");
    return path;
  }

  it("refuses a web module, and says which one and why", () => {
    const entry = write("web.baa", 'import gate\ngate.html("<h1>Baa</h1>")\n');
    assert.throws(
      () => bundle({ entry, root: work }),
      (error: unknown) => {
        assert.ok(error instanceof BundleError);
        assert.match(error.message, /gate/);
        assert.match(error.message, /barn/, "should point at the module to use instead");
        return true;
      },
    );
  });

  it("refuses a program that does not compile, and hands back the diagnostics", () => {
    const entry = write("broken.baa", "baa nope\n");
    assert.throws(
      () => bundle({ entry, root: work }),
      (error: unknown) => {
        assert.ok(error instanceof BundleError);
        assert.equal(error.diagnostics[0]?.code, "BAA102");
        return true;
      },
    );
  });

  it("bundles a relative import and reports what it packed", () => {
    write("lib.baa", "export fn two() {\n    return 2\n}\n");
    const entry = write("uses.baa", 'import "./lib.baa" as lib\nbaa lib.two()\n');
    const built = bundle({ entry, root: work });
    assert.equal(built.modules.length, 2);
    assert.deepEqual(built.stdlib, []);
    assert.ok(built.bytes.length > 0);
  });

  it("writes an image that starts with the magic and the version", () => {
    const entry = write("plain.baa", "baa 1\n");
    const built = bundle({ entry, root: work });
    assert.equal(Buffer.from(built.bytes.slice(0, MAGIC.length)).toString("ascii"), MAGIC);
    assert.equal(built.bytes[MAGIC.length], IMAGE_VERSION);
  });

  // Paths travel in the image and end up in stack traces, so they must not
  // carry the build machine's directory layout to whoever runs the program.
  it("stores paths relative to the project root, with forward slashes", () => {
    write("deep/inner.baa", "export const one = 1\n");
    const entry = write("outer.baa", 'import "./deep/inner.baa" as inner\nbaa inner.one\n');
    const built = bundle({ entry, root: work });
    assert.deepEqual([...built.modules].sort(), ["deep/inner.baa", "outer.baa"]);
  });
});

const host = hostPath();
const built = host !== null;

describe("native: the runtime, when it has been built", { skip: built ? false : "the native runtime is not built (cargo build --manifest-path rust/Cargo.toml)" }, () => {
  const work = mkdtempSync(join(tmpdir(), "baa-run-"));

  function run(source: string, argv: string[] = []): { stdout: string; status: number } {
    const entry = join(work, "program.baa");
    const image = join(work, "program.fleece");
    writeFileSync(entry, source, "utf8");
    writeFileSync(image, bundle({ entry, root: work }).bytes);
    try {
      return { stdout: execFileSync(host!, [image, ...argv], { encoding: "utf8" }), status: 0 };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { stdout: (failure.stdout ?? "") + (failure.stderr ?? ""), status: failure.status ?? 1 };
    }
  }

  it("passes the conformance suite", () => {
    const summary = runSuite();
    const failures = summary.outcomes.filter(
      (outcome) => !outcome.passed && outcome.skipped !== true,
    );
    assert.deepEqual(
      failures.map((outcome) => `${outcome.name}: ${outcome.reason}`),
      [],
      "the native runtime disagrees with the reference implementation",
    );
    assert.equal(summary.passed, summary.ran);
  });

  it("counts a skipped program as a skip, never as a pass", () => {
    // A program the runtime cannot execute is not evidence that it can. The
    // headline number is what documentation quotes, so it has to be the number
    // of programs that actually ran.
    const summary = runSuite();
    assert.equal(summary.ran + summary.skipped, summary.total);
    assert.ok(summary.passed <= summary.ran, "more passes than programs run");
    for (const outcome of summary.outcomes) {
      if (outcome.skipped === true) assert.equal(outcome.passed, false);
    }
  });

  it("prints numbers exactly as the reference does", () => {
    // The two use different languages' float formatting, and they agree only
    // because the native side reimplements JavaScript's algorithm.
    const { stdout } = run("baa 0.1 + 0.2, 1e21, 1e-7, 10 / 4, 1 / 3\n");
    assert.equal(stdout.replace(/\r\n/g, "\n"), "0.30000000000000004 1e+21 1e-7 2.5 0.3333333333333333\n");
  });

  it("reports a runtime error with its code, its line and its call stack", () => {
    const { stdout, status } = run("fn inner() {\n    baa nil + 1\n}\n\ninner()\n");
    assert.equal(status, 1);
    assert.match(stdout, /BAA302/);
    assert.match(stdout, /program\.baa:2/);
    assert.match(stdout, /call stack/);
  });

  it("stops runaway recursion with a diagnostic rather than a crash", () => {
    // Without a large stack this is a stack overflow, which is a crash with no
    // diagnostic at all: the limit exists to be the thing that fires first.
    const { stdout, status } = run("fn down() {\n    return down()\n}\n\ndown()\n");
    assert.equal(status, 1);
    assert.match(stdout, /BAA307/);
  });

  it("refuses an image it was not built to read", () => {
    const image = join(work, "wrong.fleece");
    const bytes = Buffer.from(`${MAGIC}rubbish`, "binary");
    writeFileSync(image, bytes);
    try {
      execFileSync(host!, [image], { encoding: "utf8", stdio: "pipe" });
      assert.fail("should have refused the image");
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      assert.equal(failure.status, 1);
      assert.match(failure.stderr ?? "", /version/);
    }
  });

  it("refuses a file that is not an image at all", () => {
    const image = join(work, "notanimage.fleece");
    writeFileSync(image, "this is just text\n");
    try {
      execFileSync(host!, [image], { encoding: "utf8", stdio: "pipe" });
      assert.fail("should have refused the file");
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      assert.match(failure.stderr ?? "", /not a Baa image/);
    }
  });

  it("says so plainly when it has no application in it", () => {
    try {
      execFileSync(host!, [], { encoding: "utf8", stdio: "pipe" });
      assert.fail("should have refused to run nothing");
    } catch (error) {
      const failure = error as { stderr?: string };
      assert.match(failure.stderr ?? "", /no application in it/);
    }
  });

  it("runs `test` blocks, and fails when one fails", () => {
    const passing = run('test "adds" {\n    assert_eq(1 + 1, 2)\n}\n');
    assert.equal(passing.status, 0);

    const entry = join(work, "failing.baa");
    const image = join(work, "failing.fleece");
    writeFileSync(entry, 'test "adds" {\n    assert_eq(1 + 1, 3)\n}\n', "utf8");
    writeFileSync(image, bundle({ entry, root: work }).bytes);
    try {
      execFileSync(host!, ["--test", image], { encoding: "utf8", stdio: "pipe" });
      assert.fail("a failing test should exit non-zero");
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      assert.equal(failure.status, 1);
      assert.match(failure.stdout ?? "", /FAILED/);
    }
  });

  it("has the same standard-library behaviour as the reference", () => {
    // Spot checks on the parts most likely to differ between two languages'
    // libraries: ordering, rounding, and how a map prints.
    const { stdout } = run(
      [
        "import flock",
        "import wool",
        "import ram",
        "import lamb",
        "",
        "baa flock.sort_by([{ n: 3 }, { n: 1 }], fn(x) { return x.n }).map(fn(x) { return x.n })",
        'baa wool.snake_case("parseHTMLNow")',
        "baa ram.round(2.5), ram.round(-2.5), ram.modulo(-7, 3)",
        "baa lamb.encode({ b: 1, a: [true, nil] })",
        // An array rather than an object, because `{` inside a Baa string
        // opens an interpolation: writing a JSON object literal in source
        // means escaping it as `\\{`, which is worth avoiding in a test that
        // is about something else.
        'baa lamb.decode("[1, 2, 1e3]")[2]',
      ].join("\n") + "\n",
    );
    assert.equal(
      stdout.replace(/\r\n/g, "\n"),
      ["[1, 3]", "parse_htmlnow", "3 -2 2", '{"b":1,"a":[true,null]}', "1000", ""].join("\n"),
    );
  });

  // `meadow` is the module where the two languages are least alike: the
  // reference gets a calendar from `Date` and the native runtime works one out
  // from a day number. Every value here was read from the reference first, so
  // a difference is the port being wrong rather than the expectation.
  it("keeps the same calendar as the reference, without a Date to borrow", () => {
    const { stdout } = run(
      [
        "import meadow",
        "",
        "baa meadow.iso(0), meadow.iso(1709209845500)",
        'baa meadow.format(1709209845500, "YYYY-MM-DD hh:mm:ss")',
        // Before the epoch, where a floored day number and a truncated
        // millisecond disagree if either is wrong.
        "baa meadow.iso(-1)",
        "const p = meadow.parts(1709209845500)",
        'baa p.weekday, p.month_name, p.year, p.month, p.day',
        'baa meadow.parse_iso("2024-02-29T12:30:45.500Z")',
        'baa meadow.parse_iso("not a date")',
        // The generator differs from the reference's, so only the shape of the
        // result is compared, never the value.
        "const r = meadow.random()",
        "baa r >= 0 && r < 1",
        "baa meadow.shuffle([1, 2, 3]).length(), meadow.sample([1, 2, 3], 2).length()",
        "baa meadow.random_int(4, 4)",
      ].join("\n") + "\n",
    );
    assert.equal(
      stdout.replace(/\r\n/g, "\n"),
      [
        "1970-01-01T00:00:00.000Z 2024-02-29T12:30:45.500Z",
        "2024-02-29 12:30:45",
        "1969-12-31T23:59:59.999Z",
        "Thursday February 2024 2 29",
        "1709209845500",
        "nil",
        "true",
        "3 2",
        "4",
        "",
      ].join("\n"),
    );
  });

  // An ISO date-time with no zone means local time in JavaScript, which would
  // make one program produce two different numbers on two machines. The native
  // runtime refuses it instead of guessing, and this pins that: an absence
  // that says so beats a near miss that does not.
  it("refuses an ISO time with no zone rather than guessing one", () => {
    const { stdout, status } = run('import meadow\nbaa meadow.parse_iso("2026-08-18T09:30")\n');
    assert.notEqual(status, 0);
    assert.match(stdout, /BAA301/);
    assert.match(stdout, /no time zone/);
  });

  it("gives an application its arguments, its environment and a way to print", () => {
    // `baa app build` produced an executable that could not read its own
    // command line at all: the runtime parsed the arguments and threw them
    // away. This is the test that would have caught that.
    process.env["BAA_NATIVE_TEST"] = "set";
    try {
      const { stdout } = run(
        [
          "import shepherd",
          "",
          "baa shepherd.args()",
          'shepherd.write("a", 1, "b")',
          'baa ""',
          'baa shepherd.env("BAA_NATIVE_TEST", "unset")',
          'baa shepherd.env("BAA_NOT_SET_ANYWHERE", "fallback")',
          'baa type_of(shepherd.PLATFORM) == "string" && type_of(shepherd.ARCH) == "string"',
        ].join("\n") + "\n",
        ["--", "one", "two"],
      );
      assert.equal(
        stdout.replace(/\r\n/g, "\n"),
        ['["one", "two"]', "a1b", "set", "fallback", "true", ""].join("\n"),
        "arguments after `--` belong to the program, and `write` shares `baa`'s stream",
      );
    } finally {
      delete process.env["BAA_NATIVE_TEST"];
    }
  });

  // The conformance harness deliberately clears `CI` and `BAA_NO_BAA` before
  // running anything, because the suite records one wording. This asserts that
  // the pinning is hiding a working feature rather than a broken one: if
  // somebody ever "fixes" a wording failure by deleting the neutral mode, this
  // fails instead.
  it("swaps to the neutral wording when the environment asks, as the CLI does", () => {
    const entry = join(work, "wording.baa");
    const image = join(work, "wording.fleece");
    // A caught diagnostic's message is an ordinary string the program can
    // print, which is why the mode is observable in a program's output at all.
    writeFileSync(
      entry,
      ["try {", "    baa [1][7]", "} catch problem {", "    baa problem.message", "}", ""].join("\n"),
      "utf8",
    );
    writeFileSync(image, bundle({ entry, root: work }).bytes);

    const under = (extra: Record<string, string>): string => {
      const environment = { ...process.env, CI: "", BAA_NO_BAA: "", ...extra };
      return execFileSync(host!, [image], { encoding: "utf8", env: environment }).replace(/\r\n/g, "\n");
    };

    const woolly = "Index 7 is outside the fence: this array has length 1.\n";
    const plain = "Index 7 out of range for array of length 1.\n";
    assert.equal(under({}), woolly);
    assert.equal(under({ BAA_NO_BAA: "1" }), plain);
    assert.equal(under({ CI: "true" }), plain);
  });

  it("says which `wool` functions need a regular-expression engine", () => {
    const { stdout, status } = run('import wool\nbaa wool.matches("a", "a")\n');
    assert.equal(status, 1);
    assert.match(stdout, /regular-expression engine/);
    assert.match(stdout, /contains|replace_all|split/, "should suggest what to use instead");
  });

  // `after`, not a bare call: the body of a `describe` runs before any of its
  // tests do, so a bare `rmSync` here deletes the directory the tests are
  // about to write into.
  after(() => rmSync(work, { recursive: true, force: true }));
});

/**
 * Building and running a real application, end to end.
 *
 * Windows only, because that is the only platform with a backend. The window
 * is never shown to anybody: the application is driven through Win32 messages,
 * which is what a click actually is.
 */
const canDriveWindows = built && process.platform === "win32";

describe("native: an application, built and driven", { skip: canDriveWindows ? false : "needs Windows and a built runtime" }, () => {
  it("builds the calculator into one executable that runs on its own", () => {
    const project = join(ROOT, "examples", "native", "calculator");
    const out = mkdtempSync(join(tmpdir(), "baa-app-"));
    execFileSync(process.execPath, [join(ROOT, "src", "cli", "index.ts"), "app", "build", "--out", out], {
      cwd: project,
      encoding: "utf8",
    });
    const executable = join(out, "Calculator.exe");
    assert.ok(existsSync(executable), "no executable was written");

    // The image is appended to the runtime, so the built file is strictly
    // larger than the runtime it was built from and still starts.
    const runtime = readFileSync(host!).length;
    assert.ok(readFileSync(executable).length > runtime, "nothing was appended");
    rmSync(out, { recursive: true, force: true });
  });
});
