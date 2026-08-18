/**
 * Built-in methods on Baa values.
 *
 * `"wool".upper()`, `flock.length()` and `meadow.map(fn)` all resolve here.
 * Methods are looked up in a per-type table and returned as a `NativeFunction`
 * closed over the receiver, so they are ordinary first-class values:
 *
 *     let shout = "baa".upper
 *     baa shout()          // BAA
 *
 * Method names are deliberately boring. The sheep jokes live in module names,
 * error messages and documentation: not in the API you have to remember at
 * 2am.
 */

import { BaaError, suggest } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import {
  BaaArray,
  BaaFunction,
  BaaMap,
  BaaRange,
  checkSize,
  describeType,
  display,
  formatNumber,
  inspect,
  isMapKey,
  NativeFunction,
  typeOf,
  valuesEqual,
} from "./values.ts";
import type { MapKey, NativeContext, Value } from "./values.ts";

type MethodImpl = (self: never, args: Value[], ctx: NativeContext) => Value;

type MethodSpec = {
  readonly min: number;
  readonly max: number;
  readonly doc: string;
  readonly impl: MethodImpl;
};

function method(min: number, max: number, doc: string, impl: MethodImpl): MethodSpec {
  return { min, max, doc, impl };
}

function argOf(args: readonly Value[], index: number): Value {
  return args[index] ?? null;
}

function needNumber(name: string, args: readonly Value[], index: number, span: Span): number {
  const value = argOf(args, index);
  if (typeof value !== "number") {
    throw BaaError.of("BAA311", [name, "a number", String(index + 1), typeOf(value)], {
      span,
      note: "wrong type here",
    });
  }
  return value;
}

function needString(name: string, args: readonly Value[], index: number, span: Span): string {
  const value = argOf(args, index);
  if (typeof value !== "string") {
    throw BaaError.of("BAA311", [name, "a string", String(index + 1), typeOf(value)], {
      span,
      note: "wrong type here",
    });
  }
  return value;
}

function needIndex(name: string, args: readonly Value[], index: number, span: Span): number {
  const value = needNumber(name, args, index, span);
  if (!Number.isInteger(value)) {
    throw BaaError.of("BAA311", [name, "a whole number", String(index + 1), "a fraction"], {
      span,
      note: "indexes must be whole numbers",
    });
  }
  return value;
}

function needKey(name: string, args: readonly Value[], index: number, span: Span): MapKey {
  const value = argOf(args, index);
  if (!isMapKey(value)) {
    throw BaaError.of(
      "BAA311",
      [name, "a string, number, bool or nil", String(index + 1), typeOf(value)],
      { span, note: "cannot be used as a map key" },
    );
  }
  return value;
}

/** Normalise a possibly-negative index against a length. */
function normalise(index: number, length: number): number {
  return index < 0 ? length + index : index;
}

function compareValues(a: Value, b: Value, span: Span): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  throw BaaError.of("BAA302", ["compare", describeType(a), describeType(b)], {
    span,
    note: "sorting needs values of the same comparable type",
    help: "Pass a comparison function: `flock.sort(fn(a, b) { return a.age - b.age })`.",
  });
}

// --------------------------------------------------------------------------
// Universal methods, available on every value
// --------------------------------------------------------------------------

const UNIVERSAL: Record<string, MethodSpec> = {
  to_string: method(0, 0, "Text form of this value.", (self) => display(self as Value)),
  inspect: method(0, 0, "Developer-facing form, with quotes.", (self) =>
    inspect(self as Value),
  ),
  type_of: method(0, 0, "Name of this value's type.", (self) => typeOf(self as Value)),
};

// --------------------------------------------------------------------------
// Strings
// --------------------------------------------------------------------------

