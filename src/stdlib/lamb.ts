/**
 * `lamb`: data in, data out. JSON encoding and decoding.
 *
 * Named for the newest member of the flock, because JSON is usually the first
 * thing a new program has to talk to. Encoding maps Baa values onto JSON
 * directly: `nil` is `null`, maps become objects (keys are converted to text),
 * arrays become arrays. Functions, modules and ranges have no JSON form and are
 * rejected with a clear error rather than silently dropped.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import {
  BaaArray,
  BaaFunction,
  BaaMap,
  BaaModule,
  BaaRange,
  describeType,
  formatNumber,
  NativeFunction,
} from "../runtime/values.ts";
import type { MapKey, Value } from "../runtime/values.ts";
import { argAny, argInt, argString, defineModule, fn } from "./define.ts";

export function createLamb() {
  return defineModule("lamb", {
    encode: fn(1, 2, "JSON text for a value; pass an indent for pretty output.", (args, ctx) => {
      const indent = args.length > 1 ? argInt("lamb.encode", args, 1, ctx.span) : 0;
      if (indent < 0 || indent > 10) {
        throw BaaError.of("BAA311", ["lamb.encode", "an indent of 0 to 10", "2", String(indent)], {
          span: ctx.span,
        });
      }
      return encode(argAny(args, 0), indent, 0, ctx.span, new Set());
    }),

    decode: fn(1, 1, "Parse JSON text into Baa values.", (args, ctx) => {
      const text = argString("lamb.decode", args, 0, ctx.span);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw BaaError.of("BAA301", [`invalid JSON: ${(error as Error).message}`], {
          span: ctx.span,
          note: "could not parse this text",
          help: "Use `lamb.try_decode(text)` when the input might not be valid.",
        });
      }
      return fromJson(parsed);
    }),

    try_decode: fn(1, 2, "Parse JSON text, or return a fallback (default nil).", (args, ctx) => {
      const text = argString("lamb.try_decode", args, 0, ctx.span);
      try {
        return fromJson(JSON.parse(text));
      } catch {
        return args.length > 1 ? args[1]! : null;
      }
    }),

    is_valid: fn(1, 1, "True when a string parses as JSON.", (args, ctx) => {
      try {
        JSON.parse(argString("lamb.is_valid", args, 0, ctx.span));
        return true;
      } catch {
        return false;
      }
    }),
  });
}

function keyText(key: MapKey): string {
  if (typeof key === "string") return key;
  if (key === null) return "nil";
  if (typeof key === "boolean") return key ? "true" : "false";
  return formatNumber(key);
}

/** Shared with `gate.json`, so both encode a value by the same rules. */
export function encodeJson(value: Value, span: Span, indent = 0): string {
  return encode(value, indent, 0, span, new Set());
}

function encode(
  value: Value,
  indent: number,
  depth: number,
  span: Span,
  seen: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw BaaError.of("BAA301", [`lamb.encode cannot represent ${formatNumber(value)} in JSON`], {
        span,
        note: "JSON has no infinity or nan",
        help: "Guard with `ram.is_finite(x)` before encoding.",
      });
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);

  if (value instanceof BaaFunction || value instanceof NativeFunction || value instanceof BaaModule) {
    throw BaaError.of("BAA301", [`lamb.encode cannot represent ${describeType(value)} in JSON`], {
      span,
      note: "no JSON equivalent",
    });
  }
  if (value instanceof BaaRange) {
    throw BaaError.of("BAA301", ["lamb.encode cannot represent a range in JSON"], {
      span,
      note: "no JSON equivalent",
      help: "Convert it first: `range.to_array()`.",
    });
  }
  if (seen.has(value)) {
    throw BaaError.of("BAA301", ["lamb.encode found a value that contains itself"], {
      span,
      note: "cycle detected",
      help: "JSON cannot represent cycles. Break the loop before encoding.",
    });
  }
  seen.add(value);
  try {
    const pad = indent === 0 ? "" : "\n" + " ".repeat(indent * (depth + 1));
    const closePad = indent === 0 ? "" : "\n" + " ".repeat(indent * depth);
    const separator = indent === 0 ? "," : `,${pad}`;
    const colon = indent === 0 ? ":" : ": ";

    if (value instanceof BaaArray) {
      if (value.items.length === 0) return "[]";
      const parts = value.items.map((item) => encode(item, indent, depth + 1, span, seen));
      return `[${pad}${parts.join(separator)}${closePad}]`;
    }
    if (value.entries.size === 0) return "{}";
    const parts = [...value.entries].map(
      ([key, entry]) =>
        `${JSON.stringify(keyText(key))}${colon}${encode(entry, indent, depth + 1, span, seen)}`,
    );
    return `{${pad}${parts.join(separator)}${closePad}}`;
  } finally {
    seen.delete(value);
  }
}

function fromJson(value: unknown): Value {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return new BaaArray(value.map(fromJson));
  const entries = new Map<MapKey, Value>();
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    entries.set(key, fromJson(entry));
  }
  return new BaaMap(entries);
}
