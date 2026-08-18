/**
 * `flock`: collections.
 *
 * A flock is a group, so `flock` holds the operations that work across whole
 * arrays and maps. Anything that reads naturally as a method (`items.map(f)`)
 * already is one; this module covers the shapes that don't: zipping, grouping,
 * chunking, building maps from pairs.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import {
  BaaArray,
  BaaMap,
  BaaRange,
  inspect,
  isMapKey,
  isTruthy,
  typeOf,
} from "../runtime/values.ts";
import type { MapKey, NativeContext, Value } from "../runtime/values.ts";
import { argAny, argArray, argInt, argMap, defineModule, fn } from "./define.ts";

export function createFlock() {
  return defineModule("flock", {
    of: fn(0, Number.MAX_SAFE_INTEGER, "Build an array from the arguments.", (args) =>
      new BaaArray([...args]),
    ),

    repeat: fn(2, 2, "An array with the same value repeated n times.", (args, ctx) => {
      const value = argAny(args, 0);
      const count = argInt("flock.repeat", args, 1, ctx.span);
      if (count < 0) {
        throw BaaError.of("BAA311", ["flock.repeat", "a count of 0 or more", "2", "a negative number"], {
          span: ctx.span,
        });
      }
      return new BaaArray(new Array<Value>(count).fill(value));
    }),

    zip: fn(2, 2, "Pair up two arrays, stopping at the shorter one.", (args, ctx) => {
      const left = argArray("flock.zip", args, 0, ctx.span);
      const right = argArray("flock.zip", args, 1, ctx.span);
      const length = Math.min(left.items.length, right.items.length);
      const out: Value[] = [];
      for (let i = 0; i < length; i++) {
        out.push(new BaaArray([left.items[i]!, right.items[i]!]));
      }
      return new BaaArray(out);
    }),

    chunk: fn(2, 2, "Split an array into chunks of a fixed size.", (args, ctx) => {
      const items = argArray("flock.chunk", args, 0, ctx.span);
      const size = argInt("flock.chunk", args, 1, ctx.span);
      if (size < 1) {
        throw BaaError.of("BAA311", ["flock.chunk", "a size of 1 or more", "2", "a smaller number"], {
          span: ctx.span,
        });
      }
      const out: Value[] = [];
      for (let i = 0; i < items.items.length; i += size) {
        out.push(new BaaArray(items.items.slice(i, i + size)));
      }
      return new BaaArray(out);
    }),

    group_by: fn(2, 2, "Group items into a map keyed by fn(item).", (args, ctx) => {
      const items = argArray("flock.group_by", args, 0, ctx.span);
      const keyFn = argAny(args, 1);
      const groups = new Map<MapKey, Value>();
      for (const item of items.items) {
        const key = ctx.call(keyFn, [item], ctx.span);
        if (!isMapKey(key)) {
          throw BaaError.of(
            "BAA311",
            ["flock.group_by", "a string, number, bool or nil key", "2", typeOf(key)],
            { span: ctx.span, note: "the key function returned something unusable" },
          );
        }
        const bucket = groups.get(key);
        if (bucket instanceof BaaArray) bucket.items.push(item);
        else groups.set(key, new BaaArray([item]));
      }
      return new BaaMap(groups);
    }),

    partition: fn(2, 2, "Split into [matching, rest] using a predicate.", (args, ctx) => {
      const items = argArray("flock.partition", args, 0, ctx.span);
      const predicate = argAny(args, 1);
      const yes: Value[] = [];
      const no: Value[] = [];
      for (const item of items.items) {
        (isTruthy(ctx.call(predicate, [item], ctx.span)) ? yes : no).push(item);
      }
      return new BaaArray([new BaaArray(yes), new BaaArray(no)]);
    }),

    sort_by: fn(2, 2, "Sorted copy, ordered by the key fn(item) returns.", (args, ctx) => {
      const items = argArray("flock.sort_by", args, 0, ctx.span);
      const keyFn = argAny(args, 1);
      const decorated = items.items.map((item) => ({
        item,
        key: ctx.call(keyFn, [item], ctx.span),
      }));
      decorated.sort((a, b) => {
        if (typeof a.key === "number" && typeof b.key === "number") return a.key - b.key;
        if (typeof a.key === "string" && typeof b.key === "string") {
          return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        }
        throw BaaError.of("BAA302", ["compare", typeOf(a.key), typeOf(b.key)], {
          span: ctx.span,
          note: "sort keys must be all numbers or all strings",
        });
      });
      return new BaaArray(decorated.map((entry) => entry.item));
    }),

    min_by: fn(2, 2, "Item with the smallest fn(item), or nil when empty.", (args, ctx) =>
      pickBy(args, ctx, -1),
    ),

    max_by: fn(2, 2, "Item with the largest fn(item), or nil when empty.", (args, ctx) =>
      pickBy(args, ctx, 1),
    ),

    to_map: fn(1, 1, "Build a map from an array of [key, value] pairs.", (args, ctx) => {
      const pairs = argArray("flock.to_map", args, 0, ctx.span);
      const entries = new Map<MapKey, Value>();
      for (const pair of pairs.items) {
        if (!(pair instanceof BaaArray) || pair.items.length !== 2) {
          throw BaaError.of("BAA311", ["flock.to_map", "an array of [key, value] pairs", "1", inspect(pair)], {
            span: ctx.span,
          });
        }
        const key = pair.items[0]!;
        if (!isMapKey(key)) {
          throw BaaError.of("BAA311", ["flock.to_map", "a usable map key", "1", typeOf(key)], {
            span: ctx.span,
          });
        }
        entries.set(key, pair.items[1]!);
      }
      return new BaaMap(entries);
    }),

    from_keys: fn(2, 2, "Build a map giving every key the same value.", (args, ctx) => {
      const keys = argArray("flock.from_keys", args, 0, ctx.span);
      const value = argAny(args, 1);
      const entries = new Map<MapKey, Value>();
      for (const key of keys.items) {
        if (!isMapKey(key)) {
          throw BaaError.of("BAA311", ["flock.from_keys", "usable map keys", "1", typeOf(key)], {
            span: ctx.span,
          });
        }
        entries.set(key, value);
      }
      return new BaaMap(entries);
    }),

    invert: fn(1, 1, "Swap a map's keys and values.", (args, ctx) => {
      const map = argMap("flock.invert", args, 0, ctx.span);
      const entries = new Map<MapKey, Value>();
      for (const [key, value] of map.entries) {
        if (!isMapKey(value)) {
          throw BaaError.of("BAA311", ["flock.invert", "values usable as keys", "1", typeOf(value)], {
            span: ctx.span,
          });
        }
        entries.set(value, key);
      }
      return new BaaMap(entries);
    }),

    range: fn(1, 3, "An array of numbers: range(end), range(start, end[, step]).", (args, ctx) => {
      const first = argInt("flock.range", args, 0, ctx.span);
      const start = args.length === 1 ? 0 : first;
      const end = args.length === 1 ? first : argInt("flock.range", args, 1, ctx.span);
      const step = args.length > 2 ? argInt("flock.range", args, 2, ctx.span) : 1;
      if (step === 0) {
        throw BaaError.of("BAA311", ["flock.range", "a non-zero step", "3", "zero"], {
          span: ctx.span,
        });
      }
      const out: Value[] = [];
      if (step > 0) for (let i = start; i < end; i += step) out.push(i);
      else for (let i = start; i > end; i += step) out.push(i);
      return new BaaArray(out);
    }),

    to_array: fn(1, 1, "Turn a range, string or map into an array.", (args, ctx) => {
      const value = argAny(args, 0);
      if (value instanceof BaaArray) return new BaaArray([...value.items]);
      if (value instanceof BaaRange) return new BaaArray([...value.values()]);
      if (typeof value === "string") return new BaaArray([...value]);
      if (value instanceof BaaMap) {
        return new BaaArray(
          [...value.entries].map(([key, entry]) => new BaaArray([key, entry])),
        );
      }
      throw BaaError.of("BAA311", ["flock.to_array", "an array, range, string or map", "1", typeOf(value)], {
        span: ctx.span,
      });
    }),
  });
}

function pickBy(args: Value[], ctx: NativeContext, direction: 1 | -1): Value {
  const items = argArray(direction === 1 ? "flock.max_by" : "flock.min_by", args, 0, ctx.span);
  const keyFn = argAny(args, 1);
  let best: Value = null;
  let bestKey: Value = null;
  for (const item of items.items) {
    const key = ctx.call(keyFn, [item], ctx.span);
    if (typeof key !== "number" && typeof key !== "string") {
      throw BaaError.of("BAA311", ["flock.min_by/max_by", "a number or string key", "2", typeOf(key)], {
        span: ctx.span,
      });
    }
    if (bestKey === null || compare(key, bestKey) * direction > 0) {
      best = item;
      bestKey = key;
    }
  }
  return best;
}

function compare(a: Value, b: Value): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
