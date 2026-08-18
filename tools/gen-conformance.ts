/**
 * Generate the language conformance suite.
 *
 *     node tools/gen-conformance.ts            # write it
 *     node tools/gen-conformance.ts --check    # exit 1 if out of date
 *
 * The output, `tests/conformance/suite.json`, is a language-agnostic
 * description of what Baa does: a list of programs with their expected stdout,
 * and a list of programs with the diagnostic codes they must produce. It has
 * no dependency on this implementation's internals, which is the point, a
 * second implementation (see `rust/README.md`) can be validated against it
 * without sharing a line of code.
 *
 * The reference implementation is what produces the expected values, so this
 * file records *what Baa currently does*. Anything in it that turns out to be
 * wrong is a bug in the reference implementation, not licence for a port to
 * copy the mistake.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { checkFile, toDiagnostic } from "../src/api.ts";
import { ALL_CODES, CATALOGUE } from "../src/diagnostics/codes.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { createCapturingHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = join(ROOT, "examples");
const OUT_DIR = join(ROOT, "tests", "conformance");
const OUT_FILE = join(OUT_DIR, "suite.json");
const CATALOGUE_FILE = join(OUT_DIR, "diagnostics.json");

/** Examples whose output depends on the clock, platform or filesystem. */
const SKIP = new Set(["stdlib.baa", "modules.baa", "pen.baa"]);

type OutputCase = {
  readonly name: string;
  readonly source: string;
  readonly stdout: string;
  readonly exit: number;
};

type DiagnosticCase = {
  readonly name: string;
  readonly source: string;
  readonly codes: string[];
  readonly stage: "check" | "run";
};

function execute(source: string, name: string): { stdout: string; exit: number; codes: string[] } {
  const file = new SourceFile(name, source);
  const checked = checkFile(file);
  if (!checked.ok) {
    return { stdout: "", exit: 1, codes: checked.diagnostics.map((d) => d.code) };
  }
  const host = createCapturingHost({ seed: 7 });
  const interpreter = new Interpreter({ host });
  try {
    interpreter.run(checked.program, file);
    return { stdout: host.output(), exit: 0, codes: [] };
  } catch (error) {
    const converted = toDiagnostic(error, interpreter);
    if (converted === null) throw error;
    return {
      stdout: host.output(),
      exit: converted.exitCode,
      codes: converted.diagnostics.map((d) => d.code),
    };
  }
}

// --------------------------------------------------------------------------
// Programs whose output is part of the language definition
// --------------------------------------------------------------------------

