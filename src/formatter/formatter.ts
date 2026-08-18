/**
 * The official Baa formatter.
 *
 * `baa fmt` is deterministic: formatting an already-formatted file must return
 * the identical bytes. The implementation is a plain AST printer with one
 * decision point: a collection or argument list is printed on one line when it
 * fits inside the line width, and one-item-per-line when it does not. There is
 * no heuristic that depends on the original layout, so the output for a given
 * AST is always the same.
 *
 * Comments are preserved because the lexer attaches them to tokens and the
 * parser carries them onto statements: own-line comments print above their
 * statement, same-line comments print after it.
 */

import type {
  Block,
  Expression,
  MapEntry,
  MatchArm,
  Param,
  Pattern,
  Program,
  Statement,
} from "../ast/ast.ts";
import type { Comment } from "../lexer/token.ts";

export type FormatOptions = {
  /** Spaces per indent level. Default 4. */
  indent?: number;
  /** Soft maximum line width. Default 90. */
  lineWidth?: number;
};

type Config = {
  readonly indent: number;
  readonly lineWidth: number;
};

export function formatProgram(program: Program, options: FormatOptions = {}): string {
  const config: Config = {
    indent: options.indent ?? 4,
    lineWidth: options.lineWidth ?? 90,
  };
  const printer = new Printer(config);
  printer.printStatements(program.body, 0, true);
  printer.printTrailingComments(program.trailingComments, 0);
  return printer.finish();
}

class Printer {
  readonly #config: Config;
  readonly #lines: string[] = [];

  constructor(config: Config) {
    this.#config = config;
  }

  finish(): string {
    // Exactly one trailing newline, no trailing blank lines.
    while (this.#lines.length > 0 && this.#lines[this.#lines.length - 1] === "") {
      this.#lines.pop();
    }
    return this.#lines.length === 0 ? "" : `${this.#lines.join("\n")}\n`;
  }

  #pad(depth: number): string {
    return " ".repeat(depth * this.#config.indent);
  }