const STRING_METHODS: Record<string, MethodSpec> = {
  length: method(0, 0, "Number of characters.", (self) => [...(self as string)].length),
  is_empty: method(0, 0, "True when the string has no characters.", (self) =>
    (self as string).length === 0,
  ),
  upper: method(0, 0, "Uppercase copy.", (self) => (self as string).toUpperCase()),
  lower: method(0, 0, "Lowercase copy.", (self) => (self as string).toLowerCase()),
  trim: method(0, 0, "Copy without leading or trailing whitespace.", (self) =>
    (self as string).trim(),
  ),
  trim_start: method(0, 0, "Copy without leading whitespace.", (self) =>
    (self as string).trimStart(),
  ),
  trim_end: method(0, 0, "Copy without trailing whitespace.", (self) =>
    (self as string).trimEnd(),
  ),
  contains: method(1, 1, "True when the string contains a substring.", (self, args, ctx) =>
    (self as string).includes(needString("contains", args, 0, ctx.span)),
  ),
  starts_with: method(1, 1, "True when the string starts with a prefix.", (self, args, ctx) =>
    (self as string).startsWith(needString("starts_with", args, 0, ctx.span)),
  ),
  ends_with: method(1, 1, "True when the string ends with a suffix.", (self, args, ctx) =>
    (self as string).endsWith(needString("ends_with", args, 0, ctx.span)),
  ),
  index_of: method(1, 1, "First index of a substring, or -1.", (self, args, ctx) => {
    // Counted in characters, not UTF-16 units, so the result can be handed
    // straight back to `slice` or `[]` on a string containing emoji.
    const text = self as string;
    const found = text.indexOf(needString("index_of", args, 0, ctx.span));
    return found <= 0 ? found : [...text.slice(0, found)].length;
  }),
  split: method(0, 1, "Split into an array on a separator.", (self, args, ctx) => {
    const text = self as string;
    if (args.length === 0) return new BaaArray([...text]);
    const separator = needString("split", args, 0, ctx.span);
    if (separator === "") return new BaaArray([...text]);
    return new BaaArray(text.split(separator));
  }),
  lines: method(0, 0, "Split into an array of lines.", (self) =>
    new BaaArray((self as string).split("\n")),
  ),
  chars: method(0, 0, "Array of single-character strings.", (self) =>
    new BaaArray([...(self as string)]),
  ),
  replace: method(2, 2, "Replace the first occurrence.", (self, args, ctx) =>
    (self as string).replace(
      needString("replace", args, 0, ctx.span),
      needString("replace", args, 1, ctx.span),
    ),
  ),
  replace_all: method(2, 2, "Replace every occurrence.", (self, args, ctx) =>
    (self as string).replaceAll(
      needString("replace_all", args, 0, ctx.span),
      needString("replace_all", args, 1, ctx.span),
    ),
  ),
  slice: method(1, 2, "Substring from start (inclusive) to end (exclusive).", (self, args, ctx) => {
    const chars = [...(self as string)];
    const start = normalise(needIndex("slice", args, 0, ctx.span), chars.length);
    const end =
      args.length > 1
        ? normalise(needIndex("slice", args, 1, ctx.span), chars.length)
        : chars.length;
    return chars.slice(Math.max(0, start), Math.max(0, end)).join("");
  }),
  repeat: method(1, 1, "Repeat the string n times.", (self, args, ctx) => {
    const count = needIndex("repeat", args, 0, ctx.span);
    if (count < 0) {
      throw BaaError.of("BAA311", ["repeat", "a count of 0 or more", "1", "a negative number"], {
        span: ctx.span,
      });
    }
    checkSize("repeat", count * (self as string).length, ctx.span);
    return (self as string).repeat(count);
  }),
  pad_start: method(1, 2, "Pad on the left to a target width.", (self, args, ctx) =>
    (self as string).padStart(
      checkSize("pad_start", needIndex("pad_start", args, 0, ctx.span), ctx.span),
      args.length > 1 ? needString("pad_start", args, 1, ctx.span) : " ",
    ),
  ),
  pad_end: method(1, 2, "Pad on the right to a target width.", (self, args, ctx) =>
    (self as string).padEnd(
      checkSize("pad_end", needIndex("pad_end", args, 0, ctx.span), ctx.span),
      args.length > 1 ? needString("pad_end", args, 1, ctx.span) : " ",
    ),
  ),
  reverse: method(0, 0, "Reversed copy.", (self) => [...(self as string)].reverse().join("")),
  to_number: method(0, 0, "Parse as a number, or nil when it isn't one.", (self) => {
    const text = (self as string).trim();
    if (text === "") return null;
    const value = Number(text);
    return Number.isNaN(value) ? null : value;
  }),
};

