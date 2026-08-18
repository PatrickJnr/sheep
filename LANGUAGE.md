# The Baa language tour

A guided walk through Baa, from `baa "hello"` to modules and error handling.
Every snippet here runs. If you want the precise rules instead of the friendly
version, read [SPEC.md](SPEC.md).

---

## Contents

1. [Hello, flock](#hello-flock)
2. [Comments](#comments)
3. [Values](#values)
4. [Bindings](#bindings)
5. [Strings](#strings)
6. [Operators](#operators)
7. [Conditionals](#conditionals)
8. [Loops](#loops)
9. [Functions](#functions)
10. [Closures](#closures)
11. [Arrays](#arrays)
12. [Maps](#maps)
13. [Ranges](#ranges)
14. [Match](#match)
15. [Errors](#errors)
16. [Modules](#modules)
17. [Tests](#tests)
18. [Style](#style)

---

## Hello, flock

A Baa program is a file of statements, executed top to bottom. `baa` prints.

```baa
baa "Hello, flock!"
```

```
$ baa run hello.baa
Hello, flock!
```

`baa` takes any number of values and separates them with a space:

```baa
baa "sheep:", 12, true, nil
// sheep: 12 true nil
```

There are no semicolons. A statement ends at the end of the line, unless the
line clearly is not finished, which Baa works out for you:

```baa
const total = 1 +
    2 +
    3

const names = [
    "Dolly",
    "Shaun",
]

const shouted = names
    .map(fn(n) { return n.upper() })
    .join(", ")
```

A line continues when it ends with an operator or a comma, when you are inside
`(` or `[`, or when the next line starts with `.`. Everything else is a new
statement.

## Comments

```baa
// A line comment.

/*
   A block comment.
   /* They nest, which is handy when commenting out code. */
*/

/// A doc comment. These attach to the declaration below them.
fn count_sheep(flock) {
    return flock.length()
}
```

## Values

Baa has seven kinds of value.

| Type | Examples |
| --- | --- |
| `nil` | `nil` |
| `bool` | `true`, `false` |
| `number` | `12`, `3.5`, `1_000`, `0xFF`, `0b1010`, `1e6` |
| `string` | `"Dolly"`, `"count: {n}"` |
| `array` | `[1, 2, 3]`, `[]` |
| `map` | `{ name: "Dolly", age: 6 }`, `{}` |
| `range` | `0..10`, `1..=10` |

Functions and modules are values too, so `type_of` can return `"function"` and
`"module"` as well.

There is one number type, a 64-bit float: `12` and `12.0` are the same value.
This removes a whole family of silent-promotion bugs; when you need integer
behaviour, `ram.idiv`, `ram.floor` and `n.is_whole()` are there.

```baa
baa type_of(nil), type_of(1), type_of("a"), type_of([1]), type_of({ a: 1 })
// nil number string array map
```

Only `nil` and `false` are falsy. `0`, `""` and `[]` are all truthy.

## Bindings

```baa
let sheep = 12          // can be reassigned
sheep = 13
sheep += 1

const MAX_SHEEP = 100   // cannot be reassigned
```

Reassigning a `const` is a compile-time error, not a runtime surprise:

```
error[BAA103]: `MAX_SHEEP` was shorn with `const`: its value can't grow back.
```

`const` freezes the *binding*, not the value. `const flock = []` still lets you
`flock.push("Dolly")`: the name keeps pointing at the same array. Baa's linter
will nudge you towards `const` for any `let` you never reassign.

Names are block-scoped, and an inner scope may shadow an outer one:

```baa
const name = "outer"
if true {
    const name = "inner"
    baa name        // inner
}
baa name            // outer
```

Using a name before it is declared is an error rather than a `nil`. Functions
are the exception: they are hoisted, so mutual recursion works in any order.

### Taking a value apart

The left of a binding can be a shape rather than a name:

```baa
const [first, second] = ["Dolly", "Shaun"]
baa first                          // Dolly

const [head, ..rest] = [1, 2, 3]
baa head, rest                     // 1 [2, 3]

const sheep = { name: "Dolly", age: 6 }
const { name, age } = sheep
baa name, age                      // Dolly 6

const { name as who } = sheep      // bind under a different name
baa who                            // Dolly
```

They nest, and a missing item or key is `nil` rather than an error:

```baa
const [{ name as leader }, ..others] = [{ name: "Shaun" }, { name: "Timmy" }]
baa leader, len(others)            // Shaun 1

const [a, b] = [1]
baa b                              // nil
```

An array binding needs an array and a map binding needs a map; anything else
is an error, because taking apart the wrong shape is a mistake rather than
something to paper over.

## Strings

Strings are double-quoted and single-line.

```baa
const name = "Dolly"

baa "Baa, {name}!"                 // interpolation
baa "1 + 1 = {1 + 1}"              // any expression
baa "{name.upper()} says hello"    // including method calls
baa "a brace: \{ and \}"           // escape braces with a backslash
```

Inside `{ ... }` you write ordinary Baa, quotes and all:

```baa
const flock = ["Dolly", "Shaun"]
baa "the flock: {flock.join(", ")}"
```

Escapes: `\n`, `\t`, `\r`, `\0`, `\e`, `\\`, `\"`, `\{`, `\}`, `\u{1F411}`.

### Strings over several lines

`"""` opens a block string. The closing `"""` sits on its own line, and the
whitespace before it is stripped from every line:

```baa
const page = """
    <h1>Baa, {name}!</h1>
    <p>Written on more than one line.</p>
    """
```

That is `<h1>Baa, Dolly!</h1>\n<p>Written on more than one line.</p>`, with no
trailing newline. Indentation *relative* to the closing delimiter is kept, so
nested markup stays nested. Escapes and interpolation work as usual.

Letting the closing delimiter set the indentation is what allows `baa fmt` to
move the surrounding code without changing the text.

### Strings that mean exactly what they say

`r"..."` is raw: no escapes, no interpolation, every character itself.

```baa
baa r"C:\Users\flock"              // C:\Users\flock
baa r"{not interpolated}"          // {not interpolated}
```

This exists because two kinds of text fight the ordinary rules. A regular
expression is full of backslashes, and `{2}` would be read as an
interpolation:

```baa
import wool
baa wool.matches("2026-08", r"\d{4}-\d{2}")     // true
```

CSS has the same problem with braces. `r"""..."""` is the block form:

```baa
const style = r"""
    body { color: green }
    """
```

A raw string cannot contain its own closing quote, since there is no escape to
write one with.

### Finding things in text

`wool` handles patterns. They are ordinary strings, which is why raw ones earn
their keep here:

```baa
import wool

baa wool.matches("sheep 42", r"\d+")                  // true
baa wool.find("sheep 42", r"\d+").get("match")        // 42
baa wool.find_all("a1 b22", r"\d+").length()          // 2
baa wool.substitute("a1b2", r"(\d)", "[$1]")          // a[1]b[2]
baa wool.split_on("a1b22c", r"\d+")                   // ["a", "b", "c"]
```

`find` gives back a map of `match`, `start`, `end`, `groups` and `named`, or
`nil`. Offsets count characters, like everything else about Baa strings. Flags
go last: `i` ignores case, `m` matches `^` and `$` at line breaks, `s` lets
`.` match a newline.

Strings concatenate with `+`. If either side is text, the other is converted:

```baa
baa "sheep #" + 12      // sheep #12
```

Common operations are methods on the string itself:

```baa
baa "  wool ".trim().upper()          // WOOL
baa "a,b,c".split(",")                // ["a", "b", "c"]
baa "wool".contains("oo")             // true
baa "wool"[0], "wool"[-1]             // w l
baa "5".pad_start(3, "0")             // 005
```

## Operators

From loosest to tightest:

| Operators | Notes |
| --- | --- |
| `=` `+=` `-=` `*=` `/=` `%=` | Assignment, right-associative |
| `??` | Left value unless it is `nil` |
| `\|\|` | Short-circuits |
| `&&` | Short-circuits |
| `==` `!=` | Structural for arrays and maps |
| `<` `<=` `>` `>=` `in` | Numbers and strings; `in` tests membership |
| `..` `..=` | Ranges |
| `+` `-` | |
| `*` `/` `%` | |
| `-x` `!x` | Unary |
| `**` | Right-associative, binds tighter than unary `-` |
| `f(x)` `a.b` `a[i]` | Postfix |

```baa
baa 2 ** 3 ** 2          // 512, not 64
baa -2 ** 2              // -4
baa nil ?? "fallback"    // fallback
baa 2 in [1, 2, 3]       // true
baa "oo" in "wool"       // true
baa [1, 2] == [1, 2]     // true, compared by value
```

Dividing by zero is an error, not `inf`:

```
error[BAA306]: Dividing by zero. Even sheep know better than that.
```

## Conditionals

```baa
if sheep > 10 {
    baa "The flock is thriving!"
} else if sheep > 5 {
    baa "Coming along."
} else {
    baa "We need more sheep."
}
```

Braces are always required; parentheses around the condition never are.

## Loops

```baa
for name in ["Dolly", "Shaun"] {
    baa name
}

for index, name in ["Dolly", "Shaun"] {
    baa "{index}: {name}"
}

for key, value in { Dolly: 6, Shaun: 4 } {
    baa "{key} is {value}"
}

for letter in "baa" {
    baa letter
}

for i in 0..3 { baa i }        // 0 1 2
for i in 1..=3 { baa i }       // 1 2 3
for i in 3..0 { baa i }        // 3 2 1

let n = 5
while n > 0 {
    n -= 1
}
```

`break` leaves the innermost loop; `continue` starts its next iteration. Both
are errors outside a loop.

## Functions

```baa
fn count_sheep(flock) {
    return flock.length()
}

fn greet(name, greeting = "Baa") {       // default value
    return "{greeting}, {name}!"
}

fn tally(label, ..counts) {              // rest parameter
    return "{label}: {counts.sum()}"
}
```

A function that reaches the end without `return` produces `nil`.

Baa checks the number of arguments where it can see the definition, before your
program runs:

```
error[BAA202]: `greet` was called with too few sheep: it takes 1 to 2 but got 0.
```

The one place Baa is lenient is a callback handed to the standard library:
`map` offers `(item, index)` and `reduce` offers `(total, item, index)`, but a
callback that only wants the first argument simply gets it.

```baa
baa [1, 2, 3].map(fn(n) { return n * 2 })    // [2, 4, 6]
```

## Closures

Functions are values, and they capture the scope where they were written.

```baa
fn make_counter(start) {
    let count = start
    return fn() {
        count += 1
        return count
    }
}

const next = make_counter(10)
baa next(), next(), next()      // 11 12 13
```

Anonymous functions have the same shape as named ones:

```baa
const shout = fn(text) { return text.upper() + "!" }
baa ["a", "b"].map(shout)
```

## Arrays

```baa
const flock = ["Dolly", "Shaun", "Lambchop"]

baa flock.length()               // 3
baa flock[0], flock[-1]          // Dolly Lambchop
baa flock.slice(1, 3)            // ["Shaun", "Lambchop"]
```

Indexing out of range is an error with the valid range in the message. Negative
indexes count from the end.

Mutation:

```baa
flock.push("Timmy")
flock.insert(0, "Shirley")
flock.remove(0)
flock.pop()
```

Transformation: these return new arrays and never mutate:

```baa
const weights = [46.5, 52.0, 38.25]

baa weights.map(fn(w) { return w * 2 })
baa weights.filter(fn(w) { return w > 40 })
baa weights.reduce(fn(total, w) { return total + w }, 0)
baa weights.sum(), weights.sort(), weights.reverse()
baa weights.any(fn(w) { return w > 50 })
baa weights.all(fn(w) { return w > 10 })
baa weights.find(fn(w) { return w > 40 })
```

## Maps

Maps preserve insertion order. Keys may be strings, numbers, booleans or `nil`.

```baa
const sheep = { name: "Dolly", age: 6, woolly: true }

baa sheep.name           // Dolly, field access
baa sheep["age"]         // 6, index access
baa sheep.colour         // nil: a missing key reads as nil

sheep.farm = "Hill"      // adds a key
sheep["age"] = 7
```

When a key clashes with a built-in method name, the key wins, adding a method
to Baa can never break your program.

```baa
baa sheep.get("colour", "white")   // fallback
baa sheep.expect("age")            // fails loudly if missing
baa sheep.keys(), sheep.values(), sheep.entries()
baa sheep.has("name"), sheep.length()
baa { a: 1 }.merge({ b: 2 })
```

Computed keys use brackets:

```baa
const field = "age"
const record = { [field]: 6 }
```

## Ranges

A range is a value, not just loop syntax.

```baa
const first_ten = 0..10          // 0 to 9
const inclusive = 1..=10         // 1 to 10

baa first_ten.length()           // 10
baa first_ten.contains(5)        // true
baa first_ten.to_array()
baa 5 in first_ten               // true
```

## Match

`match` is an expression: it produces a value.

```baa
const size = match len(flock) {
    0 => "empty",
    1 => "one lonely sheep",
    2 || 3 => "a small flock",
    n if n > 50 => "a very large flock ({n})",
    _ => "a flock of {len(flock)}",
}
```

Arms are tried in order:

- a literal pattern matches by value, structurally: so `[true, false]` and
  `{ ok: true }` are valid patterns;
- `||` separates alternatives;
- a bare name binds the subject for that arm;
- `_` matches anything;
- `if` adds a guard.

If no arm matches, that is a runtime error: add a `_` arm to be exhaustive.

## Errors

`throw` sends any value up the stack:

```baa
fn admit(pen, name) {
    if pen.length() >= 3 {
        throw "the pen is full"
    }
    pen.push(name)
}
```

`try` / `catch` / `finally` handles it:

```baa
try {
    admit(pen, "Shirley")
} catch problem {
    baa "could not admit: {problem}"
} finally {
    baa "gate closed"
}
```

Thrown values keep their type, so structured errors work:

```baa
throw { code: "ALREADY_SHORN", sheep: name }
```

Runtime failures are catchable too, and arrive as a map with a stable code:

```baa
try {
    baa flock[99]
} catch problem {
    baa problem.code       // BAA304
    baa problem.message
    baa problem.file, problem.line, problem.column
}
```

`assert` and `assert_eq` are available everywhere, and are what tests are built
from:

```baa
assert(flock.length() > 0, "the flock should not be empty")
assert_eq(greet("Dolly"), "Baa, Dolly!")
```

## Modules

Any `.baa` file is a module. `export` marks what is visible from outside.

```baa
// pen.baa
export const CAPACITY = 40

export fn admit(pen, name) {
    pen.push(name)
    return pen
}

fn private_helper() {          // not exported: invisible to importers
    return "hidden"
}
```

```baa
// main.baa
import "./pen.baa"                    // binds `pen`, from the file name
import "./pen.baa" as sheep_pen       // or choose the name
import { admit } from "./pen.baa"     // or import individual values

import wool                           // a standard module
import meadow as clock                // renamed
import { round, mean } from ram       // named
```

Paths are relative to the importing file, not to where you ran `baa`. A module
runs once, however many files import it. Import cycles are reported as
`BAA402` rather than producing a half-built module.

Modules are ordinary values:

```baa
fn describe_with(module, pen) {
    return module.describe(pen)
}
```

Project dependencies go in `baa.toml` under `[wool]` and are imported by name:

```bash
baa add shears --path ../shears
```

```baa
import shears
baa shears.cut()
```

## Tests

Tests live next to the code, in the language itself:

```baa
import "../greetings.baa"

test "greets a sheep by name" {
    assert_eq(greetings.greet("Dolly"), "Baa, Dolly!")
}

test "greets a whole flock" {
    const names = ["Dolly", "Shaun"]
    assert_eq(names.map(greetings.greet).length(), 2)
}
```

```
$ baa test
tests/greetings_test.baa
  ok greets a sheep by name 0.2ms
  ok greets a whole flock 0.3ms

2 passed, 0 failed in 4ms
```

`baa test --filter greets` runs a subset; `baa test --seed 42` makes anything
using `meadow` reproducible.

## Style

`baa fmt` is the answer to every formatting question. It is deterministic: the
same AST always produces the same output, and running it twice changes nothing
the second time.

- four spaces per level;
- one statement per line;
- at most one blank line in a row;
- collections on one line when they fit within 90 columns, otherwise one item
  per line with a trailing comma;
- a one-statement callback stays inline when it fits.

Naming conventions the standard library follows, and the linter assumes:

- `snake_case` for values and functions;
- `SCREAMING_SNAKE_CASE` for constants that are configuration;
- a leading `_` marks something deliberately unused, which silences the unused
  warnings.

```bash
baa fmt .                # rewrite
baa fmt --check .        # verify, non-zero exit if anything would change
baa lint --deny-warnings .
```

---

Next: [SPEC.md](SPEC.md) for the exact rules, [docs/stdlib.md](docs/stdlib.md)
for every library function, or [docs/errors.md](docs/errors.md) for the full
diagnostic catalogue.
