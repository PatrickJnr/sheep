/**
 * `baa fmt --diff`: the unified diff itself, and the command's contract that
 * it reports without writing and exits exactly like `--check`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { unifiedDiff } from "../src/formatter/diff.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "baa-diff-"));
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

describe("unified diff", () => {
  it("produces nothing for identical text", () => {
    assert.equal(unifiedDiff("a\nb\n", "a\nb\n"), "");
    assert.equal(unifiedDiff("", ""), "");
  });

  it("marks a changed line as a removal and an addition", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    assert.match(diff, /^--- a$/m);
    assert.match(diff, /^\+\+\+ b$/m);
    assert.match(diff, /^-b$/m);
    assert.match(diff, /^\+B$/m);
    assert.match(diff, /^ a$/m);
    assert.match(diff, /^ c$/m);
  });

  it("writes hunk headers whose counts match the lines that follow", () => {
    const diff = unifiedDiff("a\nb\nc\nd\n", "a\nx\nc\nd\n");
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/m.exec(diff);
    assert.ok(header, diff);
    const body = diff.split("\n").slice(3).filter((line) => line !== "");
    const removed = body.filter((line) => line.startsWith("-") || line.startsWith(" ")).length;
    const added = body.filter((line) => line.startsWith("+") || line.startsWith(" ")).length;
    assert.equal(Number(header[2]), removed);
    assert.equal(Number(header[4]), added);
    assert.equal(Number(header[1]), 1);
    assert.equal(Number(header[3]), 1);
  });

  it("keeps distant changes in separate hunks and near ones together", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const far = before.replace("line 0", "changed 0").replace("line 39", "changed 39");
    assert.equal((unifiedDiff(before, far).match(/^@@ /gm) ?? []).length, 2);
    const near = before.replace("line 10", "changed 10").replace("line 11", "changed 11");
    assert.equal((unifiedDiff(before, near).match(/^@@ /gm) ?? []).length, 1);
  });

  it("handles a pure insertion and a pure deletion", () => {
    // The `--- a` / `+++ b` headers are not operations; only the body is.
    const body = (diff: string): string[] => diff.split("\n").slice(3);

    const inserted = unifiedDiff("a\nc\n", "a\nb\nc\n");
    assert.match(inserted, /^\+b$/m);
    assert.deepEqual(body(inserted).filter((line) => line.startsWith("-")), []);

    const deleted = unifiedDiff("a\nb\nc\n", "a\nc\n");
    assert.match(deleted, /^-b$/m);
    assert.deepEqual(body(deleted).filter((line) => line.startsWith("+")), []);
  });

  it("handles an empty file on either side", () => {
    assert.match(unifiedDiff("", "a\n"), /^\+a$/m);
    assert.match(unifiedDiff("a\n", ""), /^-a$/m);
  });

  it("notices a missing final newline, which is otherwise invisible", () => {
    const diff = unifiedDiff("a\nb", "a\nb\n");
    assert.notEqual(diff, "");
    assert.match(diff, /^\\ No newline at end of file$/m);
    assert.match(diff, /^-b$/m);
    assert.match(diff, /^\+b$/m);
  });

  it("labels the sides as asked", () => {
    const diff = unifiedDiff("a\n", "b\n", { fromLabel: "a/x.baa", toLabel: "b/x.baa" });
    assert.match(diff, /^--- a\/x\.baa$/m);
    assert.match(diff, /^\+\+\+ b\/x\.baa$/m);
  });

  it("honours the context width", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "changed");
    const narrow = unifiedDiff(before, after, { context: 1 }).split("\n").length;
    const wide = unifiedDiff(before, after, { context: 5 }).split("\n").length;
    assert.ok(wide > narrow, `${wide} should exceed ${narrow}`);
  });

  it("applies cleanly: the diff describes the change it was given", () => {
    // Reconstructing the "after" side from the diff body proves the operations
    // are not merely plausible-looking.
    const before = "one\ntwo\nthree\n";
    const after = "one\n2\nthree\nfour\n";
    const body = unifiedDiff(before, after)
      .split("\n")
      .slice(3)
      .filter((line) => line !== "" && !line.startsWith("\\"));
    const rebuilt = body
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1))
      .join("\n");
    assert.equal(`${rebuilt}\n`, after);
  });
});

describe("cli: fmt --diff", () => {
  it("prints a diff, writes nothing and exits 1", () => {
    const original = "fn f(){return 1+2}\n";
    const dir = workspace({ "messy.baa": original });
    const result = baa(["fmt", "--diff", "messy.baa"], dir);
    assert.equal(result.code, 1);
    assert.equal(readFileSync(join(dir, "messy.baa"), "utf8"), original);
    assert.match(result.out, /^--- a\/messy\.baa$/m);
    assert.match(result.out, /^\+\+\+ b\/messy\.baa$/m);
    assert.match(result.out, /^-fn f\(\)\{return 1\+2\}$/m);
    assert.match(result.out, /^\+fn f\(\) \{$/m);
  });

  it("prints nothing at all for an already-formatted file", () => {
    const dir = workspace({ "tidy.baa": "baa 1\n" });
    const result = baa(["fmt", "--diff", "tidy.baa"], dir);
    assert.equal(result.code, 0);
    assert.equal(result.out, "");
    assert.equal(result.err, "");
  });

  it("exits exactly like --check", () => {
    const dir = workspace({ "messy.baa": "baa   1\n", "tidy.baa": "baa 1\n" });
    assert.equal(baa(["fmt", "--diff", "messy.baa"], dir).code, baa(["fmt", "--check", "messy.baa"], dir).code);
    assert.equal(baa(["fmt", "--diff", "tidy.baa"], dir).code, baa(["fmt", "--check", "tidy.baa"], dir).code);
  });

  it("diffs several files, one header each", () => {
    const dir = workspace({ "a.baa": "baa   1\n", "b.baa": "baa   2\n", "c.baa": "baa 3\n" });
    const result = baa(["fmt", "--diff", "."], dir);
    assert.equal(result.code, 1);
    assert.equal((result.out.match(/^--- a\//gm) ?? []).length, 2);
    assert.match(result.out, /a\.baa/);
    assert.match(result.out, /b\.baa/);
    assert.doesNotMatch(result.out, /c\.baa/);
  });

  it("still reports a file it cannot parse", () => {
    const dir = workspace({ "broken.baa": "fn f( {\n" });
    const result = baa(["fmt", "--diff", "broken.baa"], dir);
    assert.equal(result.code, 1);
    assert.match(result.err, /BAA/);
  });

  it("leaves the repository's own examples alone", () => {
    const result = baa(["fmt", "--diff", "examples"], ROOT);
    assert.equal(result.code, 0, result.out);
    assert.equal(result.out, "");
  });
});
