# FAQ

### Is this a real programming language, or a joke?

Both, in that order. Baa has a hand-written lexer, a recursive-descent parser
with error recovery, a real AST, a semantic analyser, a tree-walking
interpreter, a standard library, a deterministic formatter, a linter, a test
runner, a REPL and a project tool. It runs the ~200-line program in
[`examples/large_program.baa`](../examples/large_program.baa) and everything
else in that directory. The name is the joke; the implementation is not.

### Why is `print` called `baa`?

Because it is the one word the language is named after, and because a print
statement is the first thing anyone types. Everything else in the language is
called what you would expect: `if`, `else`, `for`, `while`, `fn`, `return`,
`let`, `const`, `import`, `try`, `catch`, `throw`, `match`. The sheep
terminology is confined to module names, error wording and documentation.

### Can I turn off the sheep jokes?

Yes, completely.

```bash
baa --no-baa check .
BAA_NO_BAA=1 baa run app.baa
```

`CI=true`, which every CI provider sets, does it automatically. Error codes,
severities and source spans are identical in both modes; only the wording
changes, and a test asserts that neither wording carries information the other
lacks.

### Why Node and TypeScript rather than Rust?

The brief preferred Rust; the machine had no Rust toolchain and no MSVC linker,
which would have meant several gigabytes of build tools before the first
compile. The trade-offs are written out in
[ARCHITECTURE.md](../ARCHITECTURE.md#why-typescript-on-node). The short
version: no build step at all, one dev dependency, runs identically on three
platforms, and the front end ports mechanically if the host ever changes.

### Why is there only one number type?

Because two numeric types means silent promotions, and silent promotions mean
bugs that only appear with real data. Baa's `number` is an IEEE-754 double:
exact for integers up to 2^53, which covers every counter, index and identifier
a script will meet. When you want integer behaviour you ask for it:
`ram.idiv`, `ram.floor`, `n.is_whole()`.

The cost is honest: money should not be stored in a `number`, in Baa or in
JavaScript or in Lua. Store it in whole pennies.

### Why does `1 / 0` fail instead of giving infinity?

Because `inf` propagates. By the time it reaches your output it has passed
through five functions and the actual mistake is far behind you. `BAA306` fires
where the divisor was zero, which is where you can fix it. `ram.INF` is there
when you genuinely want infinity.

### Are `0` and `""` falsy?

No. Only `nil` and `false` are. This is the Lua and Ruby rule, and it removes
the classic `if (count)` bug where zero is a perfectly good value.

### Does `const` make the value immutable?

No: it freezes the binding. `const flock = []` still lets you
`flock.push("Dolly")`, because `flock` keeps pointing at the same array. This
matches `const` in JavaScript and `final` in Java. Use `clone(x)` when you need
a copy nobody else can reach.

### Why do I have to escape `{` in a string?

Because `{` starts an interpolation, and Baa would rather tell you about an
unclosed one than guess. Write `\{` for a literal brace. Inside an
interpolation you write ordinary Baa, including string literals with plain
quotes:

```baa
baa "the flock: {names.join(", ")}"
```

### Why does my callback get fewer arguments than the docs say?

It does not: it gets exactly the ones it declared. `map` offers
`(item, index)` and `reduce` offers `(total, item, index)`, but a callback is
called with its arguments truncated to its parameter list. That is the one
place Baa is lenient about arity; calls you write yourself are checked
strictly, usually before the program runs.

### Can I have classes?

Not in 0.1, and possibly never. A map holding functions covers the great
majority of what objects are used for in a scripting language:

```baa
fn make_counter(start) {
    let n = start
    return {
        next: fn() {
            n += 1
            return n
        },
        value: fn() { return n },
    }
}
```

Closures give you encapsulation; maps give you shape. Inheritance is the part
that causes the trouble, and Baa is not in a hurry to add it.

### How fast is it?

About 1.2 million function calls and 4.5 million loop iterations per second on
a laptop, with the front end lexing at roughly 7 MB/s. Run `npm run bench` for
numbers from your own machine. It is a tree-walking interpreter, so it is
comfortably fast for scripting and will lose to anything compiled.
[ARCHITECTURE.md](../ARCHITECTURE.md#path-to-a-bytecode-vm) describes the route
to a bytecode VM, and why that has not been built yet.

### Is there a package registry?

No. Dependencies are local paths, declared in `baa.toml` under `[wool]` and
added with `baa add name --path ../name`. `baa add name` on its own tells you
the registry does not exist rather than pretending to search one. Building a
registry is a security and operations problem, not a weekend feature, see
[ROADMAP.md](../ROADMAP.md).

### Is `shepherd.run` safe?

Safer than the usual shape of that API. It never uses a shell: it takes a
program name and an explicit array of arguments, so there is no string that
could be reinterpreted as shell syntax and nothing to quote-escape. A program
that wants a shell has to name one, which makes the decision visible in review.
See [SECURITY.md](../SECURITY.md).

### Does Baa run on Windows?

Yes, and it was developed there. Line endings are normalised when a file is
read, so spans and diagnostics are byte-identical across platforms; paths go
through Node's platform-aware `path` module; nothing shells out. The CI matrix
covers Windows, Linux and macOS.

### How do I write a test?

In Baa, next to the code:

```baa
test "greets a sheep by name" {
    assert_eq(greet("Dolly"), "Baa, Dolly!")
}
```

`baa test` finds and runs every block. `baa run` registers them without
running, so a `test` block in a program you execute costs nothing.

### What does `BAA` stand for?

Nothing. It is the noise.
