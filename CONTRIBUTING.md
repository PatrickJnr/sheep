# Contributing to Baa

Thanks for looking. Baa is a small, deliberately coherent language, and the
most valuable contributions are the ones that keep it that way.

---

## Getting set up

You need **Node.js 22.18 or newer**. There is no build step, Node runs the
TypeScript sources directly.

```bash
git clone https://github.com/PatrickJnr/sheep.git
cd sheep
npm install
npm run ci        # typecheck, format check, lint, tests
```

`npm link` puts `baa` on your PATH. Without it, every command works as
`node src/cli/index.ts <command>`.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before your first change. It is short,
and it explains why things are where they are.

## The commands you will use

| Command | What it does |
| --- | --- |
| `npm test` | The full Node test suite |
| `node --test tests/parser.test.ts` | One suite |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run fmt` / `fmt:check` | Baa's formatter over the examples |
| `npm run lint` | Baa's linter over the examples |
| `npm run test:baa` | Baa's own test blocks, run by Baa |
| `npm run bench` | Benchmarks |
| `node tools/gen-docs.ts` | Regenerate the generated docs |
| `node tools/record-examples.ts` | Re-record example output |

## What makes a good contribution

**Bug fixes** are always welcome. A failing test in the pull request is worth
more than a paragraph of description.

**New standard-library functions** need to answer: would most programs that
need this write it badly by hand? `flock.group_by` earns its place;
`flock.second_to_last` does not.

**Language changes** need a problem, not a feature. Open an issue first with a
real program that is awkward to write today. The bar is high on purpose: every
keyword is one more thing a newcomer has to learn, and Baa's pitch is that you
can hold it in your head.

**Documentation** improvements are genuinely valuable, especially where the
docs and the implementation disagree: that is always a bug on one side or the
other.

## House rules

### Keep the humour where it belongs

Sheep terminology lives in **module names, error wording and documentation**.
It never lives in:

- operator or keyword semantics;
- standard-library function names (`group_by`, not `herd_by`);
- anything that changes what a program does.

Every diagnostic needs both a `woolly` and a `plain` wording with the same
placeholders. A test enforces this. If a joke would make a CI log harder to
read, it does not go in.

### Every diagnostic gets a code

Add it to `src/diagnostics/codes.ts` in the right range (SPEC §8), with a
source span, a `note` that explains what is wrong *there*, and a `help` that
says what to do. Codes never change meaning; new diagnostics take new numbers.

Then run `node tools/gen-docs.ts`: `docs/errors.md` is generated.

### Nothing is done without a test

The suite is layered so a change can be tested at the level it happens:

| Change | Test in |
| --- | --- |
| Tokens, spans, trivia | `tests/lexer.test.ts` |
| Grammar, precedence, recovery | `tests/parser.test.ts` |
| Scope, arity, module rules | `tests/resolver.test.ts` |
| Semantics | `tests/runtime.test.ts` |
| Library functions | `tests/stdlib.test.ts` |
| A new diagnostic | `tests/diagnostics.test.ts` |
| Formatting | `tests/formatter.test.ts` |
| Lint rules | `tests/linter.test.ts` |
| Commands and exit codes | `tests/cli.test.ts` |

If the change is user-facing, add or extend an example in `examples/`, then run
`node tools/record-examples.ts` and review the diff.

### The formatter must stay a fixed point

`format(format(x)) == format(x)` for everything, and no comment is ever lost.
Both are asserted by the test suite. If a formatting change breaks either, the
change is wrong, not the test.

### Cross-platform by default

- No hard-coded `/` or `\`: use `node:path`.
- No shelling out.
- Read files with the existing `SourceFile`, which normalises line endings so
  spans match on every platform.
- Anything touching the outside world goes through `RuntimeHost`, so tests can
  swap it and a future sandbox can restrict it.

### Style

The TypeScript here is plain and boring on purpose: plain data, `switch` on a
`kind` discriminant, no clever abstractions, no dependency injection framework.
Match the surrounding code. Comments explain *why*, not *what*, the code
already says what.

Type-stripping means no `enum`, no `namespace`, no parameter properties, and
`import type` for anything used only as a type. `npm run typecheck` catches
all of it.

## Pull requests

1. Branch from `main`.
2. Make the change, with tests.
3. `npm run ci` must pass.
4. Update the docs the change touches: `SPEC.md` for semantics, `LANGUAGE.md`
   for the tour, and `CHANGELOG.md`.
5. Write a description that says what problem this solves. A before/after
   snippet is worth three paragraphs.

Small, focused pull requests get reviewed quickly. A change that touches the
lexer, the standard library and the roadmap at once will not.

## Reporting bugs

The most useful report is a `.baa` file that misbehaves, plus what you expected
and what happened. `baa --version` and `baa doctor` output help.

Specification bugs count: if `SPEC.md` and the implementation disagree, that is
a bug in one of them, and finding it is a real contribution.

Security issues go to [SECURITY.md](SECURITY.md), not to the issue tracker.

## Code of conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). It is
short, and it amounts to: be decent, assume good faith, and remember there is a
person on the other end.
