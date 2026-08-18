/**
 * The reference implementation must pass its own conformance suite.
 *
 * This looks circular, the suite is generated from this implementation, but
 * it is not: the suite is committed, so any change in behaviour makes this fail
 * until someone regenerates it and reviews the diff. That is exactly the
 * property a second implementation (see `rust/README.md`) needs from it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFile, toDiagnostic } from "../src/api.ts";
import { ALL_CODES } from "../src/diagnostics/codes.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { createCapturingHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "tests", "conformance");

type Suite = {
  version: number;
  languageVersion: string;
  programs: Array<{ name: string; source: string; stdout: string; exit: number }>;
  diagnostics: Array<{ name: string; source: string; codes: string[]; stage: "check" | "run" }>;
};

type Catalogue = {
  version: number;
  codes: Array<{ code: string; severity: string; woolly: string; plain: string }>;
};

const suite = JSON.parse(readFileSync(join(DIR, "suite.json"), "utf8")) as Suite;
const catalogue = JSON.parse(readFileSync(join(DIR, "diagnostics.json"), "utf8")) as Catalogue;

function execute(source: string, name: string): {
  stdout: string;
  exit: number;
  codes: string[];
  ranWithoutChecking: boolean;
} {
  const file = new SourceFile(name, source);
  const checked = checkFile(file);
  if (!checked.ok) {
    return {
      stdout: "",
      exit: 1,
      codes: checked.diagnostics.map((d) => d.code),
      ranWithoutChecking: false,
    };
  }
  const host = createCapturingHost({ seed: 7 });
  const interpreter = new Interpreter({ host });
  try {
    interpreter.run(checked.program, file);
    return { stdout: host.output(), exit: 0, codes: [], ranWithoutChecking: true };
  } catch (error) {
    const converted = toDiagnostic(error, interpreter);
    if (converted === null) throw error;
    return {
      stdout: host.output(),
      exit: converted.exitCode,
      codes: converted.diagnostics.map((d) => d.code),
      ranWithoutChecking: true,
    };
  }
}

describe("conformance: the suite itself", () => {
  it("is version 1 and describes this version of the language", () => {
    assert.equal(suite.version, 1);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(suite.languageVersion, pkg.version);
  });

  it("covers a meaningful amount of the language", () => {
    assert.ok(suite.programs.length >= 40, `only ${suite.programs.length} programs`);
    assert.ok(suite.diagnostics.length >= 25, `only ${suite.diagnostics.length} cases`);
  });

  it("lists every diagnostic in the catalogue", () => {
    assert.deepEqual(
      catalogue.codes.map((entry) => entry.code),
      [...ALL_CODES],
    );
  });

  it("exercises at least one case per non-lint diagnostic range", () => {
    const covered = new Set(suite.diagnostics.flatMap((c) => c.codes.map((x) => x.slice(0, 4))));
    for (const prefix of ["BAA0", "BAA1", "BAA2", "BAA3", "BAA4"]) {
      assert.ok(covered.has(prefix), `no conformance case covers ${prefix}xx`);
    }
  });
});

describe("conformance: programs", () => {
  for (const program of suite.programs) {
    it(`${program.name} produces the recorded output`, () => {
      const result = execute(program.source, `${program.name}.baa`);
      assert.deepEqual(result.codes, [], `${program.name} failed unexpectedly`);
      assert.equal(result.stdout, program.stdout);
      assert.equal(result.exit, program.exit);
    });
  }
});

describe("conformance: diagnostics", () => {
  for (const testCase of suite.diagnostics) {
    it(`${testCase.name} reports ${testCase.codes.join(", ")}`, () => {
      const result = execute(testCase.source, `${testCase.name}.baa`);
      assert.deepEqual(result.codes, testCase.codes);
      if (testCase.stage === "check") {
        assert.equal(
          result.ranWithoutChecking,
          false,
          `${testCase.name} must be caught before the program runs`,
        );
      }
    });
  }
});
