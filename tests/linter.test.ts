import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lint } from "../src/api.ts";

function warnings(source: string): string[] {
  return lint(source, "test.baa").warnings.map((warning) => warning.code);
}

describe("linter", () => {
  it("reports nothing for tidy code", () => {
    assert.deepEqual(
      warnings(`
import wool

const NAMES = ["Dolly"]

fn shout(name) {
    return wool.title_case(name)
}

for name in NAMES {
    baa shout(name)
}
`),
      [],
    );
  });

  it("reports an unused binding as BAA901", () => {
    assert.deepEqual(warnings("const unused = 1"), ["BAA901"]);
  });

  it("stays quiet for names starting with an underscore", () => {
    assert.deepEqual(warnings("const _deliberate = 1"), []);
  });

  it("reports an unused import as BAA903", () => {
    assert.deepEqual(warnings("import wool"), ["BAA903"]);
  });

  it("reports unreachable code as BAA902", () => {
    assert.deepEqual(warnings("fn f() {\n  return 1\n  baa 2\n}\nbaa f()"), ["BAA902"]);
  });

  it("reports a never-reassigned let as BAA905", () => {
    assert.deepEqual(warnings("let a = 1\nbaa a"), ["BAA905"]);
    assert.deepEqual(warnings("let a = 1\na = 2\nbaa a"), []);
  });

  it("reports a constant condition as BAA904", () => {
    assert.deepEqual(warnings("if true {\n  baa 1\n}"), ["BAA904"]);
  });

  it("reports an empty block as BAA906", () => {
    assert.deepEqual(warnings("fn f() {}\nbaa f()"), ["BAA906"]);
  });

  it("accepts an empty block that explains itself", () => {
    assert.deepEqual(warnings("fn f() {\n  // nothing to do yet\n}\nbaa f()"), []);
  });

  it("does not warn about loop or match bindings", () => {
    assert.deepEqual(warnings('for i in 0..3 { baa "x" }'), []);
    assert.deepEqual(warnings('baa match 1 { n => "seen" }'), []);
  });

  it("does not warn about a catch binding that is ignored", () => {
    assert.deepEqual(warnings('try { baa 1 } catch e { baa "failed" }'), []);
  });

  it("honours disabled rules", () => {
    const result = lint("let a = 1\nbaa a", "test.baa");
    assert.deepEqual(
      result.warnings.map((w) => w.code),
      ["BAA905"],
    );
  });

  it("keeps lints as warnings, never errors", () => {
    const result = lint("const unused = 1", "test.baa");
    assert.ok(result.ok, "lints must not make a program invalid");
    assert.deepEqual(
      result.warnings.map((w) => w.severity),
      ["warning"],
    );
  });
});
