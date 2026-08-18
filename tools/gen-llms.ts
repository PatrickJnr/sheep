/**
 * Generates `website/llms.txt` and `website/llms-full.txt`.
 *
 * The [llms.txt convention](https://llmstxt.org) is a Markdown file at a site's
 * root telling a language model what the project is and where the good
 * documentation lives. `llms.txt` is the index; `llms-full.txt` is everything
 * needed to write correct code without fetching ten pages.
 *
 *     node tools/gen-llms.ts [--check]
 *
 * Generated rather than written, for the same reason `docs/stdlib.md` is: a
 * hand-maintained copy of every signature is a copy that goes stale, and a
 * model given a stale signature writes code that does not run. Everything here
 * comes from the implementation, except the section of things that surprise
 * people, which is knowledge rather than data and is marked as such.
 *
 * The audience is a program, so the writing is different from the rest of the
 * documentation: no jokes, no narrative, and every claim about what does not
 * work stated as plainly as what does. A model that believes `barn` works on
 * Linux writes an application nobody can run.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ALL_CODES, CATALOGUE } from "../src/diagnostics/codes.ts";
import { createCapturingHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";
import { methodDocs } from "../src/runtime/methods.ts";
import { formatNumber, NativeFunction } from "../src/runtime/values.ts";
import { NATIVE_MODULES } from "../src/native/bundle.ts";
import { STDLIB_MODULES, STDLIB_SUMMARY } from "../src/stdlib/index.ts";
import { preludeDocs } from "../src/stdlib/prelude.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = "https://sheep.grimtech.co.uk";
const REPO = "https://github.com/PatrickJnr/sheep";

const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string })
  .version;

function arity(min: number, max: number): string {
  if (max >= Number.MAX_SAFE_INTEGER) return `${min}+`;
  return min === max ? String(min) : `${min}-${max}`;
}

/** A blank line between blocks, without the caller counting them. */
function section(...blocks: string[]): string {
  return blocks.join("\n\n");
}

// --------------------------------------------------------------------------
// llms.txt: the index
// --------------------------------------------------------------------------

