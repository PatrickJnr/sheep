# CLI reference

`baa` is one executable with a handful of subcommands. It starts fast, writes
diagnostics to stderr and everything else to stdout, and never asks a question
it cannot answer itself: which makes it safe to run unattended in CI.

```
baa <command> [options]
```

Install it with `npm install -g baa-lang`, or run a single command without
installing anything using `npx baa-lang <command>`. It needs Node.js 22.18 or
newer and nothing else.

---

## Global options

| Option | Effect |
| --- | --- |
| `--no-baa` | Neutral diagnostic wording. Codes and spans are unchanged. |
| `--color` / `--no-color` | Force colour on or off. |
| `--quiet`, `-q` | Print less. Diagnostics still appear. |
| `--help`, `-h` | Help for the command, or for `baa` itself. |
| `--version`, `-V` | Print the version and exit. |

Environment variables:

| Variable | Effect |
| --- | --- |
| `NO_COLOR` | Any non-empty value disables colour. |
| `FORCE_COLOR=1` | Enables colour even when stdout is not a terminal. |
| `BAA_NO_BAA` | Any non-empty value turns on professional wording. |
| `CI` | Any non-empty value disables colour *and* the sheep wording. |

The `CI` default is deliberate: a failing build should read like a compiler.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The program failed, or a check found errors |
| `2` | The command line was wrong |
| *n* | The program called `exit(n)` |
| `70` | An internal error in Baa, please report it |

---

## `baa run`

```
baa run [file] [--seed <n>] [--max-depth <n>] [-- program args...]
```

Executes a program. With no file, runs the `entry` from the nearest `baa.toml`.

Everything after `--` is passed to the program and read with
`shepherd.args()`: it is never interpreted by `baa` itself.

| Option | Effect |
| --- | --- |
| `--seed <n>` | Seed `meadow`'s randomness. Same seed, same run. |
| `--max-depth <n>` | Call-depth limit before `BAA307`. Default 512. |

```bash
baa run hello.baa
baa run                          # the project entry point
baa run report.baa -- --format json
baa run --seed 42 simulation.baa
```

### Running a file without saying `run`

`baa hello.baa` runs it, the way `python x.py` does. A first argument ending in
`.baa`, or naming something that exists, is treated as a program; anything else
is still read as a command, so a mistyped `baa buidl` gets the command list
rather than a complaint about a missing file.

This is what makes a shebang work, and it is not only a convenience. A page
executed by the kernel arrives as `baa /path/to/page.baa`, because the script
is appended to the interpreter's arguments:

```baa
#!/usr/bin/env baa
import gate

gate.html("<h1>Baa</h1>")
```

See [web.md](web.md) for serving pages this way, and for the live example.

## `baa check`

```
baa check [paths...]
```

Parses and analyses without executing. Directories are searched recursively for
`.baa` files, skipping `node_modules`, `.git`, `dist` and dotted directories.
With no paths, checks the project (or the current directory).

Exits `1` if anything failed to compile. This is the fastest way to validate a
change.

## `baa test`

```
baa test [paths...] [--filter <text>] [--seed <n>]
```

Runs every `test "name" { ... }` block found. With no paths, runs the `tests/`
directory when there is one, otherwise the whole project: so a test run does
not also execute your application.

| Option | Effect |
| --- | --- |
| `--filter <text>` | Only run tests whose name contains this text |
| `--seed <n>` | Seed `meadow`'s randomness |

```
$ baa test
tests/greetings_test.baa
  ok greets a sheep by name 0.2ms
  ok greets a whole flock 0.3ms

2 passed, 0 failed in 4ms
```

Exits `1` if any test fails.

## `baa fmt`

```
baa fmt [paths...] [--check] [--stdout] [--indent <n>] [--line-width <n>]
```

Formats files in place. The formatter is deterministic: the same AST always
produces the same bytes, and a second run changes nothing.

| Option | Effect |
| --- | --- |
| `--check` | Do not write. Exit `1` if anything would change. |
| `--stdout` | Write the result to stdout, leaving the file alone. |
| `--indent <n>` | Spaces per level. Default 4. |
| `--line-width <n>` | Soft maximum line width. Default 90. |

```bash
baa fmt .
baa fmt --check .        # in CI
baa fmt --stdout messy.baa | less
```

## `baa lint`

```
baa lint [paths...] [--deny-warnings] [--disable <code>]
```

