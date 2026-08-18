/**
 * Check the built website: broken links, missing anchors, missing assets.
 *
 *     node tools/check-site.ts
 *
 * "No broken links" is easy to promise and easy to break, so it is checked
 * rather than asserted. External links are listed but not fetched, a build
 * should not depend on the network.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "website");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "src") continue; // build inputs, not output
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

if (!existsSync(SITE)) {
  process.stdout.write("No website/ here; nothing to check.\n");
  process.exit(0);
}

const files = walk(SITE);
const htmlFiles = files.filter((file) => file.endsWith(".html"));

if (htmlFiles.length === 0) {
  process.stderr.write("No HTML found: run `node tools/build-site.ts` first.\n");
  process.exitCode = 1;
}

/** Every `id="..."` in a document. */
function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!));
}

const idCache = new Map<string, Set<string>>();

function idsFor(path: string): Set<string> {
  let ids = idCache.get(path);
  if (ids === undefined) {
    ids = existsSync(path) ? idsIn(readFileSync(path, "utf8")) : new Set();
    idCache.set(path, ids);
  }
  return ids;
}

const problems: string[] = [];
const external = new Set<string>();
let checked = 0;

for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const here = relative(SITE, file).split("\\").join("/");
  const selfIds = idsIn(html);

  for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const target = match[1]!;
    checked++;

    if (/^(https?:|mailto:|data:)/.test(target)) {
      external.add(target);
      continue;
    }
    if (target.startsWith("#")) {
      const id = decodeURIComponent(target.slice(1));
      if (id !== "" && !selfIds.has(id)) {
        problems.push(`${here}: no element with id "${id}" (link ${target})`);
      }
      continue;
    }

    const [path, fragment] = target.split("#");
    let resolved = resolve(dirname(file), path ?? "");
    if (path === "" || path === undefined) resolved = file;
    else if (path.endsWith("/")) resolved = join(resolved, "index.html");
    else if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      resolved = join(resolved, "index.html");
    }

    if (!existsSync(resolved)) {
      problems.push(`${here}: broken link "${target}" (looked for ${relative(SITE, resolved)})`);
      continue;
    }
    if (fragment !== undefined && fragment !== "" && resolved.endsWith(".html")) {
      const id = decodeURIComponent(fragment);
      if (!idsFor(resolved).has(id)) {
        problems.push(
          `${here}: "${target}" points at a missing anchor "#${id}" in ${relative(SITE, resolved)}`,
        );
      }
    }
  }
}

// A few structural checks worth having.
for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const here = relative(SITE, file).split("\\").join("/");
  if (!html.includes('<html lang=')) problems.push(`${here}: <html> has no lang attribute`);
  if (!/<title>[^<]+<\/title>/.test(html)) problems.push(`${here}: missing or empty <title>`);
  if (!/<meta name="description" content="[^"]+"/.test(html)) {
    problems.push(`${here}: missing meta description`);
  }
  if (!html.includes('id="main"')) problems.push(`${here}: no #main landmark for the skip link`);
  const h1Count = [...html.matchAll(/<h1[\s>]/g)].length;
  if (h1Count !== 1) problems.push(`${here}: expected exactly one <h1>, found ${h1Count}`);
  for (const image of html.matchAll(/<img\s[^>]*>/g)) {
    if (!/\salt="/.test(image[0])) problems.push(`${here}: <img> without alt text`);
  }
}

process.stdout.write(
  `Checked ${htmlFiles.length} pages, ${checked} links, ${external.size} external targets.\n`,
);

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.stderr.write(`${problems.length} problem(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("No broken links, no missing anchors.\n");
}
