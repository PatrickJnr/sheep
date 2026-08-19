# Roadmap

What Baa is today, what is being built next, and what has been considered and
left out. Checked against the repository on 2026-08-19; every claim below is
either checked by CI or marked as unbuilt.

Baa follows semantic versioning from 1.0. Before then, minor versions may
change the language; every change appears in [CHANGELOG.md](CHANGELOG.md) with
a migration note.

**How to read this.** The first half is ordered by *when*: what is done, what is
being worked on, what comes next. The second half is ordered by *area*, for
when you want the state of one subsystem rather than a schedule. Milestones
carry a status label:

| Label | Means |
| --- | --- |
| **COMPLETED** | Shipped, tested, documented. |
| **IN PROGRESS** | Code exists in the repository and is not finished. |
| **NEXT** | Chosen, specified, not started. |
| **PLANNED** | Agreed as worth doing, not yet scheduled or specified. |
| **RESEARCH** | Not known to be a good idea yet. An answer is needed before a plan. |
| **BLOCKED** | Waiting on something outside the repository. |

---

## Current State

Version **0.8.0**. The reference implementation is TypeScript running on
Node.js 22.18+ with no build step and no runtime dependencies; the native
runtime is Rust with no dependencies either.

| | |
| --- | --- |
| Automated tests | 700+, across Windows, Linux and macOS on every commit |
| Diagnostics | 48 `BAAnnn` codes, each with a default and a professional wording |
| Standard library | 9 modules |
| Conformance suite | 63 programs pinned to exact output, 27 pinned to diagnostic codes |
| Native runtime conformance | All 63 conformance programs, byte for byte, none skipped |
| Executable targets | Windows x86-64, with an icon and version metadata |
| Runtime dependencies | None, on either implementation |

**Baa runs in two places, and a file's imports decide which.** A file that
imports `gate` is a web page, executed per request under CGI. A file that
imports `barn` is a native application, built into one Windows executable. A
file that imports neither is an ordinary module and works in both. `.baa` is
one language with two hosts; it is not an executable format, and `baa app
build` does not turn a source file into an `.exe` — it writes a resolved tree
into an image and appends that image to a runtime.

**What is not built, stated plainly.** There is no browser runtime and no DOM.
There is no package registry. There is no bytecode VM. There is no static type
system. Native applications run on Windows only. Each of these appears below
with its status.

---

## Recently Completed

### Native application platform — **COMPLETED** in 0.4.0

**Goal.** Let a Baa program open a real window and ship as one executable,
without changing what `.baa` means.

**Why it matters.** Baa could produce web pages and command-line programs and
nothing a person double-clicks. Doing it by wrapping a browser would have made
the claim true and the artefact dishonest.

**Delivered.**

- `rust/crates/baa-native`: a Rust tree-walking interpreter with no
  dependencies, including its own JSON parser and its own Win32 declarations.
- The `.fleece` image format, and a build that appends the image to the runtime
  binary. No linker and no compiler on the developer's machine, no Node.js on
  the user's.
- `baa app new | build | run | test`.
- `barn`, the ninth standard-library module: windows, rows and columns with
  weights, labels, buttons, inputs, text areas, lists, checkboxes, a menu bar,
  message boxes, file dialogs, the clipboard, per-monitor DPI.
- Three applications that are also the tests: a calculator that imports the
  *web* calculator's arithmetic module unchanged, a text editor, and a JSON
  viewer. All three are driven through real Win32 messages by the suite.
- Documentation, an architecture record, and `tools/bench-native.ts` so the
  performance claims can be checked rather than believed.

**Definition of done — met.** Applications build and run on a machine with no
toolchain; the conformance harness runs the suite against the native runtime in
CI; every documented `barn` function has a test that drives a real window.

### `shepherd` and `meadow` in the native runtime — **COMPLETED** in 0.5.0

**Goal.** Give native applications arguments, environment variables, standard
input, subprocesses, clocks, calendars and randomness.

**Why it matters.** It was the largest gap between the two runtimes. An
application could not read its own command line, know what time it was, or
shuffle a list, and it was the reason one conformance program was skipped
rather than run.

**Delivered.** Both modules in Rust, function for function and arity for
arity, with the calendar arithmetic written out rather than pulled in so the
zero-dependency rule holds. `shepherd.run` starts a process without ever
building a command line, exactly as the reference does. A drift guard now
compares *every* native module's functions and arities against the reference,
not just `barn`'s.

