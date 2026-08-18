# Changelog

All notable changes to Baa are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Baa follows [semantic versioning](https://semver.org/) from 1.0; before then,
minor versions may change the language, and every such change appears here with
a migration note.

## [0.1.0], 2026-08-17

The first release. Baa is a complete, working language rather than a prototype:
every feature listed here is implemented, tested and exercised by a real
program in `examples/`.

### Language

- Values: `nil`, `bool`, `number`, `string`, `array`, `map`, `range`, plus
  first-class `function` and `module`.
- One numeric type (IEEE-754 double). Literals in decimal, hex (`0xFF`), octal
  (`0o17`) and binary (`0b1010`), with `_` separators and exponents.
- `let` and `const` bindings, block-scoped, with shadowing, and destructuring
  of arrays and maps (`let [a, ..rest] = xs`, `let { name as who } = sheep`).
- Four string spellings: plain, `"""` block strings indented by their closing
  delimiter, and `r"..."` / `r"""..."""` raw strings with no escapes and no
  interpolation.
- String interpolation (`"{expr}"`), with full expressions and nested string
  literals inside the braces.
- Operators: arithmetic including `**`, comparison, `&&`, `||`, `??`, `!`,
  `in`, ranges `..` and `..=`, and compound assignment.
- Structural equality for arrays and maps.
- `if` / `else if` / `else`, `while`, `for ... in`, `break`, `continue`.
- `for` over arrays, strings, maps and ranges, with one or two bindings.
- Functions with default parameters, rest parameters (`..rest`), closures and
  hoisting.
- `match` expressions with literal, binding and wildcard patterns, `||`
  alternatives and `if` guards.
- `throw`, `try` / `catch` / `finally`, and catchable runtime errors that
  arrive as a map with a stable code.
- Modules: `export`, `import` by name or path, aliases, named imports,
  load-once semantics and cycle detection.
- `test "name" { ... }` blocks as a language construct.
- Comments: `//`, nesting `/* */`, and `///` doc comments.
- Optional semicolons, via a three-rule newline policy handled in the lexer.

### Tooling

- `baa run`, `check`, `test`, `fmt`, `lint`, `serve`, `repl`, `init`, `build`,
  `add`, `remove`, `doctor`, `modules`, `version`.
- Deterministic formatter that preserves comments and is a fixed point.
- Linter with six rules (`BAA901`–`BAA906`) and `_`-prefix and `--disable`
  escape hatches.
- REPL with persistent scope, multi-line continuation and `:` commands.
- Project manifest `baa.toml`, lockfile `baa.lock`, local path dependencies.
- `--seed` for reproducible runs of anything using `meadow`.

### Diagnostics

- 44 diagnostic codes across six ranges, each with a stable `BAAnnn` code.
- Rendered with the file, line, column, the source line and an underline of the
  exact span, plus suggestions where possible.
- Runtime errors carry a real call stack captured at the point of failure.
- Two wordings per diagnostic: sheep-flavoured by default, neutral under
  `--no-baa`, `BAA_NO_BAA=1` or `CI=true`, with identical codes and spans.
- Parser recovery: `baa check` reports many syntax errors in one pass.
- "Did you mean" suggestions for names, methods, module names and map keys.

### Standard library

- `wool`, text: formatting, case conversion, wrapping, centring, bytes,
  regular expressions, HTML and URL escaping.
- `flock`, collections: grouping, chunking, zipping, partitioning, map
  construction.
- `ram`, arithmetic: rounding, integer division, statistics, constants.
- `meadow`, time and randomness, seedable for reproducibility.
- `pasture`, files and platform-aware paths.
- `shepherd`, arguments, environment, stdin, and shell-free subprocesses.
- `lamb`: JSON encoding and decoding.
- `gate`, the web: reading a request and writing a reply over CGI, with
  escaping that is safe by default.
- Prelude: `len`, `type_of`, `to_string`, `to_number`, `inspect`, `clone`,
  `assert`, `assert_eq`, `panic`, `exit`.
- Methods on strings, arrays, maps, ranges and numbers.

### Project

- 536 automated tests across lexer, parser, resolver, runtime, standard
  library, diagnostics, formatter, linter, modules, CLI and examples.
- Baa's own test blocks, run by `baa test`.
- Recorded example transcripts, asserted by the suite.
- Benchmarks for the front end and the runtime.
- Documentation: README, language tour, specification, architecture, CLI
  reference, generated standard-library and diagnostic references, FAQ,
  roadmap, contributing guide, security policy.
- Static website, deployable to any web host.
- VS Code extension with syntax highlighting, snippets and language
  configuration.
- CI across Windows, Linux and macOS.
- No third-party packages at runtime.

[0.1.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.1.0
