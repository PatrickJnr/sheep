/**
 * Module loading exercises real files on disk, so these tests use the Node host
 * rather than the in-memory one.
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFile, toDiagnostic } from "../src/api.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { createNodeHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/modules/", import.meta.url));

type Outcome = { output: string; codes: string[] };

after(() => {
  rmSync(join(FIXTURES, "__entry.baa"), { force: true });
});

/** Write a temporary entry file next to the fixtures and run it. */
function runEntry(source: string, name = "__entry.baa"): Outcome {
  const path = join(FIXTURES, name);
  writeFileSync(path, source, "utf8");
  const file = new SourceFile(path, readFileSync(path, "utf8"));
  const checked = checkFile(file);
  if (!checked.ok) {
    return { output: "", codes: checked.diagnostics.map((d) => d.code) };
  }
  const chunks: string[] = [];
  const host = createNodeHost();
  const capturing = { ...host, write: (text: string) => void chunks.push(text) };
  const interpreter = new Interpreter({ host: capturing });
  try {
    interpreter.run(checked.program, file);
    return { output: chunks.join(""), codes: [] };
  } catch (error) {
    const converted = toDiagnostic(error, interpreter);
    if (converted === null) throw error;
    return { output: chunks.join(""), codes: converted.diagnostics.map((d) => d.code) };
  }
}

describe("modules: local files", () => {
  it("imports a sibling file and binds it to the file stem", () => {
    const result = runEntry('import "./lib.baa"\nbaa lib.double(21), lib.NAME');
    assert.deepEqual(result.codes, []);
    assert.equal(result.output, "lib loaded once\n42 lib\n");
  });

  it("honours an explicit alias", () => {
    const result = runEntry('import "./lib.baa" as helpers\nbaa helpers.double(2)');
    assert.equal(result.output.trimEnd().split("\n").pop(), "4");
  });

  it("supports named imports from a file", () => {
    const result = runEntry('import { double } from "./lib.baa"\nbaa double(3)');
    assert.equal(result.output.trimEnd().split("\n").pop(), "6");
  });

  it("resolves imports relative to the importing file, not the process", () => {
    const result = runEntry('import "./lib.baa"\nbaa lib.deep_greeting()');
    assert.equal(result.output.trimEnd().split("\n").pop(), "hello from lib");
  });

  it("evaluates a module only once, however many files import it", () => {
    const result = runEntry(`
import "./lib.baa"
import "./lib.baa" as again
baa lib.double(1) + again.double(1)
`);
    assert.equal(result.output, "lib loaded once\n4\n");
  });

  it("does not export private names", () => {
    const result = runEntry('import "./lib.baa"\nbaa lib.private_helper()');
    assert.deepEqual(result.codes, ["BAA403"]);
  });

  it("reports a missing module as BAA401", () => {
    const result = runEntry('import "./nowhere.baa"\nbaa nowhere');
    assert.deepEqual(result.codes, ["BAA401"]);
  });

  it("reports a missing named export as BAA403", () => {
    const result = runEntry('import { nope } from "./lib.baa"\nbaa nope');
    assert.deepEqual(result.codes, ["BAA403"]);
  });

  it("detects an import cycle as BAA402", () => {
    const result = runEntry('import "./cycle_a.baa"\nbaa cycle_a.a()');
    assert.deepEqual(result.codes, ["BAA402"]);
  });

  it("surfaces an error inside an imported module, with import context", () => {
    const result = runEntry('import "./broken.baa"\nbaa broken.oops()');
    assert.deepEqual(result.codes, ["BAA102"]);
  });

  it("accepts a path with or without the .baa extension", () => {
    const withExtension = runEntry('import "./lib.baa"\nbaa lib.NAME');
    const without = runEntry('import "./lib"\nbaa lib.NAME');
    assert.equal(without.output, withExtension.output);
  });
});

describe("modules: standard library", () => {
  it("caches built-in modules across imports", () => {
    const result = runEntry("import ram\nimport ram as maths\nbaa ram.PI == maths.PI");
    assert.equal(result.output, "true\n");
  });

  it("reports an unknown standard module as BAA401", () => {
    const result = runEntry("import cotton\nbaa cotton");
    assert.deepEqual(result.codes, ["BAA401"]);
  });
});
