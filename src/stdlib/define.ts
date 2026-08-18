/** Small helpers shared by every standard-library module. */

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import {
  BaaArray,
  BaaMap,
  BaaModule,
  describeType,
  NativeFunction,
  typeOf,
} from "../runtime/values.ts";
import type { MapKey, NativeContext, Value } from "../runtime/values.ts";

export type FnSpec = {
  readonly min: number;
  readonly max: number;
  readonly doc: string;
  readonly impl: (args: Value[], ctx: NativeContext) => Value;
};

export function fn(
  min: number,
  max: number,
  doc: string,
  impl: (args: Value[], ctx: NativeContext) => Value,
): FnSpec {
  return { min, max, doc, impl };
}

export function defineModule(name: string, specs: Record<string, FnSpec | Value>): BaaModule {
  const exports = new Map<string, Value>();
  for (const [key, spec] of Object.entries(specs)) {
    if (isFnSpec(spec)) {
      exports.set(
        key,
        new NativeFunction(`${name}.${key}`, spec.min, spec.max, spec.impl, spec.doc),
      );
    } else {
      exports.set(key, spec);
    }
  }
  return new BaaModule(name, exports);
}

function isFnSpec(value: unknown): value is FnSpec {
  return (
    typeof value === "object" &&
    value !== null &&
    "impl" in value &&
    typeof (value as FnSpec).impl === "function"
  );
}

export function wrongType(
  fnName: string,
  expected: string,
  index: number,
  value: Value,
  span: Span,
): BaaError {
  return BaaError.of("BAA311", [fnName, expected, String(index + 1), describeType(value)], {
    span,
    note: "wrong type here",
  });
}

export function argNumber(
  fnName: string,
  args: readonly Value[],
  index: number,
  span: Span,
): number {
  const value = args[index] ?? null;
  if (typeof value !== "number") throw wrongType(fnName, "a number", index, value, span);
  return value;
}

export function argInt(
  fnName: string,
  args: readonly Value[],
  index: number,
  span: Span,
): number {
  const value = argNumber(fnName, args, index, span);
  if (!Number.isInteger(value)) {
    throw wrongType(fnName, "a whole number", index, value, span);
  }
  return value;
}

export function argString(
  fnName: string,
  args: readonly Value[],
  index: number,
  span: Span,
): string {
  const value = args[index] ?? null;
  if (typeof value !== "string") throw wrongType(fnName, "a string", index, value, span);
  return value;
}

export function argArray(
  fnName: string,
  args: readonly Value[],
  index: number,
  span: Span,
): BaaArray {
  const value = args[index] ?? null;
  if (!(value instanceof BaaArray)) throw wrongType(fnName, "an array", index, value, span);
  return value;
}

export function argMap(
  fnName: string,
  args: readonly Value[],
  index: number,
  span: Span,
): BaaMap {
  const value = args[index] ?? null;
  if (!(value instanceof BaaMap)) throw wrongType(fnName, "a map", index, value, span);
  return value;
}

export function argAny(args: readonly Value[], index: number): Value {
  return args[index] ?? null;
}

export function mapOf(record: Record<string, Value>): BaaMap {
  return new BaaMap(new Map<MapKey, Value>(Object.entries(record)));
}

/** Guard filesystem paths against obviously wrong input before touching disk. */
export function checkPath(fnName: string, path: string, span: Span): string {
  if (path.length === 0) {
    throw BaaError.of("BAA311", [fnName, "a non-empty path", "1", "an empty string"], {
      span,
      note: "empty path",
    });
  }
  if (path.includes("\0")) {
    throw BaaError.of("BAA311", [fnName, "a path without NUL bytes", "1", "a NUL byte"], {
      span,
      note: "invalid path",
    });
  }
  return path;
}