function renderIndex(): string {
  return `${section(
    "# Baa",
    `> A small, readable scripting language with a real lexer, parser, resolver, tree-walking interpreter, formatter, linter and test runner. Version ${VERSION}. MIT. Zero runtime dependencies. Runs on Node.js 22.18+.`,
    `Baa programs run in two places, and which one a file belongs to is decided by what it imports, not by its name or location. Every file is \`.baa\`.

- A file that imports \`gate\` is a **web page**: a program executed per request under CGI that writes an HTTP reply.
- A file that imports \`barn\` is a **native application**: a program that opens a real window, built into a single Windows executable with \`baa app build\`.
- A file that imports neither is an ordinary module, usable from both.

Never import both in one file. Importing \`gate\` into a native application is a build error; calling \`barn\` under \`baa run\` is a runtime error.`,
    `## Start here

- [Language tour](${SITE}/docs/language.html): syntax, from hello world to modules and error handling
- [Full reference for models](${SITE}/llms-full.txt): syntax, every standard-library signature, and the mistakes that are easy to make
- [Specification](${SITE}/docs/spec.html): the complete definition, with grammar
- [CLI reference](${SITE}/docs/cli.html): every command, flag and exit code`,
    `## Reference

- [Standard library](${SITE}/docs/stdlib.html): every function, generated from the implementation
- [Diagnostics](${SITE}/docs/errors.html): all ${ALL_CODES.length} BAAnnn codes and what they mean
- [Web pages](${SITE}/docs/web.html): the \`gate\` module, escaping, and serving
- [Native applications](${SITE}/docs/native-applications.html): what the platform does and does not do
- [\`barn\` reference](${SITE}/docs/gui.html): windows, layout, controls, events`,
    `## Optional

- [Architecture](${SITE}/docs/architecture.html): how the implementation is put together and why
- [Roadmap](${SITE}/docs/roadmap.html): what is deliberately not built yet
- [Source](${REPO})`,
  )}\n`;
}

// --------------------------------------------------------------------------
// llms-full.txt: everything needed to write Baa that runs
// --------------------------------------------------------------------------

/**
 * Things that are true, not obvious, and cause code that looks right to fail.
 *
 * This is the one hand-written part. Each entry was a real mistake made while
 * writing the example applications, which is the only evidence that it is
 * worth a model's attention.
 */
const SURPRISES: ReadonlyArray<readonly [string, string]> = [
  [
    "`{` inside a string starts an interpolation",
    [
      "This is the one mistake that compiles and produces a wrong answer with no error, so it is worth knowing exactly when it does and does not.",
      "",
      "| Written | What happens |",
      "| --- | --- |",
      '| `"{" + x` | `BAA001`: the interpolation is never closed. A loud error |',
      "| `\"{\" + x + \"}\"` | **Silently wrong.** The closing `\"}\"` completes the interpolation, so the whole thing is one string and it prints that interpolation's own text: `` + x + `` |",
      '| `"{\\"a\\": 1}"` | `BAA001`. JSON written directly in a string does not work |',
      '| `"\\{" + x + "\\}"` | Correct: `{5}`. Escape the braces |',
      '| `r"{a}"` | Correct: `{a}`. A raw string processes no interpolation |',
      "",
      'Write `"\\{"` and `"\\}"` for literal braces. For anything brace-heavy, such as JSON or CSS, use a raw string: `r"..."`, or a raw block string `r"""` ... `"""` when it contains quotes. To build text from values, use interpolation as intended: `"{name} has {count} sheep"`.',
    ].join("\n"),
  ],
  [
    "`if` is a statement, not an expression",
    "`let x = if a { 1 } else { 2 }` does not parse. Use `match`, which is an expression: `let x = match true { _ if a => 1, _ => 2 }`.",
  ],
  [
    "`fn` declarations are hoisted; `let` and `const` are not",
    "A `fn` declaration can be called before the line it appears on. A function bound with `const f = fn() { ... }` cannot.",
  ],
  [
    "Only `nil` and `false` are falsy",
    "`0`, `\"\"` and `[]` are all truthy, as in Lua and Ruby. Test emptiness explicitly with `x.is_empty()` or `len(x) == 0`.",
  ],
  [
    "There is one number type",
    "`12` and `12.0` are the same value and `12 == 12.0` is true. Integer division is `ram.idiv(a, b)`. Dividing by zero is an error (`BAA306`), not `inf`.",
  ],
  [
    "Arrays and maps are references; `clone` copies",
    "Passing an array to a function passes the same array. `clone(x)` is a deep copy.",
  ],
  [
    "Maps keep insertion order",
    "Iteration and printing follow the order keys were first added. Replacing a value does not move it.",
  ],
  [
    "`from` and `to` are reserved words",
    "Neither can be a variable name. `flock`, `wool`, `ram`, `gate` and `barn` are ordinary bindings that shadow the module of the same name if you declare them, which then breaks every later use of the module.",
  ],
  [
    "Strings index by character, not by byte",
    "`len`, `[]`, `slice` and `index_of` all count characters, so a string containing emoji behaves the way it looks.",
  ],
  [
    "A negative index counts from the end",
    "`items[-1]` is the last item. An out-of-range index is `BAA304`, not `nil`.",
  ],
  [
    "`match` needs a total set of arms",
    "No arm matching is a runtime error (`BAA301`), not `nil`. End with `_ => ...` unless every case is genuinely covered.",
  ],
  [
    "Comparison needs matching types",
    "`<` works on two numbers or two strings; anything else is `BAA302`. Sorting mixed types needs an explicit comparison function.",
  ],
];

