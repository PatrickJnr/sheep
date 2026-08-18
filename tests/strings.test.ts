/**
 * Block strings, raw strings, patterns and destructuring.
 *
 * The four arrived together because they depend on each other: a pattern needs
 * a raw string to be writable at all, and markup needs a block string. The
 * formatter assertions matter as much as the values: a formatter that rewrites
 * a string's indentation has changed what the program means.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { format, run } from "../src/api.ts";

function output(source: string): string {
  const result = run(source, "test.baa");
  assert.ok(
    result.ok,
    `program failed: ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`,
  );
  return result.output;
}

function codes(source: string): string[] {
  return run(source, "test.baa").diagnostics.map((diagnostic) => diagnostic.code);
}

/** A formatter that changes a string literal is a formatter that changes the program. */
function isFixedPoint(source: string): void {
  const once = format(source, "test.baa");
  assert.equal(format(once, "test.baa"), once, "formatting is not a fixed point");
  assert.equal(run(source, "test.baa").output, run(once, "test.baa").output, "formatting changed the output");
}

describe("block strings", () => {
  it("takes its indentation from the closing delimiter", () => {
    assert.equal(
      output('const s = """\n    one\n    two\n    """\nbaa s'),
      "one\ntwo\n",
    );
  });

  it("keeps indentation relative to that", () => {
    assert.equal(
      output('const s = """\n    outer\n        inner\n    """\nbaa s'),
      "outer\n    inner\n",
    );
  });

  it("adds no trailing newline of its own", () => {
    assert.equal(output('const s = """\n    one\n    """\nbaa len(s)'), "3\n");
  });

  it("treats a blank line as a newline and nothing else", () => {
    assert.equal(output('const s = """\n    a\n\n    b\n    """\nbaa len(s)'), "4\n");
  });

  it("interpolates and escapes like an ordinary string", () => {
    assert.equal(
      output('const who = "Dolly"\nconst s = """\n    hi {who}\n    tab:\\tdone\n    """\nbaa s'),
      "hi Dolly\ntab:\tdone\n",
    );
  });

  it("is empty when it holds nothing", () => {
    assert.equal(output('const s = """\n    """\nbaa len(s)'), "0\n");
  });

  const malformed: Array<[string, string]> = [
    ["content on the opening line", 'const s = """oops\n    x\n    """\nbaa s'],
    ["content before the closing delimiter", 'const s = """\n    x\n    y"""\nbaa s'],
    ["a line indented less than the close", 'const s = """\n  x\n    """\nbaa s'],
    ["no closing delimiter at all", 'const s = """\n    x\nbaa s'],
  ];
  for (const [what, source] of malformed) {
    it(`rejects ${what}`, () => {
      const reported = codes(source);
      assert.ok(
        reported.includes("BAA012") || reported.includes("BAA003"),
        `expected BAA012 or BAA003, got ${reported.join(", ")}`,
      );
    });
  }

  it("survives formatting unchanged", () => {
    isFixedPoint('fn page(x) {\n    return """\n        <p>{x}</p>\n          <i>kept</i>\n        """\n}\nbaa page("a")\n');
  });
});

describe("raw strings", () => {
  it("takes a backslash literally", () => {
    assert.equal(output('baa r"C:\\Users"'), "C:\\Users\n");
    assert.equal(output('baa len(r"\\d")'), "2\n");
  });

  it("does not interpolate", () => {
    assert.equal(output('const x = 1\nbaa r"{x}"'), "{x}\n");
  });

  it("spans lines in its block form, indented by the close", () => {
    assert.equal(
      output('const s = r"""\n    body { color: red }\n    """\nbaa s'),
      "body { color: red }\n",
    );
  });

  it("refuses a newline in the single-line form", () => {
    assert.deepEqual(codes('const s = r"one\nbaa s'), ["BAA003"]);
  });

  it("is still a name when not followed by a quote", () => {
    assert.equal(output('const r = 5\nbaa r'), "5\n");
  });

  it("survives formatting unchanged", () => {
    isFixedPoint('const p = r"\\d{2,4}"\nconst c = r"""\n    a { b: c }\n    """\nbaa p, c\n');
  });
});

