import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../src/api.ts";

function output(source: string, seed?: number): string {
  const result = run(source, "test.baa", seed === undefined ? {} : { seed });
  assert.ok(
    result.ok,
    `program failed: ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`,
  );
  return result.output.trimEnd();
}

function failureCode(source: string): string {
  const result = run(source, "test.baa");
  assert.equal(result.ok, false, `expected failure, got: ${result.output}`);
  return result.diagnostics[0]!.code;
}

describe("stdlib: methods on values", () => {
  it("string methods", () => {
    assert.equal(
      output(`baa "  Wool ".trim().upper(), "a,b".split(","), "abc".slice(1), "ab".repeat(2)`),
      'WOOL ["a", "b"] bc abab',
    );
    assert.equal(
      output(`baa "wool".contains("oo"), "wool".starts_with("w"), "wool".index_of("l")`),
      "true true 3",
    );
    assert.equal(output(`baa "42".to_number(), "x".to_number(), "".to_number()`), "42 nil nil");
    assert.equal(output(`baa "5".pad_start(3, "0"), "5".pad_end(3, ".")`), "005 5..");
  });

  it("array methods", () => {
    assert.equal(
      output("const a = [3, 1, 2]\nbaa a.sort(), a.reverse(), a.unique(), a.sum()"),
      "[1, 2, 3] [2, 1, 3] [3, 1, 2] 6",
    );
    assert.equal(
      output("baa [1, 2, 3].filter(fn(n) { return n > 1 }).map(fn(n) { return n * 10 })"),
      "[20, 30]",
    );
    assert.equal(
      output("baa [1, 2, 3].reduce(fn(t, n) { return t + n }, 0), [1, 2].any(fn(n) { return n > 1 })"),
      "6 true",
    );
    assert.equal(output("baa [[1], [2, 3]].flatten(), [1, 2].concat([3])"), "[1, 2, 3] [1, 2, 3]");
    assert.equal(output('baa ["a", "b"].join("-"), [].is_empty()'), "a-b true");
  });

  it("array mutation methods", () => {
    assert.equal(
      output("const a = [1, 2, 3]\na.push(4)\na.insert(0, 0)\nbaa a.remove(1), a, a.pop()"),
      "1 [0, 2, 3, 4] 4",
    );
  });

  it("map methods", () => {
    assert.equal(
      output('const m = { a: 1, b: 2 }\nbaa m.keys(), m.values(), m.has("a"), m.length()'),
      '["a", "b"] [1, 2] true 2',
    );
    assert.equal(
      output('baa { a: 1 }.merge({ b: 2 }), { a: 1 }.get("z", 0)'),
      "{ a: 1, b: 2 } 0",
    );
    assert.equal(failureCode('baa { a: 1 }.expect("z")'), "BAA310");
  });

  it("range and number methods", () => {
    assert.equal(output("baa (0..3).to_array(), (0..3).length(), (0..3).contains(2)"), "[0, 1, 2] 3 true");
    assert.equal(output("baa (3.7).floor(), (3.2).ceil(), (-4).abs(), (2.5).to_fixed(1)"), "3 4 4 2.5");
  });

  it("reports a wrong argument type as BAA311", () => {
    assert.equal(failureCode('baa "x".repeat("y")'), "BAA311");
    assert.equal(failureCode("baa [1].join(5)"), "BAA311");
  });
});

describe("stdlib: wool", () => {
  it("changes case", () => {
    assert.equal(
      output(`import wool
baa wool.snake_case("MaxSheepPerPen"), wool.camel_case("max sheep"), wool.kebab_case("MaxSheep")`),
      "max_sheep_per_pen maxSheep max-sheep",
    );
  });

  it("formats with %s placeholders", () => {
    assert.equal(output('import wool\nbaa wool.format("%s of %s (%%)", 3, 10)'), "3 of 10 (%)");
    assert.equal(failureCode('import wool\nbaa wool.format("%s %s", 1)'), "BAA301");
  });

  it("wraps and centres text", () => {
    assert.equal(output('import wool\nbaa wool.wrap("a bb ccc", 4)'), "a bb\nccc");
    assert.equal(output('import wool\nbaa wool.center("ab", 6, "-")'), "--ab--");
  });

  it("round-trips bytes", () => {
    assert.equal(
      output('import wool\nbaa wool.from_bytes(wool.to_bytes("Baa \\u{1F411}"))'),
      "Baa \u{1F411}",
    );
  });
});