Reports warnings: unused bindings, unused imports, unreachable code, constant
conditions, empty blocks, and `let` bindings that are never reassigned.

| Option | Effect |
| --- | --- |
| `--deny-warnings` | Exit `1` when any warning is reported |
| `--disable <code>` | Skip a rule. Repeatable. |

Prefixing a name with `_` silences the unused-name lints for it, which is
lighter than disabling the rule everywhere.

```bash
baa lint .
baa lint --deny-warnings --disable BAA905 .
```

## `baa serve`

```sh
baa serve [dir] [options]
```

Run a directory of `.baa` pages over HTTP, for development. Each request
executes the matching file in a fresh process with the CGI environment set,
which is what a real web server does, so a page that works here works on a
host. See [web.md](web.md).

| Option | Meaning |
| --- | --- |
| `--port <n>` | Port to listen on (default 8080) |
| `--host <address>` | Address to bind (default `127.0.0.1`) |

URLs map to files: `/` runs `index.baa`, `/about` runs `about.baa`, and both
`/sheep.baa/Shaun` and `/sheep/Shaun` run `sheep.baa` with `/Shaun` as the path
below the script. Anything else beside the pages is served as a static file.
Paths resolving outside the directory are refused.

Both spellings resolve because only one of them survives deployment: Apache
maps a URL to a file and will not invent the extension, so a link written as
`/sheep/Shaun` needs a rewrite rule on a real host while `/sheep.baa/Shaun`
does not.

Not for production: one process per request, a ten second limit per page, and
it binds to localhost unless told otherwise.

## `baa lsp`

```
baa lsp
```

Speaks the Language Server Protocol over stdin and stdout. Editors start this
themselves; there is rarely a reason to run it by hand. Full setup, with
working configuration for Neovim, Helix and Emacs, is in
[editors.md](editors.md).

| Provides | |
| --- | --- |
| Diagnostics | On open and on every change, errors and lint warnings together |
| Formatting | Whole document, refused when the file does not parse |
| Document symbols | Top-level functions, bindings, imports and tests |
| Hover | Signature and doc comment |
| Go to definition | The declaration a name binds to |
| Find references | Every use of that binding |
| Rename | Those uses and nothing else |

Diagnostics come from the same analysis as `baa check` and `baa lint`, so an
editor cannot disagree with the command line about whether a file is valid, and
a code shown in the editor is one you can look up in [errors.md](errors.md).

Definition, references and rename read the resolver's symbol table rather than
the text. A binding that shadows an outer one of the same name is a different
symbol, so renaming the inner one leaves the outer alone.

Writes nothing to stdout that is not a protocol message, which makes a client
log with no messages in it a sign the client never sent any.

## `baa repl`

```
baa repl [--no-banner]
```

An interactive session. Bindings, functions and imports persist between lines.
An unfinished block opens a continuation prompt, so pasting a multi-line
function works.

| Command | Effect |
| --- | --- |
| `:help` | Show the command list |
| `:vars` | List the bindings you have created |
| `:type <expr>` | Show the type of an expression |
| `:modules` | List the standard library |
| `:clear` | Forget every binding |
| `:quit` | Leave (Ctrl+D also works) |

Expressions print their value; statements do not.

```
$ baa repl
Baa 0.7.0
Type :help for commands, :quit to leave.
baa> const flock = ["Dolly", "Shaun"]
baa> flock.map(fn(n) { return n.upper() })
["DOLLY", "SHAUN"]
baa> :type flock
array
```

The REPL also reads piped input, which makes it usable in a script.

## `baa init`

```
baa init [dir] [--name <name>] [--force]
```

Creates a project: `baa.toml`, `main.baa`, `greetings.baa`, a test, and a
`.gitignore`. The default name is the directory name.

Refuses to overwrite an existing `baa.toml` without `--force`.

## `baa build`

```
baa build [options]
```

Validates every `.baa` file in the project, checks the entry point exists, and
writes `baa.lock` with a SHA-256 of each dependency's entry file.

Baa is interpreted, so `build` produces no binary. It is the "is this project
coherent?" command, and the thing to run before tagging a release.

| Option | Effect |
| --- | --- |
| `--locked` | Verify `baa.lock` instead of writing it |

`--locked` reads the committed lockfile, builds what the lockfile would say
now, and reports `BAA406` if the two disagree, naming the wool that moved,
changed, arrived or went away. It writes nothing, so a failing check leaves the
file it is checking alone.