// --------------------------------------------------------------------------
// Arrays
// --------------------------------------------------------------------------

const ARRAY_METHODS: Record<string, MethodSpec> = {
  length: method(0, 0, "Number of items.", (self) => (self as BaaArray).items.length),
  is_empty: method(0, 0, "True when there are no items.", (self) =>
    (self as BaaArray).items.length === 0,
  ),
  push: method(1, Number.MAX_SAFE_INTEGER, "Append items; returns the array.", (self, args) => {
    const array = self as BaaArray;
    array.items.push(...args);
    return array;
  }),
  pop: method(0, 0, "Remove and return the last item, or nil.", (self) => {
    const array = self as BaaArray;
    return array.items.length === 0 ? null : array.items.pop()!;
  }),
  shift: method(0, 0, "Remove and return the first item, or nil.", (self) => {
    const array = self as BaaArray;
    return array.items.length === 0 ? null : array.items.shift()!;
  }),
  unshift: method(1, Number.MAX_SAFE_INTEGER, "Insert items at the front.", (self, args) => {
    const array = self as BaaArray;
    array.items.unshift(...args);
    return array;
  }),
  insert: method(2, 2, "Insert a value at an index.", (self, args, ctx) => {
    const array = self as BaaArray;
    const index = normalise(needIndex("insert", args, 0, ctx.span), array.items.length);
    if (index < 0 || index > array.items.length) {
      throw BaaError.of("BAA304", [String(index), "array", String(array.items.length)], {
        span: ctx.span,
      });
    }
    array.items.splice(index, 0, argOf(args, 1));
    return array;
  }),
  remove: method(1, 1, "Remove the item at an index and return it.", (self, args, ctx) => {
    const array = self as BaaArray;
    const index = normalise(needIndex("remove", args, 0, ctx.span), array.items.length);
    if (index < 0 || index >= array.items.length) {
      throw BaaError.of("BAA304", [String(index), "array", String(array.items.length)], {
        span: ctx.span,
      });
    }
    return array.items.splice(index, 1)[0]!;
  }),
  clear: method(0, 0, "Remove every item.", (self) => {
    const array = self as BaaArray;
    array.items.length = 0;
    return array;
  }),
  contains: method(1, 1, "True when a value is present.", (self, args) =>
    (self as BaaArray).items.some((item) => valuesEqual(item, argOf(args, 0))),
  ),
  index_of: method(1, 1, "First index of a value, or -1.", (self, args) =>
    (self as BaaArray).items.findIndex((item) => valuesEqual(item, argOf(args, 0))),
  ),
  first: method(0, 0, "First item, or nil.", (self) => (self as BaaArray).items[0] ?? null),
  last: method(0, 0, "Last item, or nil.", (self) => {
    const items = (self as BaaArray).items;
    return items[items.length - 1] ?? null;
  }),
  slice: method(1, 2, "Sub-array from start (inclusive) to end (exclusive).", (self, args, ctx) => {
    const items = (self as BaaArray).items;
    const start = normalise(needIndex("slice", args, 0, ctx.span), items.length);
    const end =
      args.length > 1 ? normalise(needIndex("slice", args, 1, ctx.span), items.length) : items.length;
    return new BaaArray(items.slice(Math.max(0, start), Math.max(0, end)));
  }),
  concat: method(1, 1, "New array with another array appended.", (self, args, ctx) => {
    const other = argOf(args, 0);
    if (!(other instanceof BaaArray)) {
      throw BaaError.of("BAA311", ["concat", "an array", "1", typeOf(other)], { span: ctx.span });
    }
    return new BaaArray([...(self as BaaArray).items, ...other.items]);
  }),
  join: method(0, 1, "Join items into a string.", (self, args, ctx) => {
    const separator = args.length > 0 ? needString("join", args, 0, ctx.span) : "";
    return (self as BaaArray).items.map((item) => display(item)).join(separator);
  }),
  reverse: method(0, 0, "Reversed copy.", (self) =>
    new BaaArray([...(self as BaaArray).items].reverse()),
  ),
  map: method(1, 1, "New array with fn applied to each item.", (self, args, ctx) => {
    const fn = argOf(args, 0);
    return new BaaArray(
      (self as BaaArray).items.map((item, index) => ctx.call(fn, [item, index], ctx.span)),
    );
  }),
  filter: method(1, 1, "New array of items where fn is truthy.", (self, args, ctx) => {
    const fn = argOf(args, 0);
    return new BaaArray(
      (self as BaaArray).items.filter((item, index) =>
        truthy(ctx.call(fn, [item, index], ctx.span)),
      ),
    );
  }),
  reduce: method(2, 2, "Fold the array into a single value.", (self, args, ctx) => {
    const fn = argOf(args, 0);
    let accumulator = argOf(args, 1);
    (self as BaaArray).items.forEach((item, index) => {
      accumulator = ctx.call(fn, [accumulator, item, index], ctx.span);
    });
    return accumulator;
  }),
  for_each: method(1, 1, "Call fn with each item.", (self, args, ctx) => {
    const fn = argOf(args, 0);
    (self as BaaArray).items.forEach((item, index) => {
      ctx.call(fn, [item, index], ctx.span);
    });
    return null;
  }),
  find: method(1, 1, "First item where fn is truthy, or nil.", (self, args, ctx) => {
    const fn = argOf(args, 0);
    for (const [index, item] of (self as BaaArray).items.entries()) {
      if (truthy(ctx.call(fn, [item, index], ctx.span))) return item;
    }
    return null;
  }),
  any: method(1, 1, "True when fn is truthy for any item.", (self, args, ctx) => {
    const fn = argOf(args, 0);
    return (self as BaaArray).items.some((item, index) =>
      truthy(ctx.call(fn, [item, index], ctx.span)),
    );
  }),
  all: method(1, 1, "True when fn is truthy for every item.", (self, args, ctx) => {
    const fn = argOf(args, 0);
    return (self as BaaArray).items.every((item, index) =>
      truthy(ctx.call(fn, [item, index], ctx.span)),
    );
  }),
  count: method(0, 1, "Count items, optionally matching fn.", (self, args, ctx) => {
    const items = (self as BaaArray).items;
    if (args.length === 0) return items.length;
    const fn = argOf(args, 0);
    return items.filter((item, index) => truthy(ctx.call(fn, [item, index], ctx.span))).length;
  }),
  sort: method(0, 1, "Sorted copy; pass fn(a, b) for a custom order.", (self, args, ctx) => {
    const items = [...(self as BaaArray).items];
    if (args.length === 0) {
      items.sort((a, b) => compareValues(a, b, ctx.span));
    } else {
      const fn = argOf(args, 0);
      items.sort((a, b) => {
        const result = ctx.call(fn, [a, b], ctx.span);
        if (typeof result !== "number") {
          throw BaaError.of("BAA311", ["sort", "a number", "1", typeOf(result)], {
            span: ctx.span,
            note: "the comparison function must return a number",
            help: "Return a negative number, zero, or a positive number.",
          });
        }
        return result;
      });
    }
    return new BaaArray(items);
  }),
  unique: method(0, 0, "Copy with duplicates removed, keeping first occurrences.", (self) => {
    const out: Value[] = [];
    for (const item of (self as BaaArray).items) {
      if (!out.some((existing) => valuesEqual(existing, item))) out.push(item);
    }
    return new BaaArray(out);
  }),
  flatten: method(0, 0, "Concatenate nested arrays one level deep.", (self) => {
    const out: Value[] = [];
    for (const item of (self as BaaArray).items) {
      if (item instanceof BaaArray) out.push(...item.items);
      else out.push(item);
    }
    return new BaaArray(out);
  }),
  sum: method(0, 0, "Add every item; all items must be numbers.", (self, _args, ctx) => {
    let total = 0;
    for (const item of (self as BaaArray).items) {
      if (typeof item !== "number") {
        throw BaaError.of("BAA302", ["add", "a number", describeType(item)], {
          span: ctx.span,
          note: "every item must be a number",
        });
      }
      total += item;
    }
    return total;
  }),
};

