/**
 * The prelude: functions available in every Baa program without an import.
 *
 * Kept deliberately small. If something can live in a module, it lives in a
 * module: a short prelude means fewer names a program can accidentally shadow,
 * and fewer things to learn on day one.
 *
 * The name list is exported separately so the resolver can validate names
 * without constructing an interpreter.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import type { Interpreter } from "../runtime/interpreter.ts";
import { ThrownValue } from "../runtime/signals.ts";
import {
  BaaArray,
  BaaMap,
  BaaRange,
  describeType,
  display,
  inspect,
  NativeFunction,
  parseNumber,
  typeOf,
  valuesEqual,
} from "../runtime/values.ts";
import type { MapKey, NativeContext, Value } from "../runtime/values.ts";

type PreludeEntry = {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly doc: string;
  readonly build: (interpreter: Interpreter) => (args: Value[], ctx: NativeContext) => Value;
};

function lengthOf(value: Value, span: Span): number {
  if (typeof value === "string") return [...value].length;
  if (value instanceof BaaArray) return value.items.length;
  if (value instanceof BaaMap) return value.entries.size;
  if (value instanceof BaaRange) return value.length;
  throw BaaError.of("BAA311", ["len", "a string, array, map or range", "1", describeType(value)], {
    span,
    note: "has no length",
  });
}

export function deepClone(value: Value, seen = new Map<object, Value>()): Value {
  if (value instanceof BaaArray) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const copy = new BaaArray([]);
    seen.set(value, copy);
    for (const item of value.items) copy.items.push(deepClone(item, seen));
    return copy;
  }
  if (value instanceof BaaMap) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const copy = new BaaMap(new Map<MapKey, Value>());
    seen.set(value, copy);
    for (const [key, entry] of value.entries) copy.entries.set(key, deepClone(entry, seen));
    return copy;
  }
  return value;
}

export const PRELUDE: readonly PreludeEntry[] = [
  {
    name: "len",
    min: 1,
    max: 1,
    doc: "Length of a string, array, map or range.",
    build: () => (args, ctx) => lengthOf(args[0] ?? null, ctx.span),
  },
  {
    name: "type_of",
    min: 1,
    max: 1,
    doc: 'Type name: "nil", "bool", "number", "string", "array", "map", "range", "function" or "module".',
    build: () => (args) => typeOf(args[0] ?? null),
  },
  {
    name: "to_string",
    min: 1,
    max: 1,
    doc: "Text form of any value.",
    build: () => (args) => display(args[0] ?? null),
  },
  {
    name: "inspect",
    min: 1,
    max: 1,
    doc: "Developer-facing form of any value, with quoted strings.",
    build: () => (args) => inspect(args[0] ?? null),
  },
  {
    name: "to_number",
    min: 1,
    max: 1,
    doc: "Parse a value as a number, or nil when it is not numeric.",
    build: () => (args) => {
      const value = args[0] ?? null;
      if (typeof value === "number") return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value !== "string") return null;
      return parseNumber(value);
    },
  },
  {
    name: "clone",
    min: 1,
    max: 1,
    doc: "Deep copy of an array or map. Other values are returned unchanged.",
    build: () => (args) => deepClone(args[0] ?? null),
  },
  {
    name: "assert",
    min: 1,
    max: 2,
    doc: "Fail the program when a condition is not truthy.",
    build: () => (args, ctx) => {
      const condition = args[0] ?? null;
      if (condition !== null && condition !== false) return null;
      const message = args.length > 1 ? display(args[1] ?? null) : "assertion failed";
      throw BaaError.of("BAA301", [message], {
        span: ctx.span,
        note: "this assertion did not hold",
      });
    },
  },
  {
    name: "assert_eq",
    min: 2,
    max: 3,
    doc: "Fail unless two values are equal, showing both when they are not.",
    build: () => (args, ctx) => {
      const left = args[0] ?? null;
      const right = args[1] ?? null;
      if (valuesEqual(left, right)) return null;
      const label = args.length > 2 ? `${display(args[2] ?? null)}: ` : "";
      throw BaaError.of(
        "BAA301",
        [`${label}expected ${inspect(right)}, got ${inspect(left)}`],
        { span: ctx.span, note: "these values differ" },
      );
    },
  },
  {
    name: "panic",
    min: 1,
    max: 1,
    doc: "Stop the program immediately with a message.",
    build: () => (args, ctx) => {
      throw new ThrownValue(args[0] ?? null, ctx.span);
    },
  },
  {
    name: "exit",
    min: 0,
    max: 1,
    doc: "Exit the program with a status code (default 0).",
    build: (interpreter) => (args, ctx) => {
      const code = args[0] ?? 0;
      if (typeof code !== "number" || !Number.isInteger(code)) {
        throw BaaError.of("BAA311", ["exit", "a whole number", "1", describeType(code)], {
          span: ctx.span,
        });
      }
      return interpreter.exit(code);
    },
  },
];

export const PRELUDE_NAMES: readonly string[] = PRELUDE.map((entry) => entry.name);

export function createPrelude(interpreter: Interpreter): Map<string, Value> {
  const bindings = new Map<string, Value>();
  for (const entry of PRELUDE) {
    bindings.set(
      entry.name,
      new NativeFunction(entry.name, entry.min, entry.max, entry.build(interpreter), entry.doc),
    );
  }
  return bindings;
}

export function preludeDocs(): Array<{ name: string; arity: string; doc: string }> {
  return PRELUDE.map((entry) => ({
    name: entry.name,
    arity: entry.min === entry.max ? String(entry.min) : `${entry.min}-${entry.max}`,
    doc: entry.doc,
  }));
}
