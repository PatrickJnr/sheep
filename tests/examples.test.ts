/**
 * End-to-end tests over the real `examples/` programs.
 *
 * Every example must compile, lint cleanly and already be in canonical
 * formatting. The deterministic ones are also executed and compared against a
 * recorded transcript in `tests/expected/`, so a change in behaviour shows up
 * as a diff rather than as a vague failure.
 *
 * Regenerate the transcripts with:  node tools/record-examples.ts
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFile, format, lint, toDiagnostic } from "../src/api.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { createNodeHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = join(ROOT, "examples");
const EXPECTED = join(ROOT, "tests", "expected");

/**
 * Examples whose output depends on the clock, the platform or the environment.
 * They are still compiled and executed, just not compared byte for byte.
 */
const NON_DETERMINISTIC = new Set(["stdlib.baa"]);

/** Library examples that exist to be imported, and print nothing by themselves. */
const MODULE_ONLY = new Set(["pen.baa"]);

function examples(): string[] {
  return readdirSync(EXAMPLES)
    .filter((name) => name.endsWith(".baa"))
    .sort();
}

/** Run an example with a capturing host, using the real filesystem for imports. */
export function runExample(name: string, seed = 7): { output: string; codes: string[] } {
  const path = join(EXAMPLES, name);
  const file = new SourceFile(path, readFileSync(path, "utf8"));
  const checked = checkFile(file);
  if (!checked.ok) {
    return { output: "", codes: checked.diagnostics.map((d) => d.code) };
  }
  const chunks: string[] = [];
  const node = createNodeHost({ seed });
  const host = { ...node, write: (text: string) => void chunks.push(text) };
  const interpreter = new Interpreter({ host });
  try {
    interpreter.run(checked.program, file);
    return { output: chunks.join(""), codes: [] };
  } catch (error) {
    const converted = toDiagnostic(error, interpreter);
    if (converted === null) throw error;
    return { output: chunks.join(""), codes: converted.diagnostics.map((d) => d.code) };
  }
}

describe("examples: static checks", () => {
  it("finds a reasonable set of examples", () => {
    assert.ok(examples().length >= 10, `only found ${examples().length} examples`);
  });

  for (const name of examples()) {
    it(`${name} compiles, lints and is formatted`, () => {
      const source = readFileSync(join(EXAMPLES, name), "utf8");
      const checked = checkFile(new SourceFile(join(EXAMPLES, name), source));
      assert.deepEqual(
        checked.diagnostics.map((d) => `${d.code}: ${d.message}`),
        [],
      );
      assert.deepEqual(
        lint(source, name).warnings.map((w) => `${w.code}: ${w.message}`),
        [],
      );
      assert.equal(format(source, name), source.replace(/\r\n?/g, "\n"));
    });
  }
});

describe("examples: execution", () => {
  for (const name of examples()) {
    it(`${name} runs without error`, () => {
      const result = runExample(name);
      assert.deepEqual(result.codes, [], `${name} failed at runtime`);
      if (!MODULE_ONLY.has(name)) {
        assert.ok(result.output.length > 0, `${name} printed nothing`);
      }
    });
  }
});

describe("examples: recorded output", () => {
  for (const name of examples().filter((n) => !NON_DETERMINISTIC.has(n))) {
    const transcript = join(EXPECTED, `${name}.txt`);
    it(`${name} matches its recorded transcript`, () => {
      assert.ok(
        existsSync(transcript),
        `missing transcript for ${name}: run \`node tools/record-examples.ts\``,
      );
      assert.equal(runExample(name).output, readFileSync(transcript, "utf8"));
    });
  }

  it("has no stale transcripts", () => {
    const names = new Set(examples().map((name) => `${name}.txt`));
    for (const file of readdirSync(EXPECTED)) {
      assert.ok(names.has(file), `${file} has no matching example`);
    }
  });
});
