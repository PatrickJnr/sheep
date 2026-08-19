/**
 * `meadow`: time and chance.
 *
 * The meadow is where things happen: the clock ticks and the dice roll. Time is
 * exposed as milliseconds since the Unix epoch plus a small calendar helper.
 * Randomness comes from the host, so `baa run --seed 42` makes every program
 * that uses this module reproducible.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { BaaArray, BaaRange } from "../runtime/values.ts";
import type { Value } from "../runtime/values.ts";
import { argAny, argArray, argInt, argNumber, argString, defineModule, fn, mapOf } from "./define.ts";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function createMeadow(host: RuntimeHost) {
  return defineModule("meadow", {
    now: fn(0, 0, "Milliseconds since 1970-01-01 UTC.", () => host.now()),

    clock: fn(0, 0, "High-resolution milliseconds, for measuring durations.", () =>
      performance.now(),
    ),

    parts: fn(0, 2, "Break a timestamp into calendar parts (UTC, or at an offset).", (args, ctx) => {
      const millis = args.length > 0 ? argNumber("meadow.parts", args, 0, ctx.span) : host.now();
      const offset = args.length > 1 ? offsetMinutes("meadow.parts", args, 1, ctx.span) : 0;
      const date = new Date(millis + offset * 60_000);
      if (Number.isNaN(date.getTime())) {
        throw BaaError.of("BAA301", ["meadow.parts got a timestamp that is not a real date"], {
          span: ctx.span,
        });
      }
      return mapOf({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        millisecond: date.getUTCMilliseconds(),
        weekday: DAYS[date.getUTCDay()]!,
        month_name: MONTHS[date.getUTCMonth()]!,
        offset,
      });
    }),

    format: fn(1, 2, "Format a timestamp as YYYY-MM-DD or with a pattern.", (args, ctx) => {
      const millis = argNumber("meadow.format", args, 0, ctx.span);
      const pattern =
        args.length > 1 ? argString("meadow.format", args, 1, ctx.span) : "YYYY-MM-DD";
      const date = new Date(millis);
      if (Number.isNaN(date.getTime())) {
        throw BaaError.of("BAA301", ["meadow.format got a timestamp that is not a real date"], {
          span: ctx.span,
        });
      }
      const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
      return pattern
        .replace(/YYYY/g, String(date.getUTCFullYear()))
        .replace(/MM/g, pad(date.getUTCMonth() + 1))
        .replace(/DD/g, pad(date.getUTCDate()))
        .replace(/hh/g, pad(date.getUTCHours()))
        .replace(/mm/g, pad(date.getUTCMinutes()))
        .replace(/ss/g, pad(date.getUTCSeconds()));
    }),

    iso: fn(0, 2, "ISO-8601 text for a timestamp (default: now, UTC).", (args, ctx) => {
      const millis = args.length > 0 ? argNumber("meadow.iso", args, 0, ctx.span) : host.now();
      const offset = args.length > 1 ? offsetMinutes("meadow.iso", args, 1, ctx.span) : 0;
      const date = new Date(millis + offset * 60_000);
      if (Number.isNaN(date.getTime())) {
        throw BaaError.of("BAA301", ["meadow.iso got a timestamp that is not a real date"], {
          span: ctx.span,
        });
      }
      // `toISOString` always writes `Z`, which would be a lie once an offset
      // has been applied: the same instant, written as the local clock reads
      // it, ends in `+01:00`.
      return offset === 0
        ? date.toISOString()
        : `${date.toISOString().slice(0, -1)}${offsetSuffix(offset)}`;
    }),

    duration: fn(1, 1, "Break a length of time in milliseconds into parts.", (args, ctx) => {
      const millis = argNumber("meadow.duration", args, 0, ctx.span);
      if (!Number.isFinite(millis)) {
        throw BaaError.of("BAA301", ["meadow.duration needs a finite number of milliseconds"], {
          span: ctx.span,
        });
      }
      const total = Math.trunc(Math.abs(millis));
      return mapOf({
        negative: millis < 0,
        days: Math.floor(total / 86_400_000),
        hours: Math.floor(total / 3_600_000) % 24,
        minutes: Math.floor(total / 60_000) % 60,
        seconds: Math.floor(total / 1000) % 60,
        milliseconds: total % 1000,
        total_seconds: total / 1000,
      });
    }),

    format_duration: fn(1, 1, "A length of time as `1d 2h 3m 4s`.", (args, ctx) =>
      formatDuration(argNumber("meadow.format_duration", args, 0, ctx.span), ctx.span),
    ),

    parse_iso: fn(1, 1, "Parse ISO-8601 text into a timestamp, or nil.", (args, ctx) => {
      const value = Date.parse(argString("meadow.parse_iso", args, 0, ctx.span));
      return Number.isNaN(value) ? null : value;
    }),

    random: fn(0, 0, "A random number in [0, 1).", () => host.random()),

    random_int: fn(2, 2, "A random whole number between low and high, inclusive.", (args, ctx) => {
      const low = argInt("meadow.random_int", args, 0, ctx.span);
      const high = argInt("meadow.random_int", args, 1, ctx.span);
      if (low > high) {
        throw BaaError.of("BAA311", ["meadow.random_int", "low <= high", "1", "a low bound above the high bound"], {
          span: ctx.span,
        });
      }
      return low + Math.floor(host.random() * (high - low + 1));
    }),

    pick: fn(1, 1, "A random item from an array or range, or nil when empty.", (args, ctx) => {
      const source = argAny(args, 0);
      const items =
        source instanceof BaaRange ? [...source.values()] : argArray("meadow.pick", args, 0, ctx.span).items;
      if (items.length === 0) return null;
      return items[Math.floor(host.random() * items.length)]!;
    }),

    shuffle: fn(1, 1, "A shuffled copy of an array.", (args, ctx) => {
      const items = [...argArray("meadow.shuffle", args, 0, ctx.span).items];
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(host.random() * (i + 1));
        const temporary = items[i]!;
        items[i] = items[j]!;
        items[j] = temporary;
      }
      return new BaaArray(items);
    }),

    sample: fn(2, 2, "n random items from an array, without repeats.", (args, ctx) => {
      const items = [...argArray("meadow.sample", args, 0, ctx.span).items];
      const count = argInt("meadow.sample", args, 1, ctx.span);
      if (count < 0 || count > items.length) {
        throw BaaError.of("BAA311", ["meadow.sample", `0 to ${items.length}`, "2", String(count)], {
          span: ctx.span,
          note: "cannot take more items than the array holds",
        });
      }
      const out: Value[] = [];
      for (let i = 0; i < count; i++) {
        const index = Math.floor(host.random() * items.length);
        out.push(items.splice(index, 1)[0]!);
      }
      return new BaaArray(out);
    }),
  });
}

/**
 * A UTC offset in minutes, checked.
 *
 * Real zones run from -12:00 to +14:00, and the offsets that exist are whole
 * minutes. Anything outside that is a mistake worth naming rather than a
 * timestamp shifted somewhere impossible.
 */
