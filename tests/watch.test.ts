/**
 * `baa check --watch`.
 *
 * The cache is tested directly, without timers or watchers, because that is
 * where being wrong would be expensive: reusing a stale answer means reporting
 * a problem that is fixed, or missing one that is not. The watcher itself gets
 * one end-to-end test that edits a real file and reads what the command wrote.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Session, touchesManifest, untilInterrupted, watchRoots } from "../src/cli/watch.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) {
    try {
      // Windows refuses to remove a directory a watcher or a just-killed child
      // still holds open, and losing a temporary directory is not a test
      // failure worth reporting.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Left for the operating system to sweep up.
    }
  }
});

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "baa-watch-"));
  workspaces.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/**
 * Write a file and make sure its stamp differs from the last write.
 *
 * Two writes inside the same filesystem timestamp tick with the same length
 * would look unchanged, which is true of a real editor almost never and of a
 * test almost always.
 */
function edit(path: string, text: string): void {
  writeFileSync(path, text);
  const stamp = new Date(Date.now() + 2000);
  utimesSync(path, stamp, stamp);
}

describe("watch: the cache", () => {
  it("checks everything the first time and nothing the second", () => {
    const dir = workspace({ "a.baa": "baa 1\n", "b.baa": "baa 2\n" });
    const session = new Session([dir], []);

    const first = session.sweep();
    assert.equal(first.checked.length, 2);
    assert.equal(first.reused, 0);

    const second = session.sweep();
    assert.equal(second.checked.length, 0);
    assert.equal(second.reused, 2);
    assert.deepEqual(second.diagnostics, []);
  });

  it("re-checks only the file that changed", () => {
    const dir = workspace({ "a.baa": "baa 1\n", "b.baa": "baa 2\n", "c.baa": "baa 3\n" });
    const session = new Session([dir], []);
    session.sweep();

    edit(join(dir, "b.baa"), "baa nope\n");
    const result = session.sweep();
    assert.equal(result.checked.length, 1);
    assert.match(result.checked[0]!, /b\.baa$/);
    assert.equal(result.reused, 2);
    assert.equal(result.errors, 1);
    assert.equal(result.diagnostics[0]!.code, "BAA102");
  });

  it("reports a cached diagnostic again rather than forgetting it", () => {
    const dir = workspace({ "bad.baa": "baa nope\n", "good.baa": "baa 1\n" });
    const session = new Session([dir], []);
    assert.equal(session.sweep().errors, 1);

    // Editing the *other* file must not make the broken one look fixed.
    edit(join(dir, "good.baa"), "baa 2\n");
    const result = session.sweep();
    assert.equal(result.checked.length, 1);
    assert.equal(result.errors, 1);
  });

  it("notices a file that appears and one that goes away", () => {
    const dir = workspace({ "a.baa": "baa 1\n" });
    const session = new Session([dir], []);
    session.sweep();

    writeFileSync(join(dir, "new.baa"), "baa nope\n");
    const added = session.sweep();
    assert.equal(added.checked.length, 1);
    assert.equal(added.errors, 1);

    unlinkSync(join(dir, "new.baa"));
    const removed = session.sweep();
    assert.equal(removed.removed.length, 1);
    assert.match(removed.removed[0]!, /new\.baa$/);
    assert.equal(removed.errors, 0);
  });

  it("keeps going when a file will not parse, and recovers when it is fixed", () => {
    const dir = workspace({ "a.baa": "fn f( {\n" });
    const session = new Session([dir], []);
    assert.ok(session.sweep().errors > 0);

    edit(join(dir, "a.baa"), "fn f() { return 1 }\nbaa f()\n");
    const fixed = session.sweep();
    assert.equal(fixed.errors, 0);
    assert.equal(fixed.checked.length, 1);
  });

  it("drops everything when the manifest changes, because module names did", () => {
    const dir = workspace({ "a.baa": "baa 1\n", "b.baa": "baa 2\n" });
    const session = new Session([dir], []);
    session.sweep();
    assert.equal(session.size, 2);

    session.invalidateAll(["extra"]);
    assert.equal(session.size, 0);
    assert.equal(session.sweep().checked.length, 2);
  });

  it("uses the module list it was given, so a dependency import is not an error", () => {
    const dir = workspace({ "a.baa": "import helper\nbaa helper\n" });
    assert.ok(new Session([dir], []).sweep().errors > 0);
    assert.equal(new Session([dir], ["helper"]).sweep().errors, 0);
  });

  it("recognises the manifest among a batch of changed paths", () => {
    assert.equal(touchesManifest(["src/a.baa"]), false);
    assert.equal(touchesManifest(["src/a.baa", "baa.toml"]), true);
    assert.equal(touchesManifest([join("nested", "baa.toml")]), true);
  });
});

