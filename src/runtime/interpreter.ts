/**
 * The Baa tree-walking interpreter.
 *
 * Execution model:
 *
 *  - Statements are executed for effect (`execute`), expressions are evaluated
 *    for a value (`evaluate`). Neither returns a completion record; `return`,
 *    `break` and `continue` travel as signal objects (see `signals.ts`).
 *
 *  - Scopes are `Environment` chains. A function value captures the
 *    environment it was declared in, which is all closures need.
 *
 *  - Every error carries a span. When one escapes a function call, the
 *    innermost `callFunction` frame attaches the live call stack, so the
 *    reported trace is the real one rather than a reconstruction.
 *
 * This is a deliberately straightforward evaluator. It is fast enough for
 * scripting, and its shape maps cleanly onto a bytecode compiler when the time
 * comes: see ARCHITECTURE.md.
 */

import type {
  Block,
  Expression,
  FunctionDeclaration,
  ImportDeclaration,
  MatchArm,
  Param,
  Program,
  Statement,
} from "../ast/ast.ts";
import type { Diagnostic, TraceFrame } from "../diagnostics/diagnostic.ts";
import { BaaError, suggest } from "../diagnostics/diagnostic.ts";
import type { SourceFile, Span } from "../diagnostics/source.ts";
import { SourceFile as SourceFileClass } from "../diagnostics/source.ts";
import { parse } from "../parser/parser.ts";
import { resolveProgram } from "../semantic/resolver.ts";
import { createPrelude } from "../stdlib/prelude.ts";
import { loadBuiltinModule, STDLIB_MODULES } from "../stdlib/index.ts";
import { Environment } from "./environment.ts";
import type { RuntimeHost } from "./host.ts";
import { getMethod, methodNames } from "./methods.ts";
import {
  BreakSignal,
  ContinueSignal,
  ExitSignal,
  ReturnSignal,
  ThrownValue,
} from "./signals.ts";
import {
  BaaArray,
  BaaFunction,
  BaaMap,
  BaaModule,
  BaaRange,
  describeType,
  display,
  formatNumber,
  inspect,
  isCallable,
  isMapKey,
  isTruthy,
  NativeFunction,
  typeOf,
  valuesEqual,
} from "./values.ts";
import type { MapKey, NativeContext, Value } from "./values.ts";

export type CollectedTest = {
  readonly name: string;
  readonly body: Block;
  readonly env: Environment;
  readonly span: Span;
};

export type InterpreterOptions = {
  readonly host: RuntimeHost;
  /** Guard against runaway recursion. */
  readonly maxDepth?: number;
  /**
   * Project dependencies from `baa.toml`, as module name → entry file path.
   * `import my_lib` finds them after the standard library.
   */
  readonly dependencies?: ReadonlyMap<string, string>;
};

const DEFAULT_MAX_DEPTH = 512;

export class Interpreter {
  readonly host: RuntimeHost;
  readonly globals: Environment;
  readonly tests: CollectedTest[];
  readonly #maxDepth: number;
  readonly #moduleCache: Map<string, BaaModule>;
  readonly #loading: Set<string>;
  readonly #dependencies: ReadonlyMap<string, string>;
  #stack: TraceFrame[];
  #depth: number;
  /** Directory of the module currently executing, for relative imports. */
  #currentDir: string;

  constructor(options: InterpreterOptions) {
    this.host = options.host;
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.globals = new Environment(null, "global");
    this.tests = [];
    this.#moduleCache = new Map();
    this.#loading = new Set();
    this.#dependencies = options.dependencies ?? new Map();
    this.#stack = [];
    this.#depth = 0;
    this.#currentDir = options.host.cwd();
    for (const [name, value] of createPrelude(this)) {
      this.globals.define(name, value, false);
    }
  }

  // -------------------------------------------------------------- entry points

  /** Run a parsed program in a fresh module scope. Returns the last value. */
  run(program: Program, file: SourceFile, env?: Environment): Value {
    const scope = env ?? this.globals.child(file.path);
    const previousDir = this.#currentDir;
    this.#currentDir = dirNameOf(this.host, file.path);
    try {
      return this.executeBody(program.body, scope);
    } finally {
      this.#currentDir = previousDir;
    }
  }

