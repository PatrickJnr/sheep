/**
 * `gate`: the way in and out. Reading a web request and writing a reply.
 *
 * A gate is where things enter and leave a field, which is what a request and
 * a response are. `shepherd` is the outside world in general; `gate` is the
 * one shape of it a page has to deal with.
 *
 * The protocol is CGI, which is not fashionable and is exactly right here. A
 * Baa program is a short-lived synchronous process that reads the environment,
 * reads stdin and writes stdout: that is precisely what CGI asks for, so this
 * module is a reading of things that already exist rather than a new
 * capability. Nothing here opens a socket. Apache, nginx and `baa serve` all
 * speak it, and shared hosting has run it for thirty years.
 *
 *     import gate
 *
 *     gate.html("<h1>Baa, {gate.escape(gate.query().get("name", "world"))}!</h1>")
 *
 * Escaping. `gate.escape` and `gate.fill` exist because the alternative is
 * every page having a cross-site scripting hole in its first line.
 * `gate.fill` escapes each value it interpolates, so it is the one to reach
 * for; `gate.html` sends what it is given untouched, for markup you built
 * yourself.
 */

import { readSync } from "node:fs";

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { BaaMap, display } from "../runtime/values.ts";
import type { MapKey, Value } from "../runtime/values.ts";
import { argAny, argInt, argString, defineModule, fn } from "./define.ts";
import { encodeJson } from "./lamb.ts";
import { escapeHtml, safeUrl } from "./wool.ts";

/** Status codes with a reason phrase worth sending. */
const REASONS: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  418: "I'm a teapot",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/**
 * Largest request body read into memory.
 *
 * CONTENT_LENGTH arrives from the client, so it is a number an attacker
 * chooses. Without a ceiling, a claimed length is an allocation request.
 */
const MAX_BODY = 8 * 1024 * 1024;

type Reply = {
  status: number;
  readonly headers: Map<string, string>;
  sent: boolean;
};

