# Security policy

## Reporting a vulnerability

Please report security issues privately, not in the public issue tracker.

- Open a [GitHub security advisory](https://github.com/PatrickJnr/sheep/security/advisories/new), or
- email the maintainer listed on the repository profile.

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
single read, and a future `baa run --deny-fs` is a matter of swapping the
implementation rather than patching seven modules.

### Path inputs are validated

Every `pasture` function rejects empty paths and paths containing NUL bytes
before touching the disk, and reports the failure as `BAA404` with the path
in the message.

Baa does **not** confine paths to the project directory. `pasture.read("../..")`
works, deliberately: a scripting language that cannot read a file outside its
own folder is not much of a scripting language. Confinement is what the sandbox
mode on the roadmap is for.

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

## For people running Baa on untrusted input

Until sandboxing lands, use the tools your operating system already gives you:

- run `baa` as an unprivileged user, in a container or a VM;
- apply CPU, memory and wall-clock limits from outside the process;
- prefer `baa check` when you only need to know whether something parses, it
  never runs the program.
