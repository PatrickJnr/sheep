/**
 * `baa run --deny-fs` and friends.
 *
 * Two things are being tested. That a denied capability actually refuses —
 * every route to it, not only the obvious one — and that an allowed capability
 * is untouched, because a sandbox that changes behaviour when it is not
 * sandboxing anything is a sandbox nobody will turn on.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALL_CAPABILITIES,
  createCapturingHost,
  DeniedError,
  isInsideRoots,
  isUnrestricted,
  restrictHost,
} from "../src/runtime/host.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "baa-cap-"));
  workspaces.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function baa(args: string[], cwd: string): { code: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "" },
  });
  return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

describe("capabilities: the host wrapper", () => {
  it("returns the host itself when nothing was taken away", () => {
    const host = createCapturingHost();
    assert.equal(restrictHost(host, ALL_CAPABILITIES), host);
    assert.equal(isUnrestricted(ALL_CAPABILITIES), true);
  });

  it("refuses every route to the filesystem, not only reading", () => {
    const host = restrictHost(createCapturingHost({ files: { "/baa/a.txt": "hi" } }), {
      ...ALL_CAPABILITIES,
      readFiles: false,
      writeFiles: false,
    });
    for (const attempt of [
      () => host.readFile("/baa/a.txt"),
      () => host.fileExists("/baa/a.txt"),
      () => host.listDir("/baa"),
      () => host.stat("/baa/a.txt"),
      () => host.writeFile("/baa/b.txt", "x"),
      () => host.appendFile("/baa/a.txt", "x"),
      () => host.makeDir("/baa/sub"),
    ]) {
      assert.throws(attempt, DeniedError);
    }
  });

  it("can allow reading while refusing writing", () => {
    const host = restrictHost(createCapturingHost({ files: { "/baa/a.txt": "hi" } }), {
      ...ALL_CAPABILITIES,
      writeFiles: false,
    });
    assert.equal(host.readFile("/baa/a.txt"), "hi");
    assert.throws(() => host.writeFile("/baa/a.txt", "x"), DeniedError);
  });

  it("leaves output, the clock and randomness alone", () => {
    // Denying the filesystem must not accidentally deny printing: a program
    // that cannot say why it failed is worse than one that fails.
    const host = restrictHost(createCapturingHost(), {
      readFiles: false,
      writeFiles: false,
      roots: null,
      env: false,
      process: false,
    });
    host.write("still here\n");
    assert.equal(typeof host.now(), "number");
    assert.equal(typeof host.random(), "number");
  });
});

describe("capabilities: running a program", () => {
  it("denies the filesystem, with BAA313 at the call", () => {
    const dir = workspace({
      "read.baa": 'import pasture\nbaa pasture.read("data.txt")\n',
      "data.txt": "secret",
    });
    const denied = baa(["run", "--deny-fs", "read.baa"], dir);
    assert.equal(denied.code, 1);
    assert.match(denied.err, /BAA313/);
    assert.match(denied.err, /may not read files/);
    assert.doesNotMatch(denied.out, /secret/);

    const allowed = baa(["run", "read.baa"], dir);
    assert.equal(allowed.code, 0, allowed.err);
    assert.match(allowed.out, /secret/);
  });

  it("denies writing while still allowing reading", () => {
    const dir = workspace({
      "write.baa": 'import pasture\npasture.write("out.txt", "written")\n',
      "read.baa": 'import pasture\nbaa pasture.read("in.txt")\n',
      "in.txt": "readable",
    });
    const write = baa(["run", "--deny-fs-write", "write.baa"], dir);
    assert.equal(write.code, 1);
    assert.match(write.err, /BAA313/);

    const read = baa(["run", "--deny-fs-write", "read.baa"], dir);
    assert.equal(read.code, 0, read.err);
    assert.match(read.out, /readable/);
  });

  it("denies the environment", () => {
    const dir = workspace({ "env.baa": 'import shepherd\nbaa shepherd.env("PATH")\n' });
    const denied = baa(["run", "--deny-env", "env.baa"], dir);
    assert.equal(denied.code, 1);
    assert.match(denied.err, /BAA313/);
    assert.match(denied.err, /may not read the environment/);
    assert.equal(baa(["run", "env.baa"], dir).code, 0);
  });

  it("denies starting other programs", () => {
    const dir = workspace({
      "spawn.baa": 'import shepherd\nbaa shepherd.run("node", ["-e", "console.log(1)"])["out"]\n',
    });
    const denied = baa(["run", "--deny-process", "spawn.baa"], dir);
    assert.equal(denied.code, 1);
    assert.match(denied.err, /BAA313/);
    assert.match(denied.err, /may not start other programs/);

    const allowed = baa(["run", "spawn.baa"], dir);
    assert.equal(allowed.code, 0, allowed.err);
    assert.match(allowed.out, /1/);
  });

  it("lets a program catch a denial and carry on", () => {
    const dir = workspace({
      "catch.baa": `import pasture
try {
    baa pasture.read("nothing.txt")
} catch e {
    baa "denied: " + e["code"]
}
baa "still running"
`,
    });
    const result = baa(["run", "--deny-fs", "catch.baa"], dir);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /denied: BAA313/);
    assert.match(result.out, /still running/);
  });

  it("restricts tests the same way", () => {
    const dir = workspace({
      "t.baa": `import pasture
test "reads a file" {
    assert(pasture.exists("t.baa"))
}
`,
    });
    assert.equal(baa(["test", "t.baa"], dir).code, 0);
    const denied = baa(["test", "--deny-fs", "t.baa"], dir);
    assert.equal(denied.code, 1);
  });

  it("changes nothing when no flag is given", () => {
    const dir = workspace({
      "all.baa": `import pasture
import shepherd
pasture.write("out.txt", "written")
baa pasture.read("out.txt")
baa shepherd.env("PATH") != nil
`,
    });
    const result = baa(["run", "all.baa"], dir);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "written\ntrue\n");
    assert.equal(readFileSync(join(dir, "out.txt"), "utf8"), "written");
  });

  it("says what it denies in the help", () => {
    const help = baa(["run", "--help"], ROOT);
    for (const flag of ["--deny-fs", "--deny-fs-write", "--deny-env", "--deny-process"]) {
      assert.match(help.out, new RegExp(flag.replace(/-/g, "\\-")));
    }
    assert.match(help.out, /BAA313/);
  });
});

describe("capabilities: the boundary is the host", () => {
  it("spawns through the host rather than around it", () => {
    // `shepherd.run` used to call child_process directly, which meant the
    // capability boundary had a hole in it exactly where it mattered most.
    const source = readFileSync(join(ROOT, "src", "stdlib", "shepherd.ts"), "utf8");
    assert.doesNotMatch(source, /child_process/);
    assert.match(source, /host\.runProcess/);
  });

  it("still never uses a shell", () => {
    const source = readFileSync(join(ROOT, "src", "runtime", "host.ts"), "utf8");
    assert.match(source, /shell: false/);
  });
});

describe("pasture: walking a real directory", () => {
  it("finds files at every depth, in a stated order, without the directories", () => {
    const dir = workspace({ "b.baa": "baa 1\n", "a.baa": "baa 2\n" });
    mkdirSync(join(dir, "sub", "deeper"), { recursive: true });
    writeFileSync(join(dir, "sub", "c.baa"), "baa 3\n");
    writeFileSync(join(dir, "sub", "deeper", "d.txt"), "notes");

    writeFileSync(
      join(dir, "walk.baa"),
      `import pasture
for path in pasture.walk(".") {
    baa pasture.base_name(path)
}
baa "---"
for path in pasture.glob(".", "**/*.baa") {
    baa pasture.base_name(path)
}
`,
    );
    const run = baa(["run", "walk.baa"], dir);
    assert.equal(run.code, 0, run.err);
    const lines = run.out.trim().split(/\r?\n/);
    const cut = lines.indexOf("---");
    const walked = lines.slice(0, cut);
    const globbed = lines.slice(cut + 1);

    // Depth-first through names sorted at each level: `sub` sorts before
    // `walk.baa`, so everything under it comes first.
    assert.deepEqual(walked, ["a.baa", "b.baa", "c.baa", "d.txt", "walk.baa"]);
    assert.deepEqual(globbed, ["a.baa", "b.baa", "c.baa", "walk.baa"]);
  });

  it("refuses to walk under --deny-fs", () => {
    const dir = workspace({ "walk.baa": 'import pasture\nbaa pasture.walk(".").length()\n' });
    const denied = baa(["run", "--deny-fs", "walk.baa"], dir);
    assert.equal(denied.code, 1);
    assert.match(denied.err, /BAA313/);
  });

  it("says which directory it could not walk", () => {
    const dir = workspace({ "walk.baa": 'import pasture\nbaa pasture.walk("nope")\n' });
    const missing = baa(["run", "walk.baa"], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /BAA404/);
    assert.match(missing.err, /nope/);
  });
});

describe("capabilities: confining the filesystem", () => {
  it("judges a path by where it leads, not by how it is written", () => {
    const dir = workspace({ "in.txt": "inside" });
    const inside = join(dir, "in.txt");
    assert.equal(isInsideRoots(inside, [dir]), true);
    assert.equal(isInsideRoots(dir, [dir]), true, "the root itself is inside it");
    assert.equal(isInsideRoots(join(dir, "sub", "deep", "new.txt"), [dir]), true);
    assert.equal(isInsideRoots(join(dir, "..", "elsewhere.txt"), [dir]), false);
    assert.equal(isInsideRoots(join(dir, "sub", "..", "..", "out.txt"), [dir]), false);
  });

  it("is not fooled by a name that merely starts the same way", () => {
    // `/tmp/data` and `/tmp/data-backup` share a prefix and are different
    // directories. A `startsWith` check gets this wrong.
    const dir = workspace({});
    mkdirSync(join(dir, "data"));
    mkdirSync(join(dir, "data-backup"));
    assert.equal(isInsideRoots(join(dir, "data", "a.txt"), [join(dir, "data")]), true);
    assert.equal(isInsideRoots(join(dir, "data-backup", "a.txt"), [join(dir, "data")]), false);
  });

  it("accepts a path under any one of several roots", () => {
    const one = workspace({ "a.txt": "1" });
    const two = workspace({ "b.txt": "2" });
    assert.equal(isInsideRoots(join(one, "a.txt"), [one, two]), true);
    assert.equal(isInsideRoots(join(two, "b.txt"), [one, two]), true);
    assert.equal(isInsideRoots(join(tmpdir(), "nowhere.txt"), [one, two]), false);
  });

  it("refuses a read outside the allowed directory, and allows one inside", () => {
    const dir = workspace({});
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "project", "data.txt"), "readable");
    writeFileSync(join(dir, "secret.txt"), "not for you");
    writeFileSync(
      join(dir, "project", "app.baa"),
      `import pasture