export function createGate(host: RuntimeHost) {
  const reply: Reply = { status: 200, headers: new Map(), sent: false };
  let body: string | null = null;

  const envOf = (name: string): string => host.envVar(name) ?? "";

  /**
   * Read the body once, bounded by CONTENT_LENGTH.
   *
   * Read directly rather than through `shepherd.read_all`, which splits on
   * newlines and rejoins them: that is lossy for a body whose exact bytes
   * matter, and it would block waiting for end-of-input on a connection the
   * server is keeping open.
   */
  const readBody = (span: import("../diagnostics/source.ts").Span): string => {
    if (body !== null) return body;
    const declared = Number(envOf("CONTENT_LENGTH"));
    if (!Number.isFinite(declared) || declared <= 0) {
      body = "";
      return body;
    }
    if (declared > MAX_BODY) {
      throw BaaError.of("BAA312", ["gate.body", String(declared), String(MAX_BODY)], {
        span,
        note: "request body too large",
        help: "Reject it with `gate.status(413)` before reading, or raise the limit upstream.",
      });
    }
    const buffer = Buffer.alloc(declared);
    let filled = 0;
    while (filled < declared) {
      let read = 0;
      try {
        read = readSync(0, buffer, filled, declared - filled, null);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") continue;
        if (code === "EOF") break;
        throw error;
      }
      // A client that promised more than it sent must not hang the process.
      if (read === 0) break;
      filled += read;
    }
    body = buffer.subarray(0, filled).toString("utf8");
    return body;
  };

  /** Write the status line and headers, once, before any body. */
  const sendHead = (): void => {
    if (reply.sent) return;
    reply.sent = true;
    if (!reply.headers.has("content-type")) {
      reply.headers.set("content-type", "text/html; charset=utf-8");
    }
    const reason = REASONS[reply.status] ?? "OK";
    host.write(`Status: ${reply.status} ${reason}\r\n`);
    for (const [name, value] of reply.headers) {
      host.write(`${name}: ${value}\r\n`);
    }
    host.write("\r\n");
  };

  const alreadySent = (name: string, span: import("../diagnostics/source.ts").Span): BaaError =>
    BaaError.of("BAA301", [`gate.${name} was called after the reply had already started`], {
      span,
      note: "headers are already on the wire",
      help: "Set the status and headers before the first `gate.send`, `html`, `fill`, `json` or `text`.",
    });

  const write = (text: string): Value => {
    sendHead();
    host.write(text);
    return null;
  };

  return defineModule("gate", {
    // ---------------------------------------------------------- the request

    method: fn(0, 0, "The request method, uppercase. Defaults to GET.", () =>
      (envOf("REQUEST_METHOD") || "GET").toUpperCase(),
    ),

    path: fn(0, 0, "The path below the script, or \"/\".", () => {
      const info = envOf("PATH_INFO");
      return info.length > 0 ? info : "/";
    }),

    query: fn(0, 0, "The query string parsed into a map.", () => parseForm(envOf("QUERY_STRING"))),

    query_string: fn(0, 0, "The raw, undecoded query string.", () => envOf("QUERY_STRING")),

    body: fn(0, 0, "The request body as text.", (_args, ctx) => readBody(ctx.span)),

    form: fn(0, 0, "A urlencoded request body parsed into a map.", (_args, ctx) => {
      const type = envOf("CONTENT_TYPE").toLowerCase();
      if (type.length > 0 && !type.startsWith("application/x-www-form-urlencoded")) {
        return new BaaMap();
      }
      return parseForm(readBody(ctx.span));
    }),

    header: fn(1, 2, "A request header, or a fallback when it is absent.", (args, ctx) => {
      const name = argString("gate.header", args, 0, ctx.span);
      const value = host.envVar(cgiHeaderName(name));
      return value ?? (args.length > 1 ? args[1]! : null);
    }),

    headers: fn(0, 0, "Every request header as a map, in Header-Case.", () => {
      const entries = new Map<MapKey, Value>();
      for (const [key, value] of Object.entries(host.envVars())) {
        if (key.startsWith("HTTP_")) entries.set(headerCase(key.slice(5)), value);
        else if (key === "CONTENT_TYPE" || key === "CONTENT_LENGTH") {
          entries.set(headerCase(key), value);
        }
      }
      return new BaaMap(entries);
    }),

    cookies: fn(0, 0, "The Cookie header parsed into a map.", () => {
      const entries = new Map<MapKey, Value>();
      for (const pair of (host.envVar("HTTP_COOKIE") ?? "").split(";")) {
        const equals = pair.indexOf("=");
        if (equals < 1) continue;
        entries.set(pair.slice(0, equals).trim(), decodeOrRaw(pair.slice(equals + 1).trim()));
      }
      return new BaaMap(entries);
    }),

    // --------------------------------------------------------- the response

    status: fn(1, 1, "Set the status code. Must come before the reply starts.", (args, ctx) => {
      const code = argInt("gate.status", args, 0, ctx.span);
      if (reply.sent) throw alreadySent("status", ctx.span);
      if (code < 100 || code > 599) {
        throw BaaError.of("BAA311", ["gate.status", "a code from 100 to 599", "1", String(code)], {
          span: ctx.span,
        });
      }
      reply.status = code;
      return null;
    }),

    set_header: fn(2, 2, "Set a response header. Must come before the reply starts.", (args, ctx) => {
      const name = argString("gate.set_header", args, 0, ctx.span);
      const value = argString("gate.set_header", args, 1, ctx.span);
      if (reply.sent) throw alreadySent("set_header", ctx.span);
      // A newline here would let a caller inject headers, or a whole second
      // response, out of what looks like an ordinary value.
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        throw BaaError.of("BAA311", ["gate.set_header", "a value without line breaks", "2", "a line break"], {
          span: ctx.span,
          note: "response splitting",
          help: "Strip carriage returns and newlines from anything a request supplied.",
        });
      }
      reply.headers.set(name.toLowerCase(), value);
      return null;
    }),

    text: fn(1, 1, "Reply with plain text.", (args) => {
      if (!reply.sent) reply.headers.set("content-type", "text/plain; charset=utf-8");
      return write(display(argAny(args, 0)));
    }),

    html: fn(1, 1, "Reply with HTML, exactly as given. Escape values yourself.", (args) =>
      write(display(argAny(args, 0))),
    ),

    fill: fn(
      1,
      Number.MAX_SAFE_INTEGER,
      "Reply with HTML, escaping each value put into a `%s`. The safe way to build a page.",
      (args, ctx) => {
        const template = argString("gate.fill", args, 0, ctx.span);
        return write(fillTemplate("gate.fill", template, args.slice(1), ctx.span));
      },
    ),

    json: fn(1, 1, "Reply with a value encoded as JSON.", (args, ctx) => {
      if (!reply.sent) reply.headers.set("content-type", "application/json; charset=utf-8");
      return write(encodeJson(argAny(args, 0), ctx.span));
    }),

    redirect: fn(1, 2, "Reply with a redirect (303 by default).", (args, ctx) => {
      const target = argString("gate.redirect", args, 0, ctx.span);
      if (reply.sent) throw alreadySent("redirect", ctx.span);
      if (/[\r\n]/.test(target)) {
        throw BaaError.of("BAA311", ["gate.redirect", "a location without line breaks", "1", "a line break"], {
          span: ctx.span,
          note: "response splitting",
        });
      }
      reply.status = args.length > 1 ? argInt("gate.redirect", args, 1, ctx.span) : 303;
      reply.headers.set("location", target);
      return write("");
    }),

    // ----------------------------------------------------------- escaping

    escape: fn(1, 1, "Escape a value for HTML. Same as `wool.escape_html`.", (args) =>
      escapeHtml(display(argAny(args, 0))),
    ),

    // Escaping and scheme-checking are different jobs. `escape` makes a value
    // safe to *display*; this makes one safe to *follow*. A link built from
    // request data needs both, because `javascript:alert(1)` contains nothing
    // for `escape` to change.
    safe_url: fn(1, 2, "A URL if its scheme is safe to link to, else a fallback (default \"#\").", (args, ctx) => {
      const url = safeUrl(argString("gate.safe_url", args, 0, ctx.span));
      return url ?? (args.length > 1 ? args[1]! : "#");
    }),

    format: fn(
      1,
      Number.MAX_SAFE_INTEGER,
      "Build HTML, escaping each value put into a `%s`, without sending it.",
      (args, ctx) =>
        fillTemplate("gate.format", argString("gate.format", args, 0, ctx.span), args.slice(1), ctx.span),
    ),
  });
}

