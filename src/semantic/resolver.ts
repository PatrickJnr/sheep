/**
 * Semantic analysis.
 *
 * Walks the AST once and answers the questions that do not need the program to
 * run: does every name exist, is anything declared twice, is a constant
 * reassigned, is `return` inside a function, does a direct call to a known
 * function pass the right number of arguments.
 *
 * The resolver collects diagnostics instead of throwing, so `baa check` reports
 * everything it can find in one pass. It also records which symbols were read
 * and written, which is exactly the information the linter needs for its unused
 * and never-reassigned warnings: computing it here means the scope rules live
 * in one place.
 */

import type {
  Block,
  Expression,
  FunctionDeclaration,
  MatchArm,
  Param,
  Program,
  Statement,
} from "../ast/ast.ts";
import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import { createDiagnostic, suggest } from "../diagnostics/diagnostic.ts";
import type { SourceFile, Span } from "../diagnostics/source.ts";
import { STDLIB_MODULES } from "../stdlib/index.ts";
import { PRELUDE_NAMES } from "../stdlib/prelude.ts";

export type SymbolKind =
  | "let"
  | "const"
  | "fn"
  | "param"
  | "import"
  | "loop"
  | "catch"
  | "match";

export type SymbolInfo = {
  readonly name: string;
  readonly span: Span;
  readonly kind: SymbolKind;
  readonly mutable: boolean;
  readonly exported: boolean;
  /** Declared parameter list, for arity checking of direct calls. */
  readonly params: readonly Param[] | null;
  reads: number;
  writes: number;
};

export type ResolveResult = {
  readonly diagnostics: readonly Diagnostic[];
  /** Symbols that were declared but never read, in declaration order. */
  readonly unused: readonly SymbolInfo[];
  /** `let` bindings that were never reassigned. */
  readonly neverReassigned: readonly SymbolInfo[];
};

export type ResolveOptions = {
  /** Extra importable module names, e.g. dependencies from `baa.toml`. */
  readonly modules?: readonly string[];
};

type Scope = {
  readonly declared: Map<string, SymbolInfo>;
  /** Names declared later in this scope, used to detect use-before-declare. */
  readonly pending: Map<string, Span>;
  readonly isFunctionBoundary: boolean;
};

class Resolver {
  readonly #file: SourceFile;
  readonly #modules: readonly string[];
  readonly #diagnostics: Diagnostic[] = [];
  readonly #scopes: Scope[] = [];
  readonly #allSymbols: SymbolInfo[] = [];
  #functionDepth = 0;
  #loopDepth = 0;

  constructor(file: SourceFile, options: ResolveOptions = {}) {
    this.#file = file;
    this.#modules = [...STDLIB_MODULES, ...(options.modules ?? [])];
  }