const WEB_EXAMPLE = `#!/usr/bin/env baa
/// A web page. Runs under CGI: one process per request, writing one reply.
import gate

const name = gate.query("name") ?? "world"

// Concatenate markup, and escape at each value. \`gate.format\` escapes what it
// interpolates, so passing markup through it renders the tags as text.
gate.html(
    "<!doctype html><html><head><title>Hello</title></head><body>" +
        "<h1>Baa, " + gate.escape(name) + "</h1>" +
        "</body></html>",
)`;

const NATIVE_EXAMPLE = `/// A native application. Build with \`baa app build\`; run with \`baa app run\`.
/// \`baa run\` cannot show a window and will say so.
import barn

let count = 0

const window = barn.window({ title: "Counter", width: 320, height: 160 })
const layout = barn.column(window, { weight: 1, spacing: 12 })
const label = barn.label(layout, { text: "0", align: "center", size: 22, weight: 1 })
const button = barn.button(layout, { text: "More" })

fn on_click() {
    count += 1
    barn.set_text(label, to_string(count))
}

barn.on(button, "click", on_click)

barn.show(window)
barn.run()`;

const MODULE_EXAMPLE = `/// A module: imports neither \`gate\` nor \`barn\`, so a web page and a native
/// application can both use it, and \`baa test\` can test it with no window and
/// no server involved. Put anything that can be wrong here.
export fn total(items) {
    let sum = 0
    for item in items {
        sum += item.price * item.quantity
    }
    return sum
}`;

const TEST_EXAMPLE = `import "../basket.baa" as basket

test "adds up a basket" {
    const items = [{ price: 2, quantity: 3 }, { price: 5, quantity: 1 }]
    assert_eq(basket.total(items), 11)
}

test "an empty basket costs nothing" {
    assert_eq(basket.total([]), 0)
}`;