**Definition of done — met.** `node tools/native-conformance.ts` reports 50 of
50, with nothing skipped, and a built application reads `shepherd.args()`.

One thing is deliberately absent rather than approximated:
`meadow.parse_iso` on a date-time with no zone. JavaScript reads it as local
time, so the same program would produce different numbers on different
machines; the native runtime raises `BAA301` naming the fix instead of guessing
an offset.

### A VS Code language client — **COMPLETED** in 0.6.0

**Goal.** Make the language server that already exists start automatically in
the editor most people use.

**Why it matters.** `baa lsp` had provided diagnostics, formatting, an outline,
hover, go-to-definition, find-references and rename for two releases, driven by
the same analysis the compiler runs, and the VS Code extension was declarative
— so the best tooling Baa has was invisible to most of its users.

**Delivered.** `editors/vscode/src/extension.ts` starts `baa lsp` and connects
VS Code to it. It registers no providers of its own, and a test asserts that:
a second opinion about what a program means is worse than no opinion. The
`.vsix` is built by CI and attached to each release, and the extension is
published to the marketplace as `baa-lang.baa-lang` — by the release workflow
itself, which publishes when a `VSCE_PAT` secret is present and skips silently
when the version is already on the marketplace, so a release is one tag.

**Definition of done — met, and verified rather than assumed.** An integration
test launches a real VS Code, loads the extension, opens a `.baa` file and
asserts that `BAA102` arrives on the right range, that formatting returns
edits, and that go-to-definition lands on the declaration.

That test earned itself immediately. On Windows `npm install -g` writes
`baa.cmd`, and since CVE-2024-27980 Node refuses to spawn a `.cmd` without a
shell — so the obvious implementation found nothing on the platform most
people use, and failed silently. Reaching for `shell: true` would have been
re-opening the vulnerability; the extension resolves the JavaScript entry npm
installed beside the shim instead, and runs it under the editor's own Node.

### Prebuilt native runtimes — **COMPLETED** in 0.7.0

**Goal.** Building a desktop application should not require installing Rust.

**Delivered.** Every release publishes `baa-native-windows-x64.tar.gz` and
`baa-native-linux-x64.tar.gz`, each with a `sha256`. `baa app build` searches
`~/.baa/runtime` before any checkout, so a downloaded runtime cannot be
shadowed by a stale `cargo build`, and names the archive for the running
platform when it finds none.

**Definition of done — met, and verified by doing it.** With the CLI installed
from npm and the runtime downloaded and checksum-verified, `baa app build`
produced a working 736 KB executable on a machine with no Rust toolchain
involved in the build.

**What is not done.** The runtime is not yet *inside* the npm package as an
`optionalDependencies` entry, so the download is a manual step rather than
something `npm install -g baa-lang` arranges.

### Structured diagnostics, incremental checking and capabilities — **COMPLETED** in 0.8.0

**Delivered.** Three tooling milestones that had been queued since 0.5.0.

`--format json` on `check`, `lint` and `fmt` writes one JSON object to stdout:
code, severity, both wordings, file, range, notes, help and trace. It renders
the same `Diagnostic` values the terminal renders, so it cannot report a
problem the terminal would not. `run` and `test` refuse it, because stdout
belongs to the program there. The schema is in
[docs/diagnostics-json.md](docs/diagnostics-json.md).

`baa fmt --diff` prints a unified diff of what formatting would change and
exits exactly like `--check`. `baa check --watch` re-checks only what changed:
92 ms cold on a 200-file project, 12 ms after one edit. There is no dependency
graph, because Baa's analysis is per-file and a graph would always report no
dependents; `baa.toml` is the exception and drops the whole cache.

`baa run` and `baa test` take `--deny-fs`, `--deny-fs-write`, `--deny-env`,
`--deny-process` and `--allow-fs <dir>`, which wrap the host rather than
auditing the library. `--allow-fs` confines instead of refusing: a path is
resolved and then followed to its real location, so neither `..` nor a link can
climb out of an allowed directory. That
audit found a hole worth the milestone on its own: `shepherd.run` was calling
`child_process` directly, so the most dangerous operation in the language was
the one operation the capability boundary could not see.

### Resolved variable slots — **COMPLETED** in 0.8.0

