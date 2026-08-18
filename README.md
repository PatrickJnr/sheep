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
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-none-2F4B3F)](package.json)

**[Website](https://sheep.grimtech.co.uk)** ·
**[Playground](https://sheep.grimtech.co.uk/playground.html)** ·
**[Docs](https://sheep.grimtech.co.uk/docs/)** ·
[Tour](LANGUAGE.md) ·
[Spec](SPEC.md) ·
[Architecture](ARCHITECTURE.md) ·
[Roadmap](ROADMAP.md)

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

The joke is the name. Everything underneath is built to be used.

|  | |
| --- | --- |
| **Small core** | Nine statement forms, one numeric type, no inheritance, no hidden coercions. You can hold the whole language in your head. |
| **Diagnostics that help** | Every error has a stable `BAAnnn` code, a source span, an underlined excerpt and, where possible, a suggestion. |
| **Fast enough to be practical** | Around 1.2 million function calls and 4.5 million loop iterations per second on a laptop. `baa run` starts in tens of milliseconds. |
| **Tooling in the box** | `fmt`, `lint`, `check`, `test`, `repl`, `init`, `build`, `doctor`. No plugin hunt on day one. |
| **Serious when it needs to be** | `--no-baa`, or `CI=true`, swaps every sheep joke for neutral wording and keeps the codes identical. |
| **Nothing to trust** | No third-party packages. Nothing is downloaded, nothing runs implicitly, and no subprocess ever sees a shell. |

Verified on every commit, across Windows, Linux and macOS: **400+ tests**, a
formatter that must be a fixed point, a linter that must be clean, and a
conformance suite that pins the exact output of 42 programs.

## Install

Baa needs **Node.js 22.18 or newer**, and nothing else. Node runs Baa's
TypeScript sources directly, so there is no build step.

```bash
git clone https://github.com/PatrickJnr/sheep.git
cd sheep
npm install          # one dev dependency: typescript, for type-checking only
npm link             # puts `baa` on your PATH
baa doctor           # check the installation
```

Prefer not to link? Every command works as `node src/cli/index.ts <command>`.

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
  ┌─ examples/hello.baa:4:19
  │
3 │ const flock = ["Dolly", "Shaun"]
4 │     baa "Baa, " + sheap
  │                   ^^^^^ not found in this pasture
  │
  = help: Did you mean `sheep`?
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
| `baa check [paths]` | Parse and analyse without running |
| `baa test [paths]` | Run `test "..." { ... }` blocks |
| `baa fmt [paths]` | Format source files, `--check` for CI |
| `baa lint [paths]` | Report warnings, `--deny-warnings` for CI |
| `baa repl` | Interactive session |
| `baa init [dir]` | Create a new project |
| `baa build` | Validate the project and write `baa.lock`, `--locked` to verify it |
| `baa add` / `baa remove` | Manage local dependencies |
| `baa doctor` | Diagnose the installation |
| `baa modules` | List the standard library |

Full reference, including exit codes and the manifest format:
[docs/cli.md](docs/cli.md).

## Standard library

Eight modules, sheep-branded on the outside and completely boring on the
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

Plus a ten-name prelude that needs no import. Full reference:
[docs/stdlib.md](docs/stdlib.md).

## Examples

Every file in [`examples/`](examples/) is executable, formatted by `baa fmt`,
clean under `baa lint`, and its output is recorded and asserted by the test
suite. If one breaks, CI says so.

| File | Shows |
| --- | --- |
| [`hello.baa`](examples/hello.baa) | The smallest useful program |
| [`variables.baa`](examples/variables.baa) | Bindings, types, operators |
| [`functions.baa`](examples/functions.baa) | Defaults, rest params, closures |
| [`loops.baa`](examples/loops.baa) | Every loop and iteration form |
| [`collections.baa`](examples/collections.baa) | Arrays and maps in anger |
| [`modules.baa`](examples/modules.baa) | Imports, aliases, local files |
| [`errors.baa`](examples/errors.baa) | Throwing, catching, `finally` |
| [`stdlib.baa`](examples/stdlib.baa) | The six modules whose output is the same on every machine |
| [`fizzbuzz.baa`](examples/fizzbuzz.baa) | `match` on structural patterns |
| [`large_program.baa`](examples/large_program.baa) | A ~200-line flock register: parsing, validation, statistics, a report and JSON |

## Editor support

[`editors/vscode/`](editors/vscode/) contains a VS Code extension with syntax
highlighting, including inside string interpolations, plus bracket and comment
configuration and snippets. To try it locally, copy or symlink the directory
into `~/.vscode/extensions/` and reload the window.

A language server is the next tooling milestone. Every piece it needs already
exists: spans, the resolver's symbol table, doc comments and the formatter.

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

Passing the conformance suite is the milestone. There is no Rust code in the
repository yet, and this README will not pretend there is.

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