const CORE_PROGRAMS: Array<[string, string]> = [
  ["print/values", 'baa 1, 2.5, "text", true, nil, [1, "a"], { a: 1 }, 0..3'],
  ["print/whole-numbers", "baa 4.0, 1e3, 7 / 2, 6 / 3"],
  ["print/strings-bare", 'baa "a", ["a"], { a: "b" }'],
  ["numbers/literals", "baa 1_000_000, 0xFF, 0b1010, 0o17, 2.5e-2"],
  ["numbers/precedence", "baa 1 + 2 * 3, (1 + 2) * 3, 2 ** 3 ** 2, -2 ** 2, 7 % 3"],
  ["truthiness", 'baa !nil, !false, !0, !"", ![]'],
  ["equality/structural", 'baa [1, [2]] == [1, [2]], { a: 1 } == { a: 1 }, { a: 1 } == { a: 2 }'],
  ["operators/concat", 'baa "n=" + 1, 1 + "=n", "a" + true, "x" + nil, [1] + [2]'],
  ["operators/logical", "baa nil ?? 5, false ?? 5, 0 ?? 5, false && 1, true || 1"],
  ["operators/in", 'baa 2 in [1, 2], "a" in { a: 1 }, 3 in 0..5, "oo" in "wool"'],
  ["strings/interpolation", 'const n = 3\nbaa "there are {n + 1} sheep and {["a", "b"].join(", ")}"'],
  ["strings/escapes", 'baa "a\\nb", "\\{literal\\}", "\\u{1F411}"'],
  ["strings/indexing", 'baa "wool"[0], "wool"[-1], "wool".length()'],
  ["arrays/methods", "const a = [3, 1, 2]\nbaa a.sort(), a.reverse(), a.sum(), a.slice(1, 3)"],
  [
    "arrays/higher-order",
    "baa [1, 2, 3].map(fn(n) { return n * 2 }).filter(fn(n) { return n > 2 }).reduce(fn(t, n) { return t + n }, 0)",
  ],
  ["maps/order", "const m = { b: 1, a: 2 }\nm.c = 3\nbaa m.keys(), m.values()"],
  ["maps/missing-key", 'const m = { a: 1 }\nbaa m["z"], m.get("z", 0), m.has("a")'],
  ["maps/data-beats-methods", 'const m = { keys: "mine" }\nbaa m.keys'],
  [
    "control/if",
    'fn size(n) {\n  if n > 10 { return "many" } else if n > 2 { return "some" } else { return "few" }\n}\nbaa size(20), size(5), size(1)',
  ],
  [
    "control/for",
    'for x in [1, 2] { baa x }\nfor c in "ab" { baa c }\nfor i in 1..=2 { baa i }\nfor k, v in { a: 1 } { baa k, v }\nfor i, x in ["p"] { baa i, x }',
  ],
  [
    "control/break-continue",
    "for i in 0..5 {\n  if i == 1 { continue }\n  if i == 3 { break }\n  baa i\n}",
  ],
  ["control/while", "let n = 3\nwhile n > 0 {\n  baa n\n  n -= 1\n}"],
  // One name binds the value, two bind position and value. `map` is the one an
  // implementation is most likely to get wrong, because a single name binds
  // the value rather than the key (SPEC 5.3).
  [
    "control/for-binds-one-name",
    'for v in ["p", "q"] { baa v }\nfor v in { a: 1, b: 2 } { baa v }\nfor c in "xy" { baa c }\nfor n in 5..7 { baa n }',
  ],
  [
    "control/for-binds-two-names",
    'for i, v in ["p", "q"] { baa i, v }\nfor k, v in { a: 1, b: 2 } { baa k, v }\nfor i, c in "xy" { baa i, c }\nfor i, n in 5..7 { baa i, n }',
  ],
  // `for` re-reads the length each step rather than taking a snapshot, so
  // items appended during the body are visited (SPEC 5.3).
  [
    "control/for-sees-appended-items",
    "let a = [1, 2, 3]\nlet seen = []\nfor x in a {\n  seen.push(x)\n  if a.length() < 5 { a.push(99) }\n}\nbaa seen",
  ],
  // Whatever `finally` finishes with replaces the pending outcome, including
  // discarding a throw that was on its way out (SPEC 5.4).
  [
    "try/finally-replaces-return",
    'fn f() {\n  try { return "try" } finally { return "finally" }\n}\nbaa f()',
  ],
  [
    "try/finally-discards-throw",
    'fn f() {\n  try { throw "boom" } finally { return "finally" }\n}\nbaa f()',
  ],
  [
    "try/finally-replaces-throw",
    'fn f() {\n  try { throw "first" } finally { throw "second" }\n}\ntry { f() } catch e { baa e }',
  ],
  [
    "try/finally-runs-on-break",
    'for i in 0..3 {\n  try { break } finally { baa "finally {i}" }\n}\nbaa "after"',
  ],
  // Keys are not coerced, so these are two entries, not one. An implementation
  // backed by JavaScript object keys would collapse them (SPEC 3.1).
  ["maps/keys-are-not-coerced", 'let m = {}\nm[1] = "number"\nm["1"] = "string"\nbaa m.keys().length(), m[1], m["1"]'],
  [
    "functions/params",
    "fn f(a, b = 10, ..rest) { return [a, b, rest] }\nbaa f(1), f(1, 2), f(1, 2, 3, 4)",
  ],
  [
    "functions/closures",
    "fn counter() {\n  let n = 0\n  return fn() {\n    n += 1\n    return n\n  }\n}\nconst next = counter()\nbaa next(), next(), counter()()",
  ],
  ["functions/hoisting", "baa f()\nfn f() { return g() }\nfn g() { return 1 }"],
  ["functions/implicit-nil", "fn f() { baa 1 }\nbaa f()"],
  [
    "match/arms",
    'fn size(n) {\n  return match n {\n    0 => "none",\n    1 || 2 => "few",\n    x if x > 10 => "many",\n    _ => "some",\n  }\n}\nbaa size(0), size(2), size(50), size(5)',
  ],
  [
    "match/structural",
    'baa match [true, false] { [true, true] => "both", [true, false] => "first", _ => "no" }',
  ],
  [
    "errors/throw-catch",
    'try { throw { code: "X" } } catch e { baa e.code }',
  ],
  [
    "errors/runtime-catch",
    'try { baa [1][9] } catch e { baa e.code, e.line }',
  ],
  [
    "errors/finally",
    'fn f(fail) {\n  try {\n    if fail { throw "x" }\n    return "ok"\n  } catch e { return "caught" } finally { baa "cleanup" }\n}\nbaa f(false), f(true)',
  ],
  ["scope/shadowing", 'const a = "outer"\nif true {\n  const a = "inner"\n  baa a\n}\nbaa a'],
  ["values/reference-semantics", "const a = [1]\nconst b = a\nb.push(2)\nconst c = clone(a)\nc.push(3)\nbaa a, c"],
  ["prelude", 'baa len([1, 2]), type_of(1.5), to_string([1]), to_number("42"), inspect("a")'],
];

// --------------------------------------------------------------------------
// Programs that must fail, and with which codes
// --------------------------------------------------------------------------

