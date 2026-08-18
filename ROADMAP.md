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

**Status: planned, not started.** There is no Rust code in the repository, and
the roadmap will not claim otherwise until there is. The milestone that counts
is a conformant `baa run`: passing both halves of the conformance suite:
rather than a partially-working pipeline.

If you want to start, open an issue tagged `rust` saying which crate you are
taking, so nobody writes the lexer twice.

## Phase 4, Faster 🔭 later

- [ ] **Bytecode compiler and VM.** See
      [ARCHITECTURE.md](ARCHITECTURE.md#path-to-a-bytecode-vm). To be built
      alongside the tree-walker, with both tested against the same programs,
      not as a replacement dropped in at once.
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
