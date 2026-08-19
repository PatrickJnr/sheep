# Architecture

How Baa is put together, why it is put together that way, and where it can go
next.

---

## The pipeline

```
   hello.baa
       │
       ▼
  SourceFile ─────────────── src/diagnostics/source.ts
       │                     normalises line endings, owns the line index
       ▼
    Lexer ────────────────── src/lexer/lexer.ts
       │                     tokens + comment trivia + significant newlines
       ▼
  Token[] ────────────────── src/lexer/token.ts
       │
       ▼
   Parser ────────────────── src/parser/parser.ts
       │                     recursive descent + precedence table + recovery
       ▼
     AST ─────────────────── src/ast/ast.ts
       │                     plain data, every node carries a span
       ├──────────────┬──────────────┬────────────────┐
       ▼              ▼              ▼                ▼
   Resolver       Formatter       Linter        Interpreter
 semantic/       formatter/      linter/         runtime/
       │                                             │
       │                                             ▼
       │                                        Standard library
       │                                          src/stdlib/
       ▼                                             │
  Diagnostic[] ◄─────────────────────────────────────┘
       │        src/diagnostics/diagnostic.ts
       ▼
      CLI ─────────────────── src/cli/
```

Each stage is a pure function of the stage before it. The lexer does not need a
parser, the parser does not need a runtime, and the formatter and linter are
just two more consumers of the same AST. That separation is what makes the test
suite specific: a lexer test can assert on tokens without constructing an
interpreter.

## Directory map

| Path | Contents |
| --- | --- |
| `src/diagnostics/` | Source files, spans, the error catalogue, the renderer |
| `src/lexer/` | Token kinds and the lexer |
| `src/parser/` | The parser |
| `src/ast/` | Node types and generic walkers |
| `src/semantic/` | Name resolution, scope and arity checking |
| `src/runtime/` | Values, environments, the interpreter, the host interface |
| `src/stdlib/` | The prelude and the nine modules |
| `src/formatter/` | The AST printer behind `baa fmt` |
| `src/linter/` | Warning rules |
| `src/project/` | `baa.toml` and `baa.lock` |
| `src/cli/` | Argument parsing, commands, output, REPL |
| `src/api.ts` | The programmatic API the CLI and tests are built on |
| `tests/` | Node test-runner suites, fixtures, recorded transcripts |
| `examples/` | Executable example programs |
| `tools/` | Benchmarks, transcript recorder |
| `editors/vscode/` | Syntax highlighting and snippets |
| `website/` | The static site, built and deployed separately, not part of this repository |

## Why TypeScript on Node

Rust was the obvious candidate and was seriously considered. It lost on one
practical point: a Rust build on Windows needs the MSVC linker, which means
several gigabytes of Visual Studio Build Tools installed before the first line
compiles. That is a poor trade for a language whose whole appeal is starting
fast and getting out of the way.

The decision was made deliberately rather than by default, so the trade-offs
on both sides are written out below. A Rust implementation remains an open
track, and the conformance suite exists so one can prove itself against this
one.

**What TypeScript on Node bought us**

- **No build step at all.** Node 22.18+ strips TypeScript types natively, so
  `node src/cli/index.ts` runs the sources directly. There is no compile, no
  watch mode, no stale `dist/`. Editing a file and running it are the same
  action.
- **One dev dependency.** `typescript`, used only for `tsc --noEmit`. The
  shipped language has zero runtime dependencies.
- **Portability for free.** The same files run on Windows, Linux and macOS with
  no cross-compilation and no per-platform release matrix.
- **A browser story.** The playground on the website is the real interpreter,
  not a re-implementation, because the runtime's only contact with the outside
  world is the `RuntimeHost` interface.

**What it cost**

- **Raw speed.** A tree-walking interpreter on V8 is perhaps 3-10× slower than
  the equivalent in Rust. The benchmarks (§ below) show this is comfortably
  fast enough for scripting, but Baa will not win a shootout.
- **Startup.** Node's own start-up is ~30 ms before Baa does anything. A native
  binary would start in single-digit milliseconds.
- **Distribution.** Users need Node installed. A Rust build would ship one
  self-contained executable.
- **Type-stripping constraints.** No `enum`, no `namespace`, no parameter
  properties: TypeScript features that need code generation. In practice this
  pushed the codebase towards plain data and `const` objects, which is where it
  wanted to be anyway.

