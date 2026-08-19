/**
 * `baa doc`.
 *
 * The rendering is tested directly, because that is what people will read, and
 * the command is tested through the CLI, because `--check` is a promise about
 * exit codes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SourceFile } from "../src/diagnostics/source.ts";
import { parse } from "../src/parser/parser.ts";
import { collectDocs, documentedPath, renderDocs } from "../src/cli/doc.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "baa-doc-"));
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

function docs(source: string, path = "lib.baa"): string {
  const file = new SourceFile(path, source);
  return renderDocs([collectDocs(parse(file).program, path)]);
}

describe("doc: what is collected", () => {
  it("documents an exported function with its signature and comment", () => {
    const rendered = docs(`/// Add sheep to the pen.
///
/// Never goes above the limit.
export fn add(pen, count = 1) {
    return pen + count
}
`);
    assert.match(rendered, /### `fn add\(pen, count = 1\)`/);
    assert.match(rendered, /Add sheep to the pen\./);
    assert.match(rendered, /Never goes above the limit\./);
  });

  it("leaves out what a module does not export", () => {
    const rendered = docs(`export fn shown() { return 1 }
fn hidden() { return 2 }
`);
    assert.match(rendered, /shown/);
    assert.doesNotMatch(rendered, /hidden/);
  });

  it("documents exported constants and every name a binding introduces", () => {
    const rendered = docs(`/// Where a flock starts.
export const START = 0
/// Both bounds.
export let [low, high] = [1, 9]
`);
    assert.match(rendered, /### `const START`/);
    assert.match(rendered, /### `let low`/);
    assert.match(rendered, /### `let high`/);
    assert.match(rendered, /Where a flock starts\./);
  });

  it("writes parameter defaults as the source writes them", () => {
    const rendered = docs(`export fn f(a = 0xFF, b = 1_000, c = "x", d = true, e = nil, ..rest) { return a }`);
    assert.match(rendered, /a = 0xFF/);
    assert.match(rendered, /b = 1_000/);
    assert.match(rendered, /c = "x"/);
    assert.match(rendered, /d = true/);
    assert.match(rendered, /e = nil/);
    assert.match(rendered, /\.\.rest/);
  });

  it("shows a default it will not print as an ellipsis rather than guessing", () => {
    // A default that is a call is a fact about the implementation. Printing it
    // invites a reader to depend on it.
    const rendered = docs(`export fn f(a = len("baa")) { return a }`);
    assert.match(rendered, /a = \.\.\./);
  });

  it("says so when a declaration has no comment", () => {
    assert.match(docs("export fn bare() { return 1 }"), /_Undocumented\._/);
  });

  it("says so when a file exports nothing", () => {
    assert.match(docs("fn private() { return 1 }"), /Exports nothing\./);
  });

  it("renders the same bytes every time", () => {
    const source = "/// One.\nexport fn one() { return 1 }\n/// Two.\nexport fn two() { return 2 }\n";
    assert.equal(docs(source), docs(source));
  });

  it("orders files by path and declarations by position", () => {
    const modules = ["b.baa", "a.baa"].map((path) =>
      collectDocs(parse(new SourceFile(path, "export fn second() { return 2 }")).program, path),
    );
    const rendered = renderDocs(modules);
    assert.ok(rendered.indexOf("`a.baa`") < rendered.indexOf("`b.baa`"));
  });

  it("names a file outside the project rather than tracing a path to it", () => {
    assert.equal(documentedPath("/tmp/pen.baa", "/project"), "pen.baa");
    assert.equal(documentedPath(join(ROOT, "examples", "pen.baa"), ROOT), "examples/pen.baa");
  });
});

describe("cli: doc", () => {
  it("writes to stdout by default, leaving nothing behind", () => {
    const dir = workspace({ "lib.baa": "/// Counts.\nexport fn count() { return 1 }\n" });
    const result = baa(["doc", "lib.baa"], dir);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /### `fn count\(\)`/);
    assert.match(result.out, /Counts\./);
  });

  it("writes a file with --out, and reports what it wrote", () => {
    const dir = workspace({ "lib.baa": "/// Counts.\nexport fn count() { return 1 }\n" });
    const result = baa(["doc", "--out", "REFERENCE.md", "lib.baa"], dir);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /1 export from 1 file/);
    assert.match(readFileSync(join(dir, "REFERENCE.md"), "utf8"), /fn count/);
  });

  it("--check passes on a current file and fails on a stale one", () => {
    const dir = workspace({ "lib.baa": "/// Counts.\nexport fn count() { return 1 }\n" });
    baa(["doc", "--out", "REFERENCE.md", "lib.baa"], dir);
    assert.equal(baa(["doc", "--out", "REFERENCE.md", "--check", "lib.baa"], dir).code, 0);

    writeFileSync(join(dir, "lib.baa"), "/// Counts differently.\nexport fn count() { return 2 }\n");
    const stale = baa(["doc", "--out", "REFERENCE.md", "--check", "lib.baa"], dir);
    assert.equal(stale.code, 1);
    assert.match(stale.out, /out of date/);
  });

  it("--check writes nothing, so a failing CI job leaves the tree alone", () => {
    const dir = workspace({ "lib.baa": "export fn count() { return 1 }\n" });
    const missing = baa(["doc", "--out", "REFERENCE.md", "--check", "lib.baa"], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /does not exist/);
    assert.equal(baa(["doc", "--out", "REFERENCE.md", "--check", "lib.baa"], dir).code, 1);
  });

  it("takes its title from the flag, and its heading from the project otherwise", () => {
    const dir = workspace({
      "baa.toml": '[flock]\nname = "pens"\nversion = "1.0.0"\nentry = "lib.baa"\n',
      "lib.baa": "export fn count() { return 1 }\n",
    });
    assert.match(baa(["doc", "lib.baa"], dir).out, /^# pens reference$/m);
    assert.match(baa(["doc", "--title", "The Pen API", "lib.baa"], dir).out, /^# The Pen API$/m);
  });

  it("reports a file it cannot parse instead of documenting half of it", () => {
    const dir = workspace({ "broken.baa": "export fn f( {\n" });
    const result = baa(["doc", "broken.baa"], dir);
    assert.equal(result.code, 1);
    assert.match(result.err, /BAA/);
    assert.equal(result.out, "");
  });
});
