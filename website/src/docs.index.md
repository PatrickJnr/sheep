# Documentation

Everything written about Baa, in one place. These pages are generated from the
Markdown in the repository, so they can never drift from the source.

New here? Read the [language tour](LANGUAGE.md): it covers the whole language
in about fifteen minutes, and every snippet in it runs.

## Start here

| Page | What it covers |
| --- | --- |
| [Language tour](LANGUAGE.md) | A guided walk from `baa "hello"` to modules and error handling |
| [CLI reference](docs/cli.md) | Every command, option, exit code and environment variable, plus `baa.toml` |
| [FAQ](docs/faq.md) | Why one number type, why `1 / 0` fails, why it is called Baa |
| [Editor support](docs/editors.md) | Syntax highlighting, and the `baa lsp` language server |

## Web pages

A `.baa` file that imports `gate` is a web page: a program run per request that
writes an HTTP reply. No daemon, no browser runtime, no client-side Baa.

| Page | What it covers |
| --- | --- |
| [Web pages](docs/web.md) | The `gate` module, escaping, `baa serve`, and putting a page on a real host |
| [Web applications](docs/web-applications.md) | The server-rendered application model: state, forms, testing, and what it is not good at |

## Native applications

A `.baa` file that imports `barn` is a desktop application, built into a single
Windows executable. The same language, a second place to run it.

| Page | What it covers |
| --- | --- |
| [Native applications](docs/native-applications.md) | What the platform is, what it does not do, and why it is not a browser in a box |
| [Windows and controls](docs/gui.md) | The `barn` module: widgets, layout, events, menus, dialogs, clipboard |
| [Application projects](docs/application-projects.md) | The manifest, the project layout, and where the code that is not the window goes |
| [Building for Windows](docs/building-windows-apps.md) | What to install, what to run, and what to check before shipping it |
| [The native runtime](docs/native-runtime.md) | The `.fleece` image, the Rust tree-walker, the window model, and how it is tested |

## Reference

| Page | What it covers |
| --- | --- |
| [Standard library](docs/stdlib.md) | Every function: the prelude, methods on values, and all {{modules}} modules |
| [Diagnostics](docs/errors.md) | All {{diagnostics}} `BAAnnn` codes, with both the default and the professional wording |
| [Diagnostics as JSON](docs/diagnostics-json.md) | The `--format json` schema, for editors and CI |
| [Specification](SPEC.md) | The precise rules: lexical structure, grammar, semantics, modules, execution |

## Project

| Page | What it covers |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | The pipeline, the design decisions, the benchmarks, and the route to a bytecode VM |
| [Roadmap](ROADMAP.md) | What is next, and what was deliberately left out |
| [Rust implementation](rust/README.md) | The plan for a Rust port, and the conformance suite that would verify it |
| [Contributing](CONTRIBUTING.md) | Setup, house rules, and what makes a change likely to be merged |
| [Security](SECURITY.md) | The threat model, the decisions made for security reasons, and how to report a problem |
| [Changelog](CHANGELOG.md) | Everything that has changed, release by release |

## The five-minute version

```baa
// Bindings. `let` can change; `const` cannot.
let sheep = 12
const MAX_SHEEP = 100

// Strings interpolate with braces.
baa "The flock holds {sheep} of a maximum {MAX_SHEEP}."

// Functions, with defaults and rest parameters.
fn tally(label, ..counts) {
    return "{label}: {counts.sum()}"
}

// Arrays and maps.
const flock = ["Dolly", "Shaun"]
const ages = { Dolly: 6, Shaun: 4 }

for name, age in ages {
    baa "{name} is {age}"
}

// Pattern-style branching, as an expression.
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

Try it without installing anything in [the playground](../playground.html), or
install Baa and run `baa repl`.

## Getting help

- **Something behaves oddly?** Open an issue with a `.baa` file that shows it.
- **Something is unclear?** That is a documentation bug, and worth reporting.
- **The specification and the implementation disagree?** That is the most
  valuable bug report this project can receive.

## For language models

Writing Baa with an AI assistant? Point it at
[`/llms.txt`](../llms.txt) for the index, or
[`/llms-full.txt`](../llms-full.txt) for every standard-library signature, the
rules that decide whether a file is a page or an application, and the mistakes
that compile but do the wrong thing. Both are generated from the
implementation, so a signature in them is a signature that exists.

Search is in the sidebar: press <kbd>/</kbd> from anywhere on these pages.