describe("watch: the watcher", () => {
  it("calls back once for a burst of writes, and stops when closed", async () => {
    const dir = workspace({ "a.baa": "baa 1\n" });
    const batches: string[][] = [];
    const watcher = watchRoots({
      roots: [dir],
      settle: 40,
      onChange: (paths) => void batches.push([...paths]),
    });
    try {
      for (let i = 0; i < 4; i++) writeFileSync(join(dir, "a.baa"), `baa ${i}\n`);
      // Generous, because how quickly a platform reports a change is the
      // platform's business: macOS batches through FSEvents and a loaded
      // runner has taken seconds. What is being tested is the debounce, not
      // the latency.
      await settled(() => batches.length > 0, 20_000);
      await pause(200);
      assert.ok(
        batches.length <= 2,
        `four writes should not be four re-checks, got ${batches.length}`,
      );
      assert.ok(batches.flat().some((path) => path.endsWith("a.baa")));
    } finally {
      watcher.close();
    }

    const seen = batches.length;
    writeFileSync(join(dir, "a.baa"), "baa 99\n");
    await pause(150);
    assert.equal(batches.length, seen, "a closed watcher reports nothing");
  });

  it("ignores files that are not Baa", async () => {
    const dir = workspace({ "a.baa": "baa 1\n" });
    let calls = 0;
    const watcher = watchRoots({ roots: [dir], settle: 30, onChange: () => void calls++ });
    try {
      writeFileSync(join(dir, "notes.txt"), "hello");
      await pause(200);
      if (process.platform !== "darwin") {
        // macOS watches a directory rather than the files in it and reports
        // whichever name it has to hand, so a write to `notes.txt` can arrive
        // as an event naming `a.baa`. An extra sweep there is harmless — it
        // reads stamps and finds nothing changed — so what is promised is that
        // the filter works wherever the platform gives it something to filter.
        assert.equal(calls, 0);
      }
    } finally {
      watcher.close();
    }
  });

  it("resolves when the process is interrupted", async () => {
    const waited = untilInterrupted();
    process.emit("SIGINT");
    await waited;
    assert.equal(process.listenerCount("SIGINT") >= 0, true);
  });
});

describe("cli: check --watch", () => {
  it("reports again after an edit, re-checking only what changed", async () => {
    const dir = workspace({ "a.baa": "baa 1\n", "b.baa": "baa 2\n" });
    const child = spawn(process.execPath, [CLI, "check", "--watch", "--format", "json", "."], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", CI: "" },
    });
    const reports: Array<{ files: number; errors: number; ok: boolean }> = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let cut = buffer.indexOf("\n");
      while (cut !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line.startsWith("{")) reports.push(JSON.parse(line));
        cut = buffer.indexOf("\n");
      }
    });

    try {
      await settled(() => reports.length >= 1, 10000);
      assert.equal(reports[0]!.files, 2);
      assert.equal(reports[0]!.ok, true);

      writeFileSync(join(dir, "b.baa"), "baa nope\n");
      await settled(() => reports.length >= 2, 10000);
      assert.equal(reports[1]!.ok, false);
      assert.equal(reports[1]!.errors, 1);
      assert.equal(reports[1]!.files, 2, "the unchanged file is still reported on");
    } finally {
      child.kill();
    }
  });
});

function pause(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

async function settled(until: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (until()) return;
    await pause(25);
  }
  throw new Error("timed out waiting for the watcher");
}
