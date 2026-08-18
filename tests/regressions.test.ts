/**
 * Regressions.
 *
 * Every test here corresponds to something that was once wrong: a value that
 * disagreed with itself, a crash that escaped as a JavaScript stack trace, or
 * a program the analyser accepted and then quietly mishandled. They live
 * together rather than scattered through the suite so the shape of the
 * mistakes stays visible, and so nothing here can be deleted by accident while
 * tidying the tests for the feature it belongs to.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { check, lint, run } from "../src/api.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

describe("regression: ranges that count downwards", () => {
  // `length` measured `end - start`, which is negative when a range descends,
  // and then clamped to zero. So `5..0` reported a length of zero while
  // happily yielding five values.
  it("reports the number of values it actually yields", () => {
    assert.equal(output("baa (5..0).length(), (5..=0).length()"), "5 6\n");
    assert.equal(output("baa (0..5).length(), (0..=5).length()"), "5 6\n");
  });

  it("agrees with iteration, len() and to_array()", () => {
    assert.equal(
      output("let r = 5..0\nlet n = 0\nfor _x in r { n += 1 }\nbaa n, len(r), len(r.to_array())"),
      "5 5 5\n",
    );
  });

  it("is only empty when it yields nothing", () => {
    assert.equal(output("baa (5..0).is_empty(), (0..0).is_empty()"), "false true\n");
  });

  it("counts a fractional bound the same way it steps over one", () => {
    assert.equal(output("baa (0..0.5).length(), len((0..0.5).to_array())"), "1 1\n");
    assert.equal(output("baa (0..=0.5).length(), len((0..=0.5).to_array())"), "1 1\n");
  });

  // `in` measured the interval while `.contains()` measured the direction, so
  // the two answered the same question differently.
  it("answers `in` and `.contains()` identically", () => {
    assert.equal(output("let r = 5..0\nbaa 5 in r, r.contains(5)"), "true true\n");
    assert.equal(output("let r = 5..0\nbaa 0 in r, r.contains(0)"), "false false\n");
    assert.equal(output("let r = 0..5\nbaa 0 in r, r.contains(0)"), "true true\n");
    assert.equal(output("let r = 0..5\nbaa 5 in r, r.contains(5)"), "false false\n");
  });

  it("indexes without materialising every value", () => {
    assert.equal(output("baa (0..10000000)[9999999]"), "9999999\n");
    assert.equal(output("baa (5..0)[0], (5..0)[-1]"), "5 1\n");
  });
});

describe("regression: sizes a program asks for", () => {
  // Each of these reached a JavaScript engine limit and threw a RangeError
  // that was not a Baa diagnostic at all: the CLI printed `internal error` and
  // a stack trace from the host language.
  const huge: Array<[string, string]> = [
    ["string repetition", 'baa "ab" * 1e10'],
    ["the repeat method", 'baa "ab".repeat(1e10)'],
    ["wool.repeat", 'import wool\nbaa wool.repeat("ab", 1e10)'],
    ["wool.center", 'import wool\nbaa wool.center("a", 1e10)'],
    ["pad_start", 'baa "a".pad_start(1e10)'],
    ["pad_end", 'baa "a".pad_end(1e10)'],
    ["flock.repeat", "import flock\nbaa flock.repeat(1, 1e10)"],
    ["flock.range", "import flock\nbaa flock.range(1e10)"],
    ["range.to_array", "baa (0..1e10).to_array()"],
  ];

  for (const [what, source] of huge) {
    it(`refuses ${what} beyond the limit, with a diagnostic`, () => {
      assert.deepEqual(codes(source), ["BAA312"]);
    });
  }

  it("still allows sizes a program might genuinely want", () => {
    assert.equal(output('baa len("ab" * 1000)'), "2000\n");
    assert.equal(output("import flock\nbaa len(flock.repeat(1, 100000))"), "100000\n");
  });
});

describe("regression: parameter lists a caller cannot satisfy", () => {
  // All four parsed, resolved and ran. `f(9)` on the first one bound `a` and
  // left `b` as nil, with nothing anywhere saying so.
  it("rejects a required parameter behind an optional one", () => {
    assert.deepEqual(codes("fn f(a = 1, b) { return b }\nbaa f(9)"), ["BAA204"]);
  });

  it("rejects a parameter after the rest parameter", () => {
    assert.deepEqual(codes("fn f(..r, a) { return a }\nbaa f(1)"), ["BAA204"]);
  });

  it("rejects a second rest parameter", () => {
    assert.deepEqual(codes("fn f(..a, ..b) { return b }\nbaa f(1)"), ["BAA204"]);
  });

  it("rejects a default on the rest parameter", () => {
    assert.deepEqual(codes("fn f(..r = 3) { return r }\nbaa f()"), ["BAA204"]);
  });

  it("reports it before the program runs", () => {
    assert.equal(check("fn f(a = 1, b) { return b }", "test.baa").ok, false);
  });

  it("accepts the orders that do work", () => {
    assert.equal(output("fn f(a, b = 2, ..rest) { return [a, b, rest] }\nbaa f(1)"), "[1, 2, []]\n");
    assert.equal(output("fn f(a, b = 2, ..rest) { return [a, b, rest] }\nbaa f(1, 9, 8, 7)"), "[1, 9, [8, 7]]\n");
    assert.equal(output("fn f(..rest) { return rest }\nbaa f(1, 2)"), "[1, 2]\n");
  });
});

describe("regression: string positions count characters", () => {
  // `index_of` returned a UTF-16 offset while `[]`, `slice` and `length` all
  // counted characters, so its result could not be fed back into them.
  it("returns an index the other string operations accept", () => {
    assert.equal(output('let s = "🐑ab"\nbaa s.index_of("a"), s[s.index_of("a")]'), "1 a\n");
    assert.equal(output('let s = "🐑ab"\nbaa s.slice(s.index_of("a"))'), "ab\n");
  });

  it("still reports -1 for text that is not there", () => {
    assert.equal(output('baa "🐑ab".index_of("z")'), "-1\n");
  });
});

describe("regression: source the parser cannot descend", () => {
  // The parser recurses once per level of nesting, so deeply nested source
  // overflowed the JavaScript stack and surfaced as `internal error`.
  it("reports deeply nested expressions as a diagnostic", () => {
    // The parser resynchronises after the depth error, so more diagnostics
    // follow it; what matters is that the first one names the real problem.
    const source = `baa ${"(".repeat(5000)}1${")".repeat(5000)}`;
    assert.equal(codes(source)[0], "BAA011");
  });

  it("reports deeply nested blocks as a diagnostic", () => {
    const source = `${"if true {\n".repeat(2000)}baa 1\n${"}\n".repeat(2000)}`;
    assert.ok(codes(source).includes("BAA011"));
  });

  it("leaves ordinary nesting alone", () => {
    assert.equal(output(`baa ${"(".repeat(50)}1${")".repeat(50)}`), "1\n");
  });
});

describe("regression: number literals", () => {
  // A decimal literal too large to represent was an error, but the radix path
  // never checked, so `0xFFFF...` became `inf` without a word.
  it("rejects a radix literal too large to represent", () => {
    assert.deepEqual(codes(`baa 0x${"F".repeat(300)}`), ["BAA005"]);
  });

  it("names the offending digit rather than trailing off", () => {
    assert.deepEqual(codes("baa 0b12"), ["BAA005"]);
    assert.deepEqual(codes("baa 0o18"), ["BAA005"]);
  });

  it("still accepts valid radix literals", () => {
    assert.equal(output("baa 0xFF, 0o17, 0b1010, 0xdead_beef"), "255 15 10 3735928559\n");
  });

  // `parseInt` stops at the first character it does not understand, so this
  // used to produce "A" and silently discard the rest.
  it("rejects a unicode escape containing something that is not a hex digit", () => {
    assert.deepEqual(codes('baa "\\u{41xyz}"'), ["BAA007"]);
  });

  it("still accepts a valid unicode escape", () => {
    assert.equal(output('baa "\\u{1F411}"'), "🐑\n");
  });
});

describe("regression: parsing text as a number", () => {
  // `Number("")` is 0, so blank text parsed as a number: `to_number` guarded
  // against it and `ram.parse` did not.
  it("treats blank text as unparseable, like to_number does", () => {
    assert.equal(output('import ram\nbaa ram.parse(""), ram.parse("  ")'), "nil nil\n");
    assert.equal(output('baa to_number(""), to_number("  ")'), "nil nil\n");
  });

  it("still parses text that is a number", () => {
    assert.equal(output('import ram\nbaa ram.parse("12"), ram.parse("ff", 16)'), "12 255\n");
  });
});

describe("regression: native functions that fail unexpectedly", () => {
  it("keeps control flow flowing through a standard-library callback", () => {
    assert.equal(
      output("fn first_even(xs) {\n  xs.for_each(fn(x) { return x })\n  return 1\n}\nbaa first_even([1, 2])"),
      "1\n",
    );
  });

  it("lets a thrown value pass through a callback to its handler", () => {
    assert.equal(
      output('try {\n  [1].for_each(fn(_x) { throw "up" })\n} catch e {\n  baa e\n}'),
      "up\n",
    );
  });
});

describe("regression: the linter reaches every expression", () => {
  // These positions were never walked, so an empty block hidden in one was
  // reported everywhere else but not here.
  const hidden: Array<[string, string]> = [
    ["a throw", 'throw fn() { }'],
    ["a range bound", "let _a = 1..(fn() { })()"],
    ["a map key", "let _m = { }\nlet _b = [fn() { }]"],
    ["an interpolation", 'baa "{ (fn() { })() }"'],
    ["an assignment target", "let m = { a: 1 }\nm[(fn() { })()] = 1"],
  ];

  for (const [where, source] of hidden) {
    it(`sees an empty block in ${where}`, () => {
      assert.ok(
        lint(source, "test.baa").warnings.some((warning) => warning.code === "BAA906"),
        `expected BAA906 in: ${source}`,
      );
    });
  }
});

describe("regression: files that must be identical on every platform", () => {
  // The Windows CI runners check files out as CRLF unless told otherwise. The
  // interpreter writes `\n`, so every recorded transcript mismatched there
  // while passing on Linux, macOS and any Windows machine with
  // `core.autocrlf=input`. `.gitattributes` pins the working tree to LF.
  it("records example output with no carriage returns", () => {
    const dir = join(ROOT, "tests", "expected");
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      assert.ok(!text.includes("\r"), `${name} contains a carriage return`);
    }
  });

  it("pins line endings so a checkout cannot introduce them", () => {
    const attributes = readFileSync(join(ROOT, ".gitattributes"), "utf8");
    assert.match(attributes, /^\* text=auto eol=lf$/m);
  });

  // `shepherd.PLATFORM` was rendered as its value on the generating machine,
  // so the committed table read `win32`: `--check` failed on Linux, and every
  // reader not on Windows was told something untrue.
  // Checked across every constant rather than the two that were noticed
  // first: enumerating them is how `pasture.SEPARATOR` slipped through after
  // `shepherd.PLATFORM` had already been fixed.
  it("generates documentation that names no particular machine", () => {
    const docs = readFileSync(join(ROOT, "docs", "stdlib.md"), "utf8");
    const hostSpecific = /^`(win32|linux|darwin|x64|arm64|ia32|\\|\/)`$/;
    for (const [, name, value] of docs.matchAll(/^\| (`\w+\.[A-Z_]+`) \| (.+?) \|$/gm)) {
      assert.doesNotMatch(
        value!,
        hostSpecific,
        `${name} is documented as ${value}, which is only true on the machine that ` +
          "generated it. Describe it in HOST_DEPENDENT in tools/gen-docs.ts instead.",
      );
    }
  });
});

describe("regression: workflows that fail before they start", () => {
  const dir = join(ROOT, ".github", "workflows");
  const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));

  it("has workflows to check", () => {
    assert.ok(workflows.length > 0);
  });

  // `secrets` is not available in an `if:`. Using it there is a validation
  // error, and GitHub fails the entire file at startup rather than the one
  // step: the run appears with zero jobs and a name that is the file path. It
  // reported a failure on every push while never having run anything.
  for (const name of workflows) {
    it(`${name} reads no secret from an if: condition`, () => {
      const text = readFileSync(join(dir, name), "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (!/^\s*if:/.test(line)) continue;
        assert.doesNotMatch(
          line,
          /secrets\./,
          `${name}:${index + 1} reads secrets in an if:, which fails the workflow at startup. ` +
            "Lift it to a job-level `env:` and test that instead.",
        );
      }
    });
  }

  it("asks for the permission npm provenance needs, wherever it publishes", () => {
    for (const name of workflows) {
      const text = readFileSync(join(dir, name), "utf8");
      if (!text.includes("--provenance")) continue;
      assert.match(
        text,
        /id-token:\s*write/,
        `${name} publishes with provenance but never requests id-token: write`,
      );
    }
  });
});
