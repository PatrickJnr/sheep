/**
 * The Baa value model.
 *
 * Baa values map onto JavaScript values as directly as possible, `nil` is
 * `null`, booleans are booleans, strings are strings, numbers are IEEE-754
 * doubles: so that the interpreter does no boxing on the hot path. Only the
 * composite types (array, map, range, function, module) get a wrapper class,
 * and those wrappers exist to give them identity and methods.
 *
 * Numbers: Baa has a single numeric type. `12` and `12.0` are the same value.
 * `wool.is_whole(n)` asks the question people actually mean when they ask
 * whether something is "an int". This is a deliberate simplification over a
 * split int/float model: it removes a whole class of surprising promotions, and
 * `ram.idiv`, `ram.floor` and friends cover the integer use cases.
 */

import type { Block, Param } from "../ast/ast.ts";
import { BaaError } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import type { Environment } from "./environment.ts";

export type Value =
  | null
  | boolean
  | number
  | string
  | BaaArray
  | BaaMap
  | BaaRange
  | BaaFunction
  | NativeFunction
  | BaaModule;

/** Keys a Baa map accepts. Composite values cannot be keys. */
export type MapKey = string | number | boolean | null;

export class BaaArray {
  readonly items: Value[];
  constructor(items: Value[] = []) {
    this.items = items;
  }
  get length(): number {
    return this.items.length;
  }
}

export class BaaMap {
  readonly entries: Map<MapKey, Value>;
  constructor(entries: Map<MapKey, Value> = new Map()) {
    this.entries = entries;
  }
  get size(): number {
    return this.entries.size;
  }
  static from(record: Record<string, Value>): BaaMap {
    return new BaaMap(new Map(Object.entries(record)));
  }
}

export class BaaRange {
  readonly start: number;
  readonly end: number;
  readonly inclusive: boolean;
  constructor(start: number, end: number, inclusive: boolean) {
    this.start = start;
    this.end = end;
    this.inclusive = inclusive;
  }

  /**
   * How many values `values()` yields. A range counts downwards when its start
   * is above its end, so the distance is what matters, not the sign: `5..0`
   * yields five values just as `0..5` does.
   */
  get length(): number {
    const distance = Math.abs(this.end - this.start);
    if (Number.isNaN(distance)) return 0;
    if (distance === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
    // Exclusive stops before the bound, so a fractional distance still yields
    // its final step; inclusive always yields the start as well.
    return this.inclusive ? Math.floor(distance) + 1 : Math.ceil(distance);
  }

  /**
   * Whether a number lies within the bounds, regardless of direction. An
   * exclusive range omits its `end`, which for a descending range is the lower
   * bound rather than the upper one.
   */
  contains(value: number): boolean {
    const low = Math.min(this.start, this.end);
    const high = Math.max(this.start, this.end);
    if (this.inclusive) return value >= low && value <= high;
    return this.start <= this.end
      ? value >= this.start && value < this.end
      : value <= this.start && value > this.end;
  }

  *values(): Generator<number> {
    if (this.start <= this.end) {
      for (let i = this.start; this.inclusive ? i <= this.end : i < this.end; i++) {
        yield i;
      }
    } else {
      for (let i = this.start; this.inclusive ? i >= this.end : i > this.end; i--) {
        yield i;
      }
    }
  }
}

export class BaaFunction {
  readonly name: string;
  readonly params: readonly Param[];
  readonly body: Block;
  readonly closure: Environment;
  readonly declaredAt: Span;
  /** Bound receiver for methods obtained from a module. */
  readonly boundSelf: Value | undefined;

  constructor(
    name: string,
    params: readonly Param[],
    body: Block,
    closure: Environment,
    declaredAt: Span,
  ) {
    this.name = name;
    this.params = params;
    this.body = body;
    this.closure = closure;
    this.declaredAt = declaredAt;
    this.boundSelf = undefined;
  }

  get arity(): number {
    return this.params.filter((p) => p.defaultValue === null && !p.rest).length;
  }
}

export type NativeContext = {
  /** Span of the call site, for diagnostics. */
  readonly span: Span;
  /** Invoke a Baa callable from native code (used by `map`, `filter`, ...). */
  readonly call: (callee: Value, args: Value[], span: Span) => Value;
};

export class NativeFunction {
  readonly name: string;
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly impl: (args: Value[], ctx: NativeContext) => Value;
  readonly doc: string;

