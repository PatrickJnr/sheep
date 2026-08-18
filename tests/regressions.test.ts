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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { check, lint, run } from "../src/api.ts";
import { ALL_CODES } from "../src/diagnostics/codes.ts";
import { suiteCounts } from "../tools/native-conformance.ts";
import { STDLIB_MODULES } from "../src/stdlib/index.ts";
import { PRELUDE_NAMES } from "../src/stdlib/prelude.ts";

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

describe("regression: a brace in a string is an interpolation", () => {
  // Not a bug: `{` opening an interpolation is the design. It is here because
  // `"{" + x + "}"` is the one construct that compiles and produces a wrong
  // answer with nothing reported, and because `llms-full.txt` states this
  // behaviour precisely for models to rely on. If any of it ever changes, the
  // documentation has to change with it, and this is what says so.
  it("is a loud error when the interpolation is never closed", () => {
    assert.deepEqual(codes('const x = 5\nbaa "{" + x'), ["BAA001"]);
    assert.deepEqual(codes('baa "{\\"a\\": 1}"'), ["BAA001"]);
  });

  it("is silently one string when a later `}` closes it", () => {
    // The closing `"}"` completes the interpolation, so the whole thing is a
    // single string literal whose interpolation is the text ` + x + `.
    // The spaces are part of it: the interpolation's text is `" + x + "`.
    assert.equal(output('const x = 5\nbaa "{" + x + "}"'), " + x + \n");
  });

  it("is a literal brace when escaped, and in a raw string", () => {
    assert.equal(output('const x = 5\nbaa "\\{" + x + "\\}"'), "{5}\n");
    assert.equal(output('baa r"{a}"'), "{a}\n");
  });

  it("still interpolates when that is what was meant", () => {
    assert.equal(output('const x = 5\nbaa "{x}"'), "5\n");
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

  // Publishing is trusted publishing now, so the OIDC token is the only
  // credential. Without this permission there is nothing to authenticate with
  // and the publish fails at the last step of a release.
  it("asks for the permission npm publishing needs, wherever it publishes", () => {
    for (const name of workflows) {
      const text = readFileSync(join(dir, name), "utf8");
      if (!/^\s*run:.*npm publish/m.test(text) && !text.includes("npm publish")) continue;
      assert.match(
        text,
        /id-token:\s*write/,
        `${name} runs npm publish but never requests id-token: write`,
      );
    }
  });

  // Trusted publishing generates provenance itself when the build qualifies,
  // and a private repository does not qualify: npm does not attest a build
  // nobody can inspect. Passing the flag is then an error rather than a
  // no-op, so it must not creep back in.
  it("does not pass --provenance, which trusted publishing decides for itself", () => {
    for (const name of workflows) {
      // Comments are stripped: this is about what the runner executes, and the
      // step above it explains at length why the flag is absent.
      const commands = readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert.ok(
        !commands.includes("--provenance"),
        `${name} passes --provenance explicitly; trusted publishing adds it when eligible`,
      );
    }
  });

  // A stored npm token is the mechanism npm is retiring: 2FA-bypass tokens
  // lost account and package management in July 2026 and lose direct publish
  // in January 2027.
  it("stores no npm token, having moved to trusted publishing", () => {
    for (const name of workflows) {
      const text = readFileSync(join(dir, name), "utf8");
      assert.ok(
        !/NPM_TOKEN|NODE_AUTH_TOKEN/.test(text),
        `${name} still references an npm token; trusted publishing needs none`,
      );
    }
  });
});

describe("regression: issue-template contact links", () => {
  const config = readFileSync(join(ROOT, ".github", "ISSUE_TEMPLATE", "config.yml"), "utf8");
  const urls = [...config.matchAll(/^\s*url:\s*(\S+)$/gm)].map((match) => match[1]!);

  it("has contact links", () => {
    assert.ok(urls.length > 0);
  });

  // GitHub offers private vulnerability reporting on public repositories only.
  // While this one is private the link 404s, which is a poor thing to hand
  // somebody who has just found a vulnerability. SECURITY.md gives both routes.
  it("does not send reporters to a page that needs a public repository", () => {
    for (const url of urls) {
      assert.doesNotMatch(
        url,
        /\/security\/advisories\/new/,
        "link to SECURITY.md instead: /security/advisories/new 404s on a private repository",
      );
    }
  });

  it("points at files that exist, for links into this repository", () => {
    for (const url of urls) {
      const path = /github\.com\/[\w-]+\/[\w-]+\/blob\/[\w-]+\/(.+)$/.exec(url)?.[1];
      if (path === undefined) continue;
      assert.ok(existsSync(join(ROOT, path)), `contact link points at ${path}, which does not exist`);
    }
  });
});

describe("regression: a document pasted into itself", () => {
  // LANGUAGE.md shipped for two releases containing a truncated copy of
  // itself. A `$` inside a shell heredoc ate the rest of a sentence and the
  // whole file landed in the gap, so the tour introduced itself twice and one
  // explanation stopped mid-clause. Nothing noticed: the links still resolved,
  // the anchors still existed, and the duplicate rendered as valid Markdown.
  //
  // One title per document is the invariant that would have caught it.
  it("never states its own title twice", () => {
    const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    for (const relative of files) {
      const text = readFileSync(join(ROOT, relative), "utf8");
      // A `#` comment inside a TOML or shell block is not a heading.
      const prose = text.replace(/^```[\s\S]*?^```/gm, "");
      // The README opens with a banner image and no `#` heading, and the
      // issue templates open with a form. Both are fine; two titles are not.
      const titles = [...prose.matchAll(/^# (.+)$/gm)];
      assert.ok(titles.length <= 1, `${relative} has ${titles.length} top-level headings`);
      if (titles.length === 0) continue;

      // The truncated line read "...`m` matches `^` and `# The Baa language
      // tour", so the first appearance was not at the start of a line at all.
      const title = titles[0]![1]!;
      const stray = new RegExp(`.# ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      assert.doesNotMatch(text, stray, `${relative} repeats its own title mid-line`);
    }
  });
});

describe("regression: counts the README states as fact", () => {
  // The README claimed seven standard-library modules while listing eight, and
  // gave the number of diagnostics as 41 in one section and 44 in another,
  // when there were 45. Hand-written numbers drift silently because nothing
  // reads them, so this reads them.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const suite = JSON.parse(readFileSync(join(ROOT, "tests", "conformance", "suite.json"), "utf8"));
  const counts = suiteCounts();

  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

  const claims = (pattern: RegExp): string[] =>
    [...readme.matchAll(pattern)].map((match) => match[1]!);

  it("states the number of standard-library modules it lists", () => {
    const stated = claims(/^(\w+) modules, sheep-branded/gm);
    assert.equal(stated.length, 1, "expected exactly one claim about the module count");
    assert.equal(stated[0]!.toLowerCase(), WORDS[STDLIB_MODULES.length]);
  });

  // The count appeared in five more places than the README: ARCHITECTURE.md,
  // SECURITY.md, rust/README.md and the site builder's own page description
  // all said seven too. Checking one file would have left four wrong.
  it("does not say a stale module count anywhere in the repository", () => {
    const words = new Set(WORDS.map((word) => word).filter((word) => word !== WORDS[STDLIB_MODULES.length]));
    const files = execFileSync("git", ["ls-files", "*.md", "*.ts"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    for (const relative of files) {
      const text = readFileSync(join(ROOT, relative), "utf8");
      for (const [phrase, word] of text.matchAll(/\b(\w+) modules\b[,.]?/g)) {
        // `2 modules, using barn` in a `baa app build` transcript counts the
        // program's own files, not the standard library. A comma after the
        // word is what tells the two apart: a claim about the library ends the
        // clause there, or continues with a verb.
        if (phrase!.endsWith(",")) continue;
        // Digits count too. A stale figure sat inside a sample `baa doctor`
        // transcript in the CLI reference through every earlier sweep,
        // because those looked only for the number written as a word.
        if (/^\d+$/.test(word!)) {
          assert.equal(
            Number(word),
            STDLIB_MODULES.length,
            `${relative} says "${phrase}", but there are ${STDLIB_MODULES.length}`,
          );
          continue;
        }
        if (!words.has(word!.toLowerCase())) continue;
        assert.fail(`${relative} says "${phrase}", but there are ${STDLIB_MODULES.length}`);
      }
    }
  });

  // `website/` is deliberately not committed, so `git ls-files` never sees it
  // and the sweep above could not. Two stale counts survived there for exactly
  // that reason: the home page and the documentation index both still spelled
  // out a module count from two releases earlier, and the index also stated a
  // diagnostic count five codes short. The site builder expands
  // `{{modules}}` and `{{diagnostics}}` in its own sources, so a page has a way
  // to state a count without writing one down; this asserts it took it.
  it("states no hand-written count in the website sources", () => {
    const src = join(ROOT, "website", "src");
    if (!existsSync(src)) return; // a clone without the site checked out
    const words = new Set(WORDS.filter((word) => word !== WORDS[STDLIB_MODULES.length]));
    for (const entry of readdirSync(src)) {
      const text = readFileSync(join(src, entry), "utf8");
      for (const [phrase, word] of text.matchAll(/\b(\w+) modules\b[,.]?/g)) {
        if (phrase!.endsWith(",")) continue;
        if (/^\d+$/.test(word!)) {
          assert.fail(`website/src/${entry} says "${phrase}"; use {{modules}}`);
        }
        if (words.has(word!.toLowerCase())) {
          assert.fail(`website/src/${entry} says "${phrase}", but there are ${STDLIB_MODULES.length}`);
        }
      }
      for (const [phrase, count] of text.matchAll(/\bAll (\d+) `?BAA/g)) {
        assert.equal(
          Number(count),
          ALL_CODES.length,
          `website/src/${entry} says "${phrase}"; use {{diagnostics}}`,
        );
      }
    }
  });

  it("lists every standard-library module in its table", () => {
    const listed = [...readme.matchAll(/^\| `(\w+)` \| /gm)].map((match) => match[1]!);
    for (const module of STDLIB_MODULES) {
      assert.ok(listed.includes(module), `the standard library table omits \`${module}\``);
    }
  });

  it("states the number of diagnostics, the same way in both places", () => {
    const stated = claims(/\b(?:All|all) (\d+) (?:of them are listed|diagnostics)/g);
    assert.ok(stated.length >= 2, `expected both diagnostic-count claims, found ${stated.length}`);
    for (const count of stated) {
      assert.equal(Number(count), ALL_CODES.length);
    }
  });

  // Sample output in the CLI reference showed `Baa 0.1.0` two releases later.
  // Only Baa's own version is checked: the same document shows an example
  // project at `hill_farm 0.1.0`, which is that project's version, not this one.
  it("shows its own version in documentation examples", () => {
    const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
    const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((relative) => relative !== "CHANGELOG.md");
    for (const relative of files) {
      const text = readFileSync(join(ROOT, relative), "utf8");
      for (const [phrase, shown] of text.matchAll(/\bBaa\s+(\d+\.\d+\.\d+)\b/g)) {
        assert.equal(shown, version, `${relative}: "${phrase}" is not the current version`);
      }
      // ROADMAP.md opens with `Version **0.5.0**`, which the sweep above did
      // not match. It was stale within hours of a release: the roadmap is
      // written before the version is cut, and nothing read it afterwards.
      for (const [phrase, shown] of text.matchAll(/\bVersion \*\*(\d+\.\d+\.\d+)\*\*/g)) {
        assert.equal(shown, version, `${relative}: "${phrase}" is not the current version`);
      }
    }
  });

  it("states the size of the prelude", () => {
    const stated = claims(/a (\w+)-name prelude/g);
    assert.equal(stated.length, 1);
    assert.equal(stated[0]!.toLowerCase(), WORDS[PRELUDE_NAMES.length]);
  });

  it("states the size of the conformance suite", () => {
    const programs = claims(/suite\.json\): (\d+) programs/g);
    assert.deepEqual(programs.map(Number), [suite.programs.length]);
    const diagnostics = claims(/and (\d+) with the diagnostic codes/g);
    assert.deepEqual(diagnostics.map(Number), [suite.diagnostics.length]);
  });

  // The same numbers appear in ROADMAP.md and rust/README.md, which are the
  // documents somebody starting a second implementation actually reads. They
  // were stale in both, so the sweep covers every tracked document rather than
  // the one file that happened to be checked.
  it("does not state a stale suite size anywhere in the repository", () => {
    const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((relative) => relative !== "CHANGELOG.md");
    for (const relative of files) {
      const text = readFileSync(join(ROOT, relative), "utf8");
      // "27 programs with the diagnostic codes" is the other half of the
      // suite, so only a count of programs-with-output is checked here.
      //
      // Two different true numbers live in these documents: the suite holds 50
      // programs, and the native runtime can attempt the ones that do not
      // import a module it lacks. A sentence saying "conformance programs"
      // means the second. Both come from the harness, so neither can be written
      // down by hand and left behind.
      for (const [phrase, count] of text.matchAll(/\b(\d+) (conformance )?programs\b(?! with the diagnostic)/g)) {
        const expected = phrase!.includes("conformance") ? counts.runnable : suite.programs.length;
        assert.equal(Number(count), expected, `${relative}: "${phrase}"`);
      }
      for (const [phrase, count] of text.matchAll(/\b(?:all|All) (\d+) diagnostics\b/g)) {
        assert.equal(Number(count), ALL_CODES.length, `${relative}: "${phrase}"`);
      }
    }
  });

  // There are no runtime dependencies, but there are three development ones,
  // so a badge reading "dependencies: none" was not true as written.
  it("does not claim to have no dependencies at all", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.deepEqual(pkg.dependencies ?? {}, {}, "a runtime dependency would make the badge wrong");
    if (Object.keys(pkg.devDependencies ?? {}).length > 0) {
      assert.doesNotMatch(
        readme,
        /badge\/dependencies-none/,
        "say `runtime dependencies` while development dependencies exist",
      );
    }
  });
});

describe("regression: the package as installed, not as cloned", () => {
  // baa-lang 0.2.0 shipped its TypeScript sources and pointed `bin` at
  // `src/cli/index.ts`. It installed cleanly and then failed on first run:
  // Node refuses to strip types from anything under node_modules, so the
  // published package could not execute a single program. It worked from a
  // clone, which is the one place it was ever tried.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    exports: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
  };

  const published = [...Object.values(pkg.bin), ...Object.values(pkg.exports)];

  it("runs compiled JavaScript, not sources Node will refuse to strip", () => {
    for (const entry of published) {
      assert.doesNotMatch(
        entry,
        /\.ts$/,
        `${entry} is TypeScript; Node cannot strip types under node_modules`,
      );
      assert.match(entry, /(^|\/)dist\//, `${entry} should come from the build output`);
    }
  });

  it("ships the build output and not the sources", () => {
    assert.ok(pkg.files.includes("dist"), "the tarball must contain dist");
    assert.ok(!pkg.files.includes("src"), "shipping src alongside dist is dead weight");
  });

  // Without this the tarball is whatever `dist` happened to contain, which on
  // a clean checkout is nothing at all.
  it("builds automatically when packing", () => {
    assert.match(pkg.scripts.prepack ?? "", /build/);
    assert.match(pkg.scripts.build ?? "", /tsc -p tsconfig\.build\.json/);
  });
});

describe("regression: commands the reference forgot", () => {
  // `baa lsp` shipped, was added to the README table and to `--help`, and was
  // never given a section in the CLI reference, which claims to document every
  // command. Nothing compared the two lists, so nothing noticed.
  it("documents every command the CLI offers", () => {
    const cli = readFileSync(join(ROOT, "src", "cli", "index.ts"), "utf8");
    const block = /^COMMANDS$([\s\S]*?)^$/m.exec(cli)?.[1] ?? "";
    const commands = [...block.matchAll(/^ {2}(\w+)/gm)].map((match) => match[1]!);
    assert.ok(commands.length > 5, `expected to find the command list, got ${commands.length}`);

    // Headings may cover two commands at once, as `baa add` / `baa remove`
    // does, so the name is looked for anywhere in a heading rather than at
    // the start of one.
    const headings = readFileSync(join(ROOT, "docs", "cli.md"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("## "));
    for (const command of commands) {
      assert.ok(
        headings.some((heading) => heading.includes(`\`baa ${command}\``)),
        `docs/cli.md has no section for \`baa ${command}\``,
      );
    }
  });
});

describe("regression: claims the documentation makes about itself", () => {
  // Each of these was written once and then quietly stopped being true. They
  // are checked rather than trusted because that is the only thing that keeps
  // documentation honest as the thing it describes moves.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  // The README said nine. The grammar defines fourteen.
  it("counts the statement forms the grammar actually defines", () => {
    const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const production = /^statement\s+::=([\s\S]*?)\n(?=\w+\s+::=)/m.exec(spec);
    assert.ok(production, "could not find the statement production in SPEC.md");
    const forms = production[1]!.split("|").map((form) => form.trim()).filter(Boolean);
    const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
      "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
    const stated = /\*\*Small core\*\* \| (\w+) statement forms/.exec(readme)?.[1];
    assert.equal(stated?.toLowerCase(), WORDS[forms.length], `the grammar defines ${forms.length}`);
  });

  // "no third-party packages" and "nothing is downloaded" are the two claims
  // it would be worst to be wrong about, so they are the two worth checking.
  it("has the runtime dependencies it says it has", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.deepEqual(pkg.dependencies ?? {}, {}, "the README promises no third-party packages");
  });

  it("spawns nothing through a shell, as the README promises", () => {
    const sources = execFileSync("git", ["ls-files", "src/**/*.ts"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    let spawns = 0;
    for (const relative of sources) {
      const text = readFileSync(join(ROOT, relative), "utf8");
      for (const [, call] of text.matchAll(/\b(spawnSync|spawn|execFile|execFileSync)\(/g)) {
        void call;
        spawns++;
      }
      assert.doesNotMatch(
        text,
        /\bexecSync\(|[^a-zA-Z]exec\(\s*["'`]/,
        `${relative} runs a command through a shell`,
      );
      assert.doesNotMatch(text, /shell:\s*true/, `${relative} asks for a shell`);
    }
    assert.ok(spawns > 0, "expected to find the subprocess calls this is guarding");
  });

  // Said "recorded and asserted" for every example, while one is executed and
  // not compared because it reads the clock.
  it("describes how the examples are checked, accurately", () => {
    const recorded = readdirSync(join(ROOT, "tests", "expected")).filter((n) => n.endsWith(".txt"));
    const all = readdirSync(join(ROOT, "examples")).filter((n) => n.endsWith(".baa"));
    if (recorded.length !== all.length) {
      assert.match(
        readme,
        /All but one have their exact\noutput recorded/,
        `${all.length - recorded.length} example(s) are run without their output being compared, and the README should say so`,
      );
    }
  });
});

describe("regression: articles in diagnostic messages", () => {
  // Four templates wrote the article themselves ("a {0}") while every call site
  // also supplied one, so real programs were told "You can't add a an array and
  // a a number" and "A an array has no field". The article belongs to the
  // phrase the call site passes, never to the template.
  it("never writes an article in front of a placeholder", () => {
    const source = readFileSync(join(ROOT, "src", "diagnostics", "codes.ts"), "utf8");
    for (const [line] of source.matchAll(/^.*\b[Aa]n? \{\d\}.*$/gm)) {
      assert.fail(`template supplies its own article, so the call site doubles it: ${line.trim()}`);
    }
  });

  const message = (source: string): string => {
    const result = run(source, "test.baa");
    const diagnostic = result.diagnostics.find((d) => d.severity === "error");
    assert.ok(diagnostic, `expected an error from: ${source}`);
    return diagnostic.message;
  };

  it("reads as English for every type slot", () => {
    for (const [source, expected] of [
      ["baa [1] + 1", "You can't add an array and a number. These sheep don't herd together."],
      ["baa [1].merge(2)", "There is no field called `merge` on an array."],
      ["baa nil.length()", "There is no field called `length` on nil."],
      ["for x in 5 { baa x }", "You can't herd a number: only arrays, maps, strings and ranges can be looped over."],
      ["baa [1].concat(2)", "`concat` expected an array for argument 1, but got a number."],
      ["baa \"x\".repeat([1])", "`repeat` expected a number for argument 1, but got an array."],
      ["baa \"x\".repeat(-1)", "`repeat` expected a count of 0 or more for argument 1, but got a negative number."],
    ] as const) {
      assert.equal(message(source), expected);
    }
  });

  // `ram.parse` and `shepherd.exit` reported the JavaScript type name, so a Baa
  // program could be told it passed "a object" or "an undefined".
  it("names Baa types rather than JavaScript ones", () => {
    for (const source of [
      'use "ram"\nbaa ram.parse([1])',
      'use "ram"\nbaa ram.sum([1, "a"])',
      'use "shepherd"\nshepherd.exit("x")',
    ]) {
      const text = message(source);
      assert.doesNotMatch(text, /\ba(n)? (object|undefined|symbol|bigint)\b/, text);
    }
  });
});

describe("regression: arrays that grow without a limit", () => {
  // Pushing to an array while iterating it grew the array until JavaScript
  // refused the length, which surfaced as BAA301 wrapping "Invalid array
  // length" after about forty seconds of allocation. The size limit that
  // already guarded `repeat` and `flock.range` now guards growth too.
  // Growing one item at a time to reach the limit would be quadratic for
  // `unshift` and `insert`, so each mutator is handed an array that is already
  // at the limit. That reaches the same guard for the price of one allocation.
  it("stops at the size limit instead of exhausting memory", () => {
    for (const call of ["a.push(1)", "a.unshift(1)", "a.insert(0, 1)", "a.concat([1])"]) {
      const source = `import flock\nlet a = flock.range(0, 10000000)\n${call}`;
      assert.deepEqual(codes(source), ["BAA312"], call);
    }
  });
});
