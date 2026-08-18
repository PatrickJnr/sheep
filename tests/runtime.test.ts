import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../src/api.ts";
import type { RunOptions } from "../src/api.ts";

/** Run a program and return its stdout, failing the test on any diagnostic. */
function output(source: string, options: RunOptions = {}): string {
  const result = run(source, "test.baa", options);
  assert.ok(
    result.ok,
    `program failed: ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`,
  );
  return result.output;
}

/** Run a program expected to fail, and return the first diagnostic code. */
function failureCode(source: string, options: RunOptions = {}): string {
  const result = run(source, "test.baa", options);
  assert.equal(result.ok, false, `expected failure, got output: ${result.output}`);
  const first = result.diagnostics[0];
  assert.ok(first !== undefined, "expected a diagnostic");
  return first.code;
}

describe("runtime: values and printing", () => {
  it("prints each type in its canonical form", () => {
    assert.equal(
      output('baa 1, 2.5, "text", true, nil, [1, "a"], { a: 1 }, 0..3'),
      '1 2.5 text true nil [1, "a"] { a: 1 } 0..3\n',
    );
  });

  it("prints whole numbers without a decimal point", () => {
    assert.equal(output("baa 4.0, 1e3, 7 / 2, 6 / 3"), "4 1000 3.5 2\n");
  });

  it("prints special numbers readably", () => {
    assert.equal(output("import ram\nbaa ram.INF, 0 - ram.INF, ram.NAN"), "inf -inf nan\n");
  });

  it("treats only nil and false as falsy", () => {
    assert.equal(
      output('baa !nil, !false, !0, !"", ![]'),
      "true true false false false\n",
    );
  });
});

describe("runtime: operators", () => {
  it("evaluates arithmetic with correct precedence", () => {
    assert.equal(output("baa 1 + 2 * 3, (1 + 2) * 3, 2 ** 3 ** 2, 7 % 3"), "7 9 512 1\n");
  });

  it("concatenates when either side of + is text", () => {
    assert.equal(output('baa "n=" + 1, 1 + "=n", "a" + true, "x" + nil'), "n=1 1=n atrue xnil\n");
  });

  it("concatenates arrays with +", () => {
    assert.equal(output("baa [1] + [2, 3]"), "[1, 2, 3]\n");
  });

  it("compares structurally", () => {
    assert.equal(
      output('baa [1, [2]] == [1, [2]], { a: 1 } == { a: 1 }, { a: 1 } == { a: 2 }'),
      "true true false\n",
    );
  });

  it("short-circuits && || and ??", () => {
    // `1 / 0` is a runtime error, so reaching it would fail the test.
    assert.equal(output("baa false && (1 / 0)"), "false\n");
    assert.equal(output("baa true || (1 / 0)"), "true\n");
    assert.equal(output("baa nil ?? 5, false ?? 5, 0 ?? 5"), "5 false 0\n");
  });

  it("implements `in` for arrays, maps, ranges and strings", () => {
    assert.equal(
      output('baa 2 in [1, 2], "a" in { a: 1 }, 3 in 0..5, "oo" in "wool"'),
      "true true true true\n",
    );
  });

  it("rejects mismatched operands with BAA302", () => {
    assert.equal(failureCode("baa [1] - 2"), "BAA302");
    assert.equal(failureCode("baa nil * 2"), "BAA302");
    assert.equal(failureCode('baa 1 < "a"'), "BAA302");
  });

  it("rejects division by zero with BAA306", () => {
    assert.equal(failureCode("baa 1 / 0"), "BAA306");
    assert.equal(failureCode("baa 1 % 0"), "BAA306");
  });
});

describe("runtime: strings", () => {
  it("interpolates expressions", () => {
    assert.equal(output('let n = 3\nbaa "there are {n + 1} sheep"'), "there are 4 sheep\n");
  });

  it("allows nested quotes inside an interpolation", () => {
    assert.equal(output('baa "{ ["a", "b"].join(", ") }"'), "a, b\n");
  });

  it("indexes by character, including from the end", () => {
    assert.equal(output('baa "wool"[0], "wool"[-1]'), "w l\n");
  });

  it("reports an out-of-range index as BAA304", () => {
    assert.equal(failureCode('baa "wool"[9]'), "BAA304");
  });
});

describe("runtime: collections", () => {
  it("indexes arrays from both ends", () => {
    assert.equal(output("const a = [1, 2, 3]\nbaa a[0], a[-1]"), "1 3\n");
  });

  it("reads a missing map key as nil and assigns new keys", () => {
    assert.equal(output('const m = { a: 1 }\nbaa m["b"]\nm["b"] = 2\nbaa m'), "nil\n{ a: 1, b: 2 }\n");
  });

  it("prefers map data over a method of the same name", () => {
    assert.equal(output('const m = { keys: "mine" }\nbaa m.keys'), "mine\n");
  });

  it("mutates through a shared reference and copies with clone", () => {
    assert.equal(
      output("const a = [1]\nconst b = a\nb.push(2)\nconst c = clone(a)\nc.push(3)\nbaa a, c"),
      "[1, 2] [1, 2, 3]\n",
    );
  });

  it("reports an out-of-range array index as BAA304", () => {
    assert.equal(failureCode("baa [1, 2][5]"), "BAA304");
  });

  it("reports a missing field as BAA305", () => {
    assert.equal(failureCode("baa (1).nope()"), "BAA305");
    assert.equal(failureCode("baa nil.anything"), "BAA305");
  });
});