  constructor(
    name: string,
    minArgs: number,
    maxArgs: number,
    impl: (args: Value[], ctx: NativeContext) => Value,
    doc = "",
  ) {
    this.name = name;
    this.minArgs = minArgs;
    this.maxArgs = maxArgs;
    this.impl = impl;
    this.doc = doc;
  }
}

export class BaaModule {
  readonly name: string;
  readonly exports: Map<string, Value>;
  /** Absolute path for file modules, or `null` for built-ins. */
  readonly path: string | null;

  constructor(name: string, exports: Map<string, Value>, path: string | null = null) {
    this.name = name;
    this.exports = exports;
    this.path = path;
  }
}

// --------------------------------------------------------------------------
// Type names and truthiness
// --------------------------------------------------------------------------

export type TypeName =
  | "nil"
  | "bool"
  | "number"
  | "string"
  | "array"
  | "map"
  | "range"
  | "function"
  | "module";

export function typeOf(value: Value): TypeName {
  if (value === null) return "nil";
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      break;
  }
  if (value instanceof BaaArray) return "array";
  if (value instanceof BaaMap) return "map";
  if (value instanceof BaaRange) return "range";
  if (value instanceof BaaFunction || value instanceof NativeFunction) return "function";
  return "module";
}

/** English article + type name, for diagnostics: "an array", "a string". */
export function describeType(value: Value): string {
  const name = typeOf(value);
  return name === "array" ? "an array" : `a ${name}`;
}

/**
 * Only `nil` and `false` are falsy. Zero, empty strings and empty arrays are
 * all truthy: this is the Lua/Ruby rule, and it avoids the classic
 * "empty string is false" bug class.
 */
export function isTruthy(value: Value): boolean {
  return value !== null && value !== false;
}

export function isCallable(value: Value): value is BaaFunction | NativeFunction {
  return value instanceof BaaFunction || value instanceof NativeFunction;
}

export function isMapKey(value: Value): value is MapKey {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// --------------------------------------------------------------------------
// Equality
// --------------------------------------------------------------------------

/** Structural equality for arrays and maps; identity for functions and modules. */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    // NaN never equals itself, matching IEEE-754 and every other language.
    return a === b;
  }
  if (a instanceof BaaArray && b instanceof BaaArray) {
    if (a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) {
      if (!valuesEqual(a.items[i]!, b.items[i]!)) return false;
    }
    return true;
  }
  if (a instanceof BaaMap && b instanceof BaaMap) {
    if (a.entries.size !== b.entries.size) return false;
    for (const [key, value] of a.entries) {
      if (!b.entries.has(key)) return false;
      if (!valuesEqual(value, b.entries.get(key)!)) return false;
    }
    return true;
  }
  if (a instanceof BaaRange && b instanceof BaaRange) {
    return a.start === b.start && a.end === b.end && a.inclusive === b.inclusive;
  }
  return false;
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";
  return String(value);
}

/** `baa x` output: strings print bare, everything else prints as source-ish. */
export function display(value: Value): string {
  return typeof value === "string" ? value : inspect(value);
}

/** Developer-facing representation, with quoted strings. Used by the REPL. */
export function inspect(value: Value, seen: Set<object> = new Set()): string {
  if (value === null) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return quote(value);
  if (value instanceof BaaRange) {
    return `${formatNumber(value.start)}${value.inclusive ? "..=" : ".."}${formatNumber(value.end)}`;
  }
  if (value instanceof BaaFunction) {
    return `<fn ${value.name}/${value.params.length}>`;
  }
  if (value instanceof NativeFunction) {
    return `<native fn ${value.name}>`;
  }
  if (value instanceof BaaModule) {
    return `<module ${value.name}>`;
  }
  if (seen.has(value)) return value instanceof BaaArray ? "[...]" : "{...}";
  seen.add(value);
  try {
    if (value instanceof BaaArray) {
      return `[${value.items.map((item) => inspect(item, seen)).join(", ")}]`;
    }
    const parts: string[] = [];
    for (const [key, entryValue] of value.entries) {
      parts.push(`${formatKey(key)}: ${inspect(entryValue, seen)}`);
    }
    return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
  } finally {
    seen.delete(value);
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function formatKey(key: MapKey): string {
  if (typeof key === "string") return IDENT_RE.test(key) ? key : quote(key);
  if (key === null) return "nil";
  if (typeof key === "boolean") return key ? "true" : "false";
  return formatNumber(key);
}

export function quote(text: string): string {
  let out = '"';
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
      default:
        out += ch;
    }
  }
  return `${out}"`;
}

