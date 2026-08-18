/**
 * The Baa abstract syntax tree.
 *
 * Every node is a plain object with a `kind` discriminant and a `span`. Nodes
 * are data, never behaviour: the resolver, interpreter, formatter and linter
 * are all separate walkers over this shape. Adding a stage never means touching
 * the AST.
 *
 * Comment trivia collected by the lexer is attached to statements (`leading` /
 * `trailing`) so the formatter can round-trip a file without losing comments.
 */

import type { Span } from "../diagnostics/source.ts";
import type { Comment } from "../lexer/token.ts";

export type Node = Statement | Expression | Program | Block | Param | MatchArm;

export type Program = {
  readonly kind: "Program";
  readonly span: Span;
  readonly body: readonly Statement[];
  /** Comments that follow the last statement in the file. */
  readonly trailingComments: readonly Comment[];
  /**
   * A leading `#!` line, without its newline, or `null`.
   *
   * Kept on the node rather than thrown away by the lexer so the formatter can
   * put it back. Rewriting an executable page without its shebang would stop
   * the operating system running it.
   */
  readonly shebang: string | null;
};

export type Block = {
  readonly kind: "Block";
  readonly span: Span;
  readonly body: readonly Statement[];
  /** A comment on the same line as the opening `{`. */
  readonly headerComment: Comment | null;
  /** Comments between the last statement and the closing `}`. */
  readonly trailingComments: readonly Comment[];
};

export type Param = {
  readonly kind: "Param";
  readonly span: Span;
  readonly name: string;
  readonly defaultValue: Expression | null;
  /** `fn f(a, ...rest)` collects remaining arguments into an array. */
  readonly rest: boolean;
};

// ---------------------------------------------------------------- statements

export type Statement =
  | LetStatement
  | FunctionDeclaration
  | ExpressionStatement
  | BaaStatement
  | ReturnStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | BreakStatement
  | ContinueStatement
  | ImportDeclaration
  | ThrowStatement
  | TryStatement
  | TestDeclaration;

type StatementBase = {
  readonly span: Span;
  readonly leading: readonly Comment[];
  readonly trailing: Comment | null;
  /** Blank lines above this statement in the source, capped at 1 by the formatter. */
  readonly blankLinesBefore: number;
};

export type LetStatement = StatementBase & {
  readonly kind: "LetStatement";
  readonly name: string;
  readonly nameSpan: Span;
  readonly value: Expression;
  /** `false` for `const`. */
  readonly mutable: boolean;
  readonly exported: boolean;
};

export type FunctionDeclaration = StatementBase & {
  readonly kind: "FunctionDeclaration";
  readonly name: string;
  readonly nameSpan: Span;
  readonly params: readonly Param[];
  readonly body: Block;
  readonly exported: boolean;
  /** Doc comment text, if the declaration is preceded by `///` style comments. */
  readonly doc: string | null;
};

export type ExpressionStatement = StatementBase & {
  readonly kind: "ExpressionStatement";
  readonly expression: Expression;
};

export type BaaStatement = StatementBase & {
  readonly kind: "BaaStatement";
  /** `baa a, b, c` prints all values space-separated. */
  readonly values: readonly Expression[];
};

export type ReturnStatement = StatementBase & {
  readonly kind: "ReturnStatement";
  readonly value: Expression | null;
};

export type IfStatement = StatementBase & {
  readonly kind: "IfStatement";
  readonly condition: Expression;
  readonly consequent: Block;
  readonly alternate: Block | IfStatement | null;
};

export type WhileStatement = StatementBase & {
  readonly kind: "WhileStatement";
  readonly condition: Expression;
  readonly body: Block;
};

export type ForStatement = StatementBase & {
  readonly kind: "ForStatement";
  readonly name: string;
  readonly nameSpan: Span;
  /** Second binding in `for key, value in map`. */
  readonly valueName: string | null;
  readonly valueNameSpan: Span | null;
  readonly iterable: Expression;
  readonly body: Block;
};

export type BreakStatement = StatementBase & { readonly kind: "BreakStatement" };
export type ContinueStatement = StatementBase & { readonly kind: "ContinueStatement" };

