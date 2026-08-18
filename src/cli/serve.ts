/**
 * `baa serve`: run a directory of `.baa` pages over HTTP.
 *
 * This is a development server. It exists so that a page can be written and
 * looked at without configuring Apache first, and it deliberately speaks the
 * same protocol Apache will: each request runs the `.baa` file in a fresh
 * process with the CGI environment set and the request body on its standard
 * input, then parses the headers it writes back. A page that works here works
 * on the real thing, because nothing about the page's side of the conversation
 * is different.
 *
 * It is not for production. One process per request is fine for one developer
 * and wrong for the internet; it is single-threaded, has no timeouts worth the
 * name, and binds to localhost only.
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { CommandContext } from "./commands.ts";
import { bold, dim, writeLine } from "./output.ts";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));

/** Enough to serve a page and its assets. Anything else downloads. */
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** A page may not take longer than this before the server gives up on it. */
const TIMEOUT_MS = 10_000;

/** Largest request body accepted, matching `gate`'s own ceiling. */
const MAX_BODY = 8 * 1024 * 1024;

export type ServeArgs = {
  readonly dir: string | null;
  readonly port: number | null;
  readonly host: string | null;
};

export async function commandServe(args: ServeArgs, context: CommandContext): Promise<number> {
  const root = resolve(args.dir ?? ".");
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw BaaError.of("BAA404", [`${args.dir ?? "."} is not a directory`], {
      help: "Pass the directory holding your `.baa` pages, or run `baa serve` inside it.",
    });
  }

  const port = args.port ?? 8080;
  // Localhost by default. A development server that binds every interface is
  // one that ends up reachable from the coffee shop's network.
  const hostname = args.host ?? "127.0.0.1";

  const server = createServer((request, response) => {
    handle(request, response, root).catch((error: unknown) => {
      fail(response, 500, error instanceof Error ? error.message : String(error));
    });
  });

  return await new Promise<number>((resolveResult) => {
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        writeLine(`Port ${port} is already in use. Try \`baa serve --port ${port + 1}\`.`);
      } else {
        writeLine(`Could not start the server: ${error.message}`);
      }
      resolveResult(1);
    });

    server.listen(port, hostname, () => {
      writeLine(`${bold("Baa", context.colour)} is serving ${relative(process.cwd(), root) || "."}`);
      writeLine(`  http://${hostname}:${port}/`);
      writeLine(dim("  Every .baa file runs per request. Ctrl+C to stop.", context.colour));
    });

    const stop = (): void => {
      server.close(() => resolveResult(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const target = resolveTarget(root, decodeURIComponent(url.pathname));

  if (target === null) {
    fail(response, 404, `Nothing at ${url.pathname}`);
    return;
  }
  if (extname(target.file).toLowerCase() !== ".baa") {
    response.writeHead(200, {
      "content-type": TYPES[extname(target.file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(target.file).pipe(response);
    return;
  }

  const body = await readBody(request);
  if (body === null) {
    fail(response, 413, "Request body too large");
    return;
  }
  runPage(target.file, target.pathInfo, url, request, body, response, root);
}

type Target = { readonly file: string; readonly pathInfo: string };

/**
 * Map a URL onto a file.
 *
 * `/about` finds `about.baa` before `about.html`, so a directory can be
 * migrated one page at a time. A path that continues past a `.baa` file
 * becomes PATH_INFO, which is how one page serves a whole subtree.
 */
function resolveTarget(root: string, pathname: string): Target | null {
  // A URL path is always `/`-separated. `normalize` rewrites those to `\` on
  // Windows, which then splits into nothing and hides every nested route, so
  // the separators are put back before anything looks at the segments.
  const cleaned = normalize(pathname).split(sep).join("/").replace(/^\/+/, "");
  const full = resolve(root, cleaned);
  // Refuse anything that climbed out of the served directory.
  if (full !== root && !full.startsWith(root + sep)) return null;

  if (existsSync(full) && statSync(full).isDirectory()) {
    for (const name of ["index.baa", "index.html"]) {
      const index = join(full, name);
      if (existsSync(index)) return { file: index, pathInfo: "" };
    }
    return null;
  }
  if (existsSync(full) && statSync(full).isFile()) return { file: full, pathInfo: "" };

  for (const extension of [".baa", ".html"]) {
    const candidate = `${full}${extension}`;
    if (existsSync(candidate)) return { file: candidate, pathInfo: "" };
  }

  // Walk back up, looking for a .baa file that owns the rest of the path.
  const parts = cleaned.split("/").filter((part) => part.length > 0);
  for (let i = parts.length - 1; i > 0; i--) {
    const base = resolve(root, parts.slice(0, i).join("/"));
    if (base !== root && !base.startsWith(root + sep)) break;
    const candidate = `${base}.baa`;
    if (existsSync(candidate)) {
      return { file: candidate, pathInfo: `/${parts.slice(i).join("/")}` };
    }
  }
  return null;
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** The CGI environment for one request, per RFC 3875. */
function cgiEnvironment(
  file: string,
  pathInfo: string,
  url: URL,
  request: IncomingMessage,
  body: Buffer,
  root: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GATEWAY_INTERFACE: "CGI/1.1",
    SERVER_PROTOCOL: request.httpVersion === "1.0" ? "HTTP/1.0" : "HTTP/1.1",
    SERVER_SOFTWARE: "baa-serve",
    REQUEST_METHOD: request.method ?? "GET",
    REQUEST_URI: request.url ?? "/",
    QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
    SCRIPT_NAME: `/${relative(root, file).split(sep).join("/")}`,
    SCRIPT_FILENAME: file,
    DOCUMENT_ROOT: root,
    PATH_INFO: pathInfo,
    REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
    CONTENT_LENGTH: String(body.length),
  };
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const flat = Array.isArray(value) ? value.join(", ") : value;
    const key = name.toUpperCase().replace(/-/g, "_");
    if (key === "CONTENT_TYPE") env.CONTENT_TYPE = flat;
    else if (key !== "CONTENT_LENGTH") env[`HTTP_${key}`] = flat;
  }
  return env;
}

function runPage(
  file: string,
  pathInfo: string,
  url: URL,
  request: IncomingMessage,
  body: Buffer,
  response: ServerResponse,
  root: string,
): void {
  const child = spawn(process.execPath, [CLI, "run", file], {
    cwd: root,
    env: cgiEnvironment(file, pathInfo, url, request, body, root),
    shell: false,
  });

  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  child.stdin.on("error", () => {
    // A page that never reads its body closes stdin early. Not an error.
  });
  child.stdin.end(body);

  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);

  child.on("error", (error) => {
    clearTimeout(timer);
    fail(response, 500, `Could not run ${file}: ${error.message}`);
  });

  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (signal === "SIGKILL") {
      fail(response, 504, `${relative(root, file)} took longer than ${TIMEOUT_MS / 1000}s`);
      return;
    }
    const stderr = Buffer.concat(err).toString("utf8");
    if (code !== 0) {
      // The diagnostic is the useful thing here, so it goes to the browser as
      // well as the terminal. This is a development server; on Apache the
      // page's stderr goes to the error log and the browser gets a 500.
      process.stderr.write(stderr);
      fail(response, 500, stderr.length > 0 ? stderr : `${relative(root, file)} exited ${code}`);
      return;
    }
    if (stderr.length > 0) process.stderr.write(stderr);
    send(response, Buffer.concat(out));
  });
}

/**
 * Split a CGI reply into headers and body.
 *
 * `Status:` is CGI's way of setting the code, and is not itself a header to
 * pass on. A reply with no header block at all is treated as a body, which
 * makes a half-written page show its output rather than a blank screen.
 */
function send(response: ServerResponse, raw: Buffer): void {
  const separator = findHeaderEnd(raw);
  if (separator === null) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(raw);
    return;
  }

  const headerText = raw.subarray(0, separator.at).toString("utf8");
  const body = raw.subarray(separator.at + separator.length);
  let status = 200;
  const headers: Record<string, string> = {};

  for (const line of headerText.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 599) status = parsed;
      continue;
    }
    headers[name] = value;
  }
  if (headers["Content-Type"] === undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "text/html; charset=utf-8";
  }
  headers["cache-control"] = "no-store";
  response.writeHead(status, headers);
  response.end(body);
}

function findHeaderEnd(raw: Buffer): { at: number; length: number } | null {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { at: crlf, length: 4 };
  if (lf !== -1) return { at: lf, length: 2 };
  return null;
}

function fail(response: ServerResponse, status: number, detail: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${status}</title>` +
      `<style>body{font:14px/1.5 ui-monospace,monospace;padding:2rem;max-width:60rem}` +
      `pre{background:#f6f6f4;padding:1rem;overflow-x:auto;white-space:pre-wrap}</style>` +
      `<h1>${status}</h1><pre>${escape(detail)}</pre>`,
  );
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}
