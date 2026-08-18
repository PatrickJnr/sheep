import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { format, run } from "../src/api.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { tokenize } from "../src/lexer/lexer.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = join(ROOT, "examples");

function fmt(source: string): string {
  return format(source, "test.baa");
}

describe("formatter: normalisation", () => {
  it("uses four-space indentation", () => {
    assert.equal(fmt("fn f() {\nreturn 1\n}"), "fn f() {\n    return 1\n}\n");
  });

  it("normalises spacing around operators and commas", () => {
    assert.equal(fmt("baa 1+2*3"), "baa 1 + 2 * 3\n");
    assert.equal(fmt("baa [1,2 ,  3]"), "baa [1, 2, 3]\n");
    assert.equal(fmt("let m={a:1,b:2}"), "let m = { a: 1, b: 2 }\n");
  });

  it("ends the file with exactly one newline", () => {
    assert.equal(fmt("baa 1\n\n\n"), "baa 1\n");
    assert.equal(fmt("baa 1"), "baa 1\n");
  });

  it("collapses runs of blank lines to one", () => {
    assert.equal(fmt("baa 1\n\n\n\nbaa 2"), "baa 1\n\nbaa 2\n");
  });

  it("keeps parentheses only where precedence needs them", () => {
    assert.equal(fmt("baa (1 + 2) * 3"), "baa (1 + 2) * 3\n");
    assert.equal(fmt("baa (1 * 2) + 3"), "baa 1 * 2 + 3\n");
  });

  it("round-trips exponentiation and unary minus without changing meaning", () => {
    const cases: Array<[string, string]> = [
      ["baa 2 ** 3 ** 2", "baa 2 ** 3 ** 2\n"],
      ["baa (2 ** 3) ** 2", "baa (2 ** 3) ** 2\n"],
      ["baa -2 ** 2", "baa -2 ** 2\n"],
      ["baa (-2) ** 2", "baa (-2) ** 2\n"],
      ["baa -(a + b)", "baa -(a + b)\n"],
      ["baa !a && b", "baa !a && b\n"],
      ["baa !(a && b)", "baa !(a && b)\n"],
    ];
    for (const [source, expected] of cases) {
      assert.equal(fmt(source), expected, source);
      assert.equal(fmt(expected), expected, `${source} is not idempotent`);
    }
  });

  it("never changes the value of an expression it reformats", () => {
    const expressions = [
      "2 ** 3 ** 2",
      "(2 ** 3) ** 2",
      "-2 ** 2",
      "(-2) ** 2",
      "1 - 2 - 3",
      "1 - (2 - 3)",
      "2 * (3 + 4)",
      "!(1 == 2) && 3 > 2",
      "1 + 2 * 3 ** 2 - 4 / 2",
    ];
    for (const expression of expressions) {
      const before = run(`baa ${expression}`, "t.baa");
      const after = run(fmt(`baa ${expression}`), "t.baa");
      assert.equal(after.output, before.output, expression);
    }
  });

  it("chains else-if on one line", () => {
    assert.equal(
      fmt("if a{baa 1}else if b{baa 2}else{baa 3}"),
      "if a {\n    baa 1\n} else if b {\n    baa 2\n} else {\n    baa 3\n}\n",
    );
  });

  it("preserves number literal spelling", () => {
    assert.equal(fmt("baa 0xFF, 1_000, 1e3"), "baa 0xFF, 1_000, 1e3\n");
  });

  it("re-escapes strings and keeps interpolations", () => {
    assert.equal(fmt('baa "a\\nb {x} \\{literal\\}"'), 'baa "a\\nb {x} \\{literal\\}"\n');
  });
});

describe("formatter: comments", () => {
  it("keeps own-line comments above their statement", () => {
    assert.equal(fmt("// note\nbaa 1"), "// note\nbaa 1\n");
  });

  it("keeps a blank line between a file header and the first statement", () => {
    assert.equal(fmt("// header\n\nbaa 1"), "// header\n\nbaa 1\n");
  });

  it("keeps same-line comments after their statement", () => {
    assert.equal(fmt("baa 1 // why"), "baa 1  // why\n");
  });

  it("keeps comments inside blocks", () => {
    assert.equal(fmt("fn f() {\n// inner\nreturn 1\n}"), "fn f() {\n    // inner\n    return 1\n}\n");
  });

  it("never inlines a body that carries a comment", () => {
    const formatted = fmt("const f = fn() { // keep me\nreturn 1\n}");
    assert.match(formatted, /keep me/);
  });
});