// --------------------------------------------------------------------------
// Maps
// --------------------------------------------------------------------------

const MAP_METHODS: Record<string, MethodSpec> = {
  length: method(0, 0, "Number of entries.", (self) => (self as BaaMap).entries.size),
  is_empty: method(0, 0, "True when there are no entries.", (self) =>
    (self as BaaMap).entries.size === 0,
  ),
  get: method(1, 2, "Value for a key, or a fallback (default nil).", (self, args, ctx) => {
    const map = self as BaaMap;
    const key = needKey("get", args, 0, ctx.span);
    return map.entries.has(key) ? map.entries.get(key)! : argOf(args, 1);
  }),
  expect: method(1, 1, "Value for a key; fails when the key is missing.", (self, args, ctx) => {
    const map = self as BaaMap;
    const key = needKey("expect", args, 0, ctx.span);
    if (!map.entries.has(key)) {
      const known = [...map.entries.keys()].filter((k): k is string => typeof k === "string");
      const hint = typeof key === "string" ? suggest(key, known) : null;
      throw BaaError.of("BAA310", [inspect(key)], {
        span: ctx.span,
        note: "key not present",
        ...(hint ? { help: `Did you mean \`${hint}\`?` } : {}),
      });
    }
    return map.entries.get(key)!;
  }),
  set: method(2, 2, "Insert or replace a key; returns the map.", (self, args, ctx) => {
    const map = self as BaaMap;
    map.entries.set(needKey("set", args, 0, ctx.span), argOf(args, 1));
    return map;
  }),
  has: method(1, 1, "True when the key is present.", (self, args, ctx) =>
    (self as BaaMap).entries.has(needKey("has", args, 0, ctx.span)),
  ),
  remove: method(1, 1, "Remove a key; returns the removed value or nil.", (self, args, ctx) => {
    const map = self as BaaMap;
    const key = needKey("remove", args, 0, ctx.span);
    const value = map.entries.get(key) ?? null;
    map.entries.delete(key);
    return value;
  }),
  clear: method(0, 0, "Remove every entry.", (self) => {
    (self as BaaMap).entries.clear();
    return self as BaaMap;
  }),
  keys: method(0, 0, "Array of keys, in insertion order.", (self) =>
    new BaaArray([...(self as BaaMap).entries.keys()]),
  ),
  values: method(0, 0, "Array of values, in insertion order.", (self) =>
    new BaaArray([...(self as BaaMap).entries.values()]),
  ),
  entries: method(0, 0, "Array of [key, value] pairs.", (self) =>
    new BaaArray(
      [...(self as BaaMap).entries].map(([key, value]) => new BaaArray([key, value])),
    ),
  ),
  merge: method(1, 1, "New map with another map's entries layered on top.", (self, args, ctx) => {
    const other = argOf(args, 0);
    if (!(other instanceof BaaMap)) {
      throw BaaError.of("BAA311", ["merge", "a map", "1", typeOf(other)], { span: ctx.span });
    }
    return new BaaMap(new Map([...(self as BaaMap).entries, ...other.entries]));
  }),
  for_each: method(1, 1, "Call fn with each key and value.", (self, args, ctx) => {
    const fn = argOf(args, 0);
    for (const [key, value] of (self as BaaMap).entries) {
      ctx.call(fn, [key, value], ctx.span);
    }
    return null;
  }),
};

