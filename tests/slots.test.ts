/**
 * Resolved variable slots.
 *
 * The resolver records where each name lives and the interpreter goes straight
 * there. Two things have to hold: the answers must be identical to looking the
 * name up (the semantics tests below), and the fast path must actually be taken
 * (the drift guard at the end, which is the part that would otherwise rot
 * silently — a mismatch falls back to the name walk and everything keeps
 * working, only slower).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFile, run } from "../src/api.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { Environment, slotStats } from "../src/runtime/environment.ts";
import { createNodeHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";
import { resolveProgram } from "../src/semantic/resolver.ts";
import { parse } from "../src/parser/parser.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function output(source: string): string {
  return run(source, "slots.baa").output;
}

describe("slots: the answers are the same as looking the name up", () => {
  it("reads a parameter, a local and an outer binding", () => {
    assert.equal(
      output(`
let outer = 10
fn add(a, b) {
    let sum = a + b
    return sum + outer
}
baa add(1, 2)
`),
      "13\n",
    );
  });

  it("honours shadowing, innermost first", () => {
    assert.equal(
      output(`
let x = "outer"
fn f() {
    let x = "inner"
    if true {
        let x = "innermost"
        baa x
    }
    baa x
}
f()
baa x
`),
      "innermost\ninner\nouter\n",
    );
  });

  it("captures by reference, not by position", () => {
    assert.equal(
      output(`
fn counter() {
    let n = 0
    return fn() {
        n = n + 1
        return n
    }
}
let a = counter()
let b = counter()
baa a()
baa a()
baa b()
`),
      "1\n2\n1\n",
    );
  });

  it("gives each loop iteration its own binding", () => {
    assert.equal(
      output(`
let fns = []
for i in 0..3 {
    let captured = i
    fns.push(fn() { return captured })
}
for f in fns {
    baa f()
}
`),
      "0\n1\n2\n",
    );
  });

  it("resolves mutually recursive functions declared in either order", () => {
    assert.equal(
      output(`
fn even(n) {
    if n == 0 { return true }
    return odd(n - 1)
}
fn odd(n) {
    if n == 0 { return false }
    return even(n - 1)
}
baa even(10)
baa odd(7)
`),
      "true\ntrue\n",
    );
  });

  it("assigns through a slot, including compound assignment", () => {
    assert.equal(
      output(`
let total = 1
fn bump() {
    total = total + 1
    total = total * 3
}
bump()
baa total
`),
      "6\n",
    );
  });

  it("still refuses to assign to a const, through the slot path", () => {
    const result = run("const x = 1\nx = 2\n", "slots.baa");
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "BAA103"));
  });

  it("keeps a catch binding and a match binding to their own scope", () => {
    assert.equal(
      output(`
let value = "outer"
try {
    throw "boom"
} catch value {
    baa value
}
baa value
baa match 2 {
    n if n > 1 => "big " + n,
    _ => "small",
}
`),
      "boom\nouter\nbig 2\n",
    );
  });

  it("reads a module binding through the import, not through a slot of its own", () => {
    assert.equal(output('import wool\nbaa wool.title_case("baa lang")\n'), "Baa Lang\n");
  });
});

describe("slots: what the resolver records", () => {
  it("places a local at its declaration position in its own scope", () => {
    const file = new SourceFile("t.baa", "let a = 1\nlet b = 2\nbaa b\n");
    const { program } = parse(file);
    resolveProgram(program, file, {});
    const statement = program.body[2]!;
    assert.equal(statement.kind, "BaaStatement");
    const printed = (statement as unknown as {
      values: ReadonlyArray<{ slot?: { hops: number; index: number } | null }>;
    }).values[0]!;
    assert.deepEqual(printed.slot, { hops: 0, index: 1 });
  });

  it("counts hops outward for a name declared in an enclosing scope", () => {
    const file = new SourceFile("t.baa", "let a = 1\nfn f() {\n    if true {\n        baa a\n    }\n}\n");
    const { program } = parse(file);
    resolveProgram(program, file, {});
    // top level -> function body -> if block: two scopes out. `a` sits at
    // position 1 because `f` is hoisted ahead of it, which is exactly what the
    // interpreter does when it defines the function declarations first.
    const found = JSON.stringify(program).match(/"slot":\{"hops":(\d+),"index":(\d+)\}/);
    assert.ok(found, "the identifier should have been placed");
    assert.equal(found[1], "2");
    assert.equal(found[2], "1");
  });

  it("leaves prelude names unplaced, so they go by name", () => {
    const file = new SourceFile("t.baa", 'baa len("baa")\n');
    const { program } = parse(file);
    resolveProgram(program, file, {});
    assert.match(JSON.stringify(program), /"slot":null/);
  });
});

describe("slots: the fast path is actually taken", () => {
  function programs(dir: string): string[] {
    const out: string[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".baa")) out.push(full);
      }
    };
    walk(dir);
    return out;
  }

  it("never falls back to a name walk across the examples", () => {
    const before = slotStats.misses;
    let ran = 0;
    for (const path of programs(join(ROOT, "examples"))) {
      const text = readFileSync(path, "utf8");
      // `gate` needs a CGI environment and `barn` needs a window.
      if (/^\s*import\s+(gate|barn)\b/m.test(text)) continue;
      const file = new SourceFile(path, text);
      const checked = checkFile(file, { modules: [] });
      if (!checked.ok) continue;
      const interpreter = new Interpreter({
        host: createNodeHost({ argv: [] }),
        dependencies: new Map(),
      });
      try {
        interpreter.run(checked.program, file);
        ran++;
      } catch {
        // A program that fails at runtime still exercised its lookups.
      }
    }
    assert.ok(ran > 10, `expected to run a real corpus, ran ${ran}`);
    assert.equal(
      slotStats.misses - before,
      0,
      "a slot did not hold the name it was resolved from: the resolver and the interpreter disagree about the scope chain",
    );
  });

  it("falls back rather than reading the wrong binding when a slot is wrong", () => {
    // The guarantee the fallback exists for: a slot that points at nothing, or
    // at another name, must still produce the right value.
    const file = new SourceFile("t.baa", "let a = 1\n");
    const env = new Environment(null, "test");
    env.define("a", 1, true);
    const before = slotStats.misses;
    assert.equal(env.getSlot(0, 7, "a", file.span(0, 1)), 1);
    assert.equal(env.getSlot(9, 0, "a", file.span(0, 1)), 1);
    assert.equal(slotStats.misses - before, 2);

    env.assignSlot(0, 7, "a", 2, file.span(0, 1));
    assert.equal(env.get("a", file.span(0, 1)), 2);
  });

  it("keeps a redefined name in its original position", () => {
    // The REPL redeclares names, and a second entry would leave every slot
    // after it pointing one place to the left.
    const file = new SourceFile("t.baa", "let a = 1\n");
    const env = new Environment(null, "repl");
    env.define("a", 1, true);
    env.define("b", 2, true);
    env.define("a", 3, true);
    assert.equal(env.getSlot(0, 0, "a", file.span(0, 1)), 3);
    assert.equal(env.getSlot(0, 1, "b", file.span(0, 1)), 2);
    assert.deepEqual(env.ownEntries(), [
      ["a", 3],
      ["b", 2],
    ]);
  });

  it("indexes a scope that grows past a scan, and still answers the same", () => {
    const file = new SourceFile("t.baa", "let a = 1\n");
    const env = new Environment(null, "big");
    for (let i = 0; i < 40; i++) env.define(`name${i}`, i, true);
    assert.equal(env.get("name0", file.span(0, 1)), 0);
    assert.equal(env.get("name39", file.span(0, 1)), 39);
    assert.equal(env.getSlot(0, 39, "name39", file.span(0, 1)), 39);
    assert.equal(env.hasOwn("name17"), true);
    assert.equal(env.hasOwn("nope"), false);
    env.define("name17", 170, true);
    assert.equal(env.getSlot(0, 17, "name17", file.span(0, 1)), 170);
  });
});
