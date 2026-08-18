import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { check, run } from "../src/api.ts";
import type { DiagnosticCode } from "../src/diagnostics/codes.ts";
import { ALL_CODES, CATALOGUE, formatTemplate } from "../src/diagnostics/codes.ts";
import {
  ANSI,
  createDiagnostic,
  isWoollyMode,
  NO_COLOUR,
  renderDiagnostic,
  renderDiagnostics,
  setWoollyMode,
  suggest,
} from "../src/diagnostics/diagnostic.ts";
import { SourceFile } from "../src/diagnostics/source.ts";

function firstDiagnostic(source: string) {
  const diagnostic = check(source, "flock.baa").diagnostics[0];
  assert.ok(diagnostic !== undefined, "expected a diagnostic");
  return diagnostic;
}

describe("diagnostics: catalogue", () => {
  it("gives every entry a code matching its key", () => {
    for (const code of ALL_CODES) {
      assert.equal(CATALOGUE[code].code, code);
    }
  });

  it("gives every entry both a woolly and a plain message", () => {
    for (const code of ALL_CODES) {
      const spec = CATALOGUE[code];
      assert.ok(spec.woolly.length > 0, `${code} has no woolly message`);
      assert.ok(spec.plain.length > 0, `${code} has no plain message`);
    }
  });

  it("uses the same placeholders in both wordings", () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]!).sort();
    for (const code of ALL_CODES) {
      const spec = CATALOGUE[code];
      assert.deepEqual(
        [...new Set(placeholders(spec.woolly))],
        [...new Set(placeholders(spec.plain))],
        `${code} placeholders differ between wordings`,
      );
    }
  });

  it("reserves 9xx for warnings and everything else for errors", () => {
    for (const code of ALL_CODES) {
      const expected = code.startsWith("BAA9") ? "warning" : "error";
      assert.equal(CATALOGUE[code].severity, expected, code);
    }
  });

  it("substitutes placeholders and literal braces", () => {
    assert.equal(formatTemplate("{0} and {1}", ["a", "b"]), "a and b");
    assert.equal(formatTemplate("{{literal}}", []), "{literal}");
    assert.equal(formatTemplate("{9}", ["a"]), "{9}");
  });
});

describe("diagnostics: professional mode", () => {
  it("swaps the wording but keeps the code", () => {
    try {
      setWoollyMode(true);
      const woolly = firstDiagnostic("baa missing");
      setWoollyMode(false);
      const plain = firstDiagnostic("baa missing");
      assert.equal(woolly.code, plain.code);
      assert.notEqual(woolly.message, plain.message);
      assert.match(woolly.message, /flock/);
      assert.match(plain.message, /Undefined name/);
    } finally {
      setWoollyMode(true);
    }
  });

  it("reports its current mode", () => {
    setWoollyMode(false);
    assert.equal(isWoollyMode(), false);
    setWoollyMode(true);
    assert.equal(isWoollyMode(), true);
  });
});

