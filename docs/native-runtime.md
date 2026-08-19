# The native runtime

How `rust/crates/baa-native` is put together, for anyone changing it, porting
it, or deciding whether to trust it.

For what it is *for*, read
[native-applications.md](native-applications.md) first.

---

## The shape

```
src/native/image.ts          writes a .fleece image        (TypeScript)
src/native/bundle.ts         collects a module graph       (TypeScript)
        │
        ▼
rust/crates/baa-native/src/
├── image.rs                 reads a .fleece image
├── ast.rs                   the tree it produces
├── interp.rs                the tree-walker, environments, calls
├── value.rs                 values, maps, equality, formatting
├── methods.rs               methods on strings, arrays, maps, ranges, numbers
├── number.rs                JavaScript-compatible number formatting
├── diag.rs                  errors, and how they are rendered
├── codes.rs                 generated from src/diagnostics/codes.ts
├── stdlib/                  ram, wool, flock, lamb, pasture, barn
├── gui/mod.rs               the window model, with no operating system in it
├── gui/win32.rs             the Windows backend
└── bin/                     two binaries: console and windowed
```

Zero dependencies. The Win32 functions are declared in `gui/win32.rs` as
forty-three `extern "system"` declarations against an ABI that has not changed
since the 1990s, which is less to maintain than a bindings crate's version
number.

---

## The image

A `.fleece` image is a parsed, resolved program. The format is little-endian
throughout:

```
"FLEECE\n"              7 bytes
version                 u8, currently 1
string count            u32
  length + UTF-8 bytes  u32 + n, repeated
app metadata            count, then key/value string indices
entry module            u32
module count            u32
  name, path, source    string indices
  statements            count, then nodes
```

Every node is a span (two `u32`s) followed by a tag byte and its fields.
Strings are interned, because a program repeats identifiers more than anything
else. Spans are kept, and so is each module's source text, so a runtime error
can underline the line it happened on rather than name it.

Two rules make the format safe to read:

- **The version is checked before anything is decoded.** A mismatch is refused
  with a sentence telling you to rebuild. A silently misread tree is a wrong
  answer rather than an error.
- **Every read is bounds-checked and returns an error**, never a panic. A
  length larger than the remaining bytes is refused rather than allocating. The
  bytes are whatever is on the end of an executable, so they are treated as
  untrusted.

Import targets are resolved at build time into module indices, and the indices
are validated once at load. That is why a shipped application never touches the
filesystem to find a module, and cannot be redirected by a file dropped beside
it.

### Why a tree and not bytecode

A second lexer and parser in Rust would be two frontends, and two frontends
drift. Every precedence rule and every newline decision would be maintained
twice, and the second copy would be the one nobody runs `baa check` through.
An image keeps exactly one frontend.

Bytecode would additionally mean a compiler, and a compiler is the part most
likely to disagree with the tree-walker about a corner of the semantics. It is
the right next step, and it is on [ROADMAP.md](../ROADMAP.md) with the
measurement that would justify it, but it was not the thing to build before
anything ran at all.

---

## The interpreter

A direct port of `src/runtime/interpreter.ts`, kept deliberately close. Where
the two could reasonably differ, this one does what the reference does, and
the conformance suite decides.

Three differences are in the implementation rather than the semantics:

**Signals are a `Result`, not exceptions.** The reference throws
`ReturnSignal`, `BreakSignal` and `ContinueSignal`. Here they are variants of
`Flow` travelling in the error half of a `Result`, so the type says which
statements produce which signals.

**Environments are `Rc<Environment>` chains**, exactly mirroring the
reference's scoping, including a fresh scope per loop iteration. That is what
makes closures capture what they capture there. It is also the obvious thing to
optimise later, and the reason the tight-loop benchmark is only 1.2x faster
than Node.

**Everything runs on a thread with a 64 MB stack.** A tree-walking interpreter
uses machine frames per Baa expression, and the default 1 MB stack runs out
well before the 512-call limit that is supposed to produce `BAA307`. Reaching a
diagnostic instead of a crash is the whole point of having a limit.