Without it `build` rewrites the lockfile every time, which means a dependency
whose contents changed quietly updates its own recorded hash. That is the right
behaviour on a developer's machine and the wrong behaviour in CI, where the
question is whether the tree still matches what was committed:

```bash
baa build --locked   # exits non-zero if any dependency has changed
```

## `baa app`

```
baa app new <dir>
baa app build [--out <dir>] [--console]
baa app run
baa app test
```

Native applications: a Baa program that opens a real window instead of
answering a web request. `build` produces a single Windows executable with the
runtime and the program inside it, needing no Node.js on the machine that runs
it.

| Action | Effect |
| --- | --- |
| `new <dir>` | Create an application project: manifest, entry point, a logic module and its tests |
| `build` | Write `build/<name>.exe` |
| `run` | Build to a temporary image and run it with a console attached |
| `test` | Run every `.baa` file under `tests/` on the native runtime |

| Option | Effect |
| --- | --- |
| `--out <dir>` | Where to write the executable. Default `build/` |
| `--console` | Build on the console runtime, so `baa` output has somewhere to go |
| `--entry <file>` | Entry point, when there is no `baa.toml` |

```bash
baa app new pen_counter
cd pen_counter
baa test          # the logic, with no window involved
baa app run       # the window
baa app build     # build/pen_counter.exe
```

An application imports [`barn`](gui.md) and draws its window. `gate`, which
serves web pages, is not available to one: those are different targets, and
importing the wrong one is a build error naming the module rather than a
failure in front of a user.

Building needs the native runtime, which is Rust and is compiled separately:

```bash
cargo build --release --manifest-path rust/Cargo.toml
```

The language itself needs no Rust. See
[native-applications.md](native-applications.md).

## `baa add` / `baa remove`

```
baa add <name> --path <path>
baa remove <name>
```

Adds or removes a dependency ("wool") in `baa.toml`, then refreshes
`baa.lock`.

There is no package registry yet, so every dependency is a local path.
`baa add name` without `--path` says so rather than pretending otherwise, see
[ROADMAP.md](../ROADMAP.md).

```bash
baa add shears --path ../shears
```

```toml
[wool]
shears = { path = "../shears" }
```

```baa
import shears
baa shears.cut()
```

## `baa doctor`

```
baa doctor
```

Reports the Node version, platform, Baa version, project state, dependency
resolution, whether the native runtime is built, and colour support. Exits `1`
if anything is wrong.

A missing native runtime is reported, not counted as a fault: the language
works without it and most people never build a native application.

```
ok   Node.js           v24.13.0
ok   Platform          win32 x64
ok   Baa               0.7.0
ok   Project           hill_farm 0.1.0 ()
ok   Wool              1 resolved
ok   Entry             main.baa
ok   Standard library  9 modules
ok   Native runtime    ready in ./rust/target/release
ok   Colour            enabled

The flock is healthy.
```

## `baa modules`

Lists the standard library with one-line summaries. The full reference is
[docs/stdlib.md](stdlib.md).

## `baa version`

Prints `baa <version>`. Identical to `baa --version`.

---

## The project manifest

`baa.toml` uses a small, strict subset of TOML: tables, and values that are
strings, numbers, booleans, string arrays or inline tables of strings. Anything
outside the subset is `BAA405` with a line number: never a silent misparse.

```toml
# Baa project manifest.
[flock]
name = "hill_farm"
version = "0.1.0"
description = "A flock management program."
entry = "main.baa"
license = "MIT"
authors = ["Shepherd <shepherd@example.com>"]

[wool]
shears = { path = "../shears" }
```

| Field | Meaning |
| --- | --- |
| `name` | Project name |
| `version` | Project version |
| `description` | One line, shown by tooling |
| `entry` | The file `baa run` executes with no arguments |
| `license` | SPDX identifier |
| `authors` | Array of strings |

`[wool]` maps a module name to a local path. The path may point at a directory
(where `<name>.baa` or `main.baa` is looked for) or directly at a `.baa` file.

`baa.lock` is generated JSON: the resolved path and a SHA-256 of each
dependency. Commit it for applications; the `.gitignore` written by
`baa init` excludes it, which suits libraries.

---

## Using Baa in CI

```yaml
- run: npm install
- run: baa check .
- run: baa fmt --check .
- run: baa lint --deny-warnings .
- run: baa test
```

`CI=true` is set by every major provider, which turns off colour and the sheep
wording automatically. Nothing else needs configuring.