  #push(depth: number, text: string): void {
    this.#lines.push(text.length === 0 ? "" : `${this.#pad(depth)}${text}`);
  }

  printTrailingComments(comments: readonly Comment[], depth: number): void {
    for (const comment of comments) {
      if (comment.blankLinesBefore > 0) this.#lines.push("");
      for (const line of normaliseComment(comment)) this.#push(depth, line);
    }
  }

  printStatements(statements: readonly Statement[], depth: number, _isTop: boolean): void {
    statements.forEach((statement, index) => {
      const first = statement.leading[0];
      // One blank line at most, before the statement *and its comments*.
      if (index > 0) {
        const gap = first === undefined ? statement.blankLinesBefore : first.blankLinesBefore;
        if (gap > 0) this.#lines.push("");
      }
      statement.leading.forEach((comment, commentIndex) => {
        if (commentIndex > 0 && comment.blankLinesBefore > 0) this.#lines.push("");
        for (const line of normaliseComment(comment)) this.#push(depth, line);
      });
      // A blank line between a comment block and the statement it precedes is
      // meaningful: it marks a file header rather than a doc comment.
      if (first !== undefined && statement.blankLinesBefore > 0) this.#lines.push("");
      this.#printStatement(statement, depth);
    });
  }

  #printStatement(statement: Statement, depth: number): void {
    const trailing = statement.trailing ? `  ${statement.trailing.text.trimEnd()}` : "";
    switch (statement.kind) {
      case "LetStatement": {
        const keyword = statement.mutable ? "let" : "const";
        const prefix = statement.exported ? "export " : "";
        this.#push(
          depth,
          `${prefix}${keyword} ${statement.name} = ${this.#expression(statement.value, depth)}${trailing}`,
        );
        return;
      }
      case "FunctionDeclaration": {
        const prefix = statement.exported ? "export " : "";
        this.#push(
          depth,
          `${prefix}fn ${statement.name}(${this.#params(statement.params, depth)}) {`,
        );
        this.#printBlockBody(statement.body, depth + 1);
        this.#push(depth, `}${trailing}`);
        return;
      }
      case "ExpressionStatement":
        this.#push(depth, `${this.#expression(statement.expression, depth)}${trailing}`);
        return;
      case "BaaStatement": {
        const values = statement.values.map((value) => this.#expression(value, depth));
        this.#push(
          depth,
          values.length === 0 ? `baa${trailing}` : `baa ${values.join(", ")}${trailing}`,
        );
        return;
      }
      case "ReturnStatement":
        this.#push(
          depth,
          statement.value === null
            ? `return${trailing}`
            : `return ${this.#expression(statement.value, depth)}${trailing}`,
        );
        return;
      case "IfStatement":
        this.#printIf(statement, depth, trailing);
        return;
      case "WhileStatement":
        this.#push(depth, `while ${this.#expression(statement.condition, depth)} {`);
        this.#printBlockBody(statement.body, depth + 1);
        this.#push(depth, `}${trailing}`);
        return;
      case "ForStatement": {
        const names =
          statement.valueName === null
            ? statement.name
            : `${statement.name}, ${statement.valueName}`;
        this.#push(
          depth,
          `for ${names} in ${this.#expression(statement.iterable, depth)} {`,
        );
        this.#printBlockBody(statement.body, depth + 1);
        this.#push(depth, `}${trailing}`);
        return;
      }
      case "BreakStatement":
        this.#push(depth, `break${trailing}`);
        return;
      case "ContinueStatement":
        this.#push(depth, `continue${trailing}`);
        return;
      case "ImportDeclaration": {
        const source = statement.relative ? JSON.stringify(statement.source) : statement.source;
        const defaultAlias = statement.relative
          ? defaultAliasFor(statement.source)
          : statement.source;
        const alias = statement.alias === defaultAlias ? "" : ` as ${statement.alias}`;
        if (statement.named.length === 0) {
          this.#push(depth, `import ${source}${alias}${trailing}`);
          return;
        }
        const names = statement.named
          .map((specifier) =>
            specifier.alias === specifier.name
              ? specifier.name
              : `${specifier.name} as ${specifier.alias}`,
          )
          .join(", ");
        this.#push(depth, `import { ${names} } from ${source}${trailing}`);
        return;
      }
      case "ThrowStatement":
        this.#push(depth, `throw ${this.#expression(statement.value, depth)}${trailing}`);
        return;
      case "TryStatement": {
        this.#push(depth, "try {");
        this.#printBlockBody(statement.block, depth + 1);
        if (statement.handler !== null) {
          const binding = statement.catchName === null ? "" : ` ${statement.catchName}`;
          this.#push(depth, `} catch${binding} {`);
          this.#printBlockBody(statement.handler, depth + 1);
        }
        if (statement.finalizer !== null) {
          this.#push(depth, "} finally {");
          this.#printBlockBody(statement.finalizer, depth + 1);
        }
        this.#push(depth, `}${trailing}`);
        return;
      }
      case "TestDeclaration":
        this.#push(depth, `test ${quote(statement.name)} {`);
        this.#printBlockBody(statement.body, depth + 1);
        this.#push(depth, `}${trailing}`);
        return;
      default: {
        const never: never = statement;
        throw new Error(`unhandled statement ${JSON.stringify(never)}`);
      }
    }
  }

  #printIf(
    statement: Extract<Statement, { kind: "IfStatement" }>,
    depth: number,
    trailing: string,
  ): void {
    this.#push(depth, `if ${this.#expression(statement.condition, depth)} {`);
    this.#printBlockBody(statement.consequent, depth + 1);
    let alternate = statement.alternate;
    while (alternate !== null && alternate.kind === "IfStatement") {
      this.#push(depth, `} else if ${this.#expression(alternate.condition, depth)} {`);
      this.#printBlockBody(alternate.consequent, depth + 1);
      alternate = alternate.alternate;
    }
    if (alternate !== null) {
      this.#push(depth, "} else {");
      this.#printBlockBody(alternate, depth + 1);
    }
    this.#push(depth, `}${trailing}`);
  }

  #printBlockBody(block: Block, depth: number): void {
    this.#appendHeaderComment(block);
    this.printStatements(block.body, depth, false);
    this.printTrailingComments(block.trailingComments, depth);
  }

  /** Re-attach a comment that sat on the same line as the opening `{`. */
  #appendHeaderComment(block: Block): void {
    if (block.headerComment === null) return;
    const index = this.#lines.length - 1;
    const last = this.#lines[index];
    if (last === undefined) return;
    this.#lines[index] = `${last}  ${block.headerComment.text.trimEnd()}`;
  }

  #params(params: readonly Param[], depth: number): string {
    return params
      .map((param) => {
        const rest = param.rest ? ".." : "";
        const fallback =
          param.defaultValue === null ? "" : ` = ${this.#expression(param.defaultValue, depth)}`;
        return `${rest}${param.name}${fallback}`;
      })
      .join(", ");
  }

  // --------------------------------------------------------------- expressions

  #expression(expression: Expression, depth: number, parentPrecedence = 0): string {
    switch (expression.kind) {
      case "IntLiteral":
      case "FloatLiteral":
        return expression.raw;
      case "BoolLiteral":
        return expression.value ? "true" : "false";
      case "NilLiteral":
        return "nil";
      case "StringLiteral": {
        let out = '"';
        for (const segment of expression.segments) {
          out +=
            segment.kind === "text"
              ? escapeText(segment.value)
              : `{${this.#expression(segment.expression, depth)}}`;
        }
        return `${out}"`;
      }
      case "Identifier":
        return expression.name;
      case "ArrayLiteral": {
        const parts = expression.elements.map((element) => this.#expression(element, depth + 1));
        return this.#group("[", parts, "]", depth);
      }
      case "MapLiteral": {
        const parts = expression.entries.map((entry) => this.#mapEntry(entry, depth + 1));
        if (parts.length === 0) return "{}";
        const inline = `{ ${parts.join(", ")} }`;
        if (this.#fits(inline, depth)) return inline;
        const pad = this.#pad(depth + 1);
        return `{\n${parts.map((part) => `${pad}${part},`).join("\n")}\n${this.#pad(depth)}}`;
      }
      case "FunctionExpression": {
        const name = expression.name === null ? "" : ` ${expression.name}`;
        const header = `fn${name}(${this.#params(expression.params, depth)}) {`;
        // A one-statement callback stays on one line when it fits, because
        // `items.map(fn(n) { return n * 2 })` is the shape people write most.
        const single = this.#singleLineBody(expression.body, depth);
        if (single !== null) {
          const oneLine = `${header} ${single} }`;
          if (this.#fits(oneLine, depth)) return oneLine;
        }
        const note =
          expression.body.headerComment === null
            ? ""
            : `  ${expression.body.headerComment.text.trimEnd()}`;
        const body = this.#inlineBlock(expression.body, depth);
        return `${header}${note}${body}${this.#pad(depth)}}`;
      }
      case "UnaryExpression": {
        // `**` binds tighter than unary minus, so the operand is printed at
        // that level: `-2 ** 2` needs no parentheses and means `-(2 ** 2)`.
        const text = `${expression.operator}${this.#expression(expression.operand, depth, POWER)}`;
        return parentPrecedence > UNARY ? `(${text})` : text;
      }
      case "BinaryExpression": {
        if (expression.operator === "**") {
          // Right-associative: the left side must bind tighter, the right side
          // may be another `**`.
          const left = this.#expression(expression.left, depth, POWER + 1);
          const right = this.#expression(expression.right, depth, POWER);
          const text = `${left} ** ${right}`;
          return parentPrecedence > POWER ? `(${text})` : text;
        }
        const precedence = binaryPrecedence(expression.operator);
        const text = `${this.#expression(expression.left, depth, precedence)} ${expression.operator} ${this.#expression(expression.right, depth, precedence + 1)}`;
        return parentPrecedence > precedence ? `(${text})` : text;
      }
      case "LogicalExpression": {
        const precedence = logicalPrecedence(expression.operator);
        const text = `${this.#expression(expression.left, depth, precedence)} ${expression.operator} ${this.#expression(expression.right, depth, precedence + 1)}`;
        return parentPrecedence > precedence ? `(${text})` : text;
      }
      case "RangeExpression": {
        const operator = expression.inclusive ? "..=" : "..";
        const text = `${this.#expression(expression.start, depth, 6)}${operator}${this.#expression(expression.end, depth, 7)}`;
        return parentPrecedence > 6 ? `(${text})` : text;
      }
      case "AssignmentExpression":
        return `${this.#expression(expression.target, depth)} ${expression.operator} ${this.#expression(expression.value, depth)}`;
      case "CallExpression": {
        const callee = this.#expression(expression.callee, depth, 13);
        if (expression.args.length === 0) return `${callee}()`;
        const parts = expression.args.map((argument) => this.#expression(argument, depth + 1));
        const inline = `${callee}(${parts.join(", ")})`;
        if (!inline.includes("\n") && this.#fits(inline, depth)) return inline;
        // A single collection or callback argument "hugs" the parentheses
        // instead of gaining a level of indentation of its own.
        const only = expression.args.length === 1 ? expression.args[0]! : null;
        if (
          only !== null &&
          (only.kind === "ArrayLiteral" ||
            only.kind === "MapLiteral" ||
            only.kind === "FunctionExpression" ||
            only.kind === "MatchExpression")
        ) {
          return `${callee}(${this.#expression(only, depth)})`;
        }
        return `${callee}${this.#group("(", parts, ")", depth)}`;
      }
      case "MemberExpression":
        return `${this.#expression(expression.object, depth, 13)}.${expression.property}`;
      case "IndexExpression":
        return `${this.#expression(expression.object, depth, 13)}[${this.#expression(expression.index, depth)}]`;
      case "MatchExpression": {
        const arms = expression.arms.map((arm) => this.#matchArm(arm, depth + 1));
        const pad = this.#pad(depth + 1);
        return `match ${this.#expression(expression.subject, depth)} {\n${arms
          .map((arm) => `${pad}${arm},`)
          .join("\n")}\n${this.#pad(depth)}}`;
      }
      default: {
        const never: never = expression;
        throw new Error(`unhandled expression ${JSON.stringify(never)}`);
      }
    }
  }

  #matchArm(arm: MatchArm, depth: number): string {
    const patterns = arm.patterns.map((pattern) => this.#pattern(pattern, depth)).join(" || ");
    const guard = arm.guard === null ? "" : ` if ${this.#expression(arm.guard, depth)}`;
    return `${patterns}${guard} => ${this.#expression(arm.body, depth)}`;
  }

  #pattern(pattern: Pattern, depth: number): string {
    switch (pattern.kind) {
      case "WildcardPattern":
        return "_";
      case "BindingPattern":
        return pattern.name;
      default:
        return this.#expression(pattern.value, depth);
    }
  }

  #mapEntry(entry: MapEntry, depth: number): string {
    const value = this.#expression(entry.value, depth);
    if (entry.computed) return `[${this.#expression(entry.key, depth)}]: ${value}`;
    if (
      entry.key.kind === "StringLiteral" &&
      entry.key.segments.length === 1 &&
      entry.key.segments[0]!.kind === "text"
    ) {
      const text = entry.key.segments[0]!.value;
      return `${isPlainIdentifier(text) ? text : quote(text)}: ${value}`;
    }
    return `${this.#expression(entry.key, depth)}: ${value}`;
  }

  /**
   * Render a block as a single statement, or `null` when it cannot be one.
   * Anything carrying a comment is refused so no comment is ever lost.
   */
  #singleLineBody(block: Block, depth: number): string | null {
    if (block.body.length !== 1 || block.trailingComments.length > 0) return null;
    if (block.headerComment !== null) return null;
    const statement = block.body[0]!;
    if (statement.leading.length > 0 || statement.trailing !== null) return null;
    switch (statement.kind) {
      case "ReturnStatement":
        return statement.value === null
          ? "return"
          : `return ${this.#expression(statement.value, depth)}`;
      case "ExpressionStatement":
        return this.#expression(statement.expression, depth);
      case "BaaStatement":
        return statement.values.length === 0
          ? "baa"
          : `baa ${statement.values.map((value) => this.#expression(value, depth)).join(", ")}`;
      default:
        return null;
    }
  }

  #inlineBlock(block: Block, depth: number): string {
    const empty = block.body.length === 0 && block.trailingComments.length === 0;
    if (empty && block.headerComment === null) return " ";
    if (empty) return "\n";
    const inner = new Printer(this.#config);
    inner.printStatements(block.body, depth + 1, false);
    inner.printTrailingComments(block.trailingComments, depth + 1);
    return `\n${inner.finish()}`;
  }

  #group(open: string, parts: readonly string[], close: string, depth: number): string {
    if (parts.length === 0) return `${open}${close}`;
    const inline = `${open}${parts.join(", ")}${close}`;
    if (this.#fits(inline, depth) && !inline.includes("\n")) return inline;
    const pad = this.#pad(depth + 1);
    return `${open}\n${parts.map((part) => `${pad}${part},`).join("\n")}\n${this.#pad(depth)}${close}`;
  }

  #fits(text: string, depth: number): boolean {
    return depth * this.#config.indent + text.length <= this.#config.lineWidth;
  }
}

// --------------------------------------------------------------------------

/** Mirrors the parser: unary binds looser than `**`, tighter than `*`. */
const UNARY = 10;
const POWER = 11;

function binaryPrecedence(operator: string): number {
  switch (operator) {
    case "==":
    case "!=":
      return 4;
    case "<":
    case "<=":
    case ">":
    case ">=":
    case "in":
      return 5;
    case "+":
    case "-":
      return 7;
    case "*":
    case "/":
    case "%":
      return 8;
    default:
      return 11;
  }
}

function logicalPrecedence(operator: string): number {
  switch (operator) {
    case "??":
      return 1;
    case "||":
      return 2;
    default:
      return 3;
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainIdentifier(text: string): boolean {
  return IDENTIFIER.test(text);
}

function escapeText(text: string): string {
  let out = "";
  for (const ch of text) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "{":
        out += "\\{";
        break;
      case "}":
        out += "\\}";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function quote(text: string): string {
  return `"${escapeText(text)}"`;
}

/** Trim trailing whitespace and split block comments into lines. */
function normaliseComment(comment: Comment): string[] {
  return comment.text.split("\n").map((line, index) => (index === 0 ? line.trimEnd() : line.trim()));
}

function defaultAliasFor(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const stem = base.replace(/\.baa$/i, "");
  const cleaned = stem.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || "module";
}