/** `wool.to_string` and string interpolation both funnel through here. */
export function toStringValue(value: Value): string {
  return display(value);
}

// --------------------------------------------------------------------------
// Allocation limit
// --------------------------------------------------------------------------

/**
 * Upper bound on anything sized by a count the program supplies: `repeat`,
 * `pad_start`, `flock.range` and friends.
 *
 * Without it, `"baa".repeat(1e10)` reaches a JavaScript engine limit and throws
 * a `RangeError` that is not a Baa diagnostic at all, and `flock.repeat(0, 1e9)`
 * exhausts memory before it gets that far. Ten million is far past any honest
 * use and far below either failure, so the program gets a diagnostic pointing
 * at the call instead of a crash.
 */
export const MAX_SIZE = 10_000_000;

export function checkSize(fn: string, count: number, span: Span): number {
  if (count > MAX_SIZE) {
    throw BaaError.of("BAA312", [fn, formatNumber(count), formatNumber(MAX_SIZE)], {
      span,
      note: "too many at once",
      help: "Build it in smaller pieces, or check the count for a mistake.",
    });
  }
  return count;
}

// --------------------------------------------------------------------------
// Argument helpers shared by every native function
// --------------------------------------------------------------------------

export function expectNumber(
  fn: string,
  args: readonly Value[],
  index: number,
  span: Span,
): number {
  const value = args[index];
  if (typeof value !== "number") {
    throw BaaError.of(
      "BAA311",
      [fn, "a number", String(index + 1), typeOf(value ?? null)],
      { span, note: "wrong type here" },
    );
  }
  return value;
}

export function expectString(
  fn: string,
  args: readonly Value[],
  index: number,
  span: Span,
): string {
  const value = args[index];
  if (typeof value !== "string") {
    throw BaaError.of(
      "BAA311",
      [fn, "a string", String(index + 1), typeOf(value ?? null)],
      { span, note: "wrong type here" },
    );
  }
  return value;
}

export function expectArray(
  fn: string,
  args: readonly Value[],
  index: number,
  span: Span,
): BaaArray {
  const value = args[index];
  if (!(value instanceof BaaArray)) {
    throw BaaError.of(
      "BAA311",
      [fn, "an array", String(index + 1), typeOf(value ?? null)],
      { span, note: "wrong type here" },
    );
  }
  return value;
}

export function expectMap(
  fn: string,
  args: readonly Value[],
  index: number,
  span: Span,
): BaaMap {
  const value = args[index];
  if (!(value instanceof BaaMap)) {
    throw BaaError.of("BAA311", [fn, "a map", String(index + 1), typeOf(value ?? null)], {
      span,
      note: "wrong type here",
    });
  }
  return value;
}

export function expectCallable(
  fn: string,
  args: readonly Value[],
  index: number,
  span: Span,
): BaaFunction | NativeFunction {
  const value = args[index];
  if (!isCallable(value ?? null)) {
    throw BaaError.of(
      "BAA311",
      [fn, "a function", String(index + 1), typeOf(value ?? null)],
      { span, note: "wrong type here" },
    );
  }
  return value as BaaFunction | NativeFunction;
}

export function expectMapKey(
  fn: string,
  args: readonly Value[],
  index: number,
  span: Span,
): MapKey {
  const value = args[index] ?? null;
  if (!isMapKey(value)) {
    throw BaaError.of(
      "BAA311",
      [fn, "a string, number, bool or nil", String(index + 1), typeOf(value)],
      { span, note: "cannot be used as a map key" },
    );
  }
  return value;
}

export function arg(args: readonly Value[], index: number): Value {
  return args[index] ?? null;
}
