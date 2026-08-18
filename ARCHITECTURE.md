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
| `src/stdlib/` | The prelude and the seven modules |
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

The project brief preferred Rust. The machine this was built on had no Rust
toolchain and, more importantly, no MSVC linker, so a Rust build would have
required installing several gigabytes of Visual Studio Build Tools before the
first line of code compiled. The choice was made explicitly, with the
trade-offs written down here as the brief requires.

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
- Scopes are `Environment` objects: a `Map` plus a parent pointer. A closure
  captures the `Environment` it was declared in, which is the whole of Baa's
  closure implementation.
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
the AST per stage. The obvious remaining win is variable resolution (see
below).

## Path to a bytecode VM

The interpreter is the only part of Baa that would need replacing, and the
groundwork is already in place.

**Step 1: resolved variable slots.** The resolver already walks every scope
and knows, for each identifier, which scope declares it. Recording a
(depth, index) pair on each `Identifier` node turns environment lookup from a
hash-map walk into an array index. This is a contained change: the resolver
gains an output field, `Environment` gains an indexed representation, and
nothing else moves. It is the single largest available speed-up.

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
