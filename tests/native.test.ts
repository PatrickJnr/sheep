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
import { BARN_FUNCTIONS } from "../src/stdlib/barn.ts";
import { STDLIB_MODULES } from "../src/stdlib/index.ts";
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
    const declared = /pub const MODULES: &\[&str\] = &\[([^\]]*)\]/.exec(source);
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

  function run(source: string): { stdout: string; status: number } {
    const entry = join(work, "program.baa");
    const image = join(work, "program.fleece");
    writeFileSync(entry, source, "utf8");
    writeFileSync(image, bundle({ entry, root: work }).bytes);
    try {
      return { stdout: execFileSync(host!, [image], { encoding: "utf8" }), status: 0 };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { stdout: (failure.stdout ?? "") + (failure.stderr ?? ""), status: failure.status ?? 1 };
    }
  }

  it("passes the conformance suite", () => {
    const summary = runSuite();
    const failures = summary.outcomes.filter((outcome) => !outcome.passed);
    assert.deepEqual(
      failures.map((outcome) => `${outcome.name}: ${outcome.reason}`),
      [],
      "the native runtime disagrees with the reference implementation",
    );
    assert.equal(summary.passed, summary.total);
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