// --------------------------------------------------------------------------
// Ranges and numbers
// --------------------------------------------------------------------------

const RANGE_METHODS: Record<string, MethodSpec> = {
  length: method(0, 0, "How many values the range yields.", (self) => (self as BaaRange).length),
  start: method(0, 0, "First value.", (self) => (self as BaaRange).start),
  end: method(0, 0, "Bound value.", (self) => (self as BaaRange).end),
  is_empty: method(0, 0, "True when the range yields nothing.", (self) =>
    (self as BaaRange).length === 0,
  ),
  contains: method(1, 1, "True when a number falls inside the range.", (self, args, ctx) =>
    (self as BaaRange).contains(needNumber("contains", args, 0, ctx.span)),
  ),
  to_array: method(0, 0, "Materialise the range as an array.", (self, _args, ctx) => {
    const range = self as BaaRange;
    checkSize("to_array", range.length, ctx.span);
    return new BaaArray([...range.values()]);
  }),
};

const NUMBER_METHODS: Record<string, MethodSpec> = {
  abs: method(0, 0, "Absolute value.", (self) => Math.abs(self as number)),
  floor: method(0, 0, "Round down.", (self) => Math.floor(self as number)),
  ceil: method(0, 0, "Round up.", (self) => Math.ceil(self as number)),
  round: method(0, 0, "Round to the nearest whole number.", (self) => Math.round(self as number)),
  is_whole: method(0, 0, "True when the number has no fractional part.", (self) =>
    Number.isInteger(self as number),
  ),
  to_fixed: method(1, 1, "Text with a fixed number of decimal places.", (self, args, ctx) => {
    const digits = needIndex("to_fixed", args, 0, ctx.span);
    if (digits < 0 || digits > 20) {
      throw BaaError.of("BAA311", ["to_fixed", "0 to 20", "1", formatNumber(digits)], {
        span: ctx.span,
      });
    }
    return (self as number).toFixed(digits);
  }),
  clamp: method(2, 2, "Constrain between a low and high bound.", (self, args, ctx) => {
    const low = needNumber("clamp", args, 0, ctx.span);
    const high = needNumber("clamp", args, 1, ctx.span);
    return Math.min(Math.max(self as number, low), high);
  }),
};