const DIAGNOSTIC_CASES: Array<[string, string, "check" | "run"]> = [
  ["syntax/bad-char", "let a = §", "check"],
  ["syntax/unterminated-string", 'baa "open', "check"],
  ["syntax/unterminated-comment", "/* open", "check"],
  ["syntax/bad-number", "baa 12abc", "check"],
  ["syntax/bad-escape", String.raw`baa "\q"`, "check"],
  ["syntax/bad-assignment-target", "1 = 2", "check"],
  ["syntax/empty-interpolation", 'baa "{ }"', "check"],
  ["names/duplicate", "let a = 1\nlet a = 2", "check"],
  ["names/undefined", "baa nope", "check"],
  ["names/const-assignment", "const a = 1\na = 2", "check"],
  ["names/return-outside-function", "return 1", "check"],
  ["names/break-outside-loop", "break", "check"],
  ["names/use-before-declaration", "baa later\nlet later = 1", "check"],
  ["calls/too-many", "fn f(a) { return a }\nf(1, 2)", "check"],
  ["calls/too-few", "fn f(a, b) { return a }\nf(1)", "check"],
  ["calls/duplicate-param", "fn f(a, a) { return a }", "check"],
  ["modules/unknown", "import cotton", "check"],
  ["runtime/no-match", 'baa match 1 { 2 => "x" }', "run"],
  ["runtime/bad-operands", "baa [1] - 1", "run"],
  ["runtime/not-callable", "const n = 1\nbaa n()", "run"],
  ["runtime/index-out-of-range", "baa [1][9]", "run"],
  ["runtime/no-such-field", "baa nil.field", "run"],
  ["runtime/divide-by-zero", "baa 1 / 0", "run"],
  ["runtime/uncaught-throw", 'throw "x"', "run"],
  ["runtime/not-iterable", "for x in 1 { baa x }", "run"],
  ["runtime/missing-key", 'baa { a: 1 }.expect("b")', "run"],
  ["runtime/bad-argument-type", 'baa "x".repeat("y")', "run"],
];

// --------------------------------------------------------------------------

const programs: OutputCase[] = [];
for (const [name, source] of CORE_PROGRAMS) {
  const result = execute(source, `${name}.baa`);
  if (result.codes.length > 0) {
    throw new Error(`conformance program \`${name}\` failed: ${result.codes.join(", ")}`);
  }
  programs.push({ name, source, stdout: result.stdout, exit: result.exit });
}

for (const file of readdirSync(EXAMPLES).sort()) {
  if (!file.endsWith(".baa") || SKIP.has(file)) continue;
  const source = readFileSync(join(EXAMPLES, file), "utf8").replace(/\r\n?/g, "\n");
  const result = execute(source, file);
  if (result.codes.length > 0) {
    throw new Error(`example \`${file}\` failed: ${result.codes.join(", ")}`);
  }
  programs.push({ name: `examples/${file}`, source, stdout: result.stdout, exit: result.exit });
}

const diagnostics: DiagnosticCase[] = [];
for (const [name, source, stage] of DIAGNOSTIC_CASES) {
  const result = execute(source, `${name}.baa`);
  if (result.codes.length === 0) {
    throw new Error(`conformance case \`${name}\` was expected to fail, but did not`);
  }
  diagnostics.push({ name, source, codes: result.codes, stage });
}

const suite = {
  $schema: "https://sheep.grimtech.co.uk/schema/conformance-1.json",
  version: 1,
  language: "baa",
  languageVersion: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  description:
    "Language conformance suite. Any Baa implementation should produce these outputs and these diagnostic codes.",
  notes: [
    "`programs` map a source string to the exact stdout it must produce, and the exit code.",
    "`diagnostics` map a source string to the diagnostic codes it must report, in order.",
    "`stage` is `check` when the codes must be reported without executing, `run` otherwise.",
    "Randomness is seeded with 7. Programs depending on the clock or filesystem are excluded.",
  ],
  programs,
  diagnostics,
};

/**
 * The diagnostic catalogue as data, so a second implementation can reuse the
 * exact wording instead of retyping forty messages and drifting from them.
 */
const catalogue = {
  $schema: "https://sheep.grimtech.co.uk/schema/diagnostics-1.json",
  version: 1,
  description:
    "Every Baa diagnostic. `woolly` is the default wording, `plain` is used under --no-baa. Placeholders {0}, {1}, ... are filled in at the point of failure.",
  codes: ALL_CODES.map((code) => ({
    code,
    severity: CATALOGUE[code].severity,
    woolly: CATALOGUE[code].woolly,
    plain: CATALOGUE[code].plain,
  })),
};

const outputs: Array<[string, string]> = [
  [OUT_FILE, `${JSON.stringify(suite, null, 2)}\n`],
  [CATALOGUE_FILE, `${JSON.stringify(catalogue, null, 2)}\n`],
];

if (process.argv.includes("--check")) {
  let stale = 0;
  for (const [path, rendered] of outputs) {
    let existing = "";
    try {
      existing = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
    } catch {
      existing = "";
    }
    if (existing !== rendered) {
      process.stderr.write(`${path} is out of date: run \`node tools/gen-conformance.ts\`\n`);
      stale++;
    }
  }
  if (stale > 0) process.exitCode = 1;
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [path, rendered] of outputs) writeFileSync(path, rendered, "utf8");
  process.stdout.write(
    `wrote ${OUT_FILE}: ${programs.length} programs, ${diagnostics.length} diagnostic cases\n`,
  );
  process.stdout.write(`wrote ${CATALOGUE_FILE}: ${catalogue.codes.length} diagnostics\n`);
}
