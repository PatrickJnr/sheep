/**
 * `wool`: text.
 *
 * Wool is what you spin things out of, so `wool` is where string handling
 * lives. Most day-to-day string work is available as a method (`"baa".upper()`);
 * this module holds the operations that take more than one string, or that
 * build strings from other values.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import { BaaArray, checkSize, display, inspect } from "../runtime/values.ts";
import type { Value } from "../runtime/values.ts";
import { argAny, argArray, argInt, argString, defineModule, fn } from "./define.ts";

const CASE_BOUNDARY = /[\s_-]+/;

export function createWool() {
  return defineModule("wool", {
    join: fn(1, 2, "Join an array of values into a string.", (args, ctx) => {
      const items = argArray("wool.join", args, 0, ctx.span);
      const separator = args.length > 1 ? argString("wool.join", args, 1, ctx.span) : "";
      return items.items.map((item) => display(item)).join(separator);
    }),

    concat: fn(0, Number.MAX_SAFE_INTEGER, "Concatenate every argument as text.", (args) =>
      args.map((item) => display(item)).join(""),
    ),

    // `%s` rather than `{}` because `{...}` inside a string literal is already
    // interpolation. A template that lives in a data file has no interpolation
    // available, which is exactly when this function earns its keep.
    format: fn(
      1,
      Number.MAX_SAFE_INTEGER,
      'Fill `%s` placeholders in order: `wool.format("%s of %s", 3, 10)`. `%%` is a literal percent.',
      (args, ctx) => {
        const template = argString("wool.format", args, 0, ctx.span);
        const rest = args.slice(1);
        let index = 0;
        let missing = false;
        const out = template.replace(/%%|%s/g, (match) => {
          if (match === "%%") return "%";
          if (index >= rest.length) {
            missing = true;
            return match;
          }
          return display(rest[index++] ?? null);
        });
        if (missing) {
          throw BaaError.of(
            "BAA301",
            [`wool.format: the template has more \`%s\` placeholders than values (${rest.length} given)`],
            { span: ctx.span, note: "not enough values" },
          );
        }
        return out;
      },
    ),

    repeat: fn(2, 2, "Repeat a string n times.", (args, ctx) => {
      const text = argString("wool.repeat", args, 0, ctx.span);
      const count = argInt("wool.repeat", args, 1, ctx.span);
      if (count < 0) {
        throw BaaError.of("BAA311", ["wool.repeat", "a count of 0 or more", "2", "a negative number"], {
          span: ctx.span,
        });
      }
      checkSize("wool.repeat", count * text.length, ctx.span);
      return text.repeat(count);
    }),

    title_case: fn(1, 1, "Capitalise the first letter of each word.", (args, ctx) =>
      argString("wool.title_case", args, 0, ctx.span)
        .split(" ")
        .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
        .join(" "),
    ),

    snake_case: fn(1, 1, "Convert text to snake_case.", (args, ctx) =>
      splitWords(argString("wool.snake_case", args, 0, ctx.span))
        .map((word) => word.toLowerCase())
        .join("_"),
    ),

    camel_case: fn(1, 1, "Convert text to camelCase.", (args, ctx) => {
      const words = splitWords(argString("wool.camel_case", args, 0, ctx.span));
      return words
        .map((word, index) =>
          index === 0
            ? word.toLowerCase()
            : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join("");
    }),

    kebab_case: fn(1, 1, "Convert text to kebab-case.", (args, ctx) =>
      splitWords(argString("wool.kebab_case", args, 0, ctx.span))
        .map((word) => word.toLowerCase())
        .join("-"),
    ),

    wrap: fn(2, 2, "Wrap text to a maximum line width, breaking on spaces.", (args, ctx) => {
      const text = argString("wool.wrap", args, 0, ctx.span);
      const width = argInt("wool.wrap", args, 1, ctx.span);
      if (width < 1) {
        throw BaaError.of("BAA311", ["wool.wrap", "a width of 1 or more", "2", "a smaller number"], {
          span: ctx.span,
        });
      }
      const lines: string[] = [];
      for (const paragraph of text.split("\n")) {
        let current = "";
        for (const word of paragraph.split(" ")) {
          if (current.length === 0) current = word;
          else if (current.length + 1 + word.length <= width) current += ` ${word}`;
          else {
            lines.push(current);
            current = word;
          }
        }
        lines.push(current);
      }
      return lines.join("\n");
    }),

    center: fn(2, 3, "Centre text within a width.", (args, ctx) => {
      const text = argString("wool.center", args, 0, ctx.span);
      const width = argInt("wool.center", args, 1, ctx.span);
      const filler = args.length > 2 ? argString("wool.center", args, 2, ctx.span) : " ";
      if (filler.length === 0 || text.length >= width) return text;
      checkSize("wool.center", width, ctx.span);
      const total = width - text.length;
      const left = Math.floor(total / 2);
      return (
        filler.repeat(Math.ceil(left / filler.length)).slice(0, left) +
        text +
        filler.repeat(Math.ceil((total - left) / filler.length)).slice(0, total - left)
      );
    }),

    // Five characters, not three. `<` and `&` are enough for text between
    // tags, but a value dropped into an attribute escapes its quoting with `"`
    // or `'`, and `>` costs nothing to cover. Anything less is a rule people
    // have to remember which context they are in to apply, which is how these
    // holes appear in the first place.
    escape_html: fn(1, 1, "Escape text so it is safe inside HTML or an attribute.", (args) =>
      escapeHtml(display(argAny(args, 0))),
    ),

    // `escape_html` cannot help here. There is nothing to escape in
    // `javascript:alert(1)`: it survives escaping untouched and still runs when
    // it lands in an `href`. Scheme is a separate question from encoding, so it
    // gets a separate function.
    safe_url: fn(1, 1, "A URL if its scheme is safe to link to, otherwise nil.", (args, ctx) =>
      safeUrl(argString("wool.safe_url", args, 0, ctx.span)),
    ),

    percent_encode: fn(1, 1, "Percent-encode text for use in a URL.", (args, ctx) =>
      encodeURIComponent(argString("wool.percent_encode", args, 0, ctx.span)),
    ),

    percent_decode: fn(1, 1, "Decode percent-encoded text, or nil when it is malformed.", (args, ctx) => {
      const text = argString("wool.percent_decode", args, 0, ctx.span);
      try {
        return decodeURIComponent(text);
      } catch {
        // `%zz` and lone surrogates are the common cases. A caller reading
        // untrusted input should get nil rather than an error it has to catch.
        return null;
      }
    }),

    is_blank: fn(1, 1, "True when a string is empty or only whitespace.", (args, ctx) =>
      argString("wool.is_blank", args, 0, ctx.span).trim().length === 0,
    ),

    to_bytes: fn(1, 1, "UTF-8 byte values of a string.", (args, ctx) =>
      new BaaArray([...new TextEncoder().encode(argString("wool.to_bytes", args, 0, ctx.span))]),
    ),

    from_bytes: fn(1, 1, "Build a string from an array of UTF-8 byte values.", (args, ctx) => {
      const bytes = argArray("wool.from_bytes", args, 0, ctx.span);
      const buffer = new Uint8Array(bytes.items.length);
      bytes.items.forEach((item, index) => {
        if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255) {
          throw BaaError.of("BAA311", ["wool.from_bytes", "byte values 0-255", "1", inspect(item)], {
            span: ctx.span,
          });
        }
        buffer[index] = item;
      });
      return new TextDecoder().decode(buffer);
    }),

    inspect: fn(1, 1, "Developer-facing text for any value.", (args) => inspect(argAny(args, 0))),
  });
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Shared with `gate`, which escapes on the program's behalf. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** Schemes a link may use. Everything else, known or not, is refused. */
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel", "ftp"]);

/**
 * A URL if it is safe to put in an `href`, or `null`.
 *
 * A relative URL has no scheme and is always allowed. An absolute one is
 * allowed only from the list above: `javascript:` and `data:` both execute,
 * and neither contains a character HTML escaping would touch.
 *
 * Control characters and whitespace are stripped before the scheme is read,
 * because browsers ignore them inside a URL and `java\tscript:alert(1)` would
 * otherwise pass a naive check and still run.
 */
export function safeUrl(text: string): string | null {
  const stripped = text.replace(/[\u0000-\u0020\u007f]/g, "");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(stripped);
  if (scheme === null) return text;
  return SAFE_SCHEMES.has(scheme[1]!.toLowerCase()) ? text : null;
}

function splitWords(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.split(CASE_BOUNDARY).filter((word) => word.length > 0);
}

export type WoolValue = Value;