export type ImportDeclaration = StatementBase & {
  readonly kind: "ImportDeclaration";
  /** Either a stdlib name (`wool`) or a relative path (`"./flock.baa"`). */
  readonly source: string;
  readonly sourceSpan: Span;
  readonly relative: boolean;
  /** Local binding name: the alias if given, otherwise the module name. */
  readonly alias: string;
  readonly aliasSpan: Span;
  /** `import { a, b } from wool`: empty when importing the whole module. */
  readonly named: readonly ImportSpecifier[];
};

export type ImportSpecifier = {
  readonly name: string;
  readonly alias: string;
  readonly span: Span;
};

export type ThrowStatement = StatementBase & {
  readonly kind: "ThrowStatement";
  readonly value: Expression;
};

export type TryStatement = StatementBase & {
  readonly kind: "TryStatement";
  readonly block: Block;
  readonly catchName: string | null;
  readonly catchNameSpan: Span | null;
  readonly handler: Block | null;
  readonly finalizer: Block | null;
};

export type TestDeclaration = StatementBase & {
  readonly kind: "TestDeclaration";
  readonly name: string;
  readonly nameSpan: Span;
  readonly body: Block;
};

// --------------------------------------------------------------- expressions

export type Expression =
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | BoolLiteral
  | NilLiteral
  | Identifier
  | ArrayLiteral
  | MapLiteral
  | FunctionExpression
  | UnaryExpression
  | BinaryExpression
  | LogicalExpression
  | AssignmentExpression
  | CallExpression
  | MemberExpression
  | IndexExpression
  | RangeExpression
  | MatchExpression;

export type IntLiteral = {
  readonly kind: "IntLiteral";
  readonly span: Span;
  readonly value: number;
  /** Original text, so the formatter preserves `0xFF` and `1_000`. */
  readonly raw: string;
};

export type FloatLiteral = {
  readonly kind: "FloatLiteral";
  readonly span: Span;
  readonly value: number;
  readonly raw: string;
};

export type StringSegment =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "expr"; readonly expression: Expression };

export type StringLiteral = {
  readonly kind: "StringLiteral";
  readonly span: Span;
  readonly segments: readonly StringSegment[];
};

export type BoolLiteral = {
  readonly kind: "BoolLiteral";
  readonly span: Span;
  readonly value: boolean;
};

export type NilLiteral = { readonly kind: "NilLiteral"; readonly span: Span };

export type Identifier = {
  readonly kind: "Identifier";
  readonly span: Span;
  readonly name: string;
};

export type ArrayLiteral = {
  readonly kind: "ArrayLiteral";
  readonly span: Span;
  readonly elements: readonly Expression[];
};

export type MapEntry = {
  readonly key: Expression;
  readonly value: Expression;
  /** `{ [expr]: v }` computes the key; `{ name: v }` and `{ "s": v }` do not. */
  readonly computed: boolean;
  readonly span: Span;
};

export type MapLiteral = {
  readonly kind: "MapLiteral";
  readonly span: Span;
  readonly entries: readonly MapEntry[];
};

export type FunctionExpression = {
  readonly kind: "FunctionExpression";
  readonly span: Span;
  readonly name: string | null;
  readonly params: readonly Param[];
  readonly body: Block;
};

export type UnaryOperator = "-" | "!";

export type UnaryExpression = {
  readonly kind: "UnaryExpression";
  readonly span: Span;
  readonly operator: UnaryOperator;
  readonly operand: Expression;
};

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in";

export type BinaryExpression = {
  readonly kind: "BinaryExpression";
  readonly span: Span;
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
  readonly operatorSpan: Span;
};

export type LogicalOperator = "&&" | "||" | "??";

export type LogicalExpression = {
  readonly kind: "LogicalExpression";
  readonly span: Span;
  readonly operator: LogicalOperator;
  readonly left: Expression;
  readonly right: Expression;
};

export type AssignmentOperator = "=" | "+=" | "-=" | "*=" | "/=" | "%=";

export type AssignmentTarget = Identifier | MemberExpression | IndexExpression;

export type AssignmentExpression = {
  readonly kind: "AssignmentExpression";
  readonly span: Span;
  readonly operator: AssignmentOperator;
  readonly target: AssignmentTarget;
  readonly value: Expression;
};

export type CallExpression = {
  readonly kind: "CallExpression";
  readonly span: Span;
  readonly callee: Expression;
  readonly args: readonly Expression[];
  /** Span of just the argument list, used for arity diagnostics. */
  readonly argsSpan: Span;
};

