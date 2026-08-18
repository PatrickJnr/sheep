<div align="center">

<a href="https://sheep.grimtech.co.uk">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="https://sheep.grimtech.co.uk/assets/social-dark.png">
    <source media="(prefers-color-scheme: light)"
            srcset="https://sheep.grimtech.co.uk/assets/social.png">
    <img src="https://sheep.grimtech.co.uk/assets/social.png" width="720"
         alt="Baa: a programming language with a little more Baa">
  </picture>
</a>

A small, readable scripting language with fast tooling, genuinely good error
messages, and extremely questionable sheep-related naming decisions.

[![CI](https://github.com/PatrickJnr/sheep/actions/workflows/ci.yml/badge.svg)](https://github.com/PatrickJnr/sheep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2F4B3F)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-2F4B3F)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/baa-lang?color=2F4B3F&label=npm)](https://www.npmjs.com/package/baa-lang)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-none-2F4B3F)](package.json)

**[Website](https://sheep.grimtech.co.uk)** ·
**[Playground](https://sheep.grimtech.co.uk/playground.html)** ·
**[Docs](https://sheep.grimtech.co.uk/docs/)** ·
[Tour](https://sheep.grimtech.co.uk/docs/language.html) ·
[Spec](https://sheep.grimtech.co.uk/docs/spec.html) ·
[Architecture](https://sheep.grimtech.co.uk/docs/architecture.html) ·
[Roadmap](https://sheep.grimtech.co.uk/docs/roadmap.html)

</div>

---

```baa
const FLOCK = ["Dolly", "Shaun", "Lambchop"]

fn greet(name) {
    return "Baa, {name}!"
}

for name in FLOCK {
    baa greet(name)
}

baa "That's {len(FLOCK)} sheep accounted for."
```

```console
$ baa run hello.baa
Baa, Dolly!
Baa, Shaun!
Baa, Lambchop!
That's 3 sheep accounted for.
```

<details>
<summary><b>Contents</b></summary>

[What Baa is](#what-baa-is) ·
[Install](#install) ·
[Your first flock](#your-first-flock) ·
[The language in ninety seconds](#the-language-in-ninety-seconds) ·
[Diagnostics](#diagnostics) ·
[Commands](#commands) ·
[Standard library](#standard-library) ·
[Examples](#examples) ·
[Editor support](#editor-support) ·
[Would you rather this were Rust?](#would-you-rather-this-were-rust) ·
[Development](#development) ·
[Brand assets](#brand-assets) ·
[Why sheep?](#why-sheep) ·
[Licence](#licence)

</details>

## What Baa is

A complete, working programming language: a hand-written lexer, a
recursive-descent parser with error recovery, a real AST, a semantic analyser,
a tree-walking interpreter, a standard library, a formatter, a linter, a test
runner, a REPL and a project tool. It runs real programs. It is not a syntax
mock-up.

**Nothing here is a wrapper around another language.** Baa does not compile to
JavaScript, transpile to anything, or hand your program to another runtime. The
lexer reads characters, the parser builds a tree, the resolver binds every name
to its declaration, and the interpreter walks that tree — all of it written for
this language and tested against a conformance suite of 50 programs pinned to
their exact output.

GitHub's language bar counts the *implementation*, which is TypeScript for the
frontend and reference runtime, and Rust for the native one. That is the same
thing it says about every young language — Elm's compiler is Haskell, Gleam's
and Roc's are Rust — and it is not a statement about what `.baa` files are.
Baa itself is absent from that bar for the ordinary reason: GitHub's Linguist
only recognises languages that are already in wide use.

The joke is the name. Everything underneath is built to be used.

|  | |
| --- | --- |
| **Small core** | Fourteen statement forms, one numeric type, no inheritance, no hidden coercions. You can hold the whole language in your head. |
| **Diagnostics that help** | Every error has a stable `BAAnnn` code, a source span, an underlined excerpt and, where possible, a suggestion. |
| **Fast enough to be practical** | Around 1.2 million function calls and 4.5 million loop iterations per second on a laptop. `baa run` starts in about a tenth of a second. |
| **Tooling in the box** | `fmt`, `lint`, `check`, `test`, `repl`, `init`, `build`, `doctor`. No plugin hunt on day one. |
| **Serious when it needs to be** | `--no-baa`, or `CI=true`, swaps every sheep joke for neutral wording and keeps the codes identical. |
| **Nothing to trust** | No third-party packages. Nothing is downloaded, nothing runs implicitly, and no subprocess ever sees a shell. |
| **Two places to run** | The same files serve [web pages](docs/web.md) and build [native Windows applications](docs/native-applications.md). One language, one set of tests, two targets. |

Verified on every commit, across Windows, Linux and macOS: **600+ tests**, a
formatter that must be a fixed point, a linter that must be clean, and a
conformance suite that pins the exact output of 50 programs.

## Install

Baa needs **Node.js 22.18 or newer**, and nothing else at runtime.

```bash
npm install -g baa-lang
baa doctor           # check the installation
```

Or run it without installing anything:

```bash
npx baa-lang run hello.baa
```

<details>
<summary><b>From a clone, for working on Baa itself</b></summary>

Node runs Baa's TypeScript sources directly, so there is no build step for
development:

```bash
git clone https://github.com/PatrickJnr/sheep.git
cd sheep
npm install          # dev dependencies: typescript, and puppeteer-core for the site checks
npm link             # puts `baa` on your PATH
```

Every command also works as `node src/cli/index.ts <command>`, with nothing
linked.

Publishing is the one place a build happens. Node refuses to strip types from
files under `node_modules`, so the npm package ships compiled JavaScript,
produced by `npm run build` and invoked automatically by `prepack`.

</details>

> Why not Rust? The question was not ducked, and a Rust implementation is an
> open track rather than a maybe. See
> [ARCHITECTURE.md](ARCHITECTURE.md#why-typescript-on-node) for the trade-offs
> and [the Rust section](#would-you-rather-this-were-rust) for the plan.

## Your first flock

```bash
baa init hill-farm
cd hill-farm
baa run
baa test
```

`baa init` writes a `baa.toml`, a `main.baa`, a module and a test, so you start
with a project that already has something to run and something to prove.

Or try it with nothing installed at all, in
[the playground](https://sheep.grimtech.co.uk/playground.html). That runs the
genuine interpreter, compiled to JavaScript, not a re-implementation.

## The language in ninety seconds

```baa
// Bindings. `let` can change, `const` cannot, and the compiler checks.
let sheep = 12
const MAX_SHEEP = 100

// Strings interpolate with braces, and take whole expressions.
baa "The flock holds {sheep} of a maximum {MAX_SHEEP}."

// Functions, with defaults and rest parameters.
fn tally(label, ..counts) {
    return "{label}: {counts.sum()}"
}
baa tally("this week", 3, 4, 5)

// Arrays and maps, compared by value rather than identity.
const flock = ["Dolly", "Shaun"]
const ages = { Dolly: 6, Shaun: 4 }
baa flock.map(fn(name) { return ages[name] })

// Loops over anything with elements.
for name, age in ages {
    baa "{name} is {age}"
}

// `match` is an expression, and patterns compare structurally.
const size = match len(flock) {
    0 => "empty",
    1 || 2 => "a small flock",
    n if n > 50 => "a very large flock",
    _ => "a flock",
}

// Errors carry values, and runtime failures are catchable.
try {
    baa flock[99]
} catch problem {
    baa "{problem.code}: {problem.message}"
}
```

The full tour is in [LANGUAGE.md](LANGUAGE.md), about fifteen minutes end to
end. The precise rules, including the grammar, are in [SPEC.md](SPEC.md).

## Diagnostics

Baa spends real effort on being wrong helpfully.

```console
$ baa check flock.baa
error[BAA102]: `sheap` is not part of the current flock.
  ┌─ flock.baa:4:19
  │
3 │ fn greet() {
4 │     baa "Baa, " + sheap
  │                   ^^^^^ not found in this pasture
  │
  = help: Did you mean `sheep`?
1 file checked, 1 error
```

Three things worth knowing:

- **Codes are stable.** `BAA102` means the same thing in every future version,
  so grepping a CI log for it is safe.
- **Professional mode keeps the information.** `--no-baa` turns that message
  into `Undefined name \`sheap\`.` with the same code, span and suggestion.
  `CI=true` does it automatically.
- **Runtime failures carry a real stack**, captured where the failure happened
  rather than reconstructed afterwards, and they are catchable as a map with
  `code`, `message`, `file`, `line` and `column`.

All 46 of them are listed in [docs/errors.md](docs/errors.md).

## Commands

| Command | What it does |
| --- | --- |
| `baa run [file]` | Execute a program, or the project entry point |
| `baa <file>` | The same, without saying `run`. What a shebang uses |
| `baa check [paths]` | Parse and analyse without running |
| `baa test [paths]` | Run `test "..." { ... }` blocks |
| `baa fmt [paths]` | Format source files, `--check` for CI |
| `baa lint [paths]` | Report warnings, `--deny-warnings` for CI |
| `baa repl` | Interactive session |
| `baa lsp` | Language server, for editors |
| `baa init [dir]` | Create a new project |
| `baa build` | Validate the project and write `baa.lock`, `--locked` to verify it |
| `baa add` / `baa remove` | Manage local dependencies |
| `baa doctor` | Diagnose the installation |
| `baa modules` | List the standard library |
| `baa serve [dir]` | Serve a directory of `.baa` pages over HTTP |
| `baa app <action>` | Native applications: `new`, `build`, `run`, `test` |

Full reference, including exit codes and the manifest format:
[docs/cli.md](docs/cli.md).

## Standard library

Nine modules, sheep-branded on the outside and completely boring on the
inside. An API you have to remember at 2am is no place for a joke.

| Module | Contents |
| --- | --- |
| `wool` | Text: formatting, casing, wrapping, bytes |
| `flock` | Collections: grouping, chunking, zipping, building maps |
| `ram` | Arithmetic: rounding, integer division, statistics, constants |
| `meadow` | Time and chance: clocks, calendars, seeded randomness |
| `pasture` | Files and paths |
| `shepherd` | Arguments, environment, stdin, subprocesses |
| `lamb` | JSON |
| `gate` | Web requests and replies, over CGI |
| `barn` | Native windows: controls, layout and events |

Plus a ten-name prelude that needs no import. Full reference:
[docs/stdlib.md](docs/stdlib.md).

## Examples

Every file in [`examples/`](examples/) is executable, formatted by `baa fmt`,
clean under `baa lint`, and run by the test suite. All but one have their exact
output recorded and compared byte for byte; `stdlib.baa` reads the clock, so it
is executed and checked for errors rather than compared. If one breaks, CI says
so.

| File | Shows |
| --- | --- |
| [`hello.baa`](examples/hello.baa) | The smallest useful program |
| [`variables.baa`](examples/variables.baa) | Bindings, types, operators |
| [`functions.baa`](examples/functions.baa) | Defaults, rest params, closures |
| [`loops.baa`](examples/loops.baa) | Every loop and iteration form |
| [`collections.baa`](examples/collections.baa) | Arrays and maps in anger |
| [`modules.baa`](examples/modules.baa) | Imports, aliases, local files |
| [`errors.baa`](examples/errors.baa) | Throwing, catching, `finally` |
| [`stdlib.baa`](examples/stdlib.baa) | Every module whose output is the same on every machine |
| [`site/`](examples/site/) | A website: pages that answer HTTP requests over CGI, [running here](https://sheep.grimtech.co.uk/baa/index.baa) |
| [`fizzbuzz.baa`](examples/fizzbuzz.baa) | `match` on structural patterns |
| [`large_program.baa`](examples/large_program.baa) | A ~200-line flock register: parsing, validation, statistics, a report and JSON |

## Native applications

A `.baa` file is a web page. It is also, when it imports `barn` instead of
`gate`, a desktop application:

```baa
import barn

const window = barn.window({ title: "Hello", width: 320, height: 140 })
const layout = barn.column(window, { weight: 1 })
const label = barn.label(layout, { text: "Baa", align: "center", size: 20 })
const button = barn.button(layout, { text: "Again" })

fn on_click() {
    barn.set_text(label, "Baa baa")
}

barn.on(button, "click", on_click)
barn.show(window)
barn.run()
```

```console
$ baa app build
Built build/Hello.exe
  1 module, using barn
  736 KB, windowed
```

One executable. No Node.js on the machine that runs it, no browser inside it,
no unpacking: a real Win32 window with the system's own controls, its own menu
bar and its own file dialogs.

`baa app build` analyses the program with exactly the code `baa check` uses,
writes the resolved tree into an image, and appends that image to a runtime
written in Rust. There is one frontend, so the two cannot disagree about what
your program means, and the runtime passes all 50 conformance programs byte for
byte.

The calculator in
[`examples/native/calculator/`](examples/native/calculator) imports the *web*
calculator's arithmetic module unchanged — same tokeniser, same
precedence-climbing parser, same tests, two front ends. That is the shape the
platform is for.

Windows today. The window model has no Win32 in it and a second backend is an
addition rather than a rewrite, but until somebody writes one, `barn.show` on
another platform says so.

[Native applications](docs/native-applications.md) ·
[`barn` reference](docs/gui.md) ·
[Building for Windows](docs/building-windows-apps.md)

## Editor support

`baa lsp` is a language server. It provides diagnostics as you type, whole-file
formatting, a document outline, hover, go to definition, find references and
rename, and it runs the same analysis as `baa check` and `baa lint`, so an
editor cannot disagree with the command line about whether a file is valid.

Neovim, Helix and Emacs can point at it directly. Setup for each, and what the
server does not do yet, is in [docs/editors.md](docs/editors.md).

[`editors/vscode/`](editors/vscode/) is a VS Code extension that starts the
server for you, alongside syntax highlighting, snippets, and bracket and
comment configuration. Install the `.vsix` from a
[release](https://github.com/PatrickJnr/sheep/releases) with
`code --install-extension baa-lang.vsix` (double-clicking it opens Visual
Studio, which is a different product and will refuse), open a `.baa` file,
and everything
above works with no configuration. It analyses nothing itself — it runs
`baa lsp`, so the editor sees what `baa check` sees.

Definition, references and rename read the resolver's symbol table rather than
the text, so renaming a binding that shadows an outer one of the same name
rewrites the inner uses and leaves the outer alone.

## Would you rather this were Rust?

So would some of us. The reference implementation is TypeScript for the
[reasons written up in ARCHITECTURE.md](ARCHITECTURE.md#why-typescript-on-node),
and a second implementation is an explicitly open track.

Everything a port needs already exists and is kept fresh by CI:

- [`SPEC.md`](SPEC.md): the full language definition, with an EBNF grammar
- [`tests/conformance/suite.json`](tests/conformance/suite.json): 50 programs
  with their exact output, and 27 with the diagnostic codes they must report
- [`tests/conformance/diagnostics.json`](tests/conformance/diagnostics.json):
  all 46 diagnostics, both wordings, ready to embed
- [`rust/README.md`](rust/README.md): crate layout, order of work, and the
  design notes worth carrying over

**Half of it now exists.** `rust/crates/baa-native` is a working Rust
*runtime* — values, the tree-walking interpreter, eight standard-library
modules, a window model and a Win32 backend — written for
[native applications](docs/native-applications.md). It passes all 50
conformance programs byte for byte.

It has no lexer, no parser, no resolver, no formatter, no linter and no CLI,
and gains nothing from having them: the reference implementation hands it a
resolved tree, so there is one frontend and it cannot disagree with itself.
That leaves the interesting half of a second implementation open, and the
milestone unchanged — a conformant `baa run` from Rust source, passing both
halves of the suite. Whoever takes it on starts with a runtime that already
works and a conformance harness that already runs.

## Development

```bash
npm test           # the full unit and integration suite
npm run typecheck  # tsc --noEmit, strict
npm run fmt:check  # the formatter must be a fixed point
npm run lint       # Baa's own linter, over the examples
npm run test:baa   # Baa's test blocks, run by Baa
npm run bench      # front-end and runtime benchmarks
npm run ci         # all of the above
```

Regenerating derived files, all of which are committed and checked in CI:

```bash
npm run gen        # docs and the conformance suite (plus the site, if present)
```

The pipeline is deliberately separable (lexer, parser, AST, resolver, runtime)
so each stage is tested on its own. [ARCHITECTURE.md](ARCHITECTURE.md) explains
the shape and the route towards a bytecode VM.

Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

## Brand assets

The PNGs in [`assets/images/`](assets/images/) are what this README embeds, so
the images resolve from a plain clone with no server involved. PNG rather than
SVG because the wordmark is live text, which would otherwise render in whatever
serif the viewer happens to have installed.

The SVG originals are served from the site, and are the better choice anywhere
that can use them.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="https://sheep.grimtech.co.uk/assets/logo-dark.png">
    <source media="(prefers-color-scheme: light)"
            srcset="https://sheep.grimtech.co.uk/assets/logo.png">
    <img src="https://sheep.grimtech.co.uk/assets/logo.png" width="200"
         alt="The Baa lockup: the sheep mark beside the word Baa">
  </picture>
</p>

| Asset | In this repository | Hosted |
| --- | --- | --- |
| Mark | [`assets/images/icon.png`](assets/images/icon.png) | [icon.svg](https://sheep.grimtech.co.uk/assets/icon.svg) |
| Lockup | [`logo.png`](assets/images/logo.png) · [`dark`](assets/images/logo-dark.png) | [logo.svg](https://sheep.grimtech.co.uk/assets/logo.svg) |
| Social card | [`social.png`](assets/images/social.png) · [`dark`](assets/images/social-dark.png) | [social.svg](https://sheep.grimtech.co.uk/assets/social.svg) |

The site these are served from is built and deployed separately and is not
part of this repository. Palette: ink `#22352C`, wool `#F7F5EE`, pasture
`#2F4B3F`.

## Why sheep?

`print` is a boring word and `baa` is not. That is genuinely the whole origin
story.

It turned out to be a useful forcing function. A language with a ridiculous
name gets no benefit of the doubt, so everything else had to be right: the
diagnostics, the formatter's determinism, the test coverage, the
specification. Nobody excuses a bad error message because the project is a
joke.

The humour is kept where it cannot do harm: module names, error wording and
documentation. It never changes what an operator does, and it is one flag away
from gone.

## Licence

MIT. See [LICENSE](LICENSE).
