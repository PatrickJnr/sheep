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

/**
 * The security headers `website/.htaccess` sets in production.
 *
 * Duplicated here on purpose: a policy that is only applied on the live server
 * is a policy nobody tests. `Cross-Origin-Embedder-Policy: require-corp` in
 * particular will refuse any subresource that does not opt in, so the
 * playground check has to run under it to be worth anything. Keep this in step
 * with the `mod_headers` block in `.htaccess`.
 *
 * Strict-Transport-Security is deliberately absent: this server is plain HTTP,
 * and sending it here would pin `localhost` to HTTPS in the developer's
 * browser for a year.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy":
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
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
    response.writeHead(404, {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
    });
    if (existsSync(notFound)) createReadStream(notFound).pipe(response);
    else response.end("404");
    return;
  }

  response.writeHead(200, {
    ...SECURITY_HEADERS,
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
