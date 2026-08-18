# CLI reference

`baa` is one executable with a handful of subcommands. It starts fast, writes
diagnostics to stderr and everything else to stdout, and never asks a question
it cannot answer itself: which makes it safe to run unattended in CI.

```
baa <command> [options]
```

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

URLs map to files: `/` runs `index.baa`, `/about` runs `about.baa`, and
`/sheep/Shaun` runs `sheep.baa` with `/Shaun` as the path below the script.
Anything else beside the pages is served as a static file. Paths resolving
outside the directory are refused.

Not for production: one process per request, a ten second limit per page, and
it binds to localhost unless told otherwise.

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
Baa 0.1.0
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
baa build
```

Validates every `.baa` file in the project, checks the entry point exists, and
writes `baa.lock` with a SHA-256 of each dependency's entry file.

Baa is interpreted, so `build` produces no binary. It is the "is this project
coherent?" command, and the thing to run before tagging a release.

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
resolution and colour support. Exits `1` if anything is wrong.

```
ok   Node.js           v24.13.0
ok   Platform          win32 x64
ok   Baa               0.1.0
ok   Project           hill_farm 0.1.0 (.)
ok   Wool              1 resolved
ok   Entry             main.baa
ok   Standard library  7 modules
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