baa pasture.read("data.txt")
try {
    baa pasture.read("../secret.txt")
} catch e {
    baa "refused: " + e["code"]
}
`,
    );
    const result = baa(["run", "--allow-fs", ".", "app.baa"], join(dir, "project"));
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /readable/);
    assert.match(result.out, /refused: BAA313/);
    assert.doesNotMatch(result.out, /not for you/);
  });

  it("refuses a write outside the allowed directory", () => {
    const dir = workspace({});
    mkdirSync(join(dir, "project"));
    writeFileSync(
      join(dir, "project", "app.baa"),
      'import pasture\npasture.write("../escaped.txt", "hi")\n',
    );
    const result = baa(["run", "--allow-fs", ".", "app.baa"], join(dir, "project"));
    assert.equal(result.code, 1);
    assert.match(result.err, /BAA313/);
    assert.equal(existsSync(join(dir, "escaped.txt")), false);
  });

  it("follows a link out of the allowed directory and refuses that too", (t) => {
    const dir = workspace({});
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "secret.txt"), "not for you");
    try {
      symlinkSync(join(dir, "secret.txt"), join(dir, "project", "link.txt"), "file");
    } catch {
      // Windows needs a privilege for this, and a machine without it is not a
      // machine where the test can say anything.
      t.skip("this machine cannot create symbolic links");
      return;
    }
    writeFileSync(
      join(dir, "project", "app.baa"),
      'import pasture\nbaa pasture.read("link.txt")\n',
    );
    const result = baa(["run", "--allow-fs", ".", "app.baa"], join(dir, "project"));
    assert.equal(result.code, 1);
    assert.match(result.err, /BAA313/);
    assert.doesNotMatch(result.out, /not for you/);
  });

  it("changes nothing when no directory is named", () => {
    const dir = workspace({});
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "reachable.txt"), "reachable");
    writeFileSync(
      join(dir, "project", "app.baa"),
      'import pasture\nbaa pasture.read("../reachable.txt")\n',
    );
    const result = baa(["run", "app.baa"], join(dir, "project"));
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /reachable/);
  });

  it("says the directories it was given, so the message can be acted on", () => {
    const dir = workspace({});
    mkdirSync(join(dir, "project"));
    writeFileSync(join(dir, "project", "app.baa"), 'import pasture\npasture.read("../x.txt")\n');
    const result = baa(["run", "--allow-fs", ".", "app.baa"], join(dir, "project"));
    assert.match(result.err, /may not touch files outside/);
    assert.match(result.err, /project/);
  });
});
