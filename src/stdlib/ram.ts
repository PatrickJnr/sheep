/**
 * `ram`: arithmetic.
 *
 * A ram is the one that does the heavy butting, so it got the maths. Baa has a
 * single numeric type (IEEE-754 double), and this module is where the integer
 * flavoured operations live: `idiv`, `gcd`, `clamp`, rounding.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import { BaaArray } from "../runtime/values.ts";
import type { Value } from "../runtime/values.ts";
import { argArray, argNumber, defineModule, fn } from "./define.ts";

function numbersOf(fnName: string, array: BaaArray, span: import("../diagnostics/source.ts").Span): number[] {
  return array.items.map((item, index) => {
    if (typeof item !== "number") {
      throw BaaError.of("BAA311", [fnName, "an array of numbers", "1", `a ${typeof item} at index ${index}`], {
        span,
        note: "every item must be a number",
      });
    }
    return item;
  });
}

export function createRam() {
  return defineModule("ram", {
    PI: Math.PI,
    E: Math.E,
    TAU: Math.PI * 2,
    INF: Number.POSITIVE_INFINITY,
    NAN: Number.NaN,
    EPSILON: Number.EPSILON,
    MAX_SAFE_WHOLE: Number.MAX_SAFE_INTEGER,

    abs: fn(1, 1, "Absolute value.", (args, ctx) => Math.abs(argNumber("ram.abs", args, 0, ctx.span))),
    sign: fn(1, 1, "-1, 0 or 1.", (args, ctx) => Math.sign(argNumber("ram.sign", args, 0, ctx.span))),
    floor: fn(1, 1, "Round down.", (args, ctx) => Math.floor(argNumber("ram.floor", args, 0, ctx.span))),
    ceil: fn(1, 1, "Round up.", (args, ctx) => Math.ceil(argNumber("ram.ceil", args, 0, ctx.span))),
    trunc: fn(1, 1, "Drop the fractional part.", (args, ctx) =>
      Math.trunc(argNumber("ram.trunc", args, 0, ctx.span)),
    ),
    round: fn(1, 2, "Round to the nearest whole number, or to n decimal places.", (args, ctx) => {
      const value = argNumber("ram.round", args, 0, ctx.span);
      if (args.length === 1) return Math.round(value);
      const digits = argNumber("ram.round", args, 1, ctx.span);
      const factor = 10 ** digits;
      return Math.round(value * factor) / factor;
    }),

    sqrt: fn(1, 1, "Square root.", (args, ctx) => {
      const value = argNumber("ram.sqrt", args, 0, ctx.span);
      if (value < 0) {
        throw BaaError.of("BAA301", ["ram.sqrt of a negative number is not a real number"], {
          span: ctx.span,
          note: "negative input",
          help: "Check the sign first, or use `ram.abs(x)`.",
        });
      }
      return Math.sqrt(value);
    }),
    pow: fn(2, 2, "Raise to a power.", (args, ctx) =>
      argNumber("ram.pow", args, 0, ctx.span) ** argNumber("ram.pow", args, 1, ctx.span),
    ),
    exp: fn(1, 1, "e raised to a power.", (args, ctx) => Math.exp(argNumber("ram.exp", args, 0, ctx.span))),
    log: fn(1, 2, "Natural logarithm, or logarithm in a given base.", (args, ctx) => {
      const value = argNumber("ram.log", args, 0, ctx.span);
      if (value <= 0) {
        throw BaaError.of("BAA301", ["ram.log needs a value greater than zero"], {
          span: ctx.span,
          note: "out of domain",
        });
      }
      if (args.length === 1) return Math.log(value);
      return Math.log(value) / Math.log(argNumber("ram.log", args, 1, ctx.span));
    }),

    sin: fn(1, 1, "Sine, in radians.", (args, ctx) => Math.sin(argNumber("ram.sin", args, 0, ctx.span))),
    cos: fn(1, 1, "Cosine, in radians.", (args, ctx) => Math.cos(argNumber("ram.cos", args, 0, ctx.span))),
    tan: fn(1, 1, "Tangent, in radians.", (args, ctx) => Math.tan(argNumber("ram.tan", args, 0, ctx.span))),
    atan2: fn(2, 2, "Angle of the vector (x, y), in radians.", (args, ctx) =>
      Math.atan2(argNumber("ram.atan2", args, 0, ctx.span), argNumber("ram.atan2", args, 1, ctx.span)),
    ),
    hypot: fn(2, 2, "Length of the vector (x, y).", (args, ctx) =>
      Math.hypot(argNumber("ram.hypot", args, 0, ctx.span), argNumber("ram.hypot", args, 1, ctx.span)),
    ),

    min: fn(1, Number.MAX_SAFE_INTEGER, "Smallest of the arguments.", (args, ctx) =>
      Math.min(...args.map((_, index) => argNumber("ram.min", args, index, ctx.span))),
    ),
    max: fn(1, Number.MAX_SAFE_INTEGER, "Largest of the arguments.", (args, ctx) =>
      Math.max(...args.map((_, index) => argNumber("ram.max", args, index, ctx.span))),
    ),
    clamp: fn(3, 3, "Constrain a value between low and high.", (args, ctx) => {
      const value = argNumber("ram.clamp", args, 0, ctx.span);
      const low = argNumber("ram.clamp", args, 1, ctx.span);
      const high = argNumber("ram.clamp", args, 2, ctx.span);
      if (low > high) {
        throw BaaError.of("BAA311", ["ram.clamp", "low <= high", "2", "a low bound above the high bound"], {
          span: ctx.span,
        });
      }
      return Math.min(Math.max(value, low), high);
    }),
    lerp: fn(3, 3, "Linear interpolation between a and b.", (args, ctx) => {
      const a = argNumber("ram.lerp", args, 0, ctx.span);
      const b = argNumber("ram.lerp", args, 1, ctx.span);
      const t = argNumber("ram.lerp", args, 2, ctx.span);
      return a + (b - a) * t;
    }),

    idiv: fn(2, 2, "Integer division, rounding toward negative infinity.", (args, ctx) => {
      const a = argNumber("ram.idiv", args, 0, ctx.span);
      const b = argNumber("ram.idiv", args, 1, ctx.span);
      if (b === 0) throw BaaError.of("BAA306", [], { span: ctx.span, note: "divisor is zero" });
      return Math.floor(a / b);
    }),
    modulo: fn(2, 2, "Remainder that always takes the sign of the divisor.", (args, ctx) => {
      const a = argNumber("ram.modulo", args, 0, ctx.span);
      const b = argNumber("ram.modulo", args, 1, ctx.span);
      if (b === 0) throw BaaError.of("BAA306", [], { span: ctx.span, note: "divisor is zero" });
      return ((a % b) + b) % b;
    }),
    gcd: fn(2, 2, "Greatest common divisor of two whole numbers.", (args, ctx) => {
      let a = Math.abs(argNumber("ram.gcd", args, 0, ctx.span));
      let b = Math.abs(argNumber("ram.gcd", args, 1, ctx.span));
      while (b > 0) {
        const next = a % b;
        a = b;
        b = next;
      }
      return a;
    }),

    is_nan: fn(1, 1, "True when the value is not a number.", (args) =>
      typeof args[0] === "number" && Number.isNaN(args[0]),
    ),
    is_finite: fn(1, 1, "True when the value is a finite number.", (args) =>
      typeof args[0] === "number" && Number.isFinite(args[0]),
    ),
    is_whole: fn(1, 1, "True when the value is a whole number.", (args) =>
      typeof args[0] === "number" && Number.isInteger(args[0]),
    ),

    sum: fn(1, 1, "Add every number in an array.", (args, ctx) =>
      numbersOf("ram.sum", argArray("ram.sum", args, 0, ctx.span), ctx.span).reduce(
        (total, value) => total + value,
        0,
      ),
    ),
    mean: fn(1, 1, "Arithmetic mean of an array, or nil when empty.", (args, ctx) => {
      const numbers = numbersOf("ram.mean", argArray("ram.mean", args, 0, ctx.span), ctx.span);
      if (numbers.length === 0) return null;
      return numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }),
    median: fn(1, 1, "Median of an array, or nil when empty.", (args, ctx) => {
      const numbers = numbersOf("ram.median", argArray("ram.median", args, 0, ctx.span), ctx.span)
        .slice()
        .sort((a, b) => a - b);
      if (numbers.length === 0) return null;
      const middle = Math.floor(numbers.length / 2);
      return numbers.length % 2 === 1
        ? numbers[middle]!
        : (numbers[middle - 1]! + numbers[middle]!) / 2;
    }),

    to_binary: fn(1, 1, "Binary text for a whole number.", (args, ctx) =>
      wholeToString("ram.to_binary", args, ctx.span, 2),
    ),
    to_hex: fn(1, 1, "Hexadecimal text for a whole number.", (args, ctx) =>
      wholeToString("ram.to_hex", args, ctx.span, 16),
    ),
    parse: fn(1, 2, "Parse text as a number in a given base (default 10).", (args, ctx) => {
      const text = args[0];
      if (typeof text !== "string") {
        throw BaaError.of("BAA311", ["ram.parse", "a string", "1", typeof text], { span: ctx.span });
      }
      const base = args.length > 1 ? argNumber("ram.parse", args, 1, ctx.span) : 10;
      const trimmed = text.trim();
      // `Number("")` is 0, which would make blank text parse as a number.
      if (trimmed === "") return null;
      const value = base === 10 ? Number(trimmed) : Number.parseInt(trimmed, base);
      return Number.isNaN(value) ? null : value;
    }),
  });
}

function wholeToString(
  fnName: string,
  args: Value[],
  span: import("../diagnostics/source.ts").Span,
  radix: number,
): string {
  const value = argNumber(fnName, args, 0, span);
  if (!Number.isInteger(value)) {
    throw BaaError.of("BAA311", [fnName, "a whole number", "1", "a fraction"], { span });
  }
  return value.toString(radix);
}
