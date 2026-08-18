/**
 * CLI integration tests. These spawn the real `baa` entry point so that exit
 * codes, stream routing and argument parsing are covered end to end.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "baa-test-"));
  workspaces.push(dir);
  return dir;
}

type CliResult = { code: number; out: string; err: string };

function baa(args: string[], cwd = ROOT): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "" },
  });
  return {
    code: result.status ?? -1,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
  };
}

describe("cli: help and version", () => {
  it("prints the version", () => {
    const result = baa(["--version"]);
    assert.equal(result.code, 0);
    assert.match(result.out, /^baa \d+\.\d+\.\d+$/m);
    assert.equal(baa(["version"]).out, result.out);
  });

  it("prints usage with no arguments, including the banner", () => {
    const result = baa([]);
    assert.equal(result.code, 0);
    assert.match(result.out, /Ready to herd some code/);
    assert.match(result.out, /COMMANDS/);
  });

  it("prints per-command help", () => {
    const result = baa(["run", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.out, /baa run \[file\]/);
    assert.match(result.out, /--seed/);
  });

  it("rejects an unknown command with exit code 2", () => {
    const result = baa(["shear"]);
    assert.equal(result.code, 2);
    assert.match(result.err, /Unknown command/);
  });

  it("rejects an unknown flag with exit code 2", () => {
    const result = baa(["-z"]);
    assert.equal(result.code, 2);
  });
});

describe("cli: run", () => {
  it("runs a file and writes to stdout", () => {
    const dir = workspace();
    writeFileSync(join(dir, "hello.baa"), 'baa "Hello, flock!"\n');
    const result = baa(["run", "hello.baa"], dir);
    assert.equal(result.code, 0);
    assert.equal(result.out, "Hello, flock!\n");
    assert.equal(result.err, "");
  });

  it("writes diagnostics to stderr and exits 1", () => {
    const dir = workspace();
    writeFileSync(join(dir, "bad.baa"), "baa nope\n");
    const result = baa(["run", "bad.baa"], dir);
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.match(result.err, /BAA102/);
  });

  it("passes arguments after -- to the program", () => {
    const dir = workspace();
    writeFileSync(join(dir, "args.baa"), "import shepherd\nbaa shepherd.args()\n");
    const result = baa(["run", "args.baa", "--", "--name", "Dolly"], dir);
    assert.equal(result.out, '["--name", "Dolly"]\n');
  });

  it("uses the program's own exit code", () => {
    const dir = workspace();
    writeFileSync(join(dir, "exit.baa"), "exit(7)\n");
    assert.equal(baa(["run", "exit.baa"], dir).code, 7);
  });

  it("produces identical output for the same seed", () => {
    const dir = workspace();
    writeFileSync(join(dir, "rand.baa"), "import meadow\nbaa meadow.random_int(1, 1000000)\n");
    const first = baa(["run", "--seed", "99", "rand.baa"], dir);
    const second = baa(["run", "--seed", "99", "rand.baa"], dir);
    assert.equal(first.out, second.out);
  });

  it("reports a missing entry with exit code 2", () => {
    const dir = workspace();
    assert.equal(baa(["run"], dir).code, 2);
  });

  // `run` read its entry without checking it existed, so a typo printed a
  // Node.js stack trace under `baa: internal error`.
  it("reports an unreadable entry as a diagnostic, not a crash", () => {
    const dir = workspace();
    for (const target of ["nope.baa", "."]) {
      const result = baa(["run", target], dir);
      assert.equal(result.code, 1, `expected exit 1 for ${target}`);
      assert.match(result.err, /BAA404/, `expected BAA404 for ${target}`);
      assert.doesNotMatch(result.err, /internal error/);
    }
  });
});

describe("cli: check", () => {
  it("succeeds on the examples directory", () => {
    const result = baa(["check", "examples"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /files checked, no problems/);
  });

  it("fails and reports every problem it finds", () => {
    const dir = workspace();
    writeFileSync(join(dir, "a.baa"), "baa missing_one\n");
    writeFileSync(join(dir, "b.baa"), "const x = 1\nx = 2\n");
    const result = baa(["check", "."], dir);
    assert.equal(result.code, 1);
    assert.match(result.err, /BAA102/);
    assert.match(result.err, /BAA103/);
  });
});

describe("cli: fmt", () => {
  it("formats a file in place", () => {
    const dir = workspace();
    const path = join(dir, "messy.baa");
    writeFileSync(path, "fn f(){return 1+2}\n");
    const result = baa(["fmt", "messy.baa"], dir);
    assert.equal(result.code, 0);
    assert.equal(readFileSync(path, "utf8"), "fn f() {\n    return 1 + 2\n}\n");
  });

  it("--check reports without writing and exits 1", () => {
    const dir = workspace();
    const path = join(dir, "messy.baa");
    const original = "fn f(){return 1}\n";
    writeFileSync(path, original);
    const result = baa(["fmt", "--check", "messy.baa"], dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /would reformat/);
    assert.equal(readFileSync(path, "utf8"), original);
  });

  it("--check exits 0 when everything is already formatted", () => {
    assert.equal(baa(["fmt", "--check", "examples"]).code, 0);
  });

  it("--stdout leaves the file alone", () => {
    const dir = workspace();
    const path = join(dir, "messy.baa");
    writeFileSync(path, "baa   1\n");
    const result = baa(["fmt", "--stdout", "messy.baa"], dir);
    assert.equal(result.out, "baa 1\n");
    assert.equal(readFileSync(path, "utf8"), "baa   1\n");
  });

  it("honours --indent", () => {
    const dir = workspace();
    writeFileSync(join(dir, "a.baa"), "fn f() {\nreturn 1\n}\n");
    const result = baa(["fmt", "--stdout", "--indent", "2", "a.baa"], dir);
    assert.match(result.out, /^ {2}return 1$/m);
  });
});

describe("cli: lint", () => {
  it("passes on the examples", () => {
    const result = baa(["lint", "examples"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /no problems/);
  });

  it("warns without failing by default", () => {
    const dir = workspace();
    writeFileSync(join(dir, "a.baa"), "const unused = 1\n");
    const result = baa(["lint", "."], dir);
    assert.equal(result.code, 0);
    assert.match(result.err, /BAA901/);
  });

  it("--deny-warnings turns warnings into a failure", () => {
    const dir = workspace();
    writeFileSync(join(dir, "a.baa"), "const unused = 1\n");
    assert.equal(baa(["lint", "--deny-warnings", "."], dir).code, 1);
  });

  it("--disable silences a rule", () => {
    const dir = workspace();
    writeFileSync(join(dir, "a.baa"), "const unused = 1\n");
    const result = baa(["lint", "--deny-warnings", "--disable", "BAA901", "."], dir);
    assert.equal(result.code, 0);
  });
});

describe("cli: test", () => {
  it("runs test blocks and reports a summary", () => {
    const result = baa(["test", "tests/programs"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /passed, 0 failed/);
  });

  it("fails when a test fails", () => {
    const dir = workspace();
    writeFileSync(join(dir, "t.baa"), 'test "bad" {\n    assert_eq(1, 2)\n}\n');
    const result = baa(["test", "."], dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL bad/);
  });

  it("--filter selects tests by name", () => {
    const dir = workspace();
    writeFileSync(
      join(dir, "t.baa"),
      'test "alpha" {\n    assert(true)\n}\ntest "beta" {\n    assert(true)\n}\n',
    );
    const result = baa(["test", "--filter", "alpha", "."], dir);
    assert.match(result.out, /1 passed, 0 failed, 1 skipped/);
  });

  it("says so when there is nothing to run", () => {
    const dir = workspace();
    writeFileSync(join(dir, "t.baa"), 'baa "no tests here"\n');
    const result = baa(["test", "."], dir);
    assert.equal(result.code, 0);
    assert.match(result.out, /No tests found/);
  });
});

describe("cli: project lifecycle", () => {
  it("init, run, test, build, add and remove work together", () => {
    const dir = workspace();

    const init = baa(["init", ".", "--name", "hill_farm"], dir);
    assert.equal(init.code, 0, init.err);
    assert.match(readFileSync(join(dir, "baa.toml"), "utf8"), /name = "hill_farm"/);

    const run = baa(["run"], dir);
    assert.equal(run.code, 0, run.err);
    assert.match(run.out, /Hello, flock!/);

    const test = baa(["test"], dir);
    assert.equal(test.code, 0, test.err);
    assert.match(test.out, /2 passed, 0 failed/);

    const build = baa(["build"], dir);
    assert.equal(build.code, 0, build.err);
    assert.match(build.out, /Ready to herd/);
    const lock = JSON.parse(readFileSync(join(dir, "baa.lock"), "utf8")) as {
      flock: string;
      wool: unknown[];
    };
    assert.equal(lock.flock, "hill_farm");
    assert.deepEqual(lock.wool, []);

    // A local dependency.
    const libDir = join(dir, "libs", "shears");
    baa(["init", "libs/shears", "--name", "shears"], dir);
    writeFileSync(join(libDir, "shears.baa"), "export fn cut() {\n    return \"snip\"\n}\n");
    const add = baa(["add", "shears", "--path", "libs/shears"], dir);
    assert.equal(add.code, 0, add.err);
    assert.match(readFileSync(join(dir, "baa.toml"), "utf8"), /shears = \{ path = "\.\/libs\/shears" \}/);

    writeFileSync(join(dir, "main.baa"), "import shears\n\nbaa shears.cut()\n");
    const withDep = baa(["run"], dir);
    assert.equal(withDep.code, 0, withDep.err);
    assert.equal(withDep.out, "snip\n");

    const lockAfter = JSON.parse(readFileSync(join(dir, "baa.lock"), "utf8")) as {
      wool: Array<{ name: string; sha256: string }>;
    };
    assert.equal(lockAfter.wool.length, 1);
    assert.equal(lockAfter.wool[0]!.name, "shears");
    assert.match(lockAfter.wool[0]!.sha256, /^[0-9a-f]{64}$/);

    const remove = baa(["remove", "shears"], dir);
    assert.equal(remove.code, 0, remove.err);
    const afterRemoval = baa(["run"], dir);
    assert.equal(afterRemoval.code, 1);
    assert.match(afterRemoval.err, /BAA401/);
  });

  it("refuses to overwrite an existing project without --force", () => {
    const dir = workspace();
    assert.equal(baa(["init", "."], dir).code, 0);
    assert.equal(baa(["init", "."], dir).code, 2);
    assert.equal(baa(["init", ".", "--force"], dir).code, 0);
  });

  it("explains that there is no registry yet", () => {
    const dir = workspace();
    baa(["init", "."], dir);
    const result = baa(["add", "something"], dir);
    assert.equal(result.code, 2);
    assert.match(result.err, /no package registry/i);
  });

  it("points at the standard library instead of adding it", () => {
    const dir = workspace();
    baa(["init", "."], dir);
    const result = baa(["add", "wool", "--path", "."], dir);
    assert.equal(result.code, 2);
    assert.match(result.err, /standard library/);
  });
});

describe("cli: doctor and modules", () => {
  it("reports a healthy installation", () => {
    const result = baa(["doctor"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /The flock is healthy/);
  });

  it("lists the standard library", () => {
    const result = baa(["modules"]);
    assert.equal(result.code, 0);
    for (const name of ["wool", "flock", "ram", "meadow", "pasture", "shepherd", "lamb"]) {
      assert.match(result.out, new RegExp(`\\b${name}\\b`));
    }
  });
});

describe("cli: professional mode", () => {
  it("--no-baa drops the sheep wording but keeps the code", () => {
    const dir = workspace();
    writeFileSync(join(dir, "bad.baa"), "baa nope\n");
    const woolly = baa(["run", "bad.baa"], dir);
    const plain = baa(["--no-baa", "run", "bad.baa"], dir);
    assert.match(woolly.err, /flock/);
    assert.match(plain.err, /Undefined name/);
    assert.match(plain.err, /BAA102/);
  });

  it("BAA_NO_BAA=1 does the same", () => {
    const dir = workspace();
    writeFileSync(join(dir, "bad.baa"), "baa nope\n");
    const result = spawnSync(process.execPath, [CLI, "run", "bad.baa"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", CI: "", BAA_NO_BAA: "1" },
    });
    assert.match(result.stderr, /Undefined name/);
  });

  it("emits no colour codes when NO_COLOR is set", () => {
    const dir = workspace();
    writeFileSync(join(dir, "bad.baa"), "baa nope\n");
    const result = baa(["run", "bad.baa"], dir);
    // eslint-disable-next-line no-control-regex
    assert.equal(/\[/.test(result.err), false);
  });
});

describe("cli: repl", () => {
  it("evaluates piped input and prints expression values", () => {
    const result = spawnSync(
      process.execPath,
      [CLI, "repl", "--no-banner"],
      {
        cwd: ROOT,
        encoding: "utf8",
        input: 'let a = 2\na * 21\n"wool".upper()\n:quit\n',
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /42/);
    assert.match(result.stdout, /"WOOL"/);
  });

  it("keeps reading while a block is unfinished", () => {
    const result = spawnSync(process.execPath, [CLI, "repl", "--no-banner"], {
      cwd: ROOT,
      encoding: "utf8",
      input: 'fn twice(n) {\n  return n * 2\n}\ntwice(21)\n:quit\n',
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(result.stdout, /42/);
  });

  it("reports errors without ending the session", () => {
    const result = spawnSync(process.execPath, [CLI, "repl", "--no-banner"], {
      cwd: ROOT,
      encoding: "utf8",
      input: "1 / 0\n6 * 7\n:quit\n",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.match(result.stdout, /BAA306/);
    assert.match(result.stdout, /42/);
  });
});
