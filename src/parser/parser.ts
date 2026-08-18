/**
 * The Baa parser.
 *
 * A hand-written recursive-descent parser with a precedence table for binary
 * operators. It produces the AST in `../ast/ast.ts`.
 *
 * Two properties matter more than elegance here:
 *
 *  1. **Spans everywhere.** Every node knows exactly which characters produced
 *     it, because the diagnostic renderer is only as good as its spans.
 *
 *  2. **Recovery.** `parse()` does not stop at the first syntax error. When a
 *     statement fails it records the diagnostic, skips to the next plausible
 *     statement boundary and keeps going, so `baa check` can report a whole
 *     file's worth of problems in one run.
 */

import type {
  ArrayLiteral,
  AssignmentOperator,
  AssignmentTarget,
  BinaryOperator,
  Block,
  Expression,
  IfStatement,
  ImportSpecifier,
  LogicalOperator,
  MapEntry,
  MatchArm,
  Param,
  Pattern,
  Program,
  Statement,
  StringSegment,
  UnaryOperator,
} from "../ast/ast.ts";
import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import { BaaError } from "../diagnostics/diagnostic.ts";
import type { SourceFile, Span } from "../diagnostics/source.ts";
import { joinSpans } from "../diagnostics/source.ts";
import { Lexer } from "../lexer/lexer.ts";
import type { Comment, Token, TokenKind } from "../lexer/token.ts";
import { describeKind, describeToken } from "../lexer/token.ts";

/** Binary precedence. Higher binds tighter. `**` and unary are handled apart. */
const BINARY_PRECEDENCE: Partial<Record<TokenKind, number>> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  in: 5,
  "..": 6,
  "..=": 6,
  "+": 7,
  "-": 7,
  "*": 8,
  "/": 8,
  "%": 8,
};

const STATEMENT_STARTERS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "let",
  "const",
  "fn",
  "return",
  "if",
  "while",
  "for",
  "break",
  "continue",
  "baa",
  "import",
  "export",
  "throw",
  "try",
  "test",
]);

const MAX_RECOVERED_ERRORS = 25;

/** The leading `#!` line, if the file opens with one. Mirrors the lexer. */
function shebangOf(text: string): string | null {
  if (!text.startsWith("#!")) return null;
  const end = text.indexOf("\n");
  return end === -1 ? text : text.slice(0, end).replace(/\r$/, "");
}

/** How deeply expressions and blocks may nest before the parser gives up. */
const MAX_NESTING = 400;

export type ParseResult = {
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
};

export class Parser {
  readonly #file: SourceFile;
  readonly #tokens: readonly Token[];
  #index: number;
  #diagnostics: Diagnostic[];
  #depth: number;

  constructor(file: SourceFile, tokens: readonly Token[]) {
    this.#file = file;
    this.#tokens = tokens;
    this.#index = 0;
    this.#diagnostics = [];
    this.#depth = 0;
  }

  // ---------------------------------------------------------------- cursor

  #peek(offset = 0): Token {
    const index = Math.min(this.#index + offset, this.#tokens.length - 1);
    return this.#tokens[index]!;
  }