export type MemberExpression = {
  readonly kind: "MemberExpression";
  readonly span: Span;
  readonly object: Expression;
  readonly property: string;
  readonly propertySpan: Span;
};

export type IndexExpression = {
  readonly kind: "IndexExpression";
  readonly span: Span;
  readonly object: Expression;
  readonly index: Expression;
};

export type RangeExpression = {
  readonly kind: "RangeExpression";
  readonly span: Span;
  readonly start: Expression;
  readonly end: Expression;
  readonly inclusive: boolean;
};

export type Pattern =
  | { readonly kind: "WildcardPattern"; readonly span: Span }
  | { readonly kind: "BindingPattern"; readonly span: Span; readonly name: string }
  | { readonly kind: "LiteralPattern"; readonly span: Span; readonly value: Expression };

export type MatchArm = {
  readonly kind: "MatchArm";
  readonly span: Span;
  /** Alternatives: `1 | 2 | 3 => ...` is represented as three patterns. */
  readonly patterns: readonly Pattern[];
  readonly guard: Expression | null;
  readonly body: Expression;
  readonly leading: readonly Comment[];
};

export type MatchExpression = {
  readonly kind: "MatchExpression";
  readonly span: Span;
  readonly subject: Expression;
  readonly arms: readonly MatchArm[];
};

// ------------------------------------------------------------------ helpers

const STATEMENT_KINDS: ReadonlySet<string> = new Set([
  "LetStatement",
  "FunctionDeclaration",
  "ExpressionStatement",
  "BaaStatement",
  "ReturnStatement",
  "IfStatement",
  "WhileStatement",
  "ForStatement",
  "BreakStatement",
  "ContinueStatement",
  "ImportDeclaration",
  "ThrowStatement",
  "TryStatement",
  "TestDeclaration",
]);

export function isStatement(node: Node): node is Statement {
  return STATEMENT_KINDS.has(node.kind);
}

export function isBlock(node: Expression | Block): node is Block {
  return node.kind === "Block";
}

/** Direct child nodes, in source order. Used by the linter and any walker. */
export function childrenOf(node: Node): Node[] {
  switch (node.kind) {
    case "Program":
      return [...node.body];
    case "Block":
      return [...node.body];
    case "Param":
      return node.defaultValue ? [node.defaultValue] : [];
    case "LetStatement":
      return [node.value];
    case "FunctionDeclaration":
      return [...node.params, node.body];
    case "ExpressionStatement":
      return [node.expression];
    case "BaaStatement":
      return [...node.values];
    case "ReturnStatement":
      return node.value ? [node.value] : [];
    case "IfStatement":
      return [
        node.condition,
        node.consequent,
        ...(node.alternate ? [node.alternate] : []),
      ];
    case "WhileStatement":
      return [node.condition, node.body];
    case "ForStatement":
      return [node.iterable, node.body];
    case "ThrowStatement":
      return [node.value];
    case "TryStatement":
      return [
        node.block,
        ...(node.handler ? [node.handler] : []),
        ...(node.finalizer ? [node.finalizer] : []),
      ];
    case "TestDeclaration":
      return [node.body];
    case "ArrayLiteral":
      return [...node.elements];
    case "MapLiteral":
      return node.entries.flatMap((entry) => [entry.key, entry.value]);
    case "FunctionExpression":
      return [...node.params, node.body];
    case "UnaryExpression":
      return [node.operand];
    case "BinaryExpression":
    case "LogicalExpression":
      return [node.left, node.right];
    case "AssignmentExpression":
      return [node.target, node.value];
    case "CallExpression":
      return [node.callee, ...node.args];
    case "MemberExpression":
      return [node.object];
    case "IndexExpression":
      return [node.object, node.index];
    case "RangeExpression":
      return [node.start, node.end];
    case "MatchExpression":
      return [node.subject, ...node.arms];
    case "MatchArm":
      return [
        ...node.patterns.flatMap((p) => (p.kind === "LiteralPattern" ? [p.value] : [])),
        ...(node.guard ? [node.guard] : []),
        node.body,
      ];
    case "StringLiteral":
      return node.segments.flatMap((s) => (s.kind === "expr" ? [s.expression] : []));
    default:
      return [];
  }
}

/** Depth-first pre-order walk. Return `false` from `visit` to skip children. */
export function walk(node: Node, visit: (node: Node) => boolean | void): void {
  if (visit(node) === false) return;
  for (const child of childrenOf(node)) walk(child, visit);
}
