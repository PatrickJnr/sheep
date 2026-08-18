# Roadmap

What is done, what is next, and what is deliberately not being built yet.

Baa follows semantic versioning from 1.0. Before then, minor versions may
change the language; every change will appear in [CHANGELOG.md](CHANGELOG.md)
with a migration note.

---

## Phase 1: Foundation ✅ shipped in 0.1

- [x] Project structure, no build step, zero runtime dependencies
- [x] Lexer with spans, comment trivia and significant-newline handling
- [x] Recursive-descent parser with a precedence table and error recovery
- [x] AST with source locations and generic walkers
- [x] Semantic analysis: scopes, mutability, arity, use-before-declare
- [x] Tree-walking interpreter with real stack traces
- [x] Variables, constants, all primitives, arrays, maps, ranges
- [x] Functions, defaults, rest parameters, closures, first-class functions
- [x] `if` / `else if` / `else`, `while`, `for`, `break`, `continue`
- [x] String interpolation
- [x] `baa` print statement
- [x] CLI with `run`, `check` and `--help`

## Phase 2: A usable language ✅ shipped in 0.1

- [x] Modules: local files, standard library, named imports, aliases, cycles
- [x] Eight standard-library modules
- [x] `try` / `catch` / `finally`, `throw`, catchable runtime errors
- [x] `match` with alternatives, guards and structural patterns
- [x] Deterministic formatter that preserves comments
- [x] Linter with six rules and an escape hatch
- [x] REPL with persistent scope and multi-line input
- [x] Test framework (`test` blocks, `baa test`)
- [x] Project manifest, lockfile, local dependencies
- [x] Full diagnostic catalogue with professional mode
- [x] 536 automated tests, benchmarks, recorded example output
- [x] Web pages over CGI (`gate`, `baa serve`), with a
      [live example](https://sheep.grimtech.co.uk/baa/index.baa) on shared
      hosting
- [x] Documentation and website
- [x] VS Code syntax highlighting and snippets

## Phase 3: Sharper tools 🚧 in progress

Ordered by how much they would improve a normal day.

- [x] **Language server**, shipped in 0.2 as `baa lsp`. Diagnostics, whole-file
      formatting, a document outline and hover for top-level declarations, all
      driven by the existing analysis rather than a second copy of it.
- [x] **A symbol table the language server can read**, shipped in 0.3. The
      resolver records each declaration with the span of every use that binds
      to it, and `check` hands it back. Go-to-definition, find-references,
      rename and scope-aware hover all read it, so shadowed names resolve the
      way the interpreter resolves them rather than the way a text search
      would.
- [ ] **A VS Code client.** The extension is declarative, so it highlights but
      does not start the server. VS Code needs a JavaScript entry point using
      `vscode-languageclient`; Neovim, Helix and Emacs already work today.
- [ ] **Resolved variable slots.** The resolver already knows which scope
      declares each name; recording a (depth, index) pair turns lookup from a
      map walk into an array index. The largest available speed-up, and a
      prerequisite for a bytecode VM.
- [ ] **Incremental `baa check --watch`.** Re-check only what changed.
- [ ] **`baa fmt --diff`.** Show what would change instead of rewriting.
- [ ] **Structured diagnostic output.** `--format json` for editors and CI
      annotations.
- [ ] **Stdlib growth.** `pasture` recursive walk
      and globbing, `flock` set operations, `meadow` durations and time zones.
- [ ] **Neovim and JetBrains highlighting**, once the grammar has settled.
- [ ] **Doc generation.** `baa doc` producing a reference from `///` comments,
      which the standard library already carries internally.

## Native applications ✅ shipped in 0.4

Baa runs in a second place: a desktop application, in a real window, from one
executable. `.baa` did not change meaning; a file is an application when it
imports `barn`, exactly as it is a web page when it imports `gate`.

- [x] **A native runtime.** `rust/crates/baa-native`, a Rust tree-walker with
      no dependencies, running a resolved tree the reference implementation
      hands it. Passes 49 of the 50 conformance programs byte for byte.
- [x] **`baa app new | build | run | test`**, producing one Windows executable
      with the runtime and the program inside it. No linker, no compiler on the
      developer's machine, no Node on the user's.
- [x] **`barn`:** windows, rows and columns with weights, labels, buttons,
      inputs, text areas, lists, checkboxes, menu bars, message boxes, file
      dialogs, clipboard, per-monitor DPI.
- [x] **Two applications that are the tests.** The calculator imports the *web*
      calculator's arithmetic module unchanged; the text editor's document
      model has nine tests and no window in it.
- [x] **Documentation**, an architecture record, and measurements rather than
      adjectives.

### Next, on this track

Ordered by how much each would change what can be built.

- [ ] **`shepherd` and `meadow` in the native runtime.** Arguments,
      environment, clocks and seeded randomness. Their absence is the reason
      one conformance program is skipped rather than run, and the reason an
      application cannot read its own command line.
- [ ] **An application icon and version metadata.** Both live in PE resources,
      which the appending build deliberately does not touch. Doing it properly
      means writing a resource section rather than shelling out to a tool.
- [ ] **A Linux backend.** The window model has no Win32 in it and is tested
      without a screen; `barn.show` on Linux reports that there is no backend.
      GTK through its C ABI would keep the zero-dependency rule.
- [ ] **Regular expressions**, which would complete `wool` natively. The five
      functions that need them currently say so when called. The trap is that a
      near-miss reimplementation of JavaScript's engine is worse than an
      absence, so this wants a specified subset rather than a best effort.
- [ ] **A table or grid control.** The first application that wants one will
      say what it needs.
- [ ] **Timers.** `barn` has no clock, so a pomodoro or an animation cannot be
      written. This is small and only waits for an application that needs it.
- [ ] **`[wool]` dependencies in a bundle.** Relative imports are bundled;
      manifest dependencies are refused with a message rather than
      half-supported.

## Parallel track: a Rust implementation 🦀 open for contributors

Baa's reference implementation is TypeScript on Node, for the reasons in
[ARCHITECTURE.md](ARCHITECTURE.md#why-typescript-on-node). Plenty of people
would rather have a single self-contained binary that starts in a millisecond,
and plenty of people would rather write a compiler in Rust. Both are reasonable.

This is not a vague someday. The material a second implementation needs already
exists and is kept fresh by CI:

- [`SPEC.md`](SPEC.md): the complete language definition, with grammar
- [`tests/conformance/suite.json`](tests/conformance/suite.json): 50 programs
  with their exact output, and 27 with the diagnostic codes they must report
- [`tests/conformance/diagnostics.json`](tests/conformance/diagnostics.json):
  all 46 diagnostics, both wordings, ready to embed
- [`rust/README.md`](rust/README.md): crate layout, suggested order of work,
  and the design notes worth carrying over

**Status: the runtime half exists, the frontend half does not.**

`rust/crates/baa-native` is a working Rust runtime — values, the tree-walking
interpreter, six standard-library modules, a window model and a Win32 backend
— built for [native applications](#native-applications-shipped-in-04).
It passes 49 of the 50 conformance programs, byte for byte; the one it does
not run imports `shepherd`, which it does not have.

It has no lexer, no parser, no resolver, no formatter, no linter and no CLI,
and gains nothing from having them: the reference implementation analyses a
program and hands the runtime a resolved tree, so there is exactly one frontend
and it cannot disagree with itself.

That leaves the interesting half of a second implementation still open, and
the milestone unchanged: a conformant `baa run` from Rust source, passing both
halves of the suite. Anyone taking it on starts with a runtime that already
works and a conformance harness that already runs.

If you want to start, open an issue tagged `rust` saying which crate you are
taking, so nobody writes the lexer twice.

## Phase 4, Faster 🔭 later

- [ ] **Bytecode compiler and VM.** See
      [ARCHITECTURE.md](ARCHITECTURE.md#path-to-a-bytecode-vm). To be built
      alongside the tree-walker, with both tested against the same programs,
      not as a replacement dropped in at once.

      There is now a measurement to argue from. `node tools/bench-native.ts`
      puts the native tree-walker 1.2x ahead of Node on a tight loop and 9.6x
      ahead on process start: almost all of the win is starting up, and none of
      it is the interpreter being cleverer, because it is the same algorithm in
      a different language. A bytecode VM is where the interpreter itself would
      get faster, and resolved variable slots are still the prerequisite.
- [ ] **Constant folding and dead-branch elimination** as AST passes.
- [ ] **Inline caches** for member and method lookup.
- [ ] **A native-compilation study.** Baa is dynamically typed, so ahead-of-time
      native code needs type feedback or a type system. This is a research
      question, not a scheduled feature.
- [ ] **Self-hosting investigation.** Writing the Baa lexer in Baa is a good
      test of whether the language is pleasant at scale, and a bad way to ship
      a compiler. Worth doing as an exercise, not as the plan.

## Phase 5: Ecosystem 🌱 someday

- [ ] **A package registry.** The blocker is not code, it is operations:
      naming, publishing, verification, revocation, supply-chain integrity and
      who pays for the bandwidth. Until that has an answer, `baa add` says so
      instead of pretending. Local path dependencies work today and cover the
      "split this project in two" case that most people actually have.
- [ ] **Signed releases and reproducible builds.**
- [ ] **A standard-library RFC process**, so the small core stays small on
      purpose rather than by neglect.

---

## Deliberately not planned

Each of these was considered and left out. They can be revisited, but they need
a stronger argument than "other languages have it".

| Not building | Why |
| --- | --- |
| Classes and inheritance | Closures plus maps cover the useful part. Inheritance is where the trouble starts. |
| A static type system | It would double the size of the language. A gradual `--strict` mode is the interesting version, if anyone wants it. |
| Operator overloading | Makes `a + b` unreadable without knowing every type in scope. |
| Implicit numeric coercion | The bug source Baa's single number type exists to avoid. |
| `async` / `await` | The runtime is synchronous by design. Concurrency needs a whole coherent model, not a keyword. |
| A second numeric type | See [FAQ](docs/faq.md#why-is-there-only-one-number-type). |
| Macros | Too easy to make every codebase a different language. |

## How to influence this

Open an issue describing the *problem*, not the feature. The most useful thing
you can attach is a real program that is awkward to write today. See
[CONTRIBUTING.md](CONTRIBUTING.md).
