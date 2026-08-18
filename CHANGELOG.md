# Changelog

All notable changes to Baa are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Baa follows [semantic versioning](https://semver.org/) from 1.0; before then,
minor versions may change the language, and every such change appears here with
a migration note.

## [0.2.1], 2026-08-18

### Fixed

- **The published package could not run.** 0.2.0 shipped its TypeScript
  sources with `bin` pointing at `src/cli/index.ts`. It installed cleanly and
  then failed on the first command with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`: Node refuses to strip types
  from files under `node_modules`. The package now ships compiled JavaScript,
  built by `npm run build` and invoked automatically by `prepack`.

  Nothing changes for a clone. Development still runs `src` directly and still
  has no build step; the build exists only to produce the tarball.

  0.2.0 is deprecated on npm. Use 0.2.1.

### Added

- A CI step that packs the tarball, installs it into a scratch project and
  runs a program through the installed binary. Every other check runs from the
  checkout, which is why a package that only fails once installed passed all of
  them.

[0.2.1]: https://github.com/PatrickJnr/sheep/releases/tag/v0.2.1

## [0.2.0], 2026-08-18

An audit release. Nothing in the language changed shape; several things that
were wrong about it are now right, and the tooling grew a language server.

### Added

- **`baa lsp`**, a language server over stdin and stdout: diagnostics as you
  type, whole-file formatting, a document outline, and hover for top-level
  declarations. It runs the same analysis as `baa check` and `baa lint` rather
  than a second copy of it. Go to definition, find references and rename are
  not implemented and are not advertised. See [docs/editors.md](docs/editors.md).
- **`baa build --locked`**, which verifies `baa.lock` instead of rewriting it
  and reports `BAA406` naming the wool that arrived, changed, moved or went
  away. Every build previously rewrote the file, so a dependency whose contents
  had changed silently updated its own recorded hash.
- `BAA406`, for a lockfile that no longer describes the project.
- Eight conformance programs covering the semantics newly written down below.

### Fixed

- **Diagnostic messages no longer double their articles.** Four templates wrote
  the article themselves while every call site also supplied one, so programs
  were told "You can't add a an array and a a number", "A an array has no field
  called `merge`" and "expected a count of 0 or more, but got a a negative
  number". `BAA302`, `BAA305`, `BAA309` and `BAA311` are affected. Codes and
  spans are unchanged; only the wording is.
- **Two diagnostics reported JavaScript type names**, so `ram.parse([1])` and
  `shepherd.exit("x")` could tell a program it had passed "a object".
- **Array growth is bounded.** `push`, `unshift`, `insert` and `concat` had no
  size limit, though `repeat` and `flock.range` have had one since 0.1.
  Appending to an array while iterating it allocated for about forty seconds
  and then surfaced a JavaScript `RangeError` wrapped in `BAA301`. It is now
  `BAA312`, reported against the call.
- The standard-library module count said seven in seven different files, in
  `SPEC.md` among them, while eight were listed. The diagnostic count was given
  as 41 in one place and 44 in another, against 45. The dependencies badge said
  "none" while three development dependencies are installed.

### Documented

- `SPEC.md` now states what `for` binds (one name is the value, two are the
  position and the value, and for a `map` a single name binds the *value*), that
  `for` re-reads a collection's length rather than taking a snapshot, how a
  `finally` block that returns or throws replaces the outcome that was pending,
  and that map keys are not coerced so `1` and `"1"` are two entries. All four
  were well defined in the implementation and absent from the document a second
  implementation would be written against.
- `docs/editors.md`, covering the language server and configuration for Neovim,
  Helix and Emacs.

### Changed

- Diagnostic wording only, as above. No code, span, severity or exit code
  changed, so anything grepping CI logs for `BAAnnn` is unaffected.

[0.2.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.2.0

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

- 45 diagnostic codes across six ranges, each with a stable `BAAnnn` code.
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