**Delivered.** The resolver records where each name lives — how many scopes out
and which position — and the interpreter reads it by index instead of hashing
it. `Environment` keeps its bindings in declaration order; a scope past eight
names builds a `Map`, which is what keeps the prelude off a linear scan.

The slot carries the name it was resolved from and is checked before it is
trusted, so a disagreement between the resolver and the interpreter falls back
to the name walk rather than reading the wrong binding. `slotStats.misses`
counts those fallbacks and a test asserts it stays at zero.

**Measured**, back to back on one machine, best of three: 300k loop iterations
56.0 ms to 46.6 ms, `map`/`filter`/`sum` 42.1 ms to 36.1 ms, `fib(22)`
unchanged within noise, because a call defines its parameters and that
bookkeeping offsets what its lookups save.

### Application icons and version metadata — **COMPLETED** in 0.8.0

**Delivered.** A built `.exe` shows its icon in Explorer and fills in the
Details tab of its Properties. Both live in a PE resource section, which the
appending build has no linker to produce, so `src/native/resources.ts` writes
one: a section header after the last, the bytes at the end of the file, three
numbers corrected in the headers. It refuses — rather than guessing — on a file
that is not a PE, a section table with no room, or an image already appended.

**Definition of done — met, and verified through Windows rather than through
the writer.** A test reads the version back with `FileVersionInfo` and counts
the icons with `ExtractIconEx`. That is what caught the first icon group being
eighteen bytes per image instead of fourteen: Windows stored it without
complaint and made no icon from it.

### `baa doc` — **COMPLETED** in 0.8.0

**Delivered.** `baa doc [paths]` writes a Markdown reference for everything the
given files export, from the `///` comments the parser already keeps for the
language server's hovers. `--out` writes a file, `--check` fails when that file
is stale, and the output is deterministic so `--check` in CI means something.

**The definition of done changed, and this is why.** It used to say the
standard-library page would be produced by `baa doc` rather than by a bespoke
tool. It cannot be: those functions are implemented in the interpreter, not
written in Baa, so there is no `.baa` source to read. Keeping the old target
would have meant either teaching `baa doc` to introspect the interpreter — a
second, stranger tool wearing the same name — or moving the standard library
into Baa, which is a different project. `tools/gen-docs.ts` keeps that page;
`baa doc` gives everyone else's code the same treatment.

### Timers in `barn` — **COMPLETED** in 0.8.0

**Delivered.** `barn.every`, `barn.after` and `barn.cancel`. Ticks arrive on
the event loop in the same single thread as every other handler, so nothing
runs in parallel with the program and there is no second concurrency model.
`examples/native/clock` is a stopwatch built on them.

**Definition of done — met.** The model is unit-tested without a screen, and an
end-to-end test drives the real event loop on a real window: three ticks, a
cancel from inside the handler, and a one-shot that quits.

One thing was learned the hard way and is written into the code. `SetTimer`
with a window keeps the id it is given; with no window it assigns its own and
ignores yours, so a timer set before `barn.show` fired `WM_TIMER` messages
carrying a number the runtime had never heard of. The backend maps the two.

### Regular expressions in the native runtime — **COMPLETED** in 0.8.0