describe("diagnostics: rendering", () => {
  const source = 'const flock = ["Dolly"]\nbaa flok\n';

  it("shows the file, line, column and the offending source line", () => {
    const rendered = renderDiagnostic(firstDiagnostic(source), { palette: NO_COLOUR });
    assert.match(rendered, /error\[BAA102\]/);
    assert.match(rendered, /flock\.baa:2:5/);
    assert.match(rendered, /baa flok/);
    assert.match(rendered, /\^\^\^\^/);
    assert.match(rendered, /help: Did you mean `flock`\?/);
  });

  it("underlines exactly the offending span", () => {
    const rendered = renderDiagnostic(firstDiagnostic(source), { palette: NO_COLOUR });
    const caretLine = rendered.split("\n").find((line) => line.includes("^"))!;
    assert.equal(caretLine.trimEnd().endsWith("^^^^ not found in this pasture"), true, caretLine);
  });

  it("emits no escape codes without a palette, and some with one", () => {
    const diagnostic = firstDiagnostic(source);
    // eslint-disable-next-line no-control-regex
    const escape = /\[/;
    assert.equal(escape.test(renderDiagnostic(diagnostic, { palette: NO_COLOUR })), false);
    assert.equal(escape.test(renderDiagnostic(diagnostic, { palette: ANSI })), true);
  });

  it("summarises counts across several diagnostics", () => {
    const rendered = renderDiagnostics([
      createDiagnostic("BAA102", ["a"], {}),
      createDiagnostic("BAA102", ["b"], {}),
      createDiagnostic("BAA901", ["c"], {}),
    ]);
    assert.match(rendered, /2 errors, 1 warning$/);
  });

  it("renders a diagnostic with no span without crashing", () => {
    const rendered = renderDiagnostic(createDiagnostic("BAA405", ["broken"], { help: "fix it" }));
    assert.match(rendered, /BAA405/);
    assert.match(rendered, /help: fix it/);
  });

  it("renders secondary labels and traces", () => {
    const file = new SourceFile("t.baa", "let a = 1\nlet a = 2\n");
    const diagnostic = createDiagnostic("BAA101", ["a"], {
      span: file.span(14, 15),
      note: "again",
      secondary: [{ span: file.span(4, 5), note: "first declared here" }],
      trace: [{ name: "main", span: file.span(0, 3) }],
    });
    const rendered = renderDiagnostic(diagnostic, { palette: NO_COLOUR });
    assert.match(rendered, /first declared here/);
    assert.match(rendered, /at main \(t\.baa:1:1\)/);
  });
});

describe("diagnostics: spans", () => {
  it("maps offsets to 1-based line and column", () => {
    const file = new SourceFile("t.baa", "abc\ndefg\n");
    assert.deepEqual(file.positionAt(0), { line: 1, column: 1 });
    assert.deepEqual(file.positionAt(4), { line: 2, column: 1 });
    assert.deepEqual(file.positionAt(7), { line: 2, column: 4 });
    assert.equal(file.lineText(2), "defg");
  });

  it("clamps offsets outside the file", () => {
    const file = new SourceFile("t.baa", "abc");
    assert.deepEqual(file.positionAt(999), { line: 1, column: 4 });
    assert.deepEqual(file.positionAt(-5), { line: 1, column: 1 });
  });
});

describe("diagnostics: suggestions", () => {
  it("finds a near miss and ignores a distant one", () => {
    assert.equal(suggest("flok", ["flock", "sheep"]), "flock");
    assert.equal(suggest("zzzzzz", ["flock"]), null);
    assert.equal(suggest("flock", ["flock"]), null);
  });
});

describe("diagnostics: end to end", () => {
  const cases: Array<[DiagnosticCode, string]> = [
    ["BAA002", "let a = §"],
    ["BAA003", 'baa "open'],
    ["BAA004", "/* open"],
    ["BAA005", "baa 12abc"],
    ["BAA007", String.raw`baa "\q"`],
    ["BAA008", "1 = 2"],
    ["BAA009", 'baa "{ }"'],
    ["BAA101", "let a = 1\nlet a = 2"],
    ["BAA102", "baa nope"],
    ["BAA103", "const a = 1\na = 2"],
    ["BAA104", "return 1"],
    ["BAA105", "break"],
    ["BAA106", "baa later\nlet later = 1"],
    ["BAA201", "fn f(a) { return a }\nf(1, 2)"],
    ["BAA202", "fn f(a, b) { return a }\nf(1)"],
    ["BAA203", "fn f(a, a) { return a }"],
    ["BAA401", "import cotton"],
  ];

  for (const [code, source] of cases) {
    it(`reports ${code}`, () => {
      const codes = check(source, "t.baa").diagnostics.map((diagnostic) => diagnostic.code);
      assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(", ") || "nothing"}`);
    });
  }

  const runtimeCases: Array<[DiagnosticCode, string]> = [
    ["BAA301", 'baa match 1 { 2 => "x" }'],
    ["BAA302", "baa [1] - 1"],
    ["BAA303", "const n = 1\nbaa n()"],
    ["BAA304", "baa [1][9]"],
    ["BAA305", "baa nil.field"],
    ["BAA306", "baa 1 / 0"],
    ["BAA307", "fn f() { return f() }\nf()"],
    ["BAA308", 'throw "x"'],
    ["BAA309", "for x in 1 { baa x }"],
    ["BAA310", 'baa { a: 1 }.expect("b")'],
    ["BAA311", 'baa "x".repeat("y")'],
  ];

  for (const [code, source] of runtimeCases) {
    it(`reports ${code} at runtime`, () => {
      const result = run(source, "t.baa", { maxDepth: 64 });
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
      assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(", ") || "nothing"}`);
    });
  }

  it("points at the right line for a runtime error deep in a file", () => {
    const source = ["baa 1", "baa 2", "baa 3", "baa [1][9]"].join("\n");
    const diagnostic = run(source, "t.baa").diagnostics[0]!;
    const position = diagnostic.primary!.span.file.positionAt(diagnostic.primary!.span.start);
    assert.equal(position.line, 4);
  });
});
