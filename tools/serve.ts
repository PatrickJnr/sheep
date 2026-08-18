/**
 * A static file server for previewing the built website.
 *
 *     node tools/serve.ts            # http://localhost:8080
 *     node tools/serve.ts 3000
 *
 * The site is static, so this is only needed because module workers, which
 * the playground uses, are not allowed from `file://`. It is deliberately the
 * smallest thing that serves the directory correctly, and it is not part of
 * the deployed site.
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)), "website");
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".baa": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Resolve a request path inside ROOT, refusing anything that escapes it. */
function resolveRequest(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const candidate = resolve(ROOT, `.${normalize(decoded).replace(/^[/\\]+/, sep)}`);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;

  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const index = join(candidate, "index.html");
    return existsSync(index) ? index : null;
  }
  if (existsSync(candidate)) return candidate;
  // Pretty URLs, matching the .htaccess rule.
  const asHtml = `${candidate}.html`;
  return existsSync(asHtml) ? asHtml : null;
}

if (!existsSync(ROOT)) {
  process.stderr.write(`No website/ directory at ${ROOT}. Nothing to serve.\n`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const file = resolveRequest(request.url ?? "/");

  if (file === null) {
    const notFound = join(ROOT, "404.html");
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    if (existsSync(notFound)) createReadStream(notFound).pipe(response);
    else response.end("404");
    return;
  }

  response.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  createReadStream(file).pipe(response);
});

server.listen(PORT, () => {
  process.stdout.write(`Serving ${ROOT}\n  http://localhost:${PORT}/\n`);
  if (!existsSync(join(ROOT, "index.html"))) {
    process.stdout.write("  (no index.html yet: run `npm run gen:site`)\n");
  }
});
