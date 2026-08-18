/**
 * Compile the real Baa interpreter for the browser playground.
 *
 *     node tools/build-playground.ts
 *
 * Two steps:
 *
 *  1. `tsc -p tsconfig.playground.json` emits `src/` as ES modules into
 *     `website/assets/baa/`, minus the CLI. TypeScript rewrites `./x.ts`
 *     import specifiers to `./x.js`, so the output loads directly in a browser
 *     with no bundler.
 *
 *  2. Rewrite `node:*` specifiers to the small shims in `website/assets/shims/`.
 *     Doing this at build time rather than with an import map means the modules
 *     also load inside a Web Worker, which is where the playground actually
 *     runs them: import maps do not apply to workers.
 *
 * The result is the genuine interpreter, not a re-implementation: the same
 * lexer, parser, resolver and runtime the CLI uses.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "website", "assets", "baa");
const SHIMS = join(ROOT, "website", "assets", "shims");

/** Node builtins the interpreter imports, and the shim that replaces each. */
const SHIM_NAMES = ["path", "fs", "process", "crypto", "child_process"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

if (!existsSync(SHIMS)) {
  process.stdout.write("No website/assets/shims here; skipping the playground build.\n");
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });

// Invoke the compiler's own entry point rather than `npx`, which resolves
// differently across shells on Windows.
const tsc = spawnSync(
  process.execPath,
  [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.playground.json"],
  { cwd: ROOT, encoding: "utf8", stdio: "inherit" },
);

if (tsc.status !== 0) {
  process.stderr.write("tsc failed: the playground bundle was not built\n");
  process.exitCode = 1;
} else {
  const files = walk(OUT);
  let rewritten = 0;
  const missing = new Set<string>();

  for (const file of files) {
    const original = readFileSync(file, "utf8");
    // Steps up from this file's directory to `website/assets/`, where the
    // shims live: one for `baa/` itself, plus one per nested directory.
    const depth = relative(OUT, file).split(sep).length;
    const prefix = `${"../".repeat(depth)}shims/`;

    const updated = original.replace(
      /(from\s+|import\s*\(\s*)["']node:([a-z_/]+)["']/g,
      (match, lead: string, name: string) => {
        if (!SHIM_NAMES.includes(name)) {
          missing.add(name);
          return match;
        }
        rewritten++;
        return `${lead}"${prefix}${name}.js"`;
      },
    );

    if (updated !== original) writeFileSync(file, updated, "utf8");
  }

  if (missing.size > 0) {
    process.stderr.write(
      `No browser shim for: ${[...missing].join(", ")}. Add one in ${relative(ROOT, SHIMS)} and list it in SHIM_NAMES.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Built the playground: ${files.length} modules, ${rewritten} node: imports rewritten to shims.\n`,
    );
  }
}