describe("stdlib: ram", () => {
  it("rounds and divides", () => {
    assert.equal(
      output("import ram\nbaa ram.round(3.14159, 2), ram.idiv(-7, 2), ram.modulo(-7, 3), ram.gcd(12, 18)"),
      "3.14 -4 2 6",
    );
  });

  it("computes statistics", () => {
    assert.equal(
      output("import ram\nbaa ram.sum([1, 2, 3]), ram.mean([1, 2, 3, 4]), ram.median([5, 1, 3])"),
      "6 2.5 3",
    );
    assert.equal(output("import ram\nbaa ram.mean([]), ram.median([])"), "nil nil");
  });

  it("converts bases", () => {
    assert.equal(
      output('import ram\nbaa ram.to_hex(255), ram.to_binary(5), ram.parse("ff", 16), ram.parse("x")'),
      "ff 101 255 nil",
    );
  });

  it("refuses undefined operations", () => {
    assert.equal(failureCode("import ram\nbaa ram.sqrt(-1)"), "BAA301");
    assert.equal(failureCode("import ram\nbaa ram.idiv(1, 0)"), "BAA306");
  });
});

describe("stdlib: flock", () => {
  it("reshapes collections", () => {
    assert.equal(
      output("import flock\nbaa flock.chunk([1, 2, 3], 2), flock.zip([1, 2], [3, 4])"),
      "[[1, 2], [3]] [[1, 3], [2, 4]]",
    );
    assert.equal(
      output('import flock\nbaa flock.to_map([["a", 1]]), flock.invert({ a: 1 })'),
      "{ a: 1 } { 1: \"a\" }",
    );
    assert.equal(output("import flock\nbaa flock.range(3), flock.range(1, 6, 2)"), "[0, 1, 2] [1, 3, 5]");
  });

  it("groups, partitions and sorts by a key", () => {
    assert.equal(
      output(`import flock
const words = ["bee", "ox", "cat"]
baa flock.group_by(words, fn(w) { return w.length() })
baa flock.partition(words, fn(w) { return w.length() == 3 })
baa flock.sort_by(words, fn(w) { return w })
baa flock.max_by(words, fn(w) { return w.length() })`),
      '{ 3: ["bee", "cat"], 2: ["ox"] }\n[["bee", "cat"], ["ox"]]\n["bee", "cat", "ox"]\nbee',
    );
  });
});

describe("stdlib: lamb", () => {
  it("round-trips values through JSON", () => {
    assert.equal(
      output(`import lamb
const value = { name: "Dolly", tags: ["a"], age: 6, ok: true, nothing: nil }
const text = lamb.encode(value)
baa text
baa lamb.decode(text) == value`),
      '{"name":"Dolly","tags":["a"],"age":6,"ok":true,"nothing":null}\ntrue',
    );
  });

  it("pretty-prints with an indent", () => {
    assert.equal(output('import lamb\nbaa lamb.encode({ a: [1] }, 2)'), '{\n  "a": [\n    1\n  ]\n}');
  });

  it("handles invalid input predictably", () => {
    assert.equal(output('import lamb\nbaa lamb.is_valid("nope"), lamb.try_decode("nope", 1)'), "false 1");
    assert.equal(failureCode('import lamb\nbaa lamb.decode("nope")'), "BAA301");
  });

  it("refuses values with no JSON form", () => {
    assert.equal(failureCode("import lamb\nbaa lamb.encode(fn() { return 1 })"), "BAA301");
    assert.equal(failureCode("import lamb\nbaa lamb.encode(0..3)"), "BAA301");
    assert.equal(
      failureCode("import lamb\nconst a = []\na.push(a)\nbaa lamb.encode(a)"),
      "BAA301",
    );
  });
});

describe("stdlib: meadow", () => {
  it("formats timestamps deterministically", () => {
    assert.equal(
      output('import meadow\nbaa meadow.format(0, "YYYY-MM-DD hh:mm:ss"), meadow.iso(0)'),
      "1970-01-01 00:00:00 1970-01-01T00:00:00.000Z",
    );
    assert.equal(output("import meadow\nbaa meadow.parts(0).weekday"), "Thursday");
    assert.equal(
      output('import meadow\nbaa meadow.parse_iso("1970-01-02T00:00:00Z"), meadow.parse_iso("x")'),
      "86400000 nil",
    );
  });

  it("is reproducible with a seed", () => {
    const program = "import meadow\nbaa meadow.random_int(1, 100), meadow.shuffle([1, 2, 3, 4])";
    assert.equal(output(program, 42), output(program, 42));
  });

  it("keeps random_int inside its bounds", () => {
    assert.equal(
      output(`import meadow
let ok = true
for i in 0..200 {
  const n = meadow.random_int(1, 6)
  if n < 1 || n > 6 { ok = false }
}
baa ok`),
      "true",
    );
  });
});

describe("stdlib: shepherd", () => {
  it("exposes platform information and arguments", () => {
    const result = run("import shepherd\nbaa shepherd.args()", "t.baa", { argv: ["a", "b"] });
    assert.equal(result.output, '["a", "b"]\n');
  });

  it("writes without a trailing newline", () => {
    assert.equal(output('import shepherd\nshepherd.write("a")\nshepherd.write("b")'), "ab");
  });
});