  resolve(program: Program): ResolveResult {
    this.#pushScope(true);
    this.#resolveStatements(program.body);
    this.#popScope();
    const unused = this.#allSymbols.filter(
      (symbol) => symbol.reads === 0 && !symbol.exported && !symbol.name.startsWith("_"),
    );
    const neverReassigned = this.#allSymbols.filter(
      (symbol) => symbol.kind === "let" && symbol.writes === 0 && !symbol.name.startsWith("_"),
    );
    return { diagnostics: this.#diagnostics, unused, neverReassigned };
  }

  // ------------------------------------------------------------------ scopes

  #pushScope(isFunctionBoundary = false): void {
    this.#scopes.push({
      declared: new Map(),
      pending: new Map(),
      isFunctionBoundary,
    });
  }

  #popScope(): void {
    this.#scopes.pop();
  }

  get #scope(): Scope {
    return this.#scopes[this.#scopes.length - 1]!;
  }

  #report(
    code: Parameters<typeof createDiagnostic>[0],
    args: readonly string[],
    options: Parameters<typeof createDiagnostic>[2],
  ): void {
    this.#diagnostics.push(createDiagnostic(code, args, options));
  }

  #declare(
    name: string,
    span: Span,
    kind: SymbolKind,
    options: { mutable?: boolean; exported?: boolean; params?: readonly Param[] | null } = {},
  ): SymbolInfo {
    const scope = this.#scope;
    const existing = scope.declared.get(name);
    if (existing !== undefined) {
      this.#report("BAA101", [name], {
        span,
        note: "declared again here",
        secondary: [{ span: existing.span, note: "first declared here" }],
        help: `Rename this one, or assign to the existing \`${name}\`.`,
      });
    }
    const symbol: SymbolInfo = {
      name,
      span,
      kind,
      mutable: options.mutable ?? true,
      exported: options.exported ?? false,
      params: options.params ?? null,
      reads: 0,
      writes: 0,
    };
    scope.declared.set(name, symbol);
    scope.pending.delete(name);
    this.#allSymbols.push(symbol);
    return symbol;
  }

  #lookup(name: string): SymbolInfo | null {
    for (let i = this.#scopes.length - 1; i >= 0; i--) {
      const symbol = this.#scopes[i]!.declared.get(name);
      if (symbol !== undefined) return symbol;
    }
    return null;
  }

  #pendingSpan(name: string): Span | null {
    for (let i = this.#scopes.length - 1; i >= 0; i--) {
      const span = this.#scopes[i]!.pending.get(name);
      if (span !== undefined) return span;
    }
    return null;
  }

  #visibleNames(): string[] {
    const names = new Set<string>(PRELUDE_NAMES);
    for (const scope of this.#scopes) {
      for (const name of scope.declared.keys()) names.add(name);
    }
    return [...names];
  }

  #reference(name: string, span: Span): SymbolInfo | null {
    const symbol = this.#lookup(name);
    if (symbol !== null) {
      symbol.reads++;
      return symbol;
    }
    if (PRELUDE_NAMES.includes(name)) return null;

    const pending = this.#pendingSpan(name);
    if (pending !== null) {
      this.#report("BAA106", [name], {
        span,
        note: "used here",
        secondary: [{ span: pending, note: "declared later" }],
        help: "Move the declaration above this line.",
      });
      return null;
    }
    const hint = suggest(name, this.#visibleNames());
    this.#report("BAA102", [name], {
      span,
      note: "not found in this pasture",
      ...(hint ? { help: `Did you mean \`${hint}\`?` } : {}),
    });
    return null;
  }

  // -------------------------------------------------------------- statements

  #resolveStatements(statements: readonly Statement[]): void {
    const scope = this.#scope;
    // Hoist function declarations so mutual recursion resolves, and record the
    // remaining declarations as pending so use-before-declare is detected.
    for (const statement of statements) {
      if (statement.kind === "FunctionDeclaration") {
        this.#declare(statement.name, statement.nameSpan, "fn", {
          mutable: false,
          exported: statement.exported,
          params: statement.params,
        });
      } else if (statement.kind === "LetStatement") {
        if (!scope.declared.has(statement.name)) {
          scope.pending.set(statement.name, statement.nameSpan);
        }
      }
    }
    for (const statement of statements) this.#resolveStatement(statement);
  }

  #resolveStatement(statement: Statement): void {
    switch (statement.kind) {
      case "LetStatement":
        this.#resolveExpression(statement.value);
        this.#declare(statement.name, statement.nameSpan, statement.mutable ? "let" : "const", {
          mutable: statement.mutable,
          exported: statement.exported,
        });
        return;
      case "FunctionDeclaration":
        this.#resolveFunction(statement.params, statement.body, statement.name);
        return;
      case "ExpressionStatement":
        this.#resolveExpression(statement.expression);
        return;
      case "BaaStatement":
        for (const value of statement.values) this.#resolveExpression(value);
        return;
      case "ReturnStatement":
        if (this.#functionDepth === 0) {
          this.#report("BAA104", [], {
            span: statement.span,
            note: "not inside a function",
            help: "Use `baa value` to print at the top level.",
          });
        }
        if (statement.value !== null) this.#resolveExpression(statement.value);
        return;
      case "IfStatement":
        this.#resolveExpression(statement.condition);
        this.#resolveBlock(statement.consequent);
        if (statement.alternate === null) return;
        if (statement.alternate.kind === "Block") this.#resolveBlock(statement.alternate);
        else this.#resolveStatement(statement.alternate);
        return;
      case "WhileStatement":
        this.#resolveExpression(statement.condition);
        this.#loopDepth++;
        this.#resolveBlock(statement.body);
        this.#loopDepth--;
        return;
      case "ForStatement": {
        this.#resolveExpression(statement.iterable);
        this.#pushScope();
        this.#declare(statement.name, statement.nameSpan, "loop");
        if (statement.valueName !== null && statement.valueNameSpan !== null) {
          this.#declare(statement.valueName, statement.valueNameSpan, "loop");
        }
        this.#loopDepth++;
        this.#resolveStatements(statement.body.body);
        this.#loopDepth--;
        this.#popScope();
        return;
      }
      case "BreakStatement":
      case "ContinueStatement":
        if (this.#loopDepth === 0) {
          this.#report("BAA105", [statement.kind === "BreakStatement" ? "break" : "continue"], {
            span: statement.span,
            note: "not inside a loop",
          });
        }
        return;
      case "ImportDeclaration": {
        if (!statement.relative && !this.#modules.includes(statement.source)) {
          const hint = suggest(statement.source, this.#modules);
          this.#report("BAA401", [statement.source], {
            span: statement.sourceSpan,
            note: "unknown module",
            help: hint
              ? `Did you mean \`${hint}\`?`
              : `Standard modules: ${STDLIB_MODULES.join(", ")}. Add a local dependency with \`baa add\`.`,
          });
        }
        if (statement.named.length === 0) {
          this.#declare(statement.alias, statement.aliasSpan, "import", { mutable: false });
        } else {
          for (const specifier of statement.named) {
            this.#declare(specifier.alias, specifier.span, "import", { mutable: false });
          }
        }
        return;
      }
      case "ThrowStatement":
        this.#resolveExpression(statement.value);
        return;
      case "TryStatement": {
        this.#resolveBlock(statement.block);
        if (statement.handler !== null) {
          this.#pushScope();
          if (statement.catchName !== null && statement.catchNameSpan !== null) {
            this.#declare(statement.catchName, statement.catchNameSpan, "catch", {
              mutable: false,
            });
          }
          this.#resolveStatements(statement.handler.body);
          this.#popScope();
        }
        if (statement.finalizer !== null) this.#resolveBlock(statement.finalizer);
        return;
      }
      case "TestDeclaration":
        this.#resolveBlock(statement.body);
        return;
      default: {
        const never: never = statement;
        throw new Error(`unhandled statement ${JSON.stringify(never)}`);
      }
    }
  }

  #resolveBlock(block: Block): void {
    this.#pushScope();
    this.#resolveStatements(block.body);
    this.#popScope();
  }

  #resolveFunction(
    params: readonly Param[],
    body: Block,
    name: string,
  ): void {
    this.#pushScope(true);
    this.#checkParamOrder(params, name);
    const seen = new Set<string>();
    for (const param of params) {
      if (param.defaultValue !== null) this.#resolveExpression(param.defaultValue);
      if (seen.has(param.name)) {
        // Report once as BAA203; re-declaring would add a redundant BAA101.
        this.#report("BAA203", [param.name], {
          span: param.span,
          note: "used twice",
          help: `Give the second one a different name in \`${name}\`.`,
        });
        continue;
      }
      seen.add(param.name);
      this.#declare(param.name, param.span, "param");
    }
    this.#functionDepth++;
    const savedLoopDepth = this.#loopDepth;
    this.#loopDepth = 0;
    this.#resolveStatements(body.body);
    this.#loopDepth = savedLoopDepth;
    this.#functionDepth--;
    this.#popScope();
  }

  /**
   * A parameter list has to be one a caller can actually satisfy.
   *
   * Arguments bind by position, so a required parameter sitting behind an
   * optional one can never be reached: `fn f(a = 1, b)` called as `f(9)` binds
   * `a` and silently leaves `b` as nil. The same goes for anything after a rest
   * parameter, which has already swallowed every remaining argument. Each of
   * these used to be accepted and then quietly misbehave at every call site.
   */
  #checkParamOrder(params: readonly Param[], name: string): void {
    let optional: Param | null = null;
    let rest: Param | null = null;
    for (const param of params) {
      if (rest !== null) {
        this.#report("BAA204", [`\`${param.name}\` comes after the rest parameter \`..${rest.name}\``], {
          span: param.span,
          note: "unreachable parameter",
          secondary: [{ span: rest.span, note: "takes every remaining argument" }],
          help: `Move \`${param.name}\` before \`..${rest.name}\` in \`${name}\`.`,
        });
        continue;
      }
      if (param.rest) {
        if (param.defaultValue !== null) {
          this.#report("BAA204", [`the rest parameter \`..${param.name}\` cannot have a default`], {
            span: param.span,
            note: "default never applies",
            help: "A rest parameter is an empty array when nothing is left over.",
          });
        }
        rest = param;
        continue;
      }
      if (param.defaultValue !== null) {
        optional = param;
        continue;
      }
      if (optional !== null) {
        this.#report("BAA204", [`\`${param.name}\` is required but comes after optional \`${optional.name}\``], {
          span: param.span,
          note: "can never be reached",
          secondary: [{ span: optional.span, note: "optional from here on" }],
          help: `Move \`${param.name}\` before \`${optional.name}\`, or give it a default too.`,
        });
      }
    }
  }

  // ------------------------------------------------------------- expressions

  #resolveExpression(expression: Expression): void {
    switch (expression.kind) {
      case "IntLiteral":
      case "FloatLiteral":
      case "BoolLiteral":
      case "NilLiteral":
        return;
      case "StringLiteral":
        for (const segment of expression.segments) {
          if (segment.kind === "expr") this.#resolveExpression(segment.expression);
        }
        return;
      case "Identifier":
        this.#reference(expression.name, expression.span);
        return;
      case "ArrayLiteral":
        for (const element of expression.elements) this.#resolveExpression(element);
        return;
      case "MapLiteral":
        for (const entry of expression.entries) {
          if (entry.computed) this.#resolveExpression(entry.key);
          this.#resolveExpression(entry.value);
        }
        return;
      case "FunctionExpression":
        this.#resolveFunction(expression.params, expression.body, expression.name ?? "this function");
        return;
      case "UnaryExpression":
        this.#resolveExpression(expression.operand);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        this.#resolveExpression(expression.left);
        this.#resolveExpression(expression.right);
        return;
      case "RangeExpression":
        this.#resolveExpression(expression.start);
        this.#resolveExpression(expression.end);
        return;
      case "AssignmentExpression": {
        this.#resolveExpression(expression.value);
        const target = expression.target;
        if (target.kind === "Identifier") {
          const symbol = this.#lookup(target.name);
          if (symbol === null) {
            this.#reference(target.name, target.span);
            return;
          }
          if (expression.operator !== "=") symbol.reads++;
          symbol.writes++;
          if (!symbol.mutable) {
            this.#report("BAA103", [target.name], {
              span: target.span,
              note: "this binding is immutable",
              secondary: [{ span: symbol.span, note: "declared here" }],
              help:
                symbol.kind === "const"
                  ? `Declare it with \`let ${target.name}\` if it needs to change.`
                  : "Functions and imports cannot be reassigned.",
            });
          }
          return;
        }
        this.#resolveExpression(target);
        return;
      }
      case "CallExpression":
        this.#resolveCall(expression);
        return;
      case "MemberExpression":
        this.#resolveExpression(expression.object);
        return;
      case "IndexExpression":
        this.#resolveExpression(expression.object);
        this.#resolveExpression(expression.index);
        return;
      case "MatchExpression":
        this.#resolveExpression(expression.subject);
        for (const arm of expression.arms) this.#resolveMatchArm(arm);
        return;
      default: {
        const never: never = expression;
        throw new Error(`unhandled expression ${JSON.stringify(never)}`);
      }
    }
  }

  #resolveMatchArm(arm: MatchArm): void {
    this.#pushScope();
    for (const pattern of arm.patterns) {
      if (pattern.kind === "LiteralPattern") this.#resolveExpression(pattern.value);
      else if (pattern.kind === "BindingPattern") {
        this.#declare(pattern.name, pattern.span, "match", { mutable: false });
      }
    }
    if (arm.guard !== null) this.#resolveExpression(arm.guard);
    this.#resolveExpression(arm.body);
    this.#popScope();
  }

  #resolveCall(expression: Extract<Expression, { kind: "CallExpression" }>): void {
    this.#resolveExpression(expression.callee);
    for (const argument of expression.args) this.#resolveExpression(argument);

    if (expression.callee.kind !== "Identifier") return;
    const symbol = this.#lookup(expression.callee.name);
    if (symbol === null || symbol.params === null) return;

    const params = symbol.params;
    const hasRest = params.some((param) => param.rest);
    const required = params.filter((param) => param.defaultValue === null && !param.rest).length;
    const count = expression.args.length;
    if (count < required) {
      this.#report("BAA202", [symbol.name, arityText(required, hasRest ? Infinity : params.length), String(count)], {
        span: expression.argsSpan,
        note: "too few arguments",
        secondary: [{ span: symbol.span, note: "declared here" }],
      });
      return;
    }
    if (!hasRest && count > params.length) {
      this.#report("BAA201", [symbol.name, arityText(required, params.length), String(count)], {
        span: expression.argsSpan,
        note: "too many arguments",
        secondary: [{ span: symbol.span, note: "declared here" }],
      });
    }
  }
}

function arityText(min: number, max: number): string {
  if (!Number.isFinite(max)) return `${min} or more`;
  if (min === max) return String(min);
  return `${min} to ${max}`;
}

export function resolveProgram(
  program: Program,
  file: SourceFile,
  options: ResolveOptions = {},
): ResolveResult {
  return new Resolver(file, options).resolve(program);
}

export type { FunctionDeclaration };
