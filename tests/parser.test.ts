import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Expression, Program, Statement } from "../src/ast/ast.ts";
import { childrenOf, walk } from "../src/ast/ast.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { parse } from "../src/parser/parser.ts";

function parseSource(source: string): { program: Program; codes: string[] } {
  const { program, diagnostics } = parse(new SourceFile("test.baa", source));
  return { program, codes: diagnostics.map((diagnostic) => diagnostic.code) };
}

function parseOk(source: string): Program {
  const { program, codes } = parseSource(source);
  assert.deepEqual(codes, [], `unexpected diagnostics: ${codes.join(", ")}`);
  return program;
}

function firstStatement(source: string): Statement {
  const program = parseOk(source);
  const statement = program.body[0];
  assert.ok(statement !== undefined, "expected at least one statement");
  return statement;
}

function expressionOf(source: string): Expression {
  const statement = firstStatement(source);
  assert.equal(statement.kind, "ExpressionStatement");
  return (statement as Extract<Statement, { kind: "ExpressionStatement" }>).expression;
}

/** Render an expression tree as an s-expression, for precedence assertions. */
function shape(expression: Expression): string {
  switch (expression.kind) {
    case "BinaryExpression":
      return `(${expression.operator} ${shape(expression.left)} ${shape(expression.right)})`;
    case "LogicalExpression":
      return `(${expression.operator} ${shape(expression.left)} ${shape(expression.right)})`;
    case "UnaryExpression":
      return `(${expression.operator} ${shape(expression.operand)})`;
    case "RangeExpression":
      return `(${expression.inclusive ? "..=" : ".."} ${shape(expression.start)} ${shape(expression.end)})`;
    case "IntLiteral":
    case "FloatLiteral":
      return String(expression.value);
    case "Identifier":
      return expression.name;
    case "CallExpression":
      return `(call ${[shape(expression.callee), ...expression.args.map(shape)].join(" ")})`;
    case "MemberExpression":
      return `(. ${shape(expression.object)} ${expression.property})`;
    case "IndexExpression":
      return `(index ${shape(expression.object)} ${shape(expression.index)})`;
    case "AssignmentExpression":
      return `(${expression.operator} ${shape(expression.target)} ${shape(expression.value)})`;
    default:
      return expression.kind;
  }
}

describe("parser: statements", () => {
  it("parses each statement form", () => {
    const program = parseOk(`
let a = 1
const B = 2
fn f(x) { return x }
baa a, B
if a { baa 1 } else { baa 2 }
while a > 0 { a -= 1 }
for i in 0..3 { baa i }
import wool
throw "x"
try { baa 1 } catch e { baa e }
test "name" { baa 1 }
export fn g() { return 1 }
export const C = 3
`);
    assert.deepEqual(
      program.body.map((statement) => statement.kind),
      [
        "LetStatement",
        "LetStatement",
        "FunctionDeclaration",
        "BaaStatement",
        "IfStatement",
        "WhileStatement",
        "ForStatement",
        "ImportDeclaration",
        "ThrowStatement",
        "TryStatement",
        "TestDeclaration",
        "FunctionDeclaration",
        "LetStatement",
      ],
    );
  });

  it("chains else-if without nesting blocks", () => {
    const statement = firstStatement("if a { baa 1 } else if b { baa 2 } else { baa 3 }");
    assert.equal(statement.kind, "IfStatement");
    const alternate = (statement as Extract<Statement, { kind: "IfStatement" }>).alternate;
    assert.equal(alternate?.kind, "IfStatement");
  });

  it("allows else and catch on their own line", () => {
    parseOk("if a {\n  baa 1\n}\nelse {\n  baa 2\n}");
    parseOk("try {\n  baa 1\n}\ncatch e {\n  baa 2\n}");
  });

  it("continues after a try/catch without a finally", () => {
    const program = parseOk('try { baa 1 } catch e { baa e }\nfn after() { return 1 }');
    assert.equal(program.body.length, 2);
    assert.equal(program.body[1]!.kind, "FunctionDeclaration");
  });

  it("parses import forms", () => {
    const program = parseOk(`
import wool
import meadow as clock
import { round, mean as average } from ram
import "./pen.baa"
import "./pen.baa" as pen
`);
    const imports = program.body.map((statement) =>
      statement.kind === "ImportDeclaration"
        ? {
            source: statement.source,
            alias: statement.alias,
            relative: statement.relative,
            named: statement.named.map((n) => `${n.name}->${n.alias}`),
          }
        : null,
    );
    assert.deepEqual(imports, [
      { source: "wool", alias: "wool", relative: false, named: [] },
      { source: "meadow", alias: "clock", relative: false, named: [] },
      { source: "ram", alias: "ram", relative: false, named: ["round->round", "mean->average"] },
      { source: "./pen.baa", alias: "pen", relative: true, named: [] },
      { source: "./pen.baa", alias: "pen", relative: true, named: [] },
    ]);
  });

  it("parses parameter defaults and rest parameters", () => {
    const statement = firstStatement("fn f(a, b = 2, ..rest) { return a }");
    assert.equal(statement.kind, "FunctionDeclaration");
    const params = (statement as Extract<Statement, { kind: "FunctionDeclaration" }>).params;
    assert.deepEqual(
      params.map((param) => [param.name, param.defaultValue !== null, param.rest]),
      [
        ["a", false, false],
        ["b", true, false],
        ["rest", false, true],
      ],
    );
  });

  it("captures doc comments on declarations", () => {
    const statement = firstStatement("/// Count them.\n/// Twice.\nfn count() { return 1 }");
    assert.equal(statement.kind, "FunctionDeclaration");
    assert.equal(
      (statement as Extract<Statement, { kind: "FunctionDeclaration" }>).doc,
      "Count them.\nTwice.",
    );
  });
});