**The exit route.** Nothing in the design assumes JavaScript. The lexer,
parser, AST and diagnostics are ordinary data structures that port directly.
If Baa outgrows this host, the front end is a mechanical translation and the
interpreter is the only part that needs real thought. See "Path to a bytecode
VM" below.

## Design decisions worth knowing

### Spans everywhere

Every token, AST node and stack frame carries a `Span`: a file plus a start and
end offset. Line and column numbers are computed lazily from a line-start index
built on first use, so the lexer never pays for them. The quality of the
diagnostics is downstream of this decision: a renderer can only underline what
the parser bothered to record.

### Comments are trivia, not tokens

The lexer attaches each comment to a token rather than emitting it into the
stream. The parser then copies that trivia onto statements. This keeps the
grammar clean (no `comment?` sprinkled through every rule) while still letting
the formatter round-trip a file. A test asserts that formatting never loses a
comment, over both the examples and a set of awkward cases.

### Newlines are significant, without being fragile

Semicolons are optional in many languages and painful in a few. Baa's rule is
three lines long (SPEC §2.2) and is implemented entirely in the lexer, so the
parser sees a clean stream of statement terminators and never has to guess.

### Errors are one type

Every stage throws `BaaError`, which wraps a fully-formed `Diagnostic`. Any
layer can catch one and render it identically. The resolver is the exception:
it *collects* diagnostics instead of throwing, so `baa check` reports a whole
file's worth of problems in one pass. The parser does both: it throws per
statement, catches at the statement boundary, records, and resynchronises.

### Two wordings, one catalogue

Each diagnostic in `src/diagnostics/codes.ts` has a `woolly` and a `plain`
message with identical placeholders. A test asserts the placeholders match, so
professional mode can never lose information the default mode showed. Humour
that can degrade a bug report is not worth having.

### The host interface

`RuntimeHost` (`src/runtime/host.ts`) is the runtime's only contact with the
outside world: streams, filesystem, clock, randomness, environment, process.
Two implementations ship: one over Node, one in memory. The in-memory one is
what lets the test suite assert on exact program output without touching real
stdio, and it is what a future `--deny-fs` sandbox would swap in. Capabilities
live in one file rather than being scattered through the standard library.

### Signals, not completion records

`return`, `break` and `continue` are JavaScript exceptions carrying no stack
trace. The alternative, threading a completion record through every `execute`
call, makes the evaluator considerably noisier for a small constant-factor
win in a case that is rare in real code.

### Data wins over methods

On a map, `x.name` finds the key `"name"` before it finds a built-in method.
This means adding a method to a future version of Baa cannot silently change
the meaning of an existing program.

### Callbacks are the one lenient arity

Baa checks argument counts strictly, at analysis time where it can. The single
exception is a function handed to a library higher-order function: `map` offers
`(item, index)`, and a one-parameter callback simply gets the item. Being
strict here would mean every `map(fn(n) { ... })` in the world fails, which is
a rule nobody would keep.

## The interpreter

A straightforward tree-walker.

- `execute(statement, env)` runs for effect; `evaluate(expression, env)`
  produces a value.
- Scopes are `Environment` objects: bindings in declaration order plus a parent
  pointer. A closure captures the `Environment` it was declared in, which is the
  whole of Baa's closure implementation.
- Reading a variable is two array indexes. The resolver records on each
  identifier how many scopes out its declaration lives and which position it
  holds there, and the interpreter goes straight to it. The slot carries the
  name it was resolved from and is checked before it is trusted, so a
  disagreement between the resolver and the interpreter falls back to the name
  walk rather than reading the wrong binding. A scope that grows past eight
  names builds a `Map`, which is what keeps the globals — the whole prelude —
  off a linear scan.
- Function declarations are hoisted per block before the block runs, which is
  what makes mutual recursion work.
- The call stack is an explicit array of frames. When a `BaaError` escapes a
  call and has no trace yet, the innermost frame attaches the live stack, so
  the reported trace is real rather than reconstructed after unwinding.
- Depth is capped (512 by default) and reported as `BAA307` with a suggestion,
  rather than as a V8 stack overflow.

## Performance

On a laptop, Node 24, median of 15 runs:

