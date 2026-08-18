/**
 * `--format json`: the schema, and the promise that it says the same thing the
 * terminal does.
 *
 * The CLI half spawns the real entry point, because the contract being tested
 * is about streams — JSON on stdout, nothing else on it — and that cannot be
 * checked by calling a function.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFile } from "../src/api.ts";
import { createDiagnostic, setWoollyMode } from "../src/diagnostics/diagnostic.ts";
import { buildReport, renderReport, SCHEMA_VERSION, toJsonDiagnostic } from "../src/diagnostics/json.ts";
import type { JsonReport } from "../src/diagnostics/json.ts";
import { SourceFile } from "../src/diagnostics/source.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "baa-json-"));
  workspaces.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

type CliResult = { code: number; out: string; err: string };

function baa(args: string[], cwd = ROOT): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CI: "" },
  });
  return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function reportOf(result: CliResult): JsonReport {
  return JSON.parse(result.out) as JsonReport;
}

describe("diagnostics as json: the value model", () => {
  it("carries both wordings, whichever one is switched on", () => {
    setWoollyMode(true);
    const woolly = toJsonDiagnostic(createDiagnostic("BAA102", ["sheap"]));
    setWoollyMode(false);
    const plain = toJsonDiagnostic(createDiagnostic("BAA102", ["sheap"]));
    setWoollyMode(true);

    assert.equal(woolly.messages.woolly, plain.messages.woolly);
    assert.equal(woolly.messages.plain, plain.messages.plain);
    assert.notEqual(woolly.messages.woolly, woolly.messages.plain);
    // `message` follows the mode; the pair never does.
    assert.equal(woolly.message, woolly.messages.woolly);
    assert.equal(plain.message, plain.messages.plain);
    // Both are rendered, not templates: no placeholder survives.
    assert.match(woolly.messages.plain, /sheap/);
    assert.doesNotMatch(woolly.messages.plain, /\{0\}/);
  });

  it("reports a span as 1-based line and column and a 0-based offset", () => {
    const file = new SourceFile("t.baa", "let a = 1\nlet b = 2\n");
    const diagnostic = createDiagnostic("BAA102", ["b"], {
      span: file.span(14, 15),
      note: "here",
    });
    const json = toJsonDiagnostic(diagnostic);
    assert.equal(json.file, "t.baa");
    assert.deepEqual(json.range, {
      start: { line: 2, column: 5, offset: 14 },
      end: { line: 2, column: 6, offset: 15 },
    });
    assert.equal(json.note, "here");
  });

  it("uses null rather than an invented position for a diagnostic with no span", () => {
    const json = toJsonDiagnostic(createDiagnostic("BAA301", ["nowhere"]));
    assert.equal(json.file, null);
    assert.equal(json.range, null);
    assert.equal(json.note, null);
  });

  it("keeps help, related spans and the trace", () => {
    const file = new SourceFile("t.baa", "let a = 1\n");
    const json = toJsonDiagnostic(
      createDiagnostic("BAA102", ["a"], {
        span: file.span(4, 5),
        help: ["did you mean `b`?"],
        secondary: [{ span: file.span(0, 3), note: "declared here" }],
        trace: [{ name: "main", span: file.span(0, 3) }],
      }),
    );
    assert.deepEqual(json.help, ["did you mean `b`?"]);
    assert.equal(json.related.length, 1);
    assert.equal(json.related[0]!.note, "declared here");
    assert.equal(json.related[0]!.file, "t.baa");
    assert.equal(json.trace[0]!.name, "main");
    assert.equal(json.trace[0]!.range!.start.line, 1);
  });

  it("renders one line of JSON, so a log of reports is JSON Lines", () => {
    const text = renderReport(
      buildReport([], { command: "check", baa: "9.9.9", woolly: true, files: 0 }),
    );
    assert.equal(text.split("\n").length, 2);
    assert.ok(text.endsWith("\n"));
    assert.equal((JSON.parse(text) as JsonReport).version, SCHEMA_VERSION);
  });

  it("counts errors and warnings separately", () => {
    const report = buildReport(
      [
        createDiagnostic("BAA102", ["a"]),
        createDiagnostic("BAA905", ["b"]),
        createDiagnostic("BAA906", []),
      ],
      { command: "lint", baa: "9.9.9", woolly: true, files: 1 },
    );
    assert.equal(report.errors, 1);
    assert.equal(report.warnings, 2);
    assert.equal(report.ok, false);
  });
});

describe("cli: --format json", () => {
  it("writes valid JSON and nothing else to stdout, with stderr empty", () => {
    const dir = workspace({ "bad.baa": "baa nope\n" });
    const result = baa(["check", "--format", "json", "bad.baa"], dir);
    assert.equal(result.code, 1);
    assert.equal(result.err, "");
    const report = reportOf(result);
    assert.equal(report.command, "check");
    assert.equal(report.ok, false);
    assert.equal(report.errors, 1);
    assert.equal(report.files, 1);
    assert.equal(report.diagnostics[0]!.code, "BAA102");
    assert.equal(report.diagnostics[0]!.file, "bad.baa");
  });

  it("is valid JSON for zero, one and many diagnostics", () => {
    const dir = workspace({
      "clean.baa": "baa 1\n",
      "one.baa": "baa nope\n",
      "many.baa": "baa nope\nbaa alsonope\n",
    });

    const none = reportOf(baa(["check", "--format", "json", "clean.baa"], dir));
    assert.deepEqual(none.diagnostics, []);
    assert.equal(none.ok, true);
    assert.equal(none.errors, 0);

    assert.equal(reportOf(baa(["check", "--format", "json", "one.baa"], dir)).diagnostics.length, 1);
    assert.equal(reportOf(baa(["check", "--format", "json", "many.baa"], dir)).diagnostics.length, 2);
  });

  it("reports the same codes the human rendering reports", () => {
    const dir = workspace({ "bad.baa": "baa nope\n" });
    const human = baa(["check", "bad.baa"], dir);
    const json = reportOf(baa(["check", "--format", "json", "bad.baa"], dir));
    for (const diagnostic of json.diagnostics) {
      assert.match(human.err, new RegExp(diagnostic.code));
    }
    assert.equal(human.code, json.ok ? 0 : 1);
  });

  it("agrees with the analysis rather than with the printed text", () => {
    const source = "baa nope\n";
    const dir = workspace({ "bad.baa": source });
    const direct = checkFile(new SourceFile("bad.baa", source), { modules: [] });
    const json = reportOf(baa(["check", "--format", "json", "bad.baa"], dir));
    assert.deepEqual(
      json.diagnostics.map((diagnostic) => diagnostic.code),
      direct.diagnostics.map((diagnostic) => diagnostic.code),
    );
  });

  it("records the wording, and switches it under --no-baa", () => {
    const dir = workspace({ "bad.baa": "baa nope\n" });
    const woolly = reportOf(baa(["check", "--format", "json", "bad.baa"], dir));
    const plain = reportOf(baa(["check", "--format", "json", "--no-baa", "bad.baa"], dir));
    assert.equal(woolly.wording, "woolly");
    assert.equal(plain.wording, "plain");
    assert.equal(woolly.diagnostics[0]!.message, woolly.diagnostics[0]!.messages.woolly);
    assert.equal(plain.diagnostics[0]!.message, plain.diagnostics[0]!.messages.plain);
    // The pair is identical in both runs: only the selection changed.
    assert.deepEqual(woolly.diagnostics[0]!.messages, plain.diagnostics[0]!.messages);
  });

  it("reports lint warnings, and follows --deny-warnings in `ok`", () => {
    const dir = workspace({ "warn.baa": "fn f() {\n    let x = 1\n    return 1\n}\nbaa f()\n" });
    const lenient = reportOf(baa(["lint", "--format", "json", "warn.baa"], dir));
    assert.equal(lenient.command, "lint");
    assert.ok(lenient.warnings > 0);
    assert.equal(lenient.errors, 0);
    assert.equal(lenient.ok, true);

    const strict = baa(["lint", "--format", "json", "--deny-warnings", "warn.baa"], dir);
    assert.equal(strict.code, 1);
    assert.equal(reportOf(strict).ok, false);
  });

  it("lists what fmt would change, and changes nothing", () => {
    const original = "fn f(){return 1}\n";
    const dir = workspace({ "messy.baa": original, "tidy.baa": "baa 1\n" });
    const result = baa(["fmt", "--format", "json", "."], dir);
    assert.equal(result.code, 1);
    const report = reportOf(result);
    assert.deepEqual(report.changed, ["messy.baa"]);
    assert.equal(report.ok, false);
    assert.equal(report.files, 2);
    assert.equal(
      spawnSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync('messy.baa','utf8'))"], {
        cwd: dir,
        encoding: "utf8",
      }).stdout,
      original,
    );
  });

  it("carries a parse failure as a diagnostic rather than as prose", () => {
    const dir = workspace({ "broken.baa": "fn f( {\n" });
    const result = baa(["fmt", "--format", "json", "broken.baa"], dir);
    assert.equal(result.code, 1);
    assert.equal(result.err, "");
    const report = reportOf(result);
    assert.equal(report.errors, 1);
    assert.equal(report.ok, false);
  });

  it("refuses on commands whose stdout belongs to the program", () => {
    const dir = workspace({ "hello.baa": "baa 1\n" });
    for (const command of ["run", "test"]) {
      const result = baa([command, "--format", "json", "hello.baa"], dir);
      assert.equal(result.code, 2, `${command} should refuse`);
      assert.match(result.err, /BAA301/);
      assert.equal(result.out, "");
    }
  });

  it("refuses a format it does not know", () => {
    const result = baa(["check", "--format", "yaml", "examples"]);
    assert.equal(result.code, 2);
    assert.match(result.err, /BAA301/);
    assert.equal(result.out, "");
  });

  it("accepts --format human as the default it already is", () => {
    const explicit = baa(["check", "--format", "human", "examples"]);
    const implicit = baa(["check", "examples"]);
    assert.equal(explicit.code, implicit.code);
    assert.equal(explicit.out, implicit.out);
  });
});