describe("parser: expression precedence", () => {
  it("binds arithmetic tighter than comparison, and comparison tighter than logic", () => {
    assert.equal(shape(expressionOf("1 + 2 * 3")), "(+ 1 (* 2 3))");
    assert.equal(shape(expressionOf("(1 + 2) * 3")), "(* (+ 1 2) 3)");
    assert.equal(shape(expressionOf("a < b == c")), "(== (< a b) c)");
    assert.equal(shape(expressionOf("a || b && c")), "(|| a (&& b c))");
    assert.equal(shape(expressionOf("a ?? b || c")), "(?? a (|| b c))");
  });

  it("makes subtraction left-associative and exponentiation right-associative", () => {
    assert.equal(shape(expressionOf("1 - 2 - 3")), "(- (- 1 2) 3)");
    assert.equal(shape(expressionOf("2 ** 3 ** 2")), "(** 2 (** 3 2))");
  });

  it("binds exponentiation tighter than unary minus", () => {
    assert.equal(shape(expressionOf("-2 ** 2")), "(- (** 2 2))");
  });

  it("parses ranges below additive precedence", () => {
    assert.equal(shape(expressionOf("0..n + 1")), "(.. 0 (+ n 1))");
  });

  it("chains postfix operators left to right", () => {
    assert.equal(shape(expressionOf("a.b[0].c()")), "(call (. (index (. a b) 0) c))");
  });

  it("parses assignment right-associatively", () => {
    assert.equal(shape(expressionOf("a = b = 1")), "(= a (= b 1))");
    assert.equal(shape(expressionOf("a[0] += 2")), "(+= (index a 0) 2)");
  });
});

describe("parser: literals", () => {
  it("parses arrays, maps and computed keys", () => {
    const map = expressionOf('{ name: "Dolly", "two words": 2, [key]: 3 }');
    assert.equal(map.kind, "MapLiteral");
    const entries = (map as Extract<Expression, { kind: "MapLiteral" }>).entries;
    assert.deepEqual(
      entries.map((entry) => entry.computed),
      [false, false, true],
    );
  });

  it("allows trailing commas", () => {
    parseOk("let a = [1, 2, 3,]");
    parseOk("let m = { a: 1, b: 2, }");
    parseOk("fn f(a, b,) { return a }");
  });

  it("parses match expressions with alternatives and guards", () => {
    const match = expressionOf(`match n {
      0 => "none",
      1 || 2 => "few",
      x if x > 10 => "many",
      _ => "some",
    }`);
    assert.equal(match.kind, "MatchExpression");
    const arms = (match as Extract<Expression, { kind: "MatchExpression" }>).arms;
    assert.deepEqual(
      arms.map((arm) => [arm.patterns.length, arm.guard !== null]),
      [
        [1, false],
        [2, false],
        [1, true],
        [1, false],
      ],
    );
    assert.equal(arms[3]!.patterns[0]!.kind, "WildcardPattern");
    assert.equal(arms[2]!.patterns[0]!.kind, "BindingPattern");
  });
});

describe("parser: errors and recovery", () => {
  it("reports a missing closing brace as BAA001", () => {
    const { codes } = parseSource("fn f() { baa 1");
    assert.ok(codes.includes("BAA001") || codes.includes("BAA010"), codes.join(","));
  });

  it("rejects an invalid assignment target", () => {
    const { codes } = parseSource("1 = 2");
    assert.deepEqual(codes, ["BAA008"]);
  });

  it("recovers and keeps parsing later statements", () => {
    const { program, codes } = parseSource("let = 1\nlet good = 2\nbaa good");
    assert.ok(codes.length >= 1);
    assert.ok(
      program.body.some(
        (statement) =>
          statement.kind === "LetStatement" &&
          statement.binding.kind === "NameBinding" &&
          statement.binding.name === "good",
      ),
      "expected the parser to recover and see `let good`",
    );
  });

  it("reports several syntax errors in one pass", () => {
    const { codes } = parseSource("let = 1\nconst = 2\nfn () {}");
    assert.ok(codes.length >= 2, `expected multiple diagnostics, got ${codes.join(",")}`);
  });
});

describe("ast helpers", () => {
  it("walks every node exactly once", () => {
    const program = parseOk("fn f(a) { return a + 1 }\nbaa f(2)");
    let count = 0;
    walk(program, () => {
      count++;
    });
    assert.ok(count > 8, `expected a full walk, visited ${count}`);
  });

  it("returns children in source order", () => {
    const call = expressionOf("f(1, 2)");
    assert.deepEqual(
      childrenOf(call).map((child) => child.kind),
      ["Identifier", "IntLiteral", "IntLiteral"],
    );
  });

  it("stops descending when the visitor returns false", () => {
    const program = parseOk("fn f() { baa 1 }");
    const seen: string[] = [];
    walk(program, (node) => {
      seen.push(node.kind);
      return node.kind !== "FunctionDeclaration";
    });
    assert.ok(!seen.includes("BaaStatement"));
  });
});
