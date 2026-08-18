import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BaaError } from "../src/diagnostics/diagnostic.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { Lexer, tokenize } from "../src/lexer/lexer.ts";
import type { Token } from "../src/lexer/token.ts";

function lex(source: string): Token[] {
  return tokenize(new SourceFile("test.baa", source));
}

function kinds(source: string): string[] {
  return lex(source)
    .map((token) => token.kind)
    .filter((kind) => kind !== "eof");
}

function throwsWith(source: string, code: string): BaaError {
  try {
    lex(source);
  } catch (error) {
    assert.ok(error instanceof BaaError, `expected BaaError, got ${String(error)}`);
    assert.equal(error.diagnostic.code, code);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${code}, but lexing succeeded` });
}

describe("lexer: basics", () => {
  it("recognises keywords and identifiers", () => {
    assert.deepEqual(kinds("let sheep = 12"), ["let", "ident", "=", "int"]);
    assert.deepEqual(kinds("const MAX = 1"), ["const", "ident", "=", "int"]);
    assert.deepEqual(kinds("baa nil true false"), ["baa", "nil", "true", "false"]);
  });

  it("treats a keyword-like identifier as an identifier", () => {
    assert.deepEqual(kinds("letter"), ["ident"]);
    assert.deepEqual(kinds("baaa"), ["ident"]);
  });

  it("records spans that map back to source text", () => {
    const file = new SourceFile("test.baa", "let sheep = 12");
    const tokens = tokenize(file);
    const sheep = tokens[1]!;
    assert.equal(file.text.slice(sheep.span.start, sheep.span.end), "sheep");
    assert.deepEqual(file.positionAt(sheep.span.start), { line: 1, column: 5 });
  });

  it("normalises CRLF line endings", () => {
    const file = new SourceFile("test.baa", "let a = 1\r\nlet b = 2\r\n");
    assert.equal(file.lineCount, 3);
    assert.equal(file.lineText(2), "let b = 2");
  });
});

describe("lexer: numbers", () => {
  it("reads decimal, float, exponent and separator forms", () => {
    const values = lex("12 3.5 1e3 1_000 2.5e-2")
      .filter((token) => token.kind === "int" || token.kind === "float")
      .map((token) => token.value);
    assert.deepEqual(values, [12, 3.5, 1000, 1000, 0.025]);
  });

  it("reads radix prefixes", () => {
    const values = lex("0xFF 0b1010 0o17").map((token) => token.value).slice(0, 3);
    assert.deepEqual(values, [255, 10, 15]);
  });

  it("does not swallow a range operator as a decimal point", () => {
    assert.deepEqual(kinds("1..5"), ["int", "..", "int"]);
    assert.deepEqual(kinds("1..=5"), ["int", "..=", "int"]);
  });

  it("rejects a malformed number", () => {
    throwsWith("0x", "BAA005");
    throwsWith("12abc", "BAA005");
  });
});

describe("lexer: strings", () => {
  it("unescapes text segments", () => {
    const token = lex(String.raw`"a\nb\t\"c\\"`)[0]!;
    assert.equal(token.parts?.length, 1);
    assert.deepEqual(token.parts?.[0], { kind: "text", value: 'a\nb\t"c\\' });
  });

  it("supports unicode escapes", () => {
    const token = lex(String.raw`"\u{1F411}"`)[0]!;
    assert.deepEqual(token.parts?.[0], { kind: "text", value: "\u{1F411}" });
  });

  it("splits interpolations into parts with absolute offsets", () => {
    const source = 'baa "Baa, {name}!"';
    const token = lex(source)[1]!;
    assert.deepEqual(
      token.parts?.map((part) => part.kind),
      ["text", "expr", "text"],
    );
    const expr = token.parts?.[1];
    assert.ok(expr !== undefined && expr.kind === "expr");
    assert.equal(expr.source, "name");
    assert.equal(source.slice(expr.offset, expr.offset + expr.source.length), "name");
  });

  it("handles nested braces and nested strings inside interpolations", () => {
    const token = lex('"{ names.map(fn(n) { return n }).join(", ") }"')[0]!;
    const expr = token.parts?.[0];
    assert.ok(expr !== undefined && expr.kind === "expr");
    assert.equal(expr.source.trim(), 'names.map(fn(n) { return n }).join(", ")');
  });

  it("rejects unterminated strings, bad escapes and empty interpolations", () => {
    throwsWith('"open', "BAA003");
    throwsWith(String.raw`"\q"`, "BAA007");
    throwsWith('"{ }"', "BAA009");
    throwsWith('"{name"', "BAA001");
  });
});

describe("lexer: comments and trivia", () => {
  it("attaches own-line comments to the next token", () => {
    const tokens = lex("// header\nlet a = 1");
    assert.equal(tokens[0]!.kind, "let");
    assert.equal(tokens[0]!.leading.length, 1);
    assert.equal(tokens[0]!.leading[0]!.text, "// header");
    assert.equal(tokens[0]!.blankLinesBefore, 0);
  });

  it("attaches same-line comments to the preceding token", () => {
    const tokens = lex("let a = 1 // trailing\nlet b = 2");
    const one = tokens.find((token) => token.text === "1")!;
    assert.equal(one.trailing?.text, "// trailing");
  });

  it("counts blank lines, not line terminators", () => {
    const tokens = lex("let a = 1\n\n\nlet b = 2");
    const second = tokens.find((token) => token.kind === "let" && token.blankLinesBefore > 0);
    assert.equal(second?.blankLinesBefore, 2);
  });

  it("nests block comments and rejects unterminated ones", () => {
    assert.deepEqual(kinds("/* outer /* inner */ still */ let a = 1"), [
      "let",
      "ident",
      "=",
      "int",
    ]);
    throwsWith("/* never closed", "BAA004");
  });
});

describe("lexer: newline significance", () => {
  it("emits a newline between statements", () => {
    assert.deepEqual(kinds("baa 1\nbaa 2"), ["baa", "int", "newline", "baa", "int"]);
  });

  it("suppresses newlines inside parentheses and brackets", () => {
    assert.equal(kinds("f(\n1,\n2\n)").includes("newline"), false);
    assert.equal(kinds("[\n1,\n2\n]").includes("newline"), false);
  });

  it("suppresses a newline after a dangling operator", () => {
    assert.equal(kinds("let a = 1 +\n2").includes("newline"), false);
  });

  it("suppresses a newline before a leading dot, for method chains", () => {
    assert.equal(kinds("names\n  .sort()\n  .first()").includes("newline"), false);
  });

  it("keeps the newline before a leading range operator", () => {
    assert.equal(kinds("let a = 1\n..2").includes("newline"), true);
  });
});

describe("lexer: ranged lexing", () => {
  it("lexes a slice with absolute spans", () => {
    const file = new SourceFile("test.baa", 'baa "x{sheep}y"');
    const tokens = Lexer.tokenizeRange(file, 7, 12);
    assert.equal(tokens[0]!.text, "sheep");
    assert.equal(tokens[0]!.span.start, 7);
    assert.equal(tokens[1]!.kind, "eof");
  });
});