### Numbers

`number.rs` reimplements JavaScript's `Number::toString`, because that is what
the reference prints and `baa 1e21` must produce `1e+21` in both. Rust's `{}`
never switches to exponential notation and would print
`1000000000000000000000`. The shortest round-trip digits come from Rust's
`{:e}`; only the placement of the point is reimplemented.

### Diagnostics

`codes.rs` is generated from `src/diagnostics/codes.ts` by
`tools/gen-native-codes.ts`, and `npm run gen:check` fails if it is stale. The
sentence a native application prints for `BAA302` is therefore the sentence
`baa run` prints, by construction rather than by discipline. `BAA_NO_BAA` and
`CI` select the neutral wording here as they do in the CLI.

That last part has a consequence worth knowing before it surprises you: a
caught diagnostic's `message` is an ordinary string, so **the wording mode is
observable in a program's output**. `examples/errors.baa` catches a `BAA304`
and prints it, and prints a different sentence under `CI=true`. The conformance
suite records one wording, so `tools/native-conformance.ts` clears `CI` and
`BAA_NO_BAA` before running anything; without that the suite passes on a laptop
and fails in CI, which is the worst of both. A test asserts the neutral mode
still works, so the pinning cannot quietly become a way of hiding a broken
feature.

---

## The window model

`gui/mod.rs` owns a tree of widgets, works out where they go, and queues
events. It contains no Win32 and is unit-tested without a screen.

The tree is an arena addressed by index rather than `Rc<RefCell<..>>`: a widget
refers to its parent and its children, which is a cycle, and an arena is how
you have one of those in Rust without pretending you do not.

Layout is one top-down pass. Each container hands its children a rectangle;
each child takes its natural size or a share of the remainder in proportion to
its weight. Menus are filtered out before the space is shared, because the
operating system draws the menu bar itself.

`gui/win32.rs` implements the `Backend` trait. Two decisions in it are
load-bearing:

**Nothing calls Baa from inside a window procedure.** A `WndProc` is called by
Windows from inside `DispatchMessageW`, at a point where the interpreter is
already borrowed. Running a handler there would be re-entrancy, and in Rust a
borrow that cannot be proven safe. So the procedure records what happened, and
the event loop runs handlers afterwards with nothing else in progress.

**The window procedure reaches the tree through a thread-local pointer**, set
for exactly as long as a message is being dispatched and null at every other
moment.

Control ids are the widget index plus one, passed as `CreateWindowExW`'s
`hMenu` argument and as a menu item's command id. So `WM_COMMAND` identifies
the widget with no lookup table, and a menu item and a button reach the same
code.

---

## Testing it

```bash
cargo test --manifest-path rust/Cargo.toml   # units: numbers, JSON, layout, paths
node tools/native-conformance.ts --verbose   # the conformance suite
node --test tests/native.test.ts             # drift guards, the bundler, the runtime
node tools/bench-native.ts                   # measurements
```

The conformance run is the one that matters. It executes the same programs the
reference implementation is tested against and compares stdout byte for byte.
All 63 run and all 63 pass. The harness still knows how to skip a program that
imports a module the runtime lacks — `gate` is the only one left — and reports a
skip as a skip rather than counting it as a pass, because a program the runtime
declined to run is not evidence that it can.

`tests/native.test.ts` also compares the lists that exist in both languages —
which modules there are, what `barn` provides, each function's arity, the image
format's version — so a name added on one side and forgotten on the other fails
a test rather than a user. Those tests need no Rust toolchain; the ones that
run programs skip with a stated reason when the runtime is not built.

`tools/drive-window.ps1` drives a real application through Win32: it finds the
controls, clicks buttons by their caption, and reads back what the window says.

---

## Adding a platform

Implement `Backend`: create a window, sync changed widgets, pump one event,
close, plus message boxes, file dialogs and the clipboard. Nothing in
`gui/mod.rs`, in `barn`, or anywhere in `src/` needs to change.

The honest scale of the job is that the Windows backend is 878 lines, and most
of that is constants, struct layouts and `extern` declarations rather than
logic.