| Benchmark | Throughput |
| --- | --- |
| Lexer | ~7 MB/s |
| Parser | ~5 MB/s |
| Resolver | ~128 MB/s |
| `fib(22)` | ~1.2 M calls/s |
| Tight loop | ~4.5 M iterations/s |
| `map`/`filter`/`sum` over 20k items | ~1.3 M items/s |

Run them yourself with `npm run bench`. The numbers exist to catch regressions,
not to win arguments.

The deliberate performance choices are: no boxing of primitives (a Baa number
*is* a JavaScript number), lazy line-index construction, and a single pass over
the AST per stage. Variable resolution, which used to be the obvious remaining
win, is done: see "Path to a bytecode VM" below.

## Path to a bytecode VM

The interpreter is the only part of Baa that would need replacing, and the
groundwork is already in place.

**Step 1: resolved variable slots — done in 0.8.0.** The resolver records a
`(hops, index)` pair on each `Identifier`, and `Environment` holds its bindings
in declaration order, so reading a resolved local is an array index rather than
a walk through a chain of hash maps. Measured back to back on the same machine:
loop-heavy code around 17% faster, calls roughly unchanged (a call defines its
parameters, and that bookkeeping offsets what the lookups save). The native
runtime is untouched — the image format carries no slots, and the Rust
tree-walker still looks names up — so the two implementations cannot disagree
about scope rules on account of this.

**Step 2: a compiler to a flat instruction array.** The AST is already a
clean tree of plain data with no behaviour attached, so a `compile(node)` that
emits opcodes sits alongside the interpreter rather than replacing it. Keeping
both, and testing that they agree on every example, is how the transition stays
honest.

**Step 3: a register or stack VM.** With slots resolved and a flat
instruction array, the dispatch loop is mechanical. Constant folding and
dead-branch elimination become straightforward AST-to-AST passes that the
formatter's own tree walker demonstrates the shape of.

**Step 4: native compilation, if it is ever justified.** Baa's semantics are
dynamically typed, so ahead-of-time native code needs either type feedback or a
type system. That is a much larger project than the previous three steps, and
the roadmap treats it as an open question rather than a plan.

What deliberately has *not* been built yet: none of the above. A bytecode VM
for a language with no users is a way of avoiding writing the standard library.
The architecture leaves the door open; the roadmap says when to walk through
it.

## Native applications

Baa runs in two places: as a web page executed per request, and as a desktop
application held open by a runtime that draws a window. The second one is
newer, and the decisions behind it are set out here because several plausible
alternatives were rejected.

### The shape

```
  main.baa ──┐   the reference frontend            the native runtime
  logic.baa ─┤   lex → parse → resolve  ──►  .fleece image  ──►  tree-walker
  barn ──────┘   (src/, TypeScript)                              (rust/, Rust)
```

`baa app build` runs exactly the analysis `baa check` runs, serialises the
resolved tree into a binary image, and appends that image to a copy of the
native runtime. The result is one executable.

### Why the frontend is not duplicated

The obvious way to write a native runtime is to write a whole implementation:
lexer, parser, resolver, interpreter. It was rejected because **two frontends
drift**. Every precedence rule, every newline decision and every diagnostic
would be maintained twice, and the second copy would be the one nobody runs
`baa check` through. Keeping one frontend means a program that compiles
compiles identically for both targets, by construction.

The cost is that a shipped application cannot compile Baa source at runtime.
Nothing wanted to.

### Why a tree and not bytecode

A bytecode image would be smaller and would start marginally faster. It also
means writing a compiler, and a compiler is the part most likely to disagree
with the tree-walker about a corner of the semantics — which is exactly the
class of bug that a second implementation exists to avoid.