describe("wool: patterns", () => {
  it("matches, finds and counts", () => {
    assert.equal(output('import wool\nbaa wool.matches("sheep 42", r"\\d+")'), "true\n");
    assert.equal(
      output('import wool\nbaa wool.find("sheep 42", r"\\d+").get("match")'),
      "42\n",
    );
    assert.equal(
      output('import wool\nbaa len(wool.find_all("a1 b22 c3", r"\\d+"))'),
      "3\n",
    );
  });

  it("reports character offsets, not UTF-16 units", () => {
    assert.equal(
      output('import wool\nbaa wool.find("\\u{1F411}ab", r"a").get("start")'),
      "1\n",
    );
  });

  it("returns nil rather than failing when nothing matches", () => {
    assert.equal(output('import wool\nbaa wool.find("abc", r"\\d")'), "nil\n");
  });

  it("captures numbered and named groups", () => {
    assert.equal(
      output('import wool\nbaa wool.find("2026-08", r"(\\d{4})-(\\d{2})").get("groups")'),
      '["2026", "08"]\n',
    );
    assert.equal(
      output('import wool\nbaa wool.find("2026-08", r"(?<y>\\d{4})").get("named").get("y")'),
      "2026\n",
    );
  });

  it("substitutes every match, with group references", () => {
    assert.equal(
      output('import wool\nbaa wool.substitute("a1b2", r"(\\d)", "[$1]")'),
      "a[1]b[2]\n",
    );
  });

  it("splits on a pattern", () => {
    assert.equal(output('import wool\nbaa wool.split_on("a1b22c", r"\\d+")'), '["a", "b", "c"]\n');
  });

  it("honours the flags it accepts and refuses the rest", () => {
    assert.equal(output('import wool\nbaa wool.matches("BAA", r"baa", "i")'), "true\n");
    assert.deepEqual(codes('import wool\nbaa wool.matches("x", r"x", "g")'), ["BAA311"]);
  });

  it("reports an invalid pattern as a diagnostic, not a crash", () => {
    const reported = codes('import wool\nbaa wool.matches("x", r"(unclosed")');
    assert.deepEqual(reported, ["BAA301"]);
  });
});

describe("destructuring", () => {
  it("takes an array apart", () => {
    assert.equal(output("const [a, b] = [1, 2]\nbaa a, b"), "1 2\n");
  });

  it("collects the remainder with `..`", () => {
    assert.equal(output("const [first, ..rest] = [1, 2, 3]\nbaa first, rest"), "1 [2, 3]\n");
    assert.equal(output("const [a, ..rest] = [1]\nbaa rest"), "[]\n");
  });

  it("binds nil for a missing item or key", () => {
    assert.equal(output("const [a, b] = [1]\nbaa b"), "nil\n");
    assert.equal(output('const { missing } = { a: 1 }\nbaa missing'), "nil\n");
  });

  it("takes a map apart, with renaming", () => {
    assert.equal(output('const { name, age } = { name: "Dolly", age: 6 }\nbaa name, age'), "Dolly 6\n");
    assert.equal(output('const { name as who } = { name: "Dolly" }\nbaa who'), "Dolly\n");
  });

  it("nests", () => {
    assert.equal(
      output('const [{ name as first }, ..others] = [{ name: "Shaun" }, { name: "Timmy" }]\nbaa first, len(others)'),
      "Shaun 1\n",
    );
  });

  it("keeps the mutability of its keyword", () => {
    assert.equal(output("let [p] = [1]\np += 1\nbaa p"), "2\n");
    assert.deepEqual(codes("const [p] = [1]\np = 2"), ["BAA103"]);
  });

  it("declares every name for use-before-declaration checking", () => {
    assert.deepEqual(codes("baa a\nconst [a] = [1]"), ["BAA106"]);
  });

  it("refuses a value of the wrong shape", () => {
    assert.deepEqual(codes("const [a] = 5\nbaa a"), ["BAA311"]);
    assert.deepEqual(codes("const { a } = [1]\nbaa a"), ["BAA311"]);
  });

  it("refuses anything after the rest element", () => {
    assert.ok(codes("const [..rest, last] = [1, 2]\nbaa last").length > 0);
  });

  it("survives formatting unchanged", () => {
    isFixedPoint('const [a, ..rest] = [1, 2, 3]\nconst { x, y as z } = { x: 1, y: 2 }\nbaa a, rest, x, z\n');
  });
});