function offsetMinutes(
  name: string,
  args: readonly Value[],
  index: number,
  span: Span,
): number {
  const value = argNumber(name, args, index, span);
  if (!Number.isInteger(value) || value < -12 * 60 || value > 14 * 60) {
    throw BaaError.of(
      "BAA311",
      [name, "a whole-minute UTC offset between -720 and 840", String(index + 1), String(value)],
      { span, note: "no time zone is that far from UTC" },
    );
  }
  return value;
}

/** `+01:00`, `-05:30`, the way ISO-8601 writes an offset. */
function offsetSuffix(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const total = Math.abs(minutes);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/**
 * `1d 2h 3m 4s`, leaving out the units above the largest one that applies.
 *
 * Zero is `0s` rather than an empty string, and a negative length keeps its
 * sign: a duration of nothing and a duration measured backwards are both
 * things a program can end up with, and neither should print as nothing.
 */
function formatDuration(millis: number, span: Span): string {
  if (!Number.isFinite(millis)) {
    throw BaaError.of("BAA301", ["meadow.format_duration needs a finite number of milliseconds"], {
      span,
    });
  }
  const total = Math.trunc(Math.abs(millis));
  const parts: string[] = [];
  const days = Math.floor(total / 86_400_000);
  const hours = Math.floor(total / 3_600_000) % 24;
  const minutes = Math.floor(total / 60_000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const rest = total % 1000;
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length > 0 || rest === 0) parts.push(`${seconds}s`);
  if (parts.length === 0) parts.push(`${rest}ms`);
  return `${millis < 0 ? "-" : ""}${parts.join(" ")}`;
}