describe("formatter: comment preservation", () => {
  function commentTexts(source: string): string[] {
    const texts: string[] = [];
    for (const token of tokenize(new SourceFile("t.baa", source))) {
      for (const comment of token.leading) texts.push(comment.text.trim());
      if (token.trailing !== null) texts.push(token.trailing.text.trim());
    }
    return texts.sort();
  }

  const tricky = [
    "fn f() { // header\n    return 1\n}",
    "if a { // yes\n    baa 1\n} else { // no\n    baa 2\n}",
    "try { // attempt\n    baa 1\n} catch e { // rescue\n    baa e\n}",
    "for i in 0..2 { // loop\n    baa i // body\n}",
    "const f = fn() { // lambda\n    return 1\n}",
    "fn f() {\n    // only a comment\n}",
    "/* block */\nbaa 1 /* after */",
    "// one\n// two\n\n// three\nbaa 1",
  ];

  for (const [index, source] of tricky.entries()) {
    it(`keeps every comment in case ${index + 1}`, () => {
      const formatted = fmt(source);
      assert.deepEqual(commentTexts(formatted), commentTexts(source), formatted);
    });
  }

  it("keeps every comment in every example", () => {
    for (const name of readdirSync(EXAMPLES).filter((n) => n.endsWith(".baa"))) {
      const source = readFileSync(join(EXAMPLES, name), "utf8");
      assert.deepEqual(commentTexts(fmt(source)), commentTexts(source), name);
    }
  });
});

describe("formatter: line breaking", () => {
  it("keeps short collections on one line", () => {
    assert.equal(fmt("const a = [1, 2, 3]"), "const a = [1, 2, 3]\n");
  });

  it("breaks collections that do not fit, one item per line with a trailing comma", () => {
    const long = `const a = ["${"x".repeat(30)}", "${"y".repeat(30)}", "${"z".repeat(30)}"]`;
    const formatted = fmt(long);
    assert.match(formatted, /\[\n {4}"x{30}",\n/);
    assert.match(formatted, /",\n\]\n$/);
  });

  it("hugs a single collection argument instead of double-indenting", () => {
    const source = `f(["${"x".repeat(60)}", "${"y".repeat(60)}"])`;
    assert.match(fmt(source), /^f\(\[\n {4}"x/);
  });

  it("inlines a one-statement callback that fits", () => {
    assert.equal(
      fmt("baa [1].map(fn(n) {\nreturn n * 2\n})"),
      "baa [1].map(fn(n) { return n * 2 })\n",
    );
  });
});

describe("formatter: idempotence", () => {
  const cases = [
    "baa 1",
    "// c\n\nfn f(a, b = 1, ..rest) {\n    return a\n}",
    'const m = {\n    a: 1,\n    b: [1, 2, 3],\n}',
    'try {\n    baa 1\n} catch e {\n    baa e\n} finally {\n    baa 2\n}',
    'const x = match n {\n    0 => "none",\n    _ => "some",\n}',
    'import { round } from ram\nimport "./pen.baa"',
    'test "it works" {\n    assert_eq(1, 1)\n}',
  ];

  for (const [index, source] of cases.entries()) {
    it(`formatting is stable for case ${index + 1}`, () => {
      const once = fmt(source);
      const twice = fmt(once);
      assert.equal(twice, once, `not idempotent:\n---\n${once}\n---\n${twice}`);
    });
  }

  it("is stable and behaviour-preserving for every example", () => {
    const files = readdirSync(EXAMPLES).filter((name) => name.endsWith(".baa"));
    assert.ok(files.length > 5, "expected a decent set of examples");
    for (const name of files) {
      const source = readFileSync(join(EXAMPLES, name), "utf8");
      const once = fmt(source);
      assert.equal(once, fmt(once), `${name} is not idempotent`);
      assert.equal(once, source.replace(/\r\n?/g, "\n"), `${name} is not in canonical form`);
    }
  });

  it("does not change what a program prints", () => {
    const source = readFileSync(join(EXAMPLES, "large_program.baa"), "utf8");
    const before = run(source, "large_program.baa");
    const after = run(fmt(source), "large_program.baa");
    assert.equal(after.output, before.output);
  });
});