The measurement that would justify it now exists (`node tools/bench-native.ts`):
the native tree-walker is 1.2x faster than Node on a tight loop and 10x faster
to start. Almost all of the win is process start, and none of it comes from the
interpreter being cleverer, because it is not. That is the honest case for a
bytecode VM *later*, on the route in
[Path to a bytecode VM](#path-to-a-bytecode-vm), and the honest case against
building it first.

### Why Rust

The reference implementation is TypeScript for the reasons in
[Why TypeScript on Node](#why-typescript-on-node), and none of them changed.
What changed is the target: a desktop application must be one file that starts
immediately and needs nothing installed, and Node cannot be that. It also has
no FFI in core, so a window would need a native module, which reintroduces the
build step and the extra file that the single-executable story exists to
remove.

Rust was already the documented direction for a second implementation
([rust/README.md](rust/README.md)), the conformance suite was already built for
it, and it keeps the project's zero-dependency rule: the Win32 calls are thirty
lines of `extern "system"` rather than a bindings crate.

C was considered and rejected: it would have been a third language in the
repository, and an interpreter written in it handles untrusted text with no
help from the compiler.

### Why appending rather than linking

A built application is the runtime followed by the image and a footer. Windows
ignores trailing bytes in a PE file, and the runtime reads its own path to find
them.

This means **building an application needs no compiler and no linker** — it
copies a file and adds bytes — so a person who has never installed Rust can
build one. The cost is that the icon and version metadata belong to the runtime
rather than to the application, which needs a PE resource rewrite to fix and is
on the roadmap.

### What keeps the two honest

- The **conformance suite** runs on both. All 63 of its programs execute on
  the native runtime and are compared byte for byte. The harness can still skip
  a program that imports a module the native runtime lacks — `gate` is the only
  one — and reports such a program as skipped rather than passed, because a
  program that was not run is not evidence that it would pass.
- The **diagnostic catalogue** is generated into Rust from
  `src/diagnostics/codes.ts`, so both print the same sentence for `BAA302`.
- **Drift guards** in `tests/native.test.ts` compare every list that exists in
  both languages: which modules there are, what `barn` provides, each
  function's arity, the image format's version.

### The boundary

`gate` is the web target's module and `barn` is the native target's. A program
imports one or the other; importing `gate` into an application is a build error
naming it. `.baa` did not change meaning, no second extension was invented, and
a module that imports neither belongs to both — which is why the native
calculator's arithmetic is the web calculator's file, unchanged.

Full detail is in [docs/native-runtime.md](docs/native-runtime.md).

## Testing strategy

| Layer | Where | What it proves |
| --- | --- | --- |
| Lexer | `tests/lexer.test.ts` | Tokens, spans, trivia, newline rules |
| Parser | `tests/parser.test.ts` | Precedence, every statement form, recovery |
| Resolver | `tests/resolver.test.ts` | Scope, mutability, arity, modules |
| Runtime | `tests/runtime.test.ts` | Every operator, control flow, closures |
| Stdlib | `tests/stdlib.test.ts` | Every module, including failure modes |
| Diagnostics | `tests/diagnostics.test.ts` | Catalogue invariants, rendering, every code |
| Formatter | `tests/formatter.test.ts` | Idempotence, comment preservation |
| Linter | `tests/linter.test.ts` | Each rule, and its escape hatch |
| Modules | `tests/modules.test.ts` | Real files, caching, cycles |
| CLI | `tests/cli.test.ts` | Exit codes, streams, the whole project lifecycle |
| Examples | `tests/examples.test.ts` | Every example compiles, lints, formats, runs |
| Baa itself | `tests/programs/*.baa` | The language testing itself, run by `baa test` |

Two invariants are worth calling out because they catch whole classes of bug:

- **Formatting is a fixed point.** `format(format(x)) == format(x)`, checked on
  every example and a set of awkward cases.
- **Example output is recorded.** `tools/record-examples.ts` writes each
  deterministic example's output to `tests/expected/`, and the suite asserts on
  it. A behavioural change shows up as a diff, not as a vague failure.

## Adding a feature

A worked route for, say, a new operator:

1. `src/lexer/token.ts`: add the token kind; `lexer.ts`: scan it, and decide
   whether it suppresses a newline.
2. `src/ast/ast.ts`: extend the operator union; update `childrenOf` if it
   introduces a new node.
3. `src/parser/parser.ts`: add it to the precedence table.
4. `src/semantic/resolver.ts`, usually nothing, since it walks children
   generically.
5. `src/runtime/interpreter.ts`, implement it in `applyBinary`.
6. `src/formatter/formatter.ts`, add its precedence so parentheses stay
   correct.
7. `src/diagnostics/codes.ts`: add any new diagnostic, in both wordings.
8. Tests at each layer, plus an example if it is user-facing.
9. `SPEC.md` and `LANGUAGE.md`.

TypeScript's exhaustive `switch` checks will point at most of the places you
have missed; `npm run typecheck` is the fastest way to find them.
