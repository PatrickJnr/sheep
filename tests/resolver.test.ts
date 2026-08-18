import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { check } from "../src/api.ts";

function codes(source: string, modules: readonly string[] = []): string[] {
  return check(source, "test.baa", { modules }).diagnostics.map(
    (diagnostic) => diagnostic.code,
  );
}

function messageFor(source: string, code: string): string {
  const diagnostic = check(source, "test.baa").diagnostics.find((d) => d.code === code);
  assert.ok(diagnostic !== undefined, `expected a ${code} diagnostic`);
  return `${diagnostic.message} ${diagnostic.help.join(" ")}`;
}

describe("resolver: names", () => {
  it("accepts a well-formed program", () => {
    assert.deepEqual(
      codes(`
const MAX = 10
fn count(items) { return items.length() }
for item in [1, 2] { baa count([item]), MAX }
`),
      [],
    );
  });

  it("reports an undefined name as BAA102 with a suggestion", () => {
    assert.deepEqual(codes("let sheep = 1\nbaa sheap"), ["BAA102"]);
    assert.match(messageFor("let sheep = 1\nbaa sheap", "BAA102"), /Did you mean `sheep`/);
  });

  it("knows every prelude name", () => {
    assert.deepEqual(codes("baa len([1]), type_of(1), to_string(1), clone([1])"), []);
  });

  it("reports a duplicate declaration as BAA101", () => {
    assert.deepEqual(codes("let a = 1\nlet a = 2"), ["BAA101"]);
  });

  it("allows shadowing in a nested scope", () => {
    assert.deepEqual(codes("let a = 1\nif true {\n  let a = 2\n  baa a\n}\nbaa a"), []);
  });

  it("reports use-before-declaration as BAA106", () => {
    assert.deepEqual(codes("baa later\nlet later = 1"), ["BAA106"]);
  });

  it("hoists function declarations so order does not matter", () => {
    assert.deepEqual(codes("baa f()\nfn f() { return g() }\nfn g() { return 1 }"), []);
  });
});

describe("resolver: mutability", () => {
  it("reports assignment to a const as BAA103", () => {
    assert.deepEqual(codes("const a = 1\na = 2"), ["BAA103"]);
    assert.match(messageFor("const a = 1\na = 2", "BAA103"), /let a/);
  });

  it("reports assignment to a function or import", () => {
    assert.deepEqual(codes("fn f() { return 1 }\nf = 2"), ["BAA103"]);
    assert.deepEqual(codes("import wool\nwool = 2"), ["BAA103"]);
  });

  it("allows reassigning a let", () => {
    assert.deepEqual(codes("let a = 1\na = 2\na += 3"), []);
  });
});

describe("resolver: control flow", () => {
  it("reports return outside a function as BAA104", () => {
    assert.deepEqual(codes("return 1"), ["BAA104"]);
  });

  it("reports break and continue outside a loop as BAA105", () => {
    assert.deepEqual(codes("break"), ["BAA105"]);
    assert.deepEqual(codes("continue"), ["BAA105"]);
    assert.deepEqual(codes("fn f() { for i in 0..1 { break } }"), []);
  });

  it("does not let a loop leak across a function boundary", () => {
    assert.deepEqual(codes("for i in 0..1 { fn f() { break } }"), ["BAA105"]);
  });
});

describe("resolver: calls", () => {
  it("checks arity for direct calls", () => {
    assert.deepEqual(codes("fn f(a, b) { return a }\nf(1)"), ["BAA202"]);
    assert.deepEqual(codes("fn f(a) { return a }\nf(1, 2)"), ["BAA201"]);
    assert.deepEqual(codes("fn f(a, b = 1) { return a }\nf(1)"), []);
    assert.deepEqual(codes("fn f(a, ..rest) { return a }\nf(1, 2, 3, 4)"), []);
  });

  it("reports duplicate parameter names as BAA203", () => {
    assert.deepEqual(codes("fn f(a, a) { return a }"), ["BAA203"]);
  });

  it("does not guess arity for values it cannot see", () => {
    assert.deepEqual(codes("fn apply(f) { return f(1, 2, 3) }"), []);
  });
});

describe("resolver: modules", () => {
  it("accepts every standard module", () => {
    assert.deepEqual(
      codes("import wool\nimport flock\nimport ram\nimport meadow\nimport pasture\nimport shepherd\nimport lamb\nbaa wool, flock, ram, meadow, pasture, shepherd, lamb"),
      [],
    );
  });

  it("reports an unknown module as BAA401", () => {
    assert.deepEqual(codes("import cotton"), ["BAA401", "BAA903"].slice(0, 1));
  });

  it("suggests a close standard module name", () => {
    assert.match(messageFor("import wooll", "BAA401"), /Did you mean `wool`/);
  });

  it("accepts declared project dependencies", () => {
    assert.deepEqual(codes("import my_lib\nbaa my_lib", ["my_lib"]), []);
  });

  it("does not check relative imports at analysis time", () => {
    assert.deepEqual(codes('import "./anything.baa"\nbaa anything'), []);
  });
});

describe("resolver: usage tracking", () => {
  it("counts a compound assignment as both a read and a write", () => {
    const result = check("let a = 1\na += 1\nbaa a");
    assert.deepEqual(
      result.diagnostics.map((d) => d.code),
      [],
    );
  });
});