function renderFull(): string {
  const interpreter = new Interpreter({ host: createCapturingHost() });
  const out: string[] = [];

  out.push(`# Baa ${VERSION}: a complete reference for language models`);
  out.push("");
  out.push(
    "Everything needed to write Baa that compiles and runs. Generated from the implementation, so every signature here is real. Source: " +
      REPO,
  );
  out.push("");
  out.push("---");
  out.push("");

  // ---------------------------------------------------------------- targets
  out.push("## Two targets, decided by what a file imports");
  out.push("");
  out.push(
    "Every Baa file has the extension `.baa`. What a file *is* depends on its imports, not on where it lives:",
  );
  out.push("");
  out.push("| Imports | It is | Run it with |");
  out.push("| --- | --- | --- |");
  out.push("| `gate` | a web page, executed once per HTTP request | `baa serve <dir>`, or CGI on a real host |");
  out.push("| `barn` | a native application with a window | `baa app run`, built with `baa app build` |");
  out.push("| neither | an ordinary module, usable from both | `baa run`, `baa test` |");
  out.push("");
  out.push(
    "Never import both into one file. `gate` is unavailable to native applications and the build refuses it; `barn` under `baa run` reports that it needs the native runtime.",
  );
  out.push("");
  out.push(
    "Put logic in a module that imports neither. It is testable in milliseconds with `baa test`, and it is the only part that both targets can share.",
  );
  out.push("");

  // ----------------------------------------------------------------- syntax
  out.push("## Syntax");
  out.push("");
  out.push("```baa");
  out.push(
    [
      "// Bindings. `const` cannot be reassigned, and the analyser checks.",
      "let count = 0",
      "const FLOCK = [\"Dolly\", \"Shaun\"]",
      "",
      "// Functions: defaults, rest parameters, closures, first-class values.",
      "fn greet(name, greeting = \"Baa\") {",
      "    return \"{greeting}, {name}!\"     // interpolation with { }",
      "}",
      "fn sum(..numbers) {",
      "    return numbers.reduce(fn(total, n) { return total + n }, 0)",
      "}",
      "",
      "// Printing. `baa` is the print statement; it takes several values.",
      "baa greet(\"Dolly\"), count",
      "",
      "// Control flow. `if` is a statement; `match` is an expression.",
      "if count > 0 {",
      "    baa \"some\"",
      "} else if count == 0 {",
      "    baa \"none\"",
      "} else {",
      "    baa \"negative\"",
      "}",
      "",
      "const label = match count {",
      "    0 => \"none\",",
      "    1 => \"one\",",
      "    n if n < 10 => \"a few\",",
      "    _ => \"many\",",
      "}",
      "",
      "// Loops. `for` walks arrays, maps, strings and ranges.",
      "for name in FLOCK { baa name }",
      "for index, name in FLOCK { baa index, name }",
      "for key, value in { a: 1 } { baa key, value }",
      "for n in 0..10 { }        // 0 to 9",
      "for n in 0..=10 { }       // 0 to 10",
      "while count < 3 { count += 1 }",
      "",
      "// Destructuring, in `let` and `const`.",
      "const [first, ..rest] = FLOCK",
      "const { name, age } = { name: \"Dolly\", age: 6 }",
      "",
      "// Errors. `throw` any value; `catch` binds it.",
      "try {",
      "    throw { code: \"TOO_WOOLLY\" }",
      "} catch problem {",
      "    baa problem.code",
      "} finally {",
      "    baa \"always\"",
      "}",
      "",
      "// Modules. Relative imports need the path; standard ones do not.",
      "// import wool",
      "// import { trim } from wool",
      "// import \"./basket.baa\" as basket",
      "",
      "// Tests live anywhere and run with `baa test`.",
      "test \"greets\" {",
      "    assert_eq(greet(\"Dolly\"), \"Baa, Dolly!\")",
      "}",
    ].join("\n"),
  );
  out.push("```");
  out.push("");
  out.push(
    "Operators: `+ - * / % **`, `== != < <= > >=`, `&& || !`, `??` (nil-coalescing), `in`, `..` and `..=` (ranges), `= += -= *= /= %=`. `**` is exponentiation and is right-associative.",
  );
  out.push("");
  out.push(
    "Newlines end statements. There is no semicolon requirement and no line-continuation character: a newline is ignored inside `(` or `[`, or after an operator, or before a leading `.` in a method chain. A `{` makes newlines significant again, so a multi-line function literal can be an argument.",
  );
  out.push("");

  // --------------------------------------------------------------- mistakes
  out.push("## Mistakes that compile");
  out.push("");
  out.push(
    "Each of these was a real error made while writing the example applications in this repository. They are listed first because they cost the most time.",
  );
  out.push("");
  for (const [what, why] of SURPRISES) {
    out.push(`### ${what}`);
    out.push("");
    out.push(why);
    out.push("");
  }

  // ---------------------------------------------------------------- prelude
  out.push("## The prelude");
  out.push("");
  out.push("Available in every file with no import. A local declaration may shadow any of them.");
  out.push("");
  out.push("| Function | Arguments | Description |");
  out.push("| --- | --- | --- |");
  for (const entry of preludeDocs()) {
    out.push(`| \`${entry.name}\` | ${entry.arity} | ${entry.doc} |`);
  }
  out.push("");

  // ---------------------------------------------------------------- methods
  out.push("## Methods on values");
  out.push("");
  const byType = new Map<string, Array<{ name: string; arity: string; doc: string }>>();
  for (const row of methodDocs()) {
    const list = byType.get(row.type) ?? [];
    list.push({ name: row.name, arity: row.arity, doc: row.doc });
    byType.set(row.type, list);
  }
  for (const [type, rows] of byType) {
    out.push(`### On ${type === "any" ? "any value" : `a ${type}`}`);
    out.push("");
    out.push("| Method | Arguments | Description |");
    out.push("| --- | --- | --- |");
    for (const row of rows) out.push(`| \`${row.name}\` | ${row.arity} | ${row.doc} |`);
    out.push("");
  }

  // ---------------------------------------------------------------- modules
  out.push("## Standard library");
  out.push("");
  out.push(
    `${STDLIB_MODULES.length} modules. Import with \`import <name>\`, or a few names with \`import { a, b } from <name>\`.`,
  );
  out.push("");
  out.push("| Module | Contents | Web | Native |");
  out.push("| --- | --- | --- | --- |");
  for (const name of STDLIB_MODULES) {
    const web = name === "barn" ? "no" : "yes";
    const native = NATIVE_MODULES.includes(name) ? "yes" : "no";
    out.push(`| \`${name}\` | ${STDLIB_SUMMARY[name] ?? ""} | ${web} | ${native} |`);
  }
  out.push("");
  out.push(
    "`wool`'s five pattern functions (`matches`, `find`, `find_all`, `substitute`, `split_on`) need a regular-expression engine and are unavailable in native applications; they report that when called. Everything else in `wool` works in both.",
  );
  out.push("");

  for (const name of STDLIB_MODULES) {
    const module = interpreter.loadModule(name, false, {
      file: { path: "<llms>", text: "" } as never,
      start: 0,
      end: 0,
    });
    out.push(`### \`${name}\``);
    out.push("");
    const constants: string[] = [];
    const functions: string[] = [];
    for (const [key, value] of module.exports) {
      if (value instanceof NativeFunction) {
        functions.push(`| \`${name}.${key}\` | ${arity(value.minArgs, value.maxArgs)} | ${value.doc} |`);
      } else {
        constants.push(
          `| \`${name}.${key}\` | ${typeof value === "number" ? formatNumber(value) : String(value)} |`,
        );
      }
    }
    if (constants.length > 0) {
      out.push("| Constant | Value |");
      out.push("| --- | --- |");
      out.push(...constants);
      out.push("");
    }
    if (functions.length > 0) {
      out.push("| Function | Arguments | Description |");
      out.push("| --- | --- | --- |");
      out.push(...functions);
      out.push("");
    }
  }

  // --------------------------------------------------------------- patterns
  out.push("## Worked examples");
  out.push("");
  out.push("### A module, and its tests");
  out.push("");
  out.push("`basket.baa`:");
  out.push("");
  out.push("```baa");
  out.push(MODULE_EXAMPLE);
  out.push("```");
  out.push("");
  out.push("`tests/basket_test.baa`, run with `baa test`:");
  out.push("");
  out.push("```baa");
  out.push(TEST_EXAMPLE);
  out.push("```");
  out.push("");
  out.push("### A web page");
  out.push("");
  out.push(
    "Runs under CGI: one process per request, no shared state between requests, and no JavaScript required on the page. Serve a directory with `baa serve <dir>`.",
  );
  out.push("");
  out.push("```baa");
  out.push(WEB_EXAMPLE);
  out.push("```");
  out.push("");
  out.push(
    "Escaping rule: `gate.escape` every value that came from a request. `gate.format` escapes what it interpolates, so never pass markup through it: build markup by concatenation and escape at each value. `gate.safe_url` before putting a URL in an `href`, because `javascript:` survives HTML escaping unchanged.",
  );
  out.push("");
  out.push("### A native application");
  out.push("");
  out.push(
    "Windows only today. The window model is platform-independent but only a Win32 backend exists; on any other platform `barn.show` reports that there is no backend. Build with `baa app build`, which produces one executable needing no Node.js.",
  );
  out.push("");
  out.push("```baa");
  out.push(NATIVE_EXAMPLE);
  out.push("```");
  out.push("");
  out.push(
    "Build the whole widget tree before `barn.show`. Handlers run between events, so a handler may do anything, including opening a dialog or closing the window. `barn.text(widget)` reads what the person typed; compare before calling `barn.set_text` on a text area, or the caret jumps to the start on every keystroke.",
  );
  out.push("");

  // ------------------------------------------------------------------- cli
  out.push("## Commands");
  out.push("");
  out.push("| Command | Purpose |");
  out.push("| --- | --- |");
  const commands: ReadonlyArray<readonly [string, string]> = [
    ["baa run [file]", "Execute a program, or the project entry point"],
    ["baa <file>", "The same, without saying `run`. What a shebang uses"],
    ["baa check [paths]", "Parse and analyse without running. The fastest way to validate"],
    ["baa test [paths]", "Run `test \"...\" { ... }` blocks"],
    ["baa fmt [paths]", "Format in place; `--check` in CI"],
    ["baa lint [paths]", "Warnings; `--deny-warnings` in CI"],
    ["baa serve [dir]", "Serve a directory of pages over HTTP, for development"],
    ["baa app new|build|run|test", "Native applications"],
    ["baa repl", "Interactive session"],
    ["baa init [dir]", "Create a project"],
    ["baa doctor", "Check the installation"],
  ];
  for (const [command, purpose] of commands) out.push(`| \`${command}\` | ${purpose} |`);
  out.push("");
  out.push(
    "Exit codes: `0` success, `1` the program failed or a check found errors, `2` the command line was wrong, `70` an internal error. `CI=true` or `--no-baa` swaps the sheep wording for neutral wording, keeping every code identical.",
  );
  out.push("");

  // ----------------------------------------------------------- diagnostics
  out.push("## Diagnostics");
  out.push("");
  out.push(
    `Every error has a stable code. ${ALL_CODES.length} in total; the ranges are what matter when reading one.`,
  );
  out.push("");
  out.push("| Range | Meaning |");
  out.push("| --- | --- |");
  out.push("| `BAA0xx` | Lexical and syntax errors: the shape of the source is wrong |");
  out.push("| `BAA1xx` | Names and scope |");
  out.push("| `BAA2xx` | Calls, arity, and static shape |");
  out.push("| `BAA3xx` | Runtime |");
  out.push("| `BAA4xx` | Modules, project and CLI |");
  out.push("| `BAA9xx` | Lints, which are warnings and never fatal |");
  out.push("");
  out.push("The ones most often hit while writing new code:");
  out.push("");
  out.push("| Code | Meaning |");
  out.push("| --- | --- |");
  const common = ["BAA102", "BAA201", "BAA202", "BAA302", "BAA304", "BAA305", "BAA306", "BAA309", "BAA311"];
  for (const code of common) {
    const entry = CATALOGUE[code as keyof typeof CATALOGUE];
    if (entry) out.push(`| \`${code}\` | ${entry.plain} |`);
  }
  out.push("");
  out.push(`Full catalogue: ${SITE}/docs/errors.html`);
  out.push("");

  out.push("---");
  out.push("");
  out.push(
    `Generated from the implementation at version ${VERSION}. If something here disagrees with the compiler, the compiler is right and it is a bug: ${REPO}/issues`,
  );

  return `${out.join("\n")}\n`;
}

// --------------------------------------------------------------------------

const files: ReadonlyArray<readonly [string, string]> = [
  ["llms.txt", renderIndex()],
  ["llms-full.txt", renderFull()],
];

const check = process.argv.includes("--check");
let stale = 0;

for (const [name, contents] of files) {
  const path = join(ROOT, "website", name);
  if (check) {
    let existing = "";
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = "";
    }
    if (existing.replace(/\r\n/g, "\n") !== contents) {
      process.stderr.write(`website/${name} is stale. Run \`npm run gen\`.\n`);
      stale++;
    }
  } else {
    writeFileSync(path, contents, "utf8");
    process.stdout.write(`wrote website/${name} (${(contents.length / 1024).toFixed(1)} KB)\n`);
  }
}

if (check) {
  if (stale > 0) process.exit(1);
  process.stdout.write("llms.txt and llms-full.txt are up to date\n");
}