**Delivered.** An engine, written for the purpose: a parser, a backtracking
virtual machine, and a subset written into [SPEC.md](SPEC.md#71-patterns)
rather than left to whatever the implementation happened to do. The five
`wool` functions that needed one now work natively.

Backtracking, not a Thompson simulation, because JavaScript's answers depend on
it: alternation is leftmost-first, so `a|ab` matches `a` in `abc`, and a greedy
quantifier gives characters back one at a time. An engine immune to blow-up
would return different matches.

**The trap this milestone was mostly about.** A near-miss reimplementation is
worse than an absence: a pattern that quietly means something different is a
bug that survives review. So lookahead, lookbehind, backreferences and
`\p{...}` are refused by name with `BAA314`, and a pattern that would run for
ever is abandoned with the same code — JavaScript hangs there, and saying so is
better than either hanging or lying.

**Definition of done — met.** Thirteen pattern programs are in the conformance
suite, so both runtimes are held to byte-identical output on greedy and lazy
quantifiers, named groups, empty matches, `$&` and `$1` replacements, flags,
boundaries and classes. 63 of 63 programs pass natively.

### Standard-library growth — **COMPLETED** in 0.8.0

**Delivered.** Nine functions, in both runtimes. `pasture.walk`, `glob` and
`matches`; `flock.union`, `intersect`, `difference` and `is_subset`;
`meadow.duration` and `format_duration`, plus a UTC offset argument on
`meadow.parts` and `meadow.iso`.

The glob subset is `?`, `*` and `**` and nothing else, written into
`docs/stdlib.md` rather than left to whatever a regular expression happened to
do. There are no time-zone *names*: an offset is a fact about an instant, while
a zone name is a rule that changes twice a year and needs a database shipping
updates.

### Documentation for language models — **COMPLETED**

`/llms.txt` and `/llms-full.txt`, generated by `tools/gen-llms.ts` from the same
catalogue the compiler uses. Every signature in them exists, the examples are
compiled by the test suite, and `npm run gen:check` fails when the published
copy drifts.

### Web-page modules are no longer served as source — **COMPLETED**

A `.baa` module a CGI handler could not execute answered with a 500 that leaked
the server's absolute path. Modules now deploy as `.baalib`, which the handler
does not claim and `.htaccess` refuses outright.

---

## In Progress

### Rust track: the frontend half — **IN PROGRESS**, open for contributors

The runtime half exists and is used by every built application. The frontend
half — lexer, parser, resolver, formatter, linter, CLI — does not, and
deliberately: the reference implementation analyses a program and hands the
runtime a resolved tree, so there is exactly one frontend and it cannot
disagree with itself.

A conformant `baa run` written entirely in Rust remains an open milestone for
anyone who wants a single self-contained binary. Whoever takes it starts with a
working runtime and a conformance harness that already runs. Open an issue
tagged `rust` naming the crate you are taking, so nobody writes the lexer twice.

The material a second implementation needs is kept fresh by CI:

- [`SPEC.md`](SPEC.md): the complete language definition, with grammar
- [`tests/conformance/suite.json`](tests/conformance/suite.json): 63 programs
  with their exact output, and 27 with the diagnostic codes they must report
- [`tests/conformance/diagnostics.json`](tests/conformance/diagnostics.json):
  all 48 diagnostics, both wordings, ready to embed
- [`rust/README.md`](rust/README.md): crate layout, suggested order of work,
  and the design notes worth carrying over

**Definition of done.** `cargo run -- program.baa` passes both halves of the
conformance suite: 63 programs byte for byte, and 27 diagnostic programs with
matching codes.

---

## Immediate Next

### 1. A Linux backend for `barn` — **NEXT**

The window model in `gui/mod.rs` has no Win32 in it and is unit-tested without
a screen; `gui/win32.rs` is one implementation of a `Backend` trait. On Linux,
`barn.show` reports that there is no backend rather than pretending. GTK
through its C ABI would keep the zero-dependency rule, at the cost of
hand-declaring another platform's functions — the Windows backend is 878 lines,
which is the honest scale of the job.

**Definition of done.** The three example applications build and run on Linux,
and the smoke tests drive them there.

**Why it is still here.** Not because it is large, though it is: because it
cannot be *verified* from a Windows machine, and a GTK backend written blind is
a few hundred lines of foreign-function declarations nobody has watched open a
window. It wants a Linux machine with a display, or a CI job running Xvfb, set
up before the first line is written.

---

## Near Term

| Milestone | Status | Definition of done |
| --- | --- | --- |
| **`[wool]` dependencies inside a bundle.** Manifest dependencies are refused today rather than bundled. | PLANNED | A manifest dependency is bundled deterministically, or refused with a reason. |
| **Calendar arithmetic in `meadow`.** Adding and subtracting amounts, not only formatting them. | PLANNED | Each function exists in both runtimes, with tests. |

---

## Medium Term

### A table control in `barn` — **PLANNED**

Rows, columns, headers, selection and scrolling. It waits for an application
that needs one, so the API is shaped by a real use rather than guessed: a small
useful table beats an enormous data grid nobody asked for. (Timers, which used
to share this entry, are now an Immediate Next.)

### `[wool]` dependencies inside a bundle — **PLANNED**

Relative imports are bundled into an application image. Manifest dependencies
are refused with a message rather than half-supported.

---

## Long Term

### Bytecode compiler and VM — **PLANNED**

See [ARCHITECTURE.md](ARCHITECTURE.md#path-to-a-bytecode-vm). To be built
alongside the tree-walker, with both tested against the same programs, not
dropped in as a replacement.

There is a measurement to argue from. `node tools/bench-native.ts` puts the
native tree-walker 1.2x ahead of Node on a tight loop and 10x ahead on process
start: almost all of the win is starting up, and none of it is the interpreter
being cleverer, because it is the same algorithm in a different language. A
bytecode VM is where the interpreter itself would get faster. Resolved variable
slots are the prerequisite.

### A package registry — **BLOCKED**

The blocker is not code, it is operations: naming, publishing, verification,
revocation, supply-chain integrity, and who pays for the bandwidth. Until that
has an answer, `baa add` says so instead of pretending. Local path dependencies
work today and cover the "split this project in two" case that most people
actually have.

### Signed releases and reproducible builds — **PLANNED**

npm provenance is already in place for the published package. Extending that to
the native runtime binaries depends on the release workflow that ships them.

### A standard-library RFC process — **PLANNED**

So the small core stays small on purpose rather than by neglect.

---

## By area

### Native applications

**State: shipped for Windows, 0.4.0.** One executable, a real window, no
browser and no wrapper. Three example applications are the tests. Since 0.8.0 a
built executable carries its own icon and version metadata, written into the PE
without a linker.

Timers landed in 0.8.0, so an application can do something while nobody is
clicking.

Queued: [a Linux backend](#1-a-linux-backend-for-barn--next), [a table
control](#a-table-control-in-barn--planned), and putting the runtime inside the
npm package so the download stops being a manual step.

Not planned: a browser-based application model. If a Baa program should run in
a browser, it should be a web page, which is what `gate` is for.

### Web platform

**State: shipped and in use.** A `.baa` file that imports `gate` is executed
per request under CGI, reads the request and writes the reply, and runs on
ordinary shared hosting with no daemon and no Node.js process to supervise.
`baa serve` runs the same programs locally over HTTP.

Provided: request line, headers, query, form and JSON bodies, cookies, status
and header control, HTML escaping by default, `wool.safe_url` and
`wool.escape_html` for the cases that need it, and file-backed state.

Not provided, deliberately: a browser runtime, a DOM API, client-side Baa, a
router, a template language, or a long-lived server process. Pages compose with
functions and string interpolation; state lives in files or cookies. See
[docs/web-applications.md](docs/web-applications.md).

Queued: nothing structural. The web model is considered complete for what it
sets out to do; work here is standard-library growth and documentation.

### Language

**State: stable enough to be worth breaking rarely.** Bindings, functions with
defaults and rest parameters, closures, arrays, maps, ranges, `if`/`while`/
`for`, `match` with alternatives, guards and structural patterns,
`try`/`catch`/`finally`, `throw`, string interpolation, modules with named
imports, aliases and cycles.

The last language change was in 0.4.0: a newline inside `{` ends a statement
again, even inside `(`. SPEC.md §2.2 records the rule.

Queued: nothing. New syntax needs a program that is awkward to write without
it, attached to an issue. See
[deliberately not planned](#deliberately-not-planned).

### Runtime

**State: two tree-walking interpreters that agree.** The TypeScript one is the
reference; the Rust one runs a resolved tree the reference hands it and is
checked against the same conformance suite.

Resolved variable slots landed in 0.8.0, in the reference only: the image
format carries no slots and the native runtime still looks names up, so the two
cannot disagree about scope rules on account of it.

Queued: a [bytecode VM](#bytecode-compiler-and-vm--planned), to be built with
the tree-walker still present and still tested.

### Tooling

**State: `run`, `check`, `test`, `fmt`, `lint`, `serve`, `lsp`, `repl`, `init`,
`build`, `app`, `add`, `remove`, `doctor`, `modules`, `version`.** The formatter
is deterministic and preserves comments; the linter has six rules and an escape
hatch; the language server is around 470 lines with no dependencies and reads
the resolver's symbol table rather than a second copy of the analysis.
`check`, `lint` and `fmt` speak JSON; `check` watches; `fmt` diffs.

Queued: nothing. Every command the roadmap asked for exists.

### Standard library

**State: 9 modules** — `wool`, `flock`, `ram`, `meadow`, `pasture`, `shepherd`,
`lamb`, `gate`, `barn`. Small on purpose. Every function is documented from the
implementation, so the reference cannot drift from the code.

Native availability today: everything except `gate`, which is refused in an
application by design. Since 0.8.0 that includes patterns: the native runtime
has its own regular-expression engine, over the subset SPEC.md defines.

0.8.0 added `pasture.walk`, `glob` and `matches`, `flock`'s set operations, and
`meadow`'s durations and UTC offsets — in both runtimes, as the drift guard
insists.

Queued: calendar arithmetic in `meadow`.

### Developer experience

**State: no build step, no dependencies to install, `npm test` runs
everything.** Diagnostics carry a code, a span, a note and usually a fix, in two
wordings. The playground runs the real interpreter in the browser.

Since 0.8.0, `check`, `lint` and `fmt` can report as JSON, `check --watch`
re-checks only what changed, and `fmt --diff` shows what it would change
without changing it.

`baa doc` publishes a reference for a project's own exports, from its `///`
comments.

Queued: nothing pressing. The next sore point is whichever one a user names.

### Cross-platform

**State, stated plainly.** The language, CLI and web platform run wherever
Node.js 22.18+ runs, and CI proves it on Windows, Linux and macOS every commit.
Native applications are Windows x86-64 only. The window model is
platform-independent and tested without a screen, so a second backend is work
rather than a rewrite, but until one exists Baa is not a cross-platform
application platform and this document will not call it one.

Queued: [a Linux backend](#1-a-linux-backend-for-barn--next). macOS would need
a third backend against Cocoa and has no volunteer; it is not scheduled.

### Performance

**State: measured, not asserted.** `npm run bench` covers the front end and the
reference runtime; `npm run bench:native` compares the two runtimes. The native
runtime starts about 10x faster and runs a tight loop about 1.2x faster —
almost all of the win is process start, because it is the same algorithm in a
different language.

Resolved variable slots landed in 0.8.0: reading a local is an array index,
worth about 17% on loop-heavy code and nothing measurable on calls.

Queued: a bytecode VM, then inline caches and constant folding. Ordered that
way because each is the prerequisite for the next being worth measuring.

### Security

**State: one capability surface.** Every filesystem, clock, randomness,
environment and process operation goes through `RuntimeHost`
(`src/runtime/host.ts`), so an audit is a single file. `shepherd.run` never uses
a shell: a program that wants one has to name it, which puts the decision in the
source and in review. `gate` escapes by default. See [SECURITY.md](SECURITY.md).

`baa run` and `baa test` can give a program less than they have:
`--deny-fs`, `--deny-fs-write`, `--deny-env` and `--deny-process` wrap the host,
and a denied operation is `BAA313` where it happens. Capability reduction, not
a sandbox — SECURITY.md says which is which.

`--allow-fs` confines a run to named directories, judging a path by where it
leads rather than by how it is written.

Queued: signed native-runtime binaries alongside the release workflow that
ships them.

### Testing

**State: 644 automated tests**, plus Baa's own `test` blocks, recorded example
transcripts, a conformance suite of 63 programs and 27 diagnostic programs, and
smoke tests that drive all three native applications through real Win32
messages.

The rule the suite is built on: a claim in the documentation should be checked
by a test, not maintained by hand. Counts, module lists, generated files, site
links and the examples in `llms-full.txt` all have guards, because each of them
has drifted at least once.

Queued: a Linux path for the native smoke tests, once there is a Linux backend
for them to drive.

### Documentation

**State: generated where it can be.** The standard-library reference, the
diagnostic catalogue, the conformance suite, the native diagnostic codes, the
site and both `llms` files are generated from the implementation, and
`npm run gen:check` fails when a published copy is stale.

Queued: `baa doc`, so the generation is a Baa command rather than a script in
`tools/`.

### Open research

- **Ahead-of-time native compilation** — **RESEARCH.** Baa is dynamically
  typed, so native code needs type feedback or a type system. The question is
  which, and whether the answer is worth the language it would produce.
- **A gradual `--strict` type mode** — **RESEARCH.** More interesting than a
  full static type system and much less certain. It needs a design before it
  needs a schedule.
- **Self-hosting** — **RESEARCH.** Writing Baa's lexer in Baa is a good test of
  whether the language is pleasant at scale and a bad way to ship a compiler.
  Worth doing as an exercise, not as the plan.

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
| A browser runtime | Baa on the client would be a second, worse JavaScript. `gate` renders on the server; the browser gets HTML. |
| An Electron-style application shell | A browser tab shipped as an `.exe` is not a native application. `barn` draws real windows instead. |

## How to influence this

Open an issue describing the *problem*, not the feature. The most useful thing
you can attach is a real program that is awkward to write today. See
[CONTRIBUTING.md](CONTRIBUTING.md).