/**
 * Fill `%s` placeholders, escaping every value.
 *
 * Deliberately the same shape as `wool.format`, so the safe one is no harder
 * to write than the unsafe one. `%%` is a literal percent.
 */
function fillTemplate(
  fnName: string,
  template: string,
  values: readonly Value[],
  span: import("../diagnostics/source.ts").Span,
): string {
  let index = 0;
  let missing = false;
  const out = template.replace(/%%|%s/g, (match) => {
    if (match === "%%") return "%";
    if (index >= values.length) {
      missing = true;
      return match;
    }
    return escapeHtml(display(values[index++] ?? null));
  });
  if (missing) {
    throw BaaError.of(
      "BAA301",
      [`${fnName}: the template has more \`%s\` placeholders than values (${values.length} given)`],
      { span, note: "not enough values" },
    );
  }
  return out;
}

/**
 * Parse `a=1&b=2` into a map.
 *
 * Repeated keys keep the last value, which is what a form post means by them.
 * A key with no `=` maps to an empty string rather than being dropped, so
 * `?debug` is visible to `has("debug")`.
 */
function parseForm(text: string): BaaMap {
  const entries = new Map<MapKey, Value>();
  for (const pair of text.split("&")) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? "" : pair.slice(equals + 1);
    entries.set(decodeOrRaw(rawKey), decodeOrRaw(rawValue));
  }
  return new BaaMap(entries);
}

/**
 * Percent-decode, treating `+` as a space.
 *
 * Malformed input keeps its raw text rather than throwing: a request is not a
 * program's fault, and a page that dies on `%zz` is a page an attacker can
 * take down with one URL.
 */
function decodeOrRaw(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function cgiHeaderName(name: string): string {
  const upper = name.toUpperCase().replace(/-/g, "_");
  return upper === "CONTENT_TYPE" || upper === "CONTENT_LENGTH" ? upper : `HTTP_${upper}`;
}

function headerCase(name: string): string {
  return name
    .toLowerCase()
    .split("_")
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("-");
}
