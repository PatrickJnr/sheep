/**
 * `baa lint`: static analysis beyond correctness.
 *
 * Everything here is a warning: a lint never changes whether a program is
 * valid. Errors belong to the resolver. Two rules of thumb keep this list
 * short and trustworthy:
 *
 *  - no false positives that require a code change to silence (prefix a name
 *    with `_` and every "unused" lint goes quiet);
 *  - no style opinions the formatter already enforces.
 */

import type { Block, Expression, Program, Statement } from "../ast/ast.ts";
import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import { createDiagnostic } from "../diagnostics/diagnostic.ts";
import type { ResolveResult } from "../semantic/resolver.ts";

export type LintOptions = {
  /** Rule codes to skip, e.g. `["BAA905"]`. */
  readonly disable?: readonly string[];
};

export function lintProgram(
  program: Program,
  analysis: ResolveResult,
  options: LintOptions = {},
): Diagnostic[] {
  const disabled = new Set(options.disable ?? []);
  const warnings: Diagnostic[] = [];

  const push = (diagnostic: Diagnostic): void => {
    if (!disabled.has(diagnostic.code)) warnings.push(diagnostic);
  };

  for (const symbol of analysis.unused) {
    if (symbol.kind === "import") {
      push(
        createDiagnostic("BAA903", [symbol.name], {
          span: symbol.span,
          note: "never used",
          help: `Remove the import, or rename it \`_${symbol.name}\` to silence this.`,
        }),
      );
      continue;
    }
    if (symbol.kind === "loop" || symbol.kind === "catch" || symbol.kind === "match") continue;
    push(
      createDiagnostic("BAA901", [symbol.name], {
        span: symbol.span,
        note: "never read",
        help: `Remove it, or rename it \`_${symbol.name}\` if that is deliberate.`,
      }),
    );
  }

  for (const symbol of analysis.neverReassigned) {
    push(
      createDiagnostic("BAA905", [symbol.name], {
        span: symbol.span,
        note: "never reassigned",
        help: `Change \`let\` to \`const\`.`,
      }),
    );
  }

  walkStatements(program.body, push);
  return warnings;
}

function walkStatements(
  statements: readonly Statement[],
  push: (diagnostic: Diagnostic) => void,
): void {
  statements.forEach((statement, index) => {
    if (statement.kind === "ReturnStatement" && index < statements.length - 1) {
      const next = statements[index + 1]!;
      push(
        createDiagnostic("BAA902", [], {
          span: next.span,
          note: "never runs",
          secondary: [{ span: statement.span, note: "returns here" }],
          help: "Remove it, or move it above the `return`.",
        }),
      );
    }
    walkStatement(statement, push);
  });
}

function walkStatement(statement: Statement, push: (diagnostic: Diagnostic) => void): void {
  switch (statement.kind) {
    case "FunctionDeclaration":
      checkBlock(statement.body, push);
      return;
    case "IfStatement":
      checkCondition(statement.condition, push);
      checkBlock(statement.consequent, push);
      if (statement.alternate === null) return;
      if (statement.alternate.kind === "Block") checkBlock(statement.alternate, push);
      else walkStatement(statement.alternate, push);
      return;
    case "WhileStatement":
      checkBlock(statement.body, push);
      walkExpression(statement.condition, push);
      return;
    case "ForStatement":
      checkBlock(statement.body, push);
      walkExpression(statement.iterable, push);
      return;
    case "TryStatement":
      checkBlock(statement.block, push);
      if (statement.handler !== null) checkBlock(statement.handler, push);
      if (statement.finalizer !== null) checkBlock(statement.finalizer, push);
      return;
    case "TestDeclaration":
      checkBlock(statement.body, push);
      return;
    case "LetStatement":
      walkExpression(statement.value, push);
      return;
    case "ExpressionStatement":
      walkExpression(statement.expression, push);
      return;
    case "BaaStatement":
      for (const value of statement.values) walkExpression(value, push);
      return;
    case "ThrowStatement":
      walkExpression(statement.value, push);
      return;
    case "ReturnStatement":
      if (statement.value !== null) walkExpression(statement.value, push);
      return;
    default:
      return;
  }
}

function checkBlock(block: Block, push: (diagnostic: Diagnostic) => void): void {
  if (block.body.length === 0 && block.trailingComments.length === 0) {
    push(
      createDiagnostic("BAA906", [], {
        span: block.span,
        note: "empty",
        help: "Remove it, or leave a comment explaining why nothing happens here.",
      }),
    );
  }
  walkStatements(block.body, push);
}

function checkCondition(condition: Expression, push: (diagnostic: Diagnostic) => void): void {
  if (condition.kind === "BoolLiteral") {
    push(
      createDiagnostic("BAA904", [condition.value ? "true" : "false"], {
        span: condition.span,
        note: "constant condition",
      }),
    );
  }
  walkExpression(condition, push);
}

function walkExpression(expression: Expression, push: (diagnostic: Diagnostic) => void): void {
  switch (expression.kind) {
    case "FunctionExpression":
      checkBlock(expression.body, push);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      walkExpression(expression.left, push);
      walkExpression(expression.right, push);
      return;
    case "UnaryExpression":
      walkExpression(expression.operand, push);
      return;
    case "CallExpression":
      walkExpression(expression.callee, push);
      for (const argument of expression.args) walkExpression(argument, push);
      return;
    case "ArrayLiteral":
      for (const element of expression.elements) walkExpression(element, push);
      return;
    case "MapLiteral":
      for (const entry of expression.entries) {
        walkExpression(entry.key, push);
        walkExpression(entry.value, push);
      }
      return;
    case "MemberExpression":
      walkExpression(expression.object, push);
      return;
    case "IndexExpression":
      walkExpression(expression.object, push);
      walkExpression(expression.index, push);
      return;
    case "RangeExpression":
      walkExpression(expression.start, push);
      walkExpression(expression.end, push);
      return;
    case "AssignmentExpression":
      walkExpression(expression.target, push);
      walkExpression(expression.value, push);
      return;
    case "StringLiteral":
      for (const segment of expression.segments) {
        if (segment.kind === "expr") walkExpression(segment.expression, push);
      }
      return;
    case "MatchExpression":
      walkExpression(expression.subject, push);
      for (const arm of expression.arms) walkExpression(arm.body, push);
      return;
    default:
      return;
  }
}
