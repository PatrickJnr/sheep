/**
 * Record the output of every deterministic example into `tests/expected/`.
 *
 *     node tools/record-examples.ts
 *
 * Run this after deliberately changing what an example prints, then review the
 * diff. The transcripts are what `tests/examples.test.ts` compares against.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { checkFile, renderDiagnostics, toDiagnostic } from "../src/api.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { createNodeHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = join(ROOT, "examples");
const EXPECTED = join(ROOT, "tests", "expected");

const NON_DETERMINISTIC = new Set(["stdlib.baa"]);

function record(name: string): string {
  const path = join(EXAMPLES, name);
  const file = new SourceFile(path, readFileSync(path, "utf8"));
  const checked = checkFile(file);
  if (!checked.ok) {
    throw new Error(`${name} does not compile:\n${renderDiagnostics(checked.diagnostics)}`);
  }
  const chunks: string[] = [];
  const node = createNodeHost({ seed: 7 });
  const host = { ...node, write: (text: string) => void chunks.push(text) };
  const interpreter = new Interpreter({ host });
  try {
    interpreter.run(checked.program, file);
  } catch (error) {
    const converted = toDiagnostic(error, interpreter);
    if (converted === null) throw error;
    throw new Error(`${name} failed:\n${renderDiagnostics(converted.diagnostics)}`);
  }
  return chunks.join("");
}

mkdirSync(EXPECTED, { recursive: true });
const names = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith(".baa") && !NON_DETERMINISTIC.has(name))
  .sort();

for (const stale of readdirSync(EXPECTED)) {
  if (!names.includes(stale.replace(/\.txt$/, ""))) {
    rmSync(join(EXPECTED, stale));
    process.stdout.write(`removed ${stale}\n`);
  }
}

for (const name of names) {
  const output = record(name);
  writeFileSync(join(EXPECTED, `${name}.txt`), output, "utf8");
  process.stdout.write(`recorded ${name} (${output.split("\n").length - 1} lines)\n`);
}