  executeBody(statements: readonly Statement[], env: Environment): Value {
    // Function declarations are hoisted so that mutually recursive functions
    // work regardless of declaration order.
    for (const statement of statements) {
      if (statement.kind === "FunctionDeclaration") {
        env.define(
          statement.name,
          new BaaFunction(statement.name, statement.params, statement.body, env, statement.span),
          false,
        );
      }
    }
    let last: Value = null;
    for (const statement of statements) {
      last = this.execute(statement, env);
    }
    return last;
  }

  // --------------------------------------------------------------- statements

  execute(statement: Statement, env: Environment): Value {
    switch (statement.kind) {
      case "LetStatement": {
        const value = this.evaluate(statement.value, env);
        env.define(statement.name, value, statement.mutable);
        return null;
      }
      case "FunctionDeclaration":
        // Already hoisted by `executeBody`, but a declaration nested inside a
        // block reached directly still needs defining.
        if (!env.hasOwn(statement.name)) {
          env.define(
            statement.name,
            new BaaFunction(statement.name, statement.params, statement.body, env, statement.span),
            false,
          );
        }
        return null;
      case "ExpressionStatement":
        return this.evaluate(statement.expression, env);
      case "BaaStatement": {
        const parts = statement.values.map((value) => display(this.evaluate(value, env)));
        this.host.write(`${parts.join(" ")}\n`);
        return null;
      }
      case "ReturnStatement":
        throw new ReturnSignal(
          statement.value === null ? null : this.evaluate(statement.value, env),
        );
      case "IfStatement": {
        if (isTruthy(this.evaluate(statement.condition, env))) {
          return this.executeBlock(statement.consequent, env.child("if"));
        }
        if (statement.alternate === null) return null;
        if (statement.alternate.kind === "Block") {
          return this.executeBlock(statement.alternate, env.child("else"));
        }
        return this.execute(statement.alternate, env);
      }
      case "WhileStatement": {
        while (isTruthy(this.evaluate(statement.condition, env))) {
          try {
            this.executeBlock(statement.body, env.child("while"));
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (signal instanceof ContinueSignal) continue;
            throw signal;
          }
        }
        return null;
      }
      case "ForStatement":
        return this.#executeFor(statement, env);
      case "BreakStatement":
        throw new BreakSignal(statement.span);
      case "ContinueStatement":
        throw new ContinueSignal(statement.span);
      case "ImportDeclaration":
        return this.#executeImport(statement, env);
      case "ThrowStatement":
        throw new ThrownValue(this.evaluate(statement.value, env), statement.span);
      case "TryStatement":
        return this.#executeTry(statement, env);
      case "TestDeclaration":
        this.tests.push({
          name: statement.name,
          body: statement.body,
          env,
          span: statement.span,
        });
        return null;
      default: {
        const never: never = statement;
        throw new Error(`unhandled statement: ${JSON.stringify(never)}`);
      }
    }
  }

  executeBlock(block: Block, env: Environment): Value {
    return this.executeBody(block.body, env);
  }