const FUNCTION_METHODS: Record<string, MethodSpec> = {
  name: method(0, 0, "The function's declared name.", (self) => {
    const fn = self as { name?: string };
    return fn.name ?? "anonymous";
  }),
};

function truthy(value: Value): boolean {
  return value !== null && value !== false;
}

function tableFor(value: Value): Record<string, MethodSpec> | null {
  if (typeof value === "string") return STRING_METHODS;
  if (typeof value === "number") return NUMBER_METHODS;
  if (value instanceof BaaArray) return ARRAY_METHODS;
  if (value instanceof BaaMap) return MAP_METHODS;
  if (value instanceof BaaRange) return RANGE_METHODS;
  if (value instanceof NativeFunction || value instanceof BaaFunction) return FUNCTION_METHODS;
  return null;
}

/** Every method name available on a value, for `did you mean` suggestions. */
export function methodNames(value: Value): string[] {
  const table = tableFor(value);
  return [...Object.keys(UNIVERSAL), ...(table ? Object.keys(table) : [])];
}

/**
 * Look up a method. Returns `null` when the type has no such method, letting
 * the caller produce a `BAA305` with a suggestion.
 */
export function getMethod(value: Value, name: string): NativeFunction | null {
  const table = tableFor(value);
  const spec = table?.[name] ?? UNIVERSAL[name];
  if (spec === undefined) return null;
  const label = `${typeOf(value)}.${name}`;
  return new NativeFunction(
    label,
    spec.min,
    spec.max,
    (args, ctx) => spec.impl(value as never, args, ctx),
    spec.doc,
  );
}

/** Documentation rows used by `baa doctor --methods` and the docs generator. */
export function methodDocs(): Array<{ type: string; name: string; doc: string; arity: string }> {
  const tables: Array<[string, Record<string, MethodSpec>]> = [
    ["any", UNIVERSAL],
    ["string", STRING_METHODS],
    ["array", ARRAY_METHODS],
    ["map", MAP_METHODS],
    ["range", RANGE_METHODS],
    ["number", NUMBER_METHODS],
  ];
  const rows: Array<{ type: string; name: string; doc: string; arity: string }> = [];
  for (const [type, table] of tables) {
    for (const [name, spec] of Object.entries(table)) {
      const arity =
        spec.max >= Number.MAX_SAFE_INTEGER
          ? `${spec.min}+`
          : spec.min === spec.max
            ? String(spec.min)
            : `${spec.min}-${spec.max}`;
      rows.push({ type, name, doc: spec.doc, arity });
    }
  }
  return rows;
}
