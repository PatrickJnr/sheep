# Security policy

## Reporting a vulnerability

Please report security issues privately, not in the public issue tracker.

Email the maintainer address published on the
[npm package page](https://www.npmjs.com/package/baa-lang). That is the route
that works today.

GitHub's private advisory form is the usual mechanism and is not available
here: GitHub offers it on public repositories only, and this one is private, so
a link to it would be a 404 handed to somebody trying to do the right thing.

Include: what you found, how to reproduce it, and what an attacker could do
with it. A `.baa` file that demonstrates the problem is ideal.

You should get an acknowledgement within **five working days**, an assessment
within **fourteen days**, and credit in the release notes unless you would
rather not have it.

Supported versions: the latest release, and `main`. Baa is pre-1.0, so fixes go
into the next release rather than into patch branches.

---

## Baa's threat model

Baa runs programs you give it, with the privileges of the process that started
it. **It is not a sandbox.** A `.baa` file can read and write files, read
environment variables and start subprocesses, exactly as a Python or Node
script can.

Treat a `.baa` file from an untrusted source the way you would treat a shell
script from the same source: read it first.

What Baa *does* promise:

- **No implicit code execution.** Running `baa check`, `baa fmt` or `baa lint`
  never executes the program. Only `baa run`, `baa test` and `baa repl` do.
- **No downloading.** Baa never fetches anything over the network. Dependencies
  are local paths on your own disk. There is no registry to be compromised.
- **No shell.** Nothing in Baa or its standard library invokes a shell on your
  behalf.

### Native applications

A built application has the same threat model, with two differences that both
narrow it.

The **native runtime has no way to load code**: no `eval`, no FFI, no plugin
mechanism, no dynamic library loading. What an application can execute is fixed
when it is built. It can start a *program* — `shepherd.run` is in the native
runtime as of the version after 0.4.0 — but it does so the same way the
reference implementation does, by handing the operating system a program name
and an explicit array of arguments. No command line is ever built from a
string, so there is nothing for an injection to be injected into.

It also **never parses at runtime**. A shipped application carries a resolved
tree and resolves its imports to indices inside that tree at build time, so it
does not consult the filesystem to find a module and cannot be redirected by a
`.baa` file placed beside it.

The image the runtime reads is treated as untrusted input, because it is
whatever bytes are on the end of the executable: the version is checked before
anything is decoded, every read is bounds-checked, and a malformed image is
refused with a reason rather than guessed at.

Two things the image is **not**: it is not encryption and it is not integrity
protection. Anyone can read the strings in your program, as they can in a
Python or JavaScript application, and anyone who can write to the file can
replace the image in it. Do not put a secret in one, and sign the executable if
its integrity matters.

`pasture` in a native application reaches everything the person running it can
reach. That is what a text editor needs, and there is no sandbox making it
narrower. See
[docs/native-applications.md](docs/native-applications.md#the-trust-boundary).

## Design decisions that exist for security reasons

### `shepherd.run` never uses a shell

```baa
import shepherd

const result = shepherd.run("git", ["log", "--oneline", "-n", "5"])
baa result.code, result.out
```

The program and its arguments are separate values, passed straight to the
operating system. There is no string that could be reinterpreted as shell
syntax, so there is nothing to quote-escape and no injection to get wrong. A
program that genuinely needs a shell has to name one:
`shepherd.run("bash", ["-c", script])`: which makes the decision visible in
the source and in review.

Arguments must be strings; anything else is `BAA311` before the process
starts.

### The host interface is the only way out

Every filesystem, clock, randomness, environment and process operation goes
through `RuntimeHost` (`src/runtime/host.ts`). Capabilities live in one file
rather than being scattered through the standard library, so an audit is a
single read.

`shepherd.run` used to be the exception: it reached for `child_process`
directly, which put the most dangerous operation in the language outside the
one boundary that was supposed to hold everything. It now goes through
`host.runProcess` like everything else, and a test asserts the module does not
import `child_process` at all.

### Capabilities can be taken away

| Flag | Effect |
| --- | --- |
| `--deny-fs` | No reading, writing, listing or stat-ing of files |
| `--deny-fs-write` | Reading is allowed; writing, appending and `mkdir` are not |
| `--deny-env` | `shepherd.env` and `shepherd.env_all` refuse |
| `--deny-process` | `shepherd.run` refuses |

They apply to `baa run` and `baa test`, and work by wrapping the host: an
allowed operation reaches the real implementation untouched, so a restricted
run behaves exactly like an unrestricted one until it asks for something it may
not have. A denial is `BAA313` at the call, which a program can catch.

Nothing is denied by default. A program run from your shell already has
whatever your shell has, and pretending otherwise would make the flags feel
like security theatre rather than the thing you reach for when running code you
have not read.

There is deliberately **no** `--deny-network`: Baa cannot open a socket. `gate`
reads a CGI request from the environment and writes a reply to stdout, and
nothing in the standard library connects to anything. A flag denying a
capability the language does not have would suggest the other flags are the
same kind of gesture.

There is no `--deny-randomness` either. It is not a boundary, and `--seed`
already makes a run reproducible, which is what that request usually means.

This is capability *reduction*, not a sandbox. A denied run cannot reach the
filesystem through the standard library, and that is the claim being made: it
is not a security boundary against hostile code that has other ways to reach
the host process, and confining reads to a directory (rather than refusing them
outright) is still on the roadmap.

### Path inputs are validated

Every `pasture` function rejects empty paths and paths containing NUL bytes
before touching the disk, and reports the failure as `BAA404` with the path
in the message.

Baa does **not** confine paths to the project directory. `pasture.read("../..")`
works, deliberately: a scripting language that cannot read a file outside its
own folder is not much of a scripting language. `--deny-fs` refuses the
filesystem outright; confining reads to a directory is still on the roadmap.

### The manifest parser is strict

`baa.toml` is parsed with a small, hand-written TOML subset that accepts
tables, strings, numbers, booleans, string arrays and inline tables of strings.
Anything else is `BAA405` with a line number. A subset parser that refuses
loudly is safer than a permissive one that guesses, and it means no third-party
parser sits between a downloaded repository and your machine.

Dependency paths are resolved and existence-checked before use, and `baa.lock`
records a SHA-256 of each dependency's entry file, so a changed dependency is
visible in a diff.

### Recursion is bounded

The interpreter enforces a call-depth limit (512 by default) and reports
`BAA307`. Deeply recursive input cannot exhaust the host stack and crash the
process.

### No runtime dependencies

Baa ships with zero runtime dependencies. The only development dependencies are
`typescript` and `@types/node`, used for type-checking and never shipped or
executed as part of running a program. There is no transitive dependency tree
to audit.

```bash
npm audit           # the whole supply chain, in one screen
```

## Known limitations

These are documented rather than fixed, because fixing them properly means
building the sandbox on the roadmap:

- A Baa program has the full privileges of the `baa` process.
- There is no resource limit on memory, output or wall-clock time. A program
  can allocate until the host runs out of memory. `--max-depth` bounds
  recursion but not allocation.
- `shepherd.run` blocks until the subprocess exits, with no timeout.
- Importing a module executes its top-level code, so `import` of an untrusted
  file runs that file.
- A `.fleece` image is not signed or checksummed. The runtime checks that it is
  well-formed, not that it is the one you built. Sign the executable if that
  matters.

## For people running Baa on untrusted input

Until sandboxing lands, use the tools your operating system already gives you:

- run `baa` as an unprivileged user, in a container or a VM;
- apply CPU, memory and wall-clock limits from outside the process;
- prefer `baa check` when you only need to know whether something parses, it
  never runs the program.