  #executeFor(statement: Extract<Statement, { kind: "ForStatement" }>, env: Environment): Value {
    const iterable = this.evaluate(statement.iterable, env);
    const pairs = this.#iterationPairs(iterable, statement.iterable.span);
    for (const [first, second] of pairs) {
      const scope = env.child("for");
      if (statement.valueName === null) {
        scope.define(statement.name, second, true);
      } else {
        scope.define(statement.name, first, true);
        scope.define(statement.valueName, second, true);
      }
      try {
        this.executeBlock(statement.body, scope);
      } catch (signal) {
        if (signal instanceof BreakSignal) break;
        if (signal instanceof ContinueSignal) continue;
        throw signal;
      }
    }
    return null;
  }

  /**
   * Iteration yields `[key, value]` pairs. With one binding the loop sees the
   * value; with two it sees both: index/item for arrays and strings, key/value
   * for maps.
   */
  *#iterationPairs(value: Value, span: Span): Generator<[Value, Value]> {
    if (value instanceof BaaArray) {
      for (let i = 0; i < value.items.length; i++) yield [i, value.items[i]!];
      return;
    }
    if (value instanceof BaaRange) {
      let index = 0;
      for (const item of value.values()) yield [index++, item];
      return;
    }
    if (typeof value === "string") {
      let index = 0;
      for (const ch of value) yield [index++, ch];
      return;
    }
    if (value instanceof BaaMap) {
      for (const [key, entry] of value.entries) yield [key, entry];
      return;
    }
    throw BaaError.of("BAA309", [describeType(value)], {
      span,
      note: "cannot be looped over",
      help: "Loop over an array, map, string or range.",
    });
  }

  #executeTry(statement: Extract<Statement, { kind: "TryStatement" }>, env: Environment): Value {
    try {
      try {
        this.executeBlock(statement.block, env.child("try"));
      } catch (error) {
        if (statement.handler === null) throw error;
        const caught = this.#toCaughtValue(error);
        if (caught === null && !(error instanceof ThrownValue)) throw error;
        const scope = env.child("catch");
        if (statement.catchName !== null) {
          scope.define(statement.catchName, caught, true);
        }
        this.executeBlock(statement.handler, scope);
      }
    } finally {
      if (statement.finalizer !== null) {
        this.executeBlock(statement.finalizer, env.child("finally"));
      }
    }
    return null;
  }

  /**
   * Convert a caught JavaScript-level error into a Baa value. User `throw`s
   * pass their value through untouched; runtime errors become a map so that
   * handlers can inspect `code` and `message`.
   */
  #toCaughtValue(error: unknown): Value {
    if (error instanceof ThrownValue) return error.value;
    if (error instanceof BaaError) {
      const position = error.diagnostic.primary
        ? error.diagnostic.primary.span.file.positionAt(error.diagnostic.primary.span.start)
        : null;
      return new BaaMap(
        new Map<MapKey, Value>([
          ["code", error.diagnostic.code],
          ["message", error.diagnostic.message],
          ["file", error.diagnostic.primary?.span.file.path ?? null],
          ["line", position ? position.line : null],
          ["column", position ? position.column : null],
        ]),
      );
    }
    return null;
  }

  // ------------------------------------------------------------------ modules

  #executeImport(statement: ImportDeclaration, env: Environment): Value {
    const module = this.loadModule(statement.source, statement.relative, statement.sourceSpan);
    if (statement.named.length === 0) {
      env.define(statement.alias, module, false);
      return null;
    }
    for (const specifier of statement.named) {
      if (!module.exports.has(specifier.name)) {
        const hint = suggest(specifier.name, module.exports.keys());
        throw BaaError.of("BAA403", [module.name, specifier.name], {
          span: specifier.span,
          note: "not exported",
          ...(hint ? { help: `Did you mean \`${hint}\`?` } : {}),
        });
      }
      env.define(specifier.alias, module.exports.get(specifier.name)!, false);
    }
    return null;
  }

  loadModule(source: string, relative: boolean, span: Span): BaaModule {
    if (!relative) {
      const cached = this.#moduleCache.get(`std:${source}`);
      if (cached) return cached;
      const module = loadBuiltinModule(source, this);
      if (module !== null) {
        this.#moduleCache.set(`std:${source}`, module);
        return module;
      }
      // Not a standard module: try the project's declared dependencies.
      const dependency = this.#dependencies.get(source);
      if (dependency !== undefined) return this.#loadFileModule(source, span, dependency);

      const known = [...STDLIB_MODULES, ...this.#dependencies.keys()];
      const hint = suggest(source, known);
      throw BaaError.of("BAA401", [source], {
        span,
        note: "unknown module",
        help: hint
          ? `Did you mean \`${hint}\`?`
          : `Standard modules: ${STDLIB_MODULES.join(", ")}. Import a file with a path: \`import "./${source}.baa"\`, or add it to \`baa.toml\` with \`baa add\`.`,
      });
    }
    return this.#loadFileModule(source, span);
  }

  #loadFileModule(source: string, span: Span, absolutePath?: string): BaaModule {
    let resolved: string | null = absolutePath ?? null;
    if (resolved === null) {
      const candidates = source.endsWith(".baa") ? [source] : [`${source}.baa`, source];
      for (const candidate of candidates) {
        const full = this.host.resolvePath(this.#currentDir, candidate);
        if (this.host.fileExists(full)) {
          resolved = full;
          break;
        }
      }
    }
    if (resolved === null) {
      throw BaaError.of("BAA401", [source], {
        span,
        note: "no such file",
        help: `Looked in ${this.#currentDir}. Paths are relative to the importing file.`,
      });
    }

    const cached = this.#moduleCache.get(resolved);
    if (cached) return cached;
    if (this.#loading.has(resolved)) {
      throw BaaError.of("BAA402", [`${resolved} imports itself`], {
        span,
        note: "already being loaded",
        help: "Move the shared code into a third module that both can import.",
      });
    }

    let text: string;
    try {
      text = this.host.readFile(resolved);
    } catch (error) {
      throw BaaError.of("BAA404", [`${resolved}: ${(error as Error).message}`], { span });
    }

    const file = new SourceFileClass(resolved, text);
    const { program, diagnostics } = parse(file);
    const analysis = resolveProgram(program, file);
    const problems = [...diagnostics, ...analysis.diagnostics].filter(
      (d) => d.severity === "error",
    );
    const first = problems[0];
    if (first !== undefined) {
      throw new BaaError(withImportContext(first, span, source));
    }

    this.#loading.add(resolved);
    const scope = this.globals.child(resolved);
    const previousDir = this.#currentDir;
    this.#currentDir = dirNameOf(this.host, resolved);
    try {
      this.executeBody(program.body, scope);
    } finally {
      this.#currentDir = previousDir;
      this.#loading.delete(resolved);
    }

    const exports = new Map<string, Value>();
    for (const statement of program.body) {
      if (
        (statement.kind === "LetStatement" || statement.kind === "FunctionDeclaration") &&
        statement.exported
      ) {
        exports.set(statement.name, scope.get(statement.name, statement.span));
      }
    }
    const module = new BaaModule(moduleNameOf(resolved), exports, resolved);
    this.#moduleCache.set(resolved, module);
    return module;
  }

  // -------------------------------------------------------------- expressions

  evaluate(expression: Expression, env: Environment): Value {
    switch (expression.kind) {
      case "IntLiteral":
      case "FloatLiteral":
        return expression.value;
      case "BoolLiteral":
        return expression.value;
      case "NilLiteral":
        return null;
      case "StringLiteral": {
        if (expression.segments.length === 1 && expression.segments[0]!.kind === "text") {
          return expression.segments[0]!.value;
        }
        let out = "";
        for (const segment of expression.segments) {
          out +=
            segment.kind === "text"
              ? segment.value
              : display(this.evaluate(segment.expression, env));
        }
        return out;
      }
      case "Identifier":
        return env.get(expression.name, expression.span);
      case "ArrayLiteral":
        return new BaaArray(expression.elements.map((element) => this.evaluate(element, env)));
      case "MapLiteral": {
        const entries = new Map<MapKey, Value>();
        for (const entry of expression.entries) {
          const key = this.evaluate(entry.key, env);
          if (!isMapKey(key)) {
            throw BaaError.of("BAA311", ["map key", "a string, number, bool or nil", "1", typeOf(key)], {
              span: entry.key.span,
              note: "cannot be used as a map key",
            });
          }
          entries.set(key, this.evaluate(entry.value, env));
        }
        return new BaaMap(entries);
      }
      case "FunctionExpression":
        return new BaaFunction(
          expression.name ?? "anonymous",
          expression.params,
          expression.body,
          env,
          expression.span,
        );
      case "UnaryExpression": {
        const operand = this.evaluate(expression.operand, env);
        if (expression.operator === "!") return !isTruthy(operand);
        if (typeof operand !== "number") {
          throw BaaError.of("BAA302", ["negate", describeType(operand), "nothing"], {
            span: expression.span,
            note: "only numbers can be negated",
          });
        }
        return -operand;
      }
      case "BinaryExpression":
        return this.#binary(expression, env);
      case "LogicalExpression": {
        const left = this.evaluate(expression.left, env);
        switch (expression.operator) {
          case "&&":
            return isTruthy(left) ? this.evaluate(expression.right, env) : left;
          case "||":
            return isTruthy(left) ? left : this.evaluate(expression.right, env);
          default:
            return left === null ? this.evaluate(expression.right, env) : left;
        }
      }
      case "RangeExpression": {
        const start = this.evaluate(expression.start, env);
        const end = this.evaluate(expression.end, env);
        if (typeof start !== "number" || typeof end !== "number") {
          throw BaaError.of(
            "BAA302",
            ["build a range from", describeType(start), describeType(end)],
            { span: expression.span, note: "ranges need numbers on both sides" },
          );
        }
        return new BaaRange(start, end, expression.inclusive);
      }
      case "AssignmentExpression":
        return this.#assign(expression, env);
      case "MemberExpression": {
        const object = this.evaluate(expression.object, env);
        return this.readMember(object, expression.property, expression.propertySpan);
      }
      case "IndexExpression": {
        const object = this.evaluate(expression.object, env);
        const index = this.evaluate(expression.index, env);
        return this.readIndex(object, index, expression.span);
      }
      case "CallExpression":
        return this.#call(expression, env);
      case "MatchExpression":
        return this.#match(expression, env);
      default: {
        const never: never = expression;
        throw new Error(`unhandled expression: ${JSON.stringify(never)}`);
      }
    }
  }

  #match(
    expression: Extract<Expression, { kind: "MatchExpression" }>,
    env: Environment,
  ): Value {
    const subject = this.evaluate(expression.subject, env);
    for (const arm of expression.arms) {
      const scope = this.#matchArm(arm, subject, env);
      if (scope === null) continue;
      return this.evaluate(arm.body, scope);
    }
    throw BaaError.of("BAA301", [`no match arm accepted ${inspect(subject)}`], {
      span: expression.span,
      note: "nothing matched",
      help: "Add a `_ => ...` arm to cover the remaining cases.",
    });
  }

  #matchArm(arm: MatchArm, subject: Value, env: Environment): Environment | null {
    for (const pattern of arm.patterns) {
      const scope = env.child("match");
      let matched = false;
      switch (pattern.kind) {
        case "WildcardPattern":
          matched = true;
          break;
        case "BindingPattern":
          scope.define(pattern.name, subject, false);
          matched = true;
          break;
        case "LiteralPattern":
          matched = valuesEqual(this.evaluate(pattern.value, env), subject);
          break;
      }
      if (!matched) continue;
      if (arm.guard !== null && !isTruthy(this.evaluate(arm.guard, scope))) continue;
      return scope;
    }
    return null;
  }

  #binary(
    expression: Extract<Expression, { kind: "BinaryExpression" }>,
    env: Environment,
  ): Value {
    const left = this.evaluate(expression.left, env);
    const right = this.evaluate(expression.right, env);
    return this.applyBinary(expression.operator, left, right, expression.operatorSpan);
  }

  applyBinary(
    operator: Extract<Expression, { kind: "BinaryExpression" }>["operator"],
    left: Value,
    right: Value,
    span: Span,
  ): Value {
    switch (operator) {
      case "==":
        return valuesEqual(left, right);
      case "!=":
        return !valuesEqual(left, right);
      case "in":
        return this.#containsValue(right, left, span);
      case "+":
        if (typeof left === "number" && typeof right === "number") return left + right;
        if (typeof left === "string" || typeof right === "string") {
          // Concatenation wins when either side is text, which is what the
          // `"Baa, " + name` idiom needs. Everything else must be numeric.
          if (isConcatenable(left) && isConcatenable(right)) {
            return `${display(left)}${display(right)}`;
          }
        }
        if (left instanceof BaaArray && right instanceof BaaArray) {
          return new BaaArray([...left.items, ...right.items]);
        }
        throw this.#operandError("add", left, right, span);
      case "-":
      case "*":
      case "/":
      case "%":
      case "**": {
        if (typeof left !== "number" || typeof right !== "number") {
          if (operator === "*" && typeof left === "string" && typeof right === "number") {
            return left.repeat(Math.max(0, Math.floor(right)));
          }
          throw this.#operandError(verbFor(operator), left, right, span);
        }
        switch (operator) {
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "**":
            return left ** right;
          case "/":
            if (right === 0) throw BaaError.of("BAA306", [], { span, note: "divisor is zero" });
            return left / right;
          default:
            if (right === 0) throw BaaError.of("BAA306", [], { span, note: "divisor is zero" });
            return left % right;
        }
      }
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (typeof left === "number" && typeof right === "number") {
          return compareNumbers(operator, left, right);
        }
        if (typeof left === "string" && typeof right === "string") {
          return compareStrings(operator, left, right);
        }
        throw this.#operandError("compare", left, right, span);
      }
      default: {
        const never: never = operator;
        throw new Error(`unhandled operator ${String(never)}`);
      }
    }
  }

  #operandError(verb: string, left: Value, right: Value, span: Span): BaaError {
    return BaaError.of("BAA302", [verb, describeType(left), describeType(right)], {
      span,
      note: "these types don't mix",
      help:
        typeof left === "number" || typeof right === "number"
          ? "Convert the other value first, for example with `to_number(x)`."
          : "Check the types with `type_of(x)`.",
    });
  }

  #containsValue(container: Value, needle: Value, span: Span): boolean {
    if (container instanceof BaaArray) {
      return container.items.some((item) => valuesEqual(item, needle));
    }
    if (container instanceof BaaMap) {
      return isMapKey(needle) && container.entries.has(needle);
    }
    if (container instanceof BaaRange) {
      if (typeof needle !== "number") return false;
      const low = Math.min(container.start, container.end);
      const high = Math.max(container.start, container.end);
      return container.inclusive
        ? needle >= low && needle <= high
        : needle >= low && needle < high;
    }
    if (typeof container === "string" && typeof needle === "string") {
      return container.includes(needle);
    }
    throw BaaError.of("BAA302", ["look inside", describeType(needle), describeType(container)], {
      span,
      note: "`in` works on arrays, maps, ranges and strings",
    });
  }

  // ------------------------------------------------------------ member access

  readMember(object: Value, property: string, span: Span): Value {
    if (object instanceof BaaModule) {
      const value = object.exports.get(property);
      if (value === undefined) {
        const hint = suggest(property, object.exports.keys());
        throw BaaError.of("BAA403", [object.name, property], {
          span,
          note: "not exported",
          ...(hint ? { help: `Did you mean \`${hint}\`?` } : {}),
        });
      }
      return value;
    }
    if (object instanceof BaaMap && object.entries.has(property)) {
      // Data wins over methods, so adding a method never breaks a program that
      // already stores a key by that name.
      return object.entries.get(property)!;
    }
    const method = getMethod(object, property);
    if (method !== null) return method;
    if (object instanceof BaaMap) return null;
    if (object === null) {
      throw BaaError.of("BAA305", ["nil value", property], {
        span,
        note: "nil has no fields",
        help: "Check the value before reading from it, or use `value ?? fallback`.",
      });
    }
    const hint = suggest(property, methodNames(object));
    throw BaaError.of("BAA305", [describeType(object), property], {
      span,
      note: "no such field or method",
      ...(hint ? { help: `Did you mean \`${hint}\`?` } : {}),
    });
  }

  readIndex(object: Value, index: Value, span: Span): Value {
    if (object instanceof BaaArray) {
      const position = normaliseIndex(index, object.items.length, span, "array");
      return object.items[position]!;
    }
    if (typeof object === "string") {
      const chars = [...object];
      const position = normaliseIndex(index, chars.length, span, "string");
      return chars[position]!;
    }
    if (object instanceof BaaMap) {
      if (!isMapKey(index)) {
        throw BaaError.of("BAA311", ["index", "a string, number, bool or nil", "1", typeOf(index)], {
          span,
          note: "cannot be used as a map key",
        });
      }
      return object.entries.has(index) ? object.entries.get(index)! : null;
    }
    if (object instanceof BaaRange) {
      const values = [...object.values()];
      const position = normaliseIndex(index, values.length, span, "range");
      return values[position]!;
    }
    throw BaaError.of("BAA305", [describeType(object), display(index)], {
      span,
      note: "this value cannot be indexed",
      help: "Indexing works on arrays, maps, strings and ranges.",
    });
  }

  #assign(
    expression: Extract<Expression, { kind: "AssignmentExpression" }>,
    env: Environment,
  ): Value {
    const target = expression.target;
    const compute = (current: Value): Value => {
      if (expression.operator === "=") return this.evaluate(expression.value, env);
      const right = this.evaluate(expression.value, env);
      const operator = expression.operator.slice(0, -1) as "+" | "-" | "*" | "/" | "%";
      return this.applyBinary(operator, current, right, expression.span);
    };

    if (target.kind === "Identifier") {
      const current =
        expression.operator === "=" ? null : env.get(target.name, target.span);
      const value = compute(current);
      env.assign(target.name, value, target.span);
      return value;
    }
    if (target.kind === "MemberExpression") {
      const object = this.evaluate(target.object, env);
      if (!(object instanceof BaaMap)) {
        throw BaaError.of("BAA305", [describeType(object), target.property], {
          span: target.propertySpan,
          note: "cannot assign to this",
          help: "Only map fields and array elements can be assigned.",
        });
      }
      const current =
        expression.operator === "=" ? null : (object.entries.get(target.property) ?? null);
      const value = compute(current);
      object.entries.set(target.property, value);
      return value;
    }
    const object = this.evaluate(target.object, env);
    const index = this.evaluate(target.index, env);
    if (object instanceof BaaArray) {
      const position = normaliseIndex(index, object.items.length, target.span, "array");
      const value = compute(expression.operator === "=" ? null : object.items[position]!);
      object.items[position] = value;
      return value;
    }
    if (object instanceof BaaMap) {
      if (!isMapKey(index)) {
        throw BaaError.of("BAA311", ["index", "a string, number, bool or nil", "1", typeOf(index)], {
          span: target.span,
          note: "cannot be used as a map key",
        });
      }
      const value = compute(
        expression.operator === "=" ? null : (object.entries.get(index) ?? null),
      );
      object.entries.set(index, value);
      return value;
    }
    throw BaaError.of("BAA305", [describeType(object), display(index)], {
      span: target.span,
      note: "cannot assign into this value",
      help: "Only arrays and maps support indexed assignment.",
    });
  }

  // ---------------------------------------------------------------- calling

  #call(expression: Extract<Expression, { kind: "CallExpression" }>, env: Environment): Value {
    const callee = this.evaluate(expression.callee, env);
    const args = expression.args.map((argument) => this.evaluate(argument, env));
    const name = calleeName(expression.callee);
    return this.callValue(callee, args, expression.argsSpan, name);
  }

  /** Public so native functions can call back into Baa (`array.map(fn)`). */
  callValue(callee: Value, args: Value[], span: Span, name = "this value"): Value {
    if (callee instanceof NativeFunction) return this.#callNative(callee, args, span);
    if (callee instanceof BaaFunction) return this.callFunction(callee, args, span);
    throw BaaError.of("BAA303", [name], {
      span,
      note: `this is ${describeType(callee)}`,
      help: "Only functions can be called.",
    });
  }

  #callNative(fn: NativeFunction, args: Value[], span: Span): Value {
    if (args.length < fn.minArgs) {
      throw BaaError.of("BAA202", [fn.name, arityText(fn.minArgs, fn.maxArgs), String(args.length)], {
        span,
        note: "too few arguments",
      });
    }
    if (args.length > fn.maxArgs) {
      throw BaaError.of("BAA201", [fn.name, arityText(fn.minArgs, fn.maxArgs), String(args.length)], {
        span,
        note: "too many arguments",
      });
    }
    const context: NativeContext = {
      span,
      call: (callee, callArgs, callSpan) => this.callCallback(callee, callArgs, callSpan),
    };
    return fn.impl(args, context);
  }

  /**
   * Call a user function supplied to a standard-library function.
   *
   * Library callbacks are offered more than they usually want, `map` passes
   * `(item, index)`, `reduce` passes `(total, item, index)`, so extra
   * arguments are dropped to fit the callback's parameter list. Explicit calls
   * written in Baa source stay strict about arity; only this path is lenient,
   * and only in the direction of ignoring what the callback did not ask for.
   */
  callCallback(callee: Value, args: Value[], span: Span): Value {
    if (
      callee instanceof BaaFunction &&
      args.length > callee.params.length &&
      !callee.params.some((param) => param.rest)
    ) {
      return this.callValue(callee, args.slice(0, callee.params.length), span);
    }
    return this.callValue(callee, args, span);
  }

  callFunction(fn: BaaFunction, args: Value[], span: Span): Value {
    const required = fn.arity;
    const rest = fn.params.find((param) => param.rest) ?? null;
    const maximum = rest === null ? fn.params.length : Number.MAX_SAFE_INTEGER;
    if (args.length < required) {
      throw BaaError.of(
        "BAA202",
        [fn.name, arityText(required, rest === null ? fn.params.length : Number.MAX_SAFE_INTEGER), String(args.length)],
        {
          span,
          note: "too few arguments",
          secondary: [{ span: fn.declaredAt, note: "declared here" }],
        },
      );
    }
    if (args.length > maximum) {
      throw BaaError.of("BAA201", [fn.name, arityText(required, fn.params.length), String(args.length)], {
        span,
        note: "too many arguments",
        secondary: [{ span: fn.declaredAt, note: "declared here" }],
      });
    }

    if (this.#depth >= this.#maxDepth) {
      throw BaaError.of("BAA307", [], {
        span,
        note: "call stack limit reached",
        help: `The limit is ${this.#maxDepth} nested calls. Rewrite deep recursion as a loop, or raise it with \`--max-depth\`.`,
        trace: this.#stack.slice(0, 8),
      });
    }

    const scope = fn.closure.child(fn.name);
    this.#bindParams(fn.params, args, scope, span);

    this.#stack.push({ name: fn.name, span });
    this.#depth++;
    try {
      this.executeBody(fn.body.body, scope);
      return null;
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.value;
      if (signal instanceof BaaError && signal.diagnostic.trace.length === 0) {
        throw new BaaError({ ...signal.diagnostic, trace: [...this.#stack].reverse() });
      }
      throw signal;
    } finally {
      this.#depth--;
      this.#stack.pop();
    }
  }

  #bindParams(params: readonly Param[], args: Value[], scope: Environment, span: Span): void {
    let index = 0;
    for (const param of params) {
      if (param.rest) {
        scope.define(param.name, new BaaArray(args.slice(index)), true);
        index = args.length;
        continue;
      }
      const provided = index < args.length ? args[index]! : undefined;
      if (provided === undefined) {
        scope.define(
          param.name,
          param.defaultValue === null ? null : this.evaluate(param.defaultValue, scope),
          true,
        );
      } else {
        scope.define(param.name, provided, true);
      }
      index++;
    }
    void span;
  }

  /** Snapshot of the live call stack, innermost first. */
  stackTrace(): TraceFrame[] {
    return [...this.#stack].reverse();
  }

  /** Used by `baa test` to run a collected test body in its own scope. */
  runTestBody(test: CollectedTest): void {
    this.executeBlock(test.body, test.env.child(`test ${test.name}`));
  }

  exit(code: number): never {
    throw new ExitSignal(code);
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function isConcatenable(value: Value): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function verbFor(operator: string): string {
  switch (operator) {
    case "-":
      return "subtract";
    case "*":
      return "multiply";
    case "/":
      return "divide";
    case "%":
      return "take the remainder of";
    default:
      return "raise";
  }
}

function compareNumbers(operator: string, left: number, right: number): boolean {
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    default:
      return left >= right;
  }
}

function compareStrings(operator: string, left: string, right: string): boolean {
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    default:
      return left >= right;
  }
}

function normaliseIndex(index: Value, length: number, span: Span, what: string): number {
  if (typeof index !== "number" || !Number.isInteger(index)) {
    throw BaaError.of("BAA311", ["index", "a whole number", "1", typeOf(index)], {
      span,
      note: "indexes must be whole numbers",
    });
  }
  const position = index < 0 ? length + index : index;
  if (position < 0 || position >= length) {
    throw BaaError.of("BAA304", [formatNumber(index), what, String(length)], {
      span,
      note: "index out of range",
      help:
        length === 0
          ? "This value is empty."
          : `Valid indexes are 0 to ${length - 1} (or -1 to -${length} counting from the end).`,
    });
  }
  return position;
}

function arityText(min: number, max: number): string {
  if (max >= Number.MAX_SAFE_INTEGER) return `${min} or more`;
  if (min === max) return String(min);
  return `${min} to ${max}`;
}

function calleeName(expression: Expression): string {
  if (expression.kind === "Identifier") return expression.name;
  if (expression.kind === "MemberExpression") return expression.property;
  return "this value";
}

function moduleNameOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.baa$/i, "");
}

function dirNameOf(host: RuntimeHost, path: string): string {
  const resolved = host.resolvePath(path);
  const index = Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf("\\"));
  return index <= 0 ? resolved : resolved.slice(0, index);
}

function withImportContext(diagnostic: Diagnostic, span: Span, source: string): Diagnostic {
  return {
    ...diagnostic,
    secondary: [...diagnostic.secondary, { span, note: `imported as \`${source}\` here` }],
  };
}

/** Convenience wrapper used by `baa run`, the REPL and the test runner. */
export function createInterpreter(options: InterpreterOptions): Interpreter {
  return new Interpreter(options);
}

export { ExitSignal };
export type { FunctionDeclaration };