  #at(kind: TokenKind): boolean {
    return this.#peek().kind === kind;
  }

  #advance(): Token {
    const token = this.#peek();
    if (this.#index < this.#tokens.length - 1) this.#index++;
    return token;
  }

  #eat(kind: TokenKind): Token | null {
    if (this.#at(kind)) return this.#advance();
    return null;
  }

  #expect(kind: TokenKind, context?: string): Token {
    if (this.#at(kind)) return this.#advance();
    const found = this.#peek();
    if (found.kind === "eof") {
      throw BaaError.of("BAA010", [], {
        span: found.span,
        note: `expected ${describeKind(kind)}`,
        ...(context ? { help: context } : {}),
      });
    }
    const closers: Partial<Record<TokenKind, string>> = {
      ")": "`)`",
      "]": "`]`",
      "}": "`}`",
    };
    const closer = closers[kind];
    if (closer !== undefined) {
      throw BaaError.of("BAA001", [closer], {
        span: found.span,
        note: `expected ${closer} here`,
        ...(context ? { help: context } : {}),
      });
    }
    throw BaaError.of("BAA006", [describeKind(kind), describeToken(found)], {
      span: found.span,
      note: "unexpected",
      ...(context ? { help: context } : {}),
    });
  }

  #skipNewlines(): void {
    while (this.#at("newline") || this.#at(";")) this.#advance();
  }

  // --------------------------------------------------------------- program

  parseProgram(): ParseResult {
    const body: Statement[] = [];
    this.#skipNewlines();
    while (!this.#at("eof")) {
      const before = this.#index;
      try {
        body.push(this.#parseStatement());
      } catch (error) {
        if (!(error instanceof BaaError)) throw error;
        this.#diagnostics.push(error.diagnostic);
        if (this.#diagnostics.length >= MAX_RECOVERED_ERRORS) break;
        this.#synchronize(before);
      }
      this.#skipNewlines();
    }
    const trailingComments = this.#peek().leading;
    const span = this.#file.span(0, this.#file.text.length);
    return {
      program: { kind: "Program", span, body, trailingComments, shebang: shebangOf(this.#file.text) },
      diagnostics: this.#diagnostics,
    };
  }

  /** Skip forward to a plausible statement boundary after a syntax error. */
  #synchronize(failedAt: number): void {
    if (this.#index === failedAt) this.#advance();
    let depth = 0;
    while (!this.#at("eof")) {
      const kind = this.#peek().kind;
      if (kind === "{" || kind === "(" || kind === "[") depth++;
      else if (kind === "}" || kind === ")" || kind === "]") {
        if (depth === 0) {
          this.#advance();
          return;
        }
        depth--;
      } else if (depth === 0 && (kind === "newline" || kind === ";")) {
        return;
      } else if (depth === 0 && STATEMENT_STARTERS.has(kind)) {
        return;
      }
      this.#advance();
    }
  }

  // ------------------------------------------------------------ statements

  #parseStatement(): Statement {
    const token = this.#peek();
    switch (token.kind) {
      case "let":
      case "const":
        return this.#parseLet(false);
      case "fn":
        return this.#parseFunctionDeclaration(false);
      case "export":
        return this.#parseExport();
      case "baa":
        return this.#parseBaa();
      case "return":
        return this.#parseReturn();
      case "if":
        return this.#parseIf();
      case "while":
        return this.#parseWhile();
      case "for":
        return this.#parseFor();
      case "break":
      case "continue":
        return this.#parseLoopJump();
      case "import":
        return this.#parseImport();
      case "throw":
        return this.#parseThrow();
      case "try":
        return this.#parseTry();
      case "test":
        return this.#parseTest();
      default:
        return this.#parseExpressionStatement();
    }
  }

  #trivia(token: Token): {
    leading: readonly Comment[];
    blankLinesBefore: number;
  } {
    return { leading: token.leading, blankLinesBefore: token.blankLinesBefore };
  }

  /** Consume the end of a statement: newline, `;`, `}` or EOF. */
  #endStatement(): Comment | null {
    const trailing = this.#tokens[this.#index - 1]?.trailing ?? null;
    if (this.#at("newline") || this.#at(";")) {
      const token = this.#advance();
      return token.trailing ?? trailing;
    }
    if (this.#at("}") || this.#at("eof")) return trailing;
    const found = this.#peek();
    throw BaaError.of("BAA006", ["the end of the statement", describeToken(found)], {
      span: found.span,
      note: "unexpected",
      help: "Statements in Baa end at the end of the line. Put this on its own line.",
    });
  }

  #parseExport(): Statement {
    const start = this.#advance(); // export
    if (this.#at("fn")) return this.#parseFunctionDeclaration(true, start);
    if (this.#at("let") || this.#at("const")) return this.#parseLet(true, start);
    throw BaaError.of("BAA006", ["`fn`, `let` or `const`", describeToken(this.#peek())], {
      span: this.#peek().span,
      note: "cannot be exported",
      help: "Only functions and bindings can be exported from a Baa module.",
    });
  }

  #parseLet(exported: boolean, exportToken?: Token): Statement {
    const keyword = this.#advance(); // let | const
    const start = exportToken ?? keyword;
    const mutable = keyword.kind === "let";
    const nameToken = this.#expect(
      "ident",
      "Bindings look like `let flock = [\"Dolly\"]`.",
    );
    this.#expect(
      "=",
      mutable
        ? "Every `let` needs a value: `let sheep = 12`."
        : "Every `const` needs a value: `const MAX_SHEEP = 100`.",
    );
    const value = this.#parseExpression();
    const trailing = this.#endStatement();
    return {
      kind: "LetStatement",
      span: joinSpans(start.span, value.span),
      name: nameToken.text,
      nameSpan: nameToken.span,
      value,
      mutable,
      exported,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseFunctionDeclaration(exported: boolean, exportToken?: Token): Statement {
    const keyword = this.#advance(); // fn
    const start = exportToken ?? keyword;
    const nameToken = this.#expect(
      "ident",
      "Functions look like `fn count_sheep(flock) { ... }`.",
    );
    const params = this.#parseParams();
    const body = this.#parseBlock();
    const trailing = this.#endStatement();
    return {
      kind: "FunctionDeclaration",
      span: joinSpans(start.span, body.span),
      name: nameToken.text,
      nameSpan: nameToken.span,
      params,
      body,
      exported,
      doc: docCommentOf(start.leading),
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseParams(): Param[] {
    this.#expect("(", "Function parameters go in parentheses.");
    const params: Param[] = [];
    this.#skipNewlines();
    while (!this.#at(")")) {
      const rest = this.#eat("..") !== null;
      const nameToken = this.#expect("ident", "Parameters are plain names.");
      let defaultValue: Expression | null = null;
      if (this.#eat("=")) defaultValue = this.#parseExpression();
      params.push({
        kind: "Param",
        span: defaultValue
          ? joinSpans(nameToken.span, defaultValue.span)
          : nameToken.span,
        name: nameToken.text,
        defaultValue,
        rest,
      });
      this.#skipNewlines();
      if (!this.#eat(",")) break;
      this.#skipNewlines();
    }
    this.#expect(")");
    return params;
  }

  #parseBlock(): Block {
    // Blocks nest through statements rather than expressions, so they need the
    // same bound: a few thousand nested `if`s overflow the stack just as well.
    if (this.#depth >= MAX_NESTING) {
      throw BaaError.of("BAA011", [String(MAX_NESTING)], {
        span: this.#peek().span,
        note: "nested too deeply",
        help: "Pull the inner blocks out into functions.",
      });
    }
    const open = this.#expect("{", "Blocks are wrapped in `{` and `}`.");
    const body: Statement[] = [];
    this.#depth++;
    try {
      this.#skipNewlines();
      while (!this.#at("}") && !this.#at("eof")) {
        const before = this.#index;
        try {
          body.push(this.#parseStatement());
        } catch (error) {
          if (!(error instanceof BaaError)) throw error;
          if (this.#diagnostics.length >= MAX_RECOVERED_ERRORS) throw error;
          this.#diagnostics.push(error.diagnostic);
          this.#synchronize(before);
        }
        this.#skipNewlines();
      }
    } finally {
      this.#depth--;
    }
    const trailingComments = this.#peek().leading;
    const close = this.#expect("}", "This block is never closed.");
    return {
      kind: "Block",
      span: joinSpans(open.span, close.span),
      body,
      headerComment: open.trailing,
      trailingComments,
    };
  }

  #parseBaa(): Statement {
    const start = this.#advance(); // baa
    const values: Expression[] = [];
    if (!this.#atStatementEnd()) {
      values.push(this.#parseExpression());
      while (this.#eat(",")) {
        this.#skipNewlines();
        values.push(this.#parseExpression());
      }
    }
    const trailing = this.#endStatement();
    const last = values[values.length - 1];
    return {
      kind: "BaaStatement",
      span: last ? joinSpans(start.span, last.span) : start.span,
      values,
      trailing,
      ...this.#trivia(start),
    };
  }

  #atStatementEnd(): boolean {
    return this.#at("newline") || this.#at(";") || this.#at("}") || this.#at("eof");
  }

  #parseReturn(): Statement {
    const start = this.#advance();
    const value = this.#atStatementEnd() ? null : this.#parseExpression();
    const trailing = this.#endStatement();
    return {
      kind: "ReturnStatement",
      span: value ? joinSpans(start.span, value.span) : start.span,
      value,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseIf(): Statement {
    const start = this.#advance(); // if
    const condition = this.#parseExpression();
    const consequent = this.#parseBlock();
    let alternate: Block | IfStatement | null = null;
    // `else` may sit on its own line, so look past newlines, but rewind if it
    // turns out the `if` simply ended.
    const save = this.#index;
    this.#skipNewlines();
    if (this.#at("else")) {
      this.#advance();
      this.#skipNewlines();
      alternate = this.#at("if")
        ? (this.#parseIf() as IfStatement)
        : this.#parseBlock();
    } else {
      this.#index = save;
    }
    // A nested `else if` has already consumed its own statement terminator.
    const trailing = alternate?.kind === "IfStatement" ? null : this.#endStatement();
    return {
      kind: "IfStatement",
      span: joinSpans(start.span, (alternate ?? consequent).span),
      condition,
      consequent,
      alternate,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseWhile(): Statement {
    const start = this.#advance();
    const condition = this.#parseExpression();
    const body = this.#parseBlock();
    const trailing = this.#endStatement();
    return {
      kind: "WhileStatement",
      span: joinSpans(start.span, body.span),
      condition,
      body,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseFor(): Statement {
    const start = this.#advance(); // for
    const nameToken = this.#expect(
      "ident",
      "Loops look like `for sheep in flock { ... }`.",
    );
    let valueName: string | null = null;
    let valueNameSpan: Span | null = null;
    if (this.#eat(",")) {
      const valueToken = this.#expect("ident");
      valueName = valueToken.text;
      valueNameSpan = valueToken.span;
    }
    this.#expect("in", "A `for` loop needs `in`: `for sheep in flock { ... }`.");
    const iterable = this.#parseExpression();
    const body = this.#parseBlock();
    const trailing = this.#endStatement();
    return {
      kind: "ForStatement",
      span: joinSpans(start.span, body.span),
      name: nameToken.text,
      nameSpan: nameToken.span,
      valueName,
      valueNameSpan,
      iterable,
      body,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseLoopJump(): Statement {
    const start = this.#advance();
    const trailing = this.#endStatement();
    return {
      kind: start.kind === "break" ? "BreakStatement" : "ContinueStatement",
      span: start.span,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseImport(): Statement {
    const start = this.#advance(); // import
    const named: ImportSpecifier[] = [];
    if (this.#eat("{")) {
      this.#skipNewlines();
      while (!this.#at("}")) {
        const nameToken = this.#expect("ident");
        let alias = nameToken.text;
        if (this.#eat("as")) alias = this.#expect("ident").text;
        named.push({ name: nameToken.text, alias, span: nameToken.span });
        this.#skipNewlines();
        if (!this.#eat(",")) break;
        this.#skipNewlines();
      }
      this.#expect("}");
      this.#expect("from", "Named imports read `import { trim } from wool`.");
    }

    const sourceToken = this.#peek();
    let source: string;
    let relative: boolean;
    if (sourceToken.kind === "string") {
      const segments = sourceToken.parts ?? [];
      const first = segments[0];
      if (segments.length !== 1 || first === undefined || first.kind !== "text") {
        throw BaaError.of("BAA401", ["<interpolated>"], {
          span: sourceToken.span,
          help: "Module paths must be plain strings, known before the program runs.",
        });
      }
      source = first.value;
      relative = true;
      this.#advance();
    } else {
      const ident = this.#expect(
        "ident",
        "Import a standard module by name (`import wool`) or a file by path (`import \"./flock.baa\"`).",
      );
      source = ident.text;
      relative = false;
    }

    let alias = relative ? defaultAliasForPath(source) : source;
    let aliasSpan = sourceToken.span;
    if (this.#eat("as")) {
      const aliasToken = this.#expect("ident");
      alias = aliasToken.text;
      aliasSpan = aliasToken.span;
    }
    const trailing = this.#endStatement();
    return {
      kind: "ImportDeclaration",
      span: joinSpans(start.span, aliasSpan),
      source,
      sourceSpan: sourceToken.span,
      relative,
      alias,
      aliasSpan,
      named,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseThrow(): Statement {
    const start = this.#advance();
    const value = this.#parseExpression();
    const trailing = this.#endStatement();
    return {
      kind: "ThrowStatement",
      span: joinSpans(start.span, value.span),
      value,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseTry(): Statement {
    const start = this.#advance(); // try
    const block = this.#parseBlock();
    let catchName: string | null = null;
    let catchNameSpan: Span | null = null;
    let handler: Block | null = null;
    let finalizer: Block | null = null;
    let end: Span = block.span;

    // `catch` and `finally` may sit on their own line, so look past newlines:
    // and rewind when they are not there, or the statement terminator is lost.
    let save = this.#index;
    this.#skipNewlines();
    if (this.#at("catch")) {
      this.#advance();
      if (this.#at("ident")) {
        const nameToken = this.#advance();
        catchName = nameToken.text;
        catchNameSpan = nameToken.span;
      }
      handler = this.#parseBlock();
      end = handler.span;
    } else {
      this.#index = save;
    }
    save = this.#index;
    this.#skipNewlines();
    if (this.#at("ident") && this.#peek().text === "finally") {
      this.#advance();
      finalizer = this.#parseBlock();
      end = finalizer.span;
    } else {
      this.#index = save;
    }
    if (handler === null && finalizer === null) {
      throw BaaError.of("BAA006", ["`catch`", describeToken(this.#peek())], {
        span: this.#peek().span,
        help: "A `try` block needs a `catch` block, a `finally` block, or both.",
      });
    }
    const trailing = this.#endStatement();
    return {
      kind: "TryStatement",
      span: joinSpans(start.span, end),
      block,
      catchName,
      catchNameSpan,
      handler,
      finalizer,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseTest(): Statement {
    const start = this.#advance(); // test
    const nameToken = this.#expect(
      "string",
      'Tests look like `test "counts the flock" { ... }`.',
    );
    const parts = nameToken.parts ?? [];
    const first = parts[0];
    const name =
      parts.length === 1 && first !== undefined && first.kind === "text"
        ? first.value
        : nameToken.text;
    const body = this.#parseBlock();
    const trailing = this.#endStatement();
    return {
      kind: "TestDeclaration",
      span: joinSpans(start.span, body.span),
      name,
      nameSpan: nameToken.span,
      body,
      trailing,
      ...this.#trivia(start),
    };
  }

  #parseExpressionStatement(): Statement {
    const start = this.#peek();
    const expression = this.#parseExpression();
    const trailing = this.#endStatement();
    return {
      kind: "ExpressionStatement",
      span: expression.span,
      expression,
      trailing,
      ...this.#trivia(start),
    };
  }

  // ----------------------------------------------------------- expressions

  /** Public entry point used by the REPL to parse a bare expression. */
  parseExpressionEntry(): Expression {
    this.#skipNewlines();
    return this.#parseExpression();
  }

  /**
   * Every nested expression funnels through here, which makes it the one place
   * that has to bound recursion. The parser descends the JavaScript stack once
   * per level, so source nested a few thousand deep would otherwise overflow it
   * and surface as a stack trace from the host language rather than a
   * diagnostic. The limit is far above anything a person writes by hand and far
   * below where the stack actually gives out.
   */
  #parseExpression(): Expression {
    if (this.#depth >= MAX_NESTING) {
      throw BaaError.of("BAA011", [String(MAX_NESTING)], {
        span: this.#peek().span,
        note: "nested too deeply",
        help: "Split this into named parts with `let`.",
      });
    }
    this.#depth++;
    try {
      return this.#parseAssignment();
    } finally {
      this.#depth--;
    }
  }

  #parseAssignment(): Expression {
    const left = this.#parseBinary(0);
    const kind = this.#peek().kind;
    const assignOps: readonly TokenKind[] = ["=", "+=", "-=", "*=", "/=", "%="];
    if (!assignOps.includes(kind)) return left;

    const operatorToken = this.#advance();
    this.#skipNewlines();
    const value = this.#parseAssignment();
    if (
      left.kind !== "Identifier" &&
      left.kind !== "MemberExpression" &&
      left.kind !== "IndexExpression"
    ) {
      throw BaaError.of("BAA008", [], {
        span: left.span,
        note: "cannot be assigned to",
        help: "Assign to a name, a field (`obj.field`) or an element (`arr[0]`).",
      });
    }
    return {
      kind: "AssignmentExpression",
      span: joinSpans(left.span, value.span),
      operator: operatorToken.kind as AssignmentOperator,
      target: left as AssignmentTarget,
      value,
    };
  }

  #parseBinary(minPrecedence: number): Expression {
    let left = this.#parseUnary();
    for (;;) {
      const token = this.#peek();
      const precedence = BINARY_PRECEDENCE[token.kind];
      if (precedence === undefined || precedence < minPrecedence) return left;
      this.#advance();
      this.#skipNewlines();
      const right = this.#parseBinary(precedence + 1);
      const span = joinSpans(left.span, right.span);
      if (token.kind === ".." || token.kind === "..=") {
        left = {
          kind: "RangeExpression",
          span,
          start: left,
          end: right,
          inclusive: token.kind === "..=",
        };
      } else if (token.kind === "&&" || token.kind === "||" || token.kind === "??") {
        left = {
          kind: "LogicalExpression",
          span,
          operator: token.kind as LogicalOperator,
          left,
          right,
        };
      } else {
        left = {
          kind: "BinaryExpression",
          span,
          operator: token.kind as BinaryOperator,
          left,
          right,
          operatorSpan: token.span,
        };
      }
    }
  }

  #parseUnary(): Expression {
    const token = this.#peek();
    if (token.kind === "-" || token.kind === "!") {
      this.#advance();
      const operand = this.#parseUnary();
      return {
        kind: "UnaryExpression",
        span: joinSpans(token.span, operand.span),
        operator: token.kind as UnaryOperator,
        operand,
      };
    }
    return this.#parsePower();
  }

  #parsePower(): Expression {
    const base = this.#parsePostfix();
    if (this.#at("**")) {
      const operatorToken = this.#advance();
      // Right associative, and the right side may be unary: `2 ** -1`.
      const exponent = this.#parseUnary();
      return {
        kind: "BinaryExpression",
        span: joinSpans(base.span, exponent.span),
        operator: "**",
        left: base,
        right: exponent,
        operatorSpan: operatorToken.span,
      };
    }
    return base;
  }

  #parsePostfix(): Expression {
    let expression = this.#parsePrimary();
    for (;;) {
      if (this.#at(".")) {
        this.#advance();
        this.#skipNewlines();
        const nameToken = this.#expect("ident", "Field and method names are plain names.");
        expression = {
          kind: "MemberExpression",
          span: joinSpans(expression.span, nameToken.span),
          object: expression,
          property: nameToken.text,
          propertySpan: nameToken.span,
        };
        continue;
      }
      if (this.#at("(")) {
        const open = this.#advance();
        const args: Expression[] = [];
        this.#skipNewlines();
        while (!this.#at(")")) {
          args.push(this.#parseExpression());
          this.#skipNewlines();
          if (!this.#eat(",")) break;
          this.#skipNewlines();
        }
        const close = this.#expect(")", "This argument list is never closed.");
        expression = {
          kind: "CallExpression",
          span: joinSpans(expression.span, close.span),
          callee: expression,
          args,
          argsSpan: joinSpans(open.span, close.span),
        };
        continue;
      }
      if (this.#at("[")) {
        this.#advance();
        this.#skipNewlines();
        const index = this.#parseExpression();
        this.#skipNewlines();
        const close = this.#expect("]", "This index is never closed.");
        expression = {
          kind: "IndexExpression",
          span: joinSpans(expression.span, close.span),
          object: expression,
          index,
        };
        continue;
      }
      return expression;
    }
  }

  #parsePrimary(): Expression {
    const token = this.#peek();
    switch (token.kind) {
      case "int":
        this.#advance();
        return {
          kind: "IntLiteral",
          span: token.span,
          value: token.value ?? 0,
          raw: token.text,
        };
      case "float":
        this.#advance();
        return {
          kind: "FloatLiteral",
          span: token.span,
          value: token.value ?? 0,
          raw: token.text,
        };
      case "string":
        this.#advance();
        return this.#buildString(token);
      case "true":
      case "false":
        this.#advance();
        return { kind: "BoolLiteral", span: token.span, value: token.kind === "true" };
      case "nil":
        this.#advance();
        return { kind: "NilLiteral", span: token.span };
      case "ident":
        this.#advance();
        return { kind: "Identifier", span: token.span, name: token.text };
      case "(": {
        this.#advance();
        this.#skipNewlines();
        const inner = this.#parseExpression();
        this.#skipNewlines();
        this.#expect(")", "This group is never closed.");
        return inner;
      }
      case "[":
        return this.#parseArray();
      case "{":
        return this.#parseMap();
      case "fn":
        return this.#parseFunctionExpression();
      case "match":
        return this.#parseMatch();
      default:
        throw BaaError.of("BAA006", ["an expression", describeToken(token)], {
          span: token.span,
          note: "expected a value here",
          help:
            token.kind === "newline" || token.kind === "eof"
              ? "The line ends before the expression is finished."
              : undefined,
        });
    }
  }

  #buildString(token: Token): Expression {
    const segments: StringSegment[] = [];
    for (const part of token.parts ?? []) {
      if (part.kind === "text") {
        segments.push({ kind: "text", value: part.value });
        continue;
      }
      const tokens = Lexer.tokenizeRange(
        this.#file,
        part.offset,
        part.offset + part.source.length,
      );
      const sub = new Parser(this.#file, tokens);
      const expression = sub.parseExpressionEntry();
      sub.#skipNewlines();
      if (!sub.#at("eof")) {
        throw BaaError.of("BAA006", ["`}`", describeToken(sub.#peek())], {
          span: sub.#peek().span,
          note: "unexpected inside `{ ... }`",
          help: "An interpolation holds exactly one expression.",
        });
      }
      segments.push({ kind: "expr", expression });
    }
    return { kind: "StringLiteral", span: token.span, segments };
  }

  #parseArray(): ArrayLiteral {
    const open = this.#advance(); // [
    const elements: Expression[] = [];
    this.#skipNewlines();
    while (!this.#at("]")) {
      elements.push(this.#parseExpression());
      this.#skipNewlines();
      if (!this.#eat(",")) break;
      this.#skipNewlines();
    }
    const close = this.#expect("]", "This array is never closed.");
    return {
      kind: "ArrayLiteral",
      span: joinSpans(open.span, close.span),
      elements,
    };
  }

  #parseMap(): Expression {
    const open = this.#advance(); // {
    const entries: MapEntry[] = [];
    this.#skipNewlines();
    while (!this.#at("}")) {
      const keyToken = this.#peek();
      let key: Expression;
      let computed = false;
      if (this.#at("[")) {
        this.#advance();
        key = this.#parseExpression();
        this.#expect("]");
        computed = true;
      } else if (this.#at("string")) {
        this.#advance();
        key = this.#buildString(keyToken);
      } else if (this.#at("ident") || isKeywordToken(keyToken.kind)) {
        this.#advance();
        key = {
          kind: "StringLiteral",
          span: keyToken.span,
          segments: [{ kind: "text", value: keyToken.text }],
        };
      } else {
        throw BaaError.of("BAA006", ["a map key", describeToken(keyToken)], {
          span: keyToken.span,
          help: 'Map keys are names, strings, or `[expression]`.',
        });
      }
      this.#expect(":", "Map entries look like `{ name: value }`.");
      this.#skipNewlines();
      const value = this.#parseExpression();
      entries.push({ key, value, computed, span: joinSpans(keyToken.span, value.span) });
      this.#skipNewlines();
      if (!this.#eat(",")) break;
      this.#skipNewlines();
    }
    const close = this.#expect("}", "This map is never closed.");
    return {
      kind: "MapLiteral",
      span: joinSpans(open.span, close.span),
      entries,
    };
  }

  #parseFunctionExpression(): Expression {
    const keyword = this.#advance(); // fn
    const name = this.#at("ident") ? this.#advance().text : null;
    const params = this.#parseParams();
    const body = this.#parseBlock();
    return {
      kind: "FunctionExpression",
      span: joinSpans(keyword.span, body.span),
      name,
      params,
      body,
    };
  }

  #parseMatch(): Expression {
    const keyword = this.#advance(); // match
    const subject = this.#parseExpression();
    this.#expect("{", "A `match` body is wrapped in `{` and `}`.");
    const arms: MatchArm[] = [];
    this.#skipNewlines();
    while (!this.#at("}") && !this.#at("eof")) {
      const armStart = this.#peek();
      const patterns: Pattern[] = [this.#parsePattern()];
      while (this.#eat("||")) patterns.push(this.#parsePattern());
      const guard = this.#eat("if") ? this.#parseExpression() : null;
      this.#expect("=>", "Match arms look like `pattern => value`.");
      this.#skipNewlines();
      const body = this.#parseExpression();
      arms.push({
        kind: "MatchArm",
        span: joinSpans(armStart.span, body.span),
        patterns,
        guard,
        body,
        leading: armStart.leading,
      });
      this.#skipNewlines();
      if (!this.#eat(",")) break;
      this.#skipNewlines();
    }
    this.#skipNewlines();
    const close = this.#expect("}", "This `match` is never closed.");
    if (arms.length === 0) {
      throw BaaError.of("BAA006", ["at least one match arm", "an empty `match`"], {
        span: joinSpans(keyword.span, close.span),
        help: "A `match` with no arms can never produce a value.",
      });
    }
    return {
      kind: "MatchExpression",
      span: joinSpans(keyword.span, close.span),
      subject,
      arms,
    };
  }

  #parsePattern(): Pattern {
    const token = this.#peek();
    if (token.kind === "ident") {
      this.#advance();
      if (token.text === "_") return { kind: "WildcardPattern", span: token.span };
      return { kind: "BindingPattern", span: token.span, name: token.text };
    }
    const value = this.#parseBinary(4); // literals and simple expressions, no `||`
    return { kind: "LiteralPattern", span: value.span, value };
  }
}

function isKeywordToken(kind: TokenKind): boolean {
  return /^[a-z]+$/.test(kind) && kind !== "ident" && kind !== "newline" && kind !== "eof";
}

function defaultAliasForPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const stem = base.replace(/\.baa$/i, "");
  const cleaned = stem.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || "module";
}

/** Extract `///` doc comment text from a statement's leading trivia. */
function docCommentOf(comments: readonly Comment[]): string | null {
  const lines = comments
    .filter((c) => !c.block && c.text.startsWith("///"))
    .map((c) => c.text.slice(3).trim());
  return lines.length > 0 ? lines.join("\n") : null;
}

export function parse(file: SourceFile): ParseResult {
  const tokens = Lexer.tokenize(file);
  return new Parser(file, tokens).parseProgram();
}