describe("runtime: control flow", () => {
  it("runs if/else-if/else", () => {
    const program = `
fn size(n) {
  if n > 10 { return "many" } else if n > 2 { return "some" } else { return "few" }
}
baa size(20), size(5), size(1)`;
    assert.equal(output(program), "many some few\n");
  });

  it("iterates arrays, strings, ranges and maps", () => {
    assert.equal(
      output(`
for x in [1, 2] { baa x }
for c in "ab" { baa c }
for i in 1..=2 { baa i }
for k, v in { a: 1 } { baa k, v }
for i, x in ["p", "q"] { baa i, x }`),
      "1\n2\na\nb\n1\n2\na 1\n0 p\n1 q\n",
    );
  });

  it("breaks and continues", () => {
    assert.equal(
      output("for i in 0..5 {\n  if i == 1 { continue }\n  if i == 3 { break }\n  baa i\n}"),
      "0\n2\n",
    );
  });

  it("reports a non-iterable as BAA309", () => {
    assert.equal(failureCode("for x in 5 { baa x }"), "BAA309");
  });
});

describe("runtime: functions", () => {
  it("applies defaults and rest parameters", () => {
    assert.equal(
      output(`
fn f(a, b = 10, ..rest) { return [a, b, rest] }
baa f(1), f(1, 2), f(1, 2, 3, 4)`),
      "[1, 10, []] [1, 2, []] [1, 2, [3, 4]]\n",
    );
  });

  it("returns nil when a function falls off the end", () => {
    assert.equal(output("fn f() { baa 1 }\nbaa f()"), "1\nnil\n");
  });

  it("closes over its declaring scope", () => {
    assert.equal(
      output(`
fn counter() {
  let n = 0
  return fn() { n += 1
    return n }
}
const next = counter()
const other = counter()
baa next(), next(), other()`),
      "1 2 1\n",
    );
  });

  it("passes functions as values", () => {
    assert.equal(
      output("fn twice(f, x) { return f(f(x)) }\nbaa twice(fn(n) { return n * 3 }, 2)"),
      "18\n",
    );
  });

  it("ignores extra arguments the standard library offers a callback", () => {
    assert.equal(output("baa [1, 2, 3].map(fn(n) { return n * 2 })"), "[2, 4, 6]\n");
  });

  it("stays strict about arity for calls written in source", () => {
    assert.equal(failureCode("fn f(a) { return a }\nconst g = f\nbaa g(1, 2)"), "BAA201");
  });

  it("reports calling a non-function as BAA303", () => {
    assert.equal(failureCode("const n = 1\nbaa n()"), "BAA303");
  });

  it("stops runaway recursion with BAA307", () => {
    assert.equal(failureCode("fn f() { return f() }\nf()", { maxDepth: 64 }), "BAA307");
  });
});

describe("runtime: match", () => {
  it("matches literals, alternatives, guards and the wildcard", () => {
    const program = `
fn describe(n) {
  return match n {
    0 => "none",
    1 || 2 => "few",
    x if x > 10 => "many",
    _ => "some",
  }
}
baa describe(0), describe(2), describe(50), describe(5)`;
    assert.equal(output(program), "none few many some\n");
  });

  it("matches composite values structurally", () => {
    assert.equal(
      output('baa match [true, false] { [true, true] => "both", [true, false] => "first", _ => "no" }'),
      "first\n",
    );
  });

  it("fails when nothing matches", () => {
    assert.equal(failureCode('baa match 9 { 1 => "one" }'), "BAA301");
  });
});

describe("runtime: errors", () => {
  it("catches a thrown value", () => {
    assert.equal(
      output('try { throw "boom" } catch e { baa "caught {e}" }'),
      "caught boom\n",
    );
  });

  it("preserves the type of a thrown value", () => {
    assert.equal(
      output('try { throw { code: "X" } } catch e { baa e.code }'),
      "X\n",
    );
  });

  it("exposes runtime errors as a map with a stable code", () => {
    assert.equal(
      output('try { baa [1][9] } catch e { baa e.code, e.line }'),
      "BAA304 1\n",
    );
  });

  it("always runs finally", () => {
    assert.equal(
      output(`
fn f(fail) {
  try {
    if fail { throw "x" }
    return "ok"
  } catch e { return "caught" } finally { baa "cleanup" }
}
baa f(false), f(true)`),
      "cleanup\ncleanup\nok caught\n",
    );
  });

  it("reports an uncaught throw as BAA308", () => {
    assert.equal(failureCode('throw "loose sheep"'), "BAA308");
  });

  it("attaches a call stack to errors raised inside functions", () => {
    const result = run("fn inner() { baa [1][9] }\nfn outer() { inner() }\nouter()", "t.baa");
    const diagnostic = result.diagnostics[0]!;
    assert.deepEqual(
      diagnostic.trace.map((frame) => frame.name),
      ["inner", "outer"],
    );
  });

  it("fails assertions with a useful message", () => {
    const result = run("assert_eq(1, 2)", "t.baa");
    assert.equal(result.diagnostics[0]!.code, "BAA301");
    assert.match(result.diagnostics[0]!.message, /expected 2, got 1/);
  });
});

describe("runtime: exit", () => {
  it("stops the program and reports the code", () => {
    const result = run('baa "before"\nexit(3)\nbaa "after"', "t.baa");
    assert.equal(result.exitCode, 3);
    assert.equal(result.output, "before\n");
  });
});
