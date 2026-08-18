# Native applications

Baa runs in two places. It always has done one of them: a `.baa` file is a web
page, executed by a server per request, and that is what `gate`, `baa serve`
and [the live example](https://sheep.grimtech.co.uk/baa/index.baa) are.

This is the other one. The same language, the same files, held open by a
runtime that draws a window instead of writing a reply.

```bash
baa app new pen_counter
cd pen_counter
baa app run          # a window
baa app build        # build/pen_counter.exe
```

The result is one executable. It does not need Node.js, it does not unpack
anything, and it is not a browser: it creates a Win32 window and fills it with
the controls Windows already has.

---

## What did *not* change

`.baa` still means what it meant. There is no second extension, no desktop
dialect and no `#[native]` marker. A file is a native application when it
imports `barn` and asks for a window, in the same way a file is a web page when
it imports `gate` and writes a reply. Everything else — the syntax, the
standard library, `baa check`, `baa fmt`, `baa test`, the language server — is
the same tooling doing the same job.

The clearest demonstration is
[`examples/native/calculator/`](https://github.com/PatrickJnr/sheep/tree/HEAD/examples/native/calculator).
Its arithmetic is `examples/apps/calculator/expression.baa`, imported
unchanged: the same tokeniser and precedence-climbing parser that powers the
web calculator, with the same tests. One module, two front ends, because it
imports neither `gate` nor `barn` and therefore belongs to neither.

That is the shape worth copying. Put the part that can be wrong in a module
with no window in it, and the window becomes the small part.

---

## How it works

```
  main.baa ──┐
             │   baa app build
  logic.baa ─┤   ───────────────►   MyApp.exe
             │                      ├── the native runtime (Rust)
  barn ──────┘                      └── your program, as a .fleece image
```

**The reference implementation is still the only frontend.** `baa app build`
lexes, parses and resolves your program with exactly the code `baa check` uses,
then writes the resolved tree into a binary `.fleece` image. A build that would
not pass `baa check` produces no executable.

**The native runtime walks that tree.** It is a Rust program of about 8,400
lines with no dependencies, and it is a port of the same tree-walking
interpreter, kept close enough that both agree on the conformance suite.

**The executable is the runtime with the image appended to it.** Building an
application copies a file and adds bytes to the end of it, so it needs no
linker and no compiler on your machine.

Three consequences are worth knowing:

- There is **no parser in a shipped application**, and no module lookup at
  runtime. A built program cannot be redirected by a `.baa` file dropped next
  to it.
- Startup does no parsing, so it is fast: see [the measurements](#speed).
- The image is **not encryption**. Anyone can read the strings in your
  program, exactly as they can in a Python or JavaScript application. Do not
  put a secret in one.

Why a tree and not bytecode, and why Rust rather than the alternatives, is
argued in [ARCHITECTURE.md](../ARCHITECTURE.md#native-applications).

---

## What works today

Verified by driving real applications through Win32 — the tests send the
messages a click actually is, and read back what the window says.

| | |
| --- | --- |
| Windows | Real `CreateWindowExW` windows, resizable, with the system's own controls |
| Controls | Labels, buttons, single-line inputs, multi-line editors, lists, checkboxes |
| Layout | Rows and columns with weights, padding and spacing, recomputed on every resize |
| Menus | A real menu bar with menus, items and separators |
| Events | Click, change, select, toggle, close |
| Dialogs | Message boxes, confirmations, open-file and save-file dialogs |
| Clipboard | Read and write |
| High DPI | Per-monitor v2, so text is sharp on a scaled display rather than stretched |
| Keyboard | Tab order, and every control's own keyboard behaviour |

The standard library available to an application is `barn`, `flock`, `lamb`,
`pasture`, `ram` and `wool`. Importing anything else is a **build** error
naming the module, not a surprise at runtime.

## What does not work yet

Stated plainly, because a gap nobody wrote down is indistinguishable from a
bug.

| Not available | Why, and what to do |
| --- | --- |
| `gate` | It serves web pages over CGI. Native applications draw windows: use `barn`. This one is not a gap, it is the boundary. |
| `shepherd`, `meadow` | Not ported yet. Arguments, environment, subprocesses, clocks and seeded randomness are unavailable in an application. |
| `wool.matches`, `find`, `find_all`, `substitute`, `split_on` | These need a regular-expression engine. Calling one reports that. The other twenty `wool` functions work; for fixed text use `text.contains`, `text.replace_all` or `text.split`. |
| Linux and macOS | The window model is platform-independent and has no Win32 in it, but only the Windows backend exists. `barn.show` on another platform says so rather than doing nothing. |
| An application icon | The executable carries the runtime's icon. Changing it needs a PE resource rewrite, which the appending build deliberately avoids. |
| Timers, images, sound, networking | Not built. No application has needed them yet, and an API with no use case is worse than no API. |
| Tables, tabs, trees, custom drawing | The control set is the one the example applications needed. |
| A runtime in the npm package | `npm install -g baa-lang` gives you the language, not a compiled Rust binary for your platform. Building applications means cloning the repository once; `baa app build` says so and `baa doctor` reports it. |

Everything in that table is also in [ROADMAP.md](../ROADMAP.md), which is where
it will move from when it changes.

---

## The trust boundary

A native application is an ordinary process with the permissions of whoever
runs it. There is no sandbox, and pretending otherwise would be worse than
saying so plainly.

What the runtime does guarantee is narrower, and exact:

- **No shell, anywhere.** Nothing in the native runtime builds a command line
  or starts a process. `shepherd`, which can run programs in the reference
  implementation, is not in the native runtime at all, so there is no command
  injection to have.
- **No code loading at runtime.** No `eval`, no FFI, no plugin mechanism, no
  dynamic library loading. What an application can execute is fixed when it is
  built.
- **No path is reinterpreted.** `pasture` passes a path to the operating
  system as given. `..` is not blocked, because a text editor legitimately
  needs it and a block that can be walked around is a false comfort.
- **The image is treated as untrusted input.** Every read is bounds-checked
  and a malformed image is refused with a reason, because those bytes are
  whatever is on the end of the file.
- **Every failure is a diagnostic.** A native application reports `BAA302` with
  the same sentence `baa run` uses, because the catalogue is generated from the
  reference implementation rather than retyped.

The practical advice is the same as for any desktop program: an application
that reads a file the person chose in a dialog is doing what they asked; one
that reads their home directory is not, and nothing here will stop it. See
[SECURITY.md](../SECURITY.md).

---

## Speed

Measured with `node tools/bench-native.ts`, which runs the same programs on
both runtimes. Median of seven runs on one Windows 11 machine, in
milliseconds, whole process each time, because process start is what somebody
waits for when they open an application:

```
                                       node    native   ratio
start up and print one line           194     19       10.3x
one million loop iterations           372     309      1.2x
two hundred thousand function calls   408     164      2.5x
build and sort fifty thousand items   393     123      3.2x
encode and decode a megabyte of JSON  309     106      2.9x

runtime 619 KB, image for a one-line program 114 bytes
building the calculator: 255 ms
```

Read that carefully rather than as a scoreboard.

- **Startup is the real difference**, and it is the one that matters for an
  application: a window that appears immediately feels native and one that
  appears after a beat does not. Most of the 194 ms is Node starting and
  type-stripping the CLI's TypeScript; running the published build is faster
  than this figure, and still not 19 ms.
- **Throughput is comparable**, and deliberately so. Both are tree-walking
  interpreters with the same environment-chain semantics. The 1.2x on a tight
  loop is the honest picture of what porting an interpreter buys: not much,
  because the algorithm is the same.
- Neither is a match for a compiled language, and nothing here claims
  otherwise. A bytecode VM is the next real step and is on
  [ROADMAP.md](../ROADMAP.md), where it belongs until there is a measurement
  asking for it. This is that measurement's starting line.
- **Build time is dominated by Node**, not by the appending: 255 ms for the
  calculator, with no compiler or linker involved at all.

Run it on your own machine before believing any of it.

---

## Reading on

- [gui.md](gui.md) — every `barn` function
- [application-projects.md](application-projects.md) — the manifest and the project layout
- [building-windows-apps.md](building-windows-apps.md) — building, shipping and what to check
- [native-runtime.md](native-runtime.md) — the image format and the runtime's insides
- [web.md](web.md) — the other half of Baa, unchanged
