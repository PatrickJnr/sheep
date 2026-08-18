# The Baa language specification

Version 0.1. This document describes what Baa *is*, precisely enough to
implement it again. For the friendly version, read [LANGUAGE.md](LANGUAGE.md).

Where this document and the implementation disagree, that is a bug. Please
[report it](https://github.com/PatrickJnr/sheep/issues) rather than assuming
either side is right.

---

## 1. Source files

A Baa source file is a sequence of Unicode characters encoded as UTF-8, with
the extension `.baa`.

Line endings `\r\n` and `\r` are normalised to `\n` before lexing. Diagnostic
line and column numbers are therefore identical on every platform. Columns are
counted in UTF-16 code units, 1-based; lines are 1-based.

Outside string literals and comments, source text must be ASCII. Any other
character is `BAA002`.

## 2. Lexical structure

### 2.1 Whitespace and comments

Spaces and tabs separate tokens and are otherwise insignificant.

```
line-comment   ::= "//" { any character except newline }
doc-comment    ::= "///" { any character except newline }
block-comment  ::= "/*" { any character | block-comment } "*/"
```

Block comments nest. An unterminated block comment is `BAA004`.

Comments are trivia: they never appear in the token stream. Each comment is
attached to the token that follows it (leading trivia), or to the token it
follows when both are on the same line (trailing trivia). Doc comments (`///`)
preceding a `fn` declaration are additionally recorded on that declaration.

### 2.2 Newlines

A newline is significant: it terminates a statement. A newline is *suppressed*,
and behaves as whitespace, when any of the following holds:

1. The lexer is inside an unclosed `(` or `[`.
2. The previous token cannot end an expression. That is the set
   `+ - * / % ** == != < <= > >= && || ! ?? = += -= *= /= %= .. ..= , : . ( [ { =>`
   and the keywords `else in as from import let const fn`.
3. The next non-trivia character is `.` and is not the start of `..`.

Rule 3 is what allows a method chain to be written one call per line. There is
no line-continuation character; `;` is accepted as an explicit statement
terminator but is never required and is never emitted by the formatter.

### 2.3 Identifiers and keywords

```
identifier ::= ( letter | "_" ) { letter | digit | "_" }
letter     ::= "a".."z" | "A".."Z"
```

Identifiers are case-sensitive. `_` alone is an identifier, and is the wildcard
pattern in `match`.

Reserved keywords, none of which may be used as an identifier:

```
as       baa      break    catch    const    continue  else     export
fn       for      from     if       import   in        let      match
nil      return   test     throw    true     try       while    false
```

`finally` is a contextual keyword: it is recognised only directly after a `try`
block or its `catch` block, and is otherwise an ordinary identifier.

### 2.4 Number literals

```
number   ::= decimal | hex | octal | binary
decimal  ::= digits [ "." digits ] [ ( "e" | "E" ) [ "+" | "-" ] digits ]
hex      ::= "0" ( "x" | "X" ) hex-digits
octal    ::= "0" ( "o" | "O" ) octal-digits
binary   ::= "0" ( "b" | "B" ) binary-digits
digits   ::= digit { digit | "_" }
```

Underscores are separators and are ignored. A `.` begins a fractional part only
when the next character is a digit, so `1..5` is a range and `1.abs()` is a
method call. There are no type suffixes: a letter directly after a number is
`BAA005`.

All numeric literals produce a value of the single type `number` (§3.1).

### 2.5 String literals

```
string   ::= '"' { text-char | escape | interpolation } '"'
escape   ::= "\" ( "n" | "t" | "r" | "0" | "e" | "\" | '"' | "{" | "}"
                 | "u" "{" hex-digits "}" )
interpolation ::= "{" expression "}"
```

A string literal may not contain a raw newline; an unterminated string is
`BAA003`. An unrecognised escape is `BAA007`.

`{` begins an interpolation. To write a literal brace, escape it: `\{`, `\}`.

Interpolation contents are lexed and parsed as an ordinary expression, in the
same source file and with the same offsets, so diagnostics inside an
interpolation point at the right characters. Because the interpolation is a
separate lexical region, string literals inside it use unescaped quotes:

```baa
baa "the flock: {names.join(", ")}"
```

Braces nest, and string literals inside an interpolation are skipped when
finding the closing brace. An empty interpolation is `BAA009`; an unterminated
one is `BAA001`.

### 2.6 Operators and punctuation

```
( ) [ ] { } , . : ; =>
+ - * / % **
== != < <= > >=
&& || ! ??
= += -= *= /= %=
.. ..=
```

## 3. Values

### 3.1 Types

There are seven value types: `nil`, `bool`, `number`, `string`, `array`, `map`,
`range`, plus `function` and `module` which are produced by the language
itself. `type_of(x)` returns the type name as a string.

**`number`** is an IEEE-754 binary64 float. Baa deliberately has one numeric
type: `12` and `12.0` denote the same value, and `12 == 12.0` is `true`.
Integers are exact up to 2^53. Whole values print without a decimal point.
`inf`, `-inf` and `nan` are printable values but cannot be produced by `/`
(§4.4): they arise from `ram` constants and functions.

**`string`** is a sequence of Unicode code points. `length()`, indexing and
iteration operate on code points, not UTF-16 units.

**`array`** is an ordered, mutable, heterogeneous sequence.

**`map`** is an insertion-ordered mutable mapping. Keys may be `nil`, `bool`,
`number` or `string`; a composite key is `BAA311`.

**`range`** is an immutable `start`, `end`, `inclusive` triple. `a..b` excludes
`b`; `a..=b` includes it. When `start > end` the range counts downwards.

### 3.2 Truthiness

`nil` and `false` are falsy. Every other value, including `0`, `""` and `[]`,
is truthy.

### 3.3 Equality

`==` compares:

- `nil`, `bool`, `number`, `string` by value (`nan != nan`, per IEEE-754);
- `array` element-wise and recursively;
- `map` by size and by key/value pairs, ignoring insertion order;
- `range` by its three fields;
- `function` and `module` by identity.

### 3.4 Mutability

Values of type `array` and `map` are reference values: binding one to a second
name does not copy it. `clone(x)` produces a deep copy, preserving shared
structure and tolerating cycles.

`const` freezes the binding, not the value: `const a = []` still permits
`a.push(1)`.

## 4. Expressions

### 4.1 Grammar

```
expression      ::= assignment
assignment      ::= conditional [ assign-op assignment ]
assign-op       ::= "=" | "+=" | "-=" | "*=" | "/=" | "%="
conditional     ::= nullish
nullish         ::= logical-or  { "??" logical-or }
logical-or      ::= logical-and { "||" logical-and }
logical-and     ::= equality    { "&&" equality }
equality        ::= comparison  { ( "==" | "!=" ) comparison }
comparison      ::= range-expr  { ( "<" | "<=" | ">" | ">=" | "in" ) range-expr }
range-expr      ::= additive    [ ( ".." | "..=" ) additive ]
additive        ::= multiplicative { ( "+" | "-" ) multiplicative }
multiplicative  ::= unary       { ( "*" | "/" | "%" ) unary }
unary           ::= ( "-" | "!" ) unary | power
power           ::= postfix [ "**" unary ]
postfix         ::= primary { "." identifier | "(" arguments ")" | "[" expression "]" }
primary         ::= number | string | "true" | "false" | "nil" | identifier
                  | "(" expression ")" | array | map | function | match
array           ::= "[" [ expression { "," expression } [ "," ] ] "]"
map             ::= "{" [ entry { "," entry } [ "," ] ] "}"
entry           ::= ( identifier | keyword | string | "[" expression "]" ) ":" expression
function        ::= "fn" [ identifier ] "(" parameters ")" block
parameters      ::= [ parameter { "," parameter } [ "," ] ]
parameter       ::= [ ".." ] identifier [ "=" expression ]
match           ::= "match" expression "{" arm { "," arm } [ "," ] "}"
arm             ::= pattern { "||" pattern } [ "if" expression ] "=>" expression
pattern         ::= "_" | identifier | expression
```

`**` is right-associative and binds tighter than unary `-`, so `-2 ** 2` is
`-4`. Assignment is right-associative. Every other binary operator is
left-associative.

An assignment target must be an identifier, a member access or an index
expression; anything else is `BAA008`.

### 4.2 Evaluation order

Operands evaluate left to right, and the left operand fully evaluates before
the right one begins. Arguments evaluate left to right, after the callee.

`&&`, `||` and `??` short-circuit: the right operand is not evaluated when the
left decides the result.

For a compound assignment (`a[i] += x`), the target's object and index are
evaluated exactly once.

### 4.3 Operators on values

| Operator | Accepts | Result |
| --- | --- | --- |
| `+` | number + number | sum |
| `+` | string with nil/bool/number/string | concatenation |
| `+` | array + array | new array |
| `-` `*` `/` `%` `**` | number, number | number |
| `*` | string, number | the string repeated |
| `<` `<=` `>` `>=` | number, number or string, string | bool |
| `==` `!=` | any, any | bool (§3.3) |
| `in` | any, array/map/range/string | bool |
| `!` | any | bool (negated truthiness) |
| `-` | number | negation |
| `??` | any, any | left unless `nil` |

Any other combination is `BAA302`.

`in` tests: array membership by equality; map key presence; whether a number
falls inside a range; substring containment for strings.

### 4.4 Arithmetic errors

`/` and `%` with a zero divisor are `BAA306`. This is a deliberate departure
from IEEE-754: silently producing `inf` moves the failure far away from its
cause.

### 4.5 Indexing

`a[i]` where `a` is an array, string or range requires `i` to be a whole
number. Negative indexes count from the end (`-1` is the last element). An
index outside the bounds is `BAA304`.

`m[k]` where `m` is a map requires `k` to be a valid key type and evaluates to
`nil` when the key is absent. `m.expect(k)` raises `BAA310` instead.

### 4.6 Member access

`x.name` resolves in this order:

1. If `x` is a module: its export named `name`, else `BAA403`.
2. If `x` is a map and has the key `"name"`: that value.
3. A built-in method for the type of `x`, bound to `x`.
4. If `x` is a map: `nil`.
5. Otherwise `BAA305`.

Data taking precedence over methods on maps means adding a method to a future
version of Baa cannot change the meaning of an existing program.

Methods obtained this way are ordinary values: `const shout = "baa".upper`
followed by `shout()` is valid.

### 4.7 Calls

A call evaluates the callee, then the arguments left to right.

For a function with `r` required parameters (those with neither a default nor
`..`) and `n` parameters in total:

- fewer than `r` arguments is `BAA202`;
- more than `n` arguments is `BAA201`, unless a rest parameter is present.

Parameters bind positionally. A parameter with a default binds that default:
evaluated in the callee's scope, at call time: when no argument is supplied. A
rest parameter binds an array of the remaining arguments, possibly empty.

Because binding is positional, a parameter list must be one a caller can
satisfy. Each of the following is `BAA204`, reported at analysis time:

- a required parameter after one with a default, which no argument can reach
  without also supplying the optional one;
- any parameter after the rest parameter, which has already taken everything
  left;
- a second rest parameter;
- a default on the rest parameter, which is an empty array when nothing
  remains and so never falls back.

So `fn f(a, b = 2, ..rest)` is valid and `fn f(a = 1, b)` is not.

When the callee's definition is statically visible, arity is checked at
analysis time; otherwise at call time.

Exception: a function passed to a standard-library higher-order function is
called with its arguments truncated to its parameter count, so a callback may
ignore the extra values the library offers.

Calling a non-function is `BAA303`. Exceeding the call-depth limit (512 by
default, `--max-depth` to change) is `BAA307`.

### 4.8 Match

`match subject { ... }` evaluates `subject`, then tries each arm in order.

An arm matches when one of its patterns matches and its guard, if present, is
truthy. Patterns:

- `_` matches anything and binds nothing;
- an identifier matches anything and binds the subject under that name, visible
  in the guard and the arm body;
- any other expression is evaluated and compared with `==` (§3.3), so array and
  map literals match structurally.

The value of the expression is the value of the matching arm's body. If no arm
matches, that is `BAA301`.

## 5. Statements

```
program     ::= { statement }
statement   ::= let | function | expression-stmt | baa | return | if | while
              | for | break | continue | import | throw | try | test
let         ::= [ "export" ] ( "let" | "const" ) identifier "=" expression
function    ::= [ "export" ] "fn" identifier "(" parameters ")" block
baa         ::= "baa" [ expression { "," expression } ]
return      ::= "return" [ expression ]
if          ::= "if" expression block [ "else" ( if | block ) ]
while       ::= "while" expression block
for         ::= "for" identifier [ "," identifier ] "in" expression block
import      ::= "import" [ "{" specifiers "}" "from" ] ( identifier | string )
                [ "as" identifier ]
throw       ::= "throw" expression
try         ::= "try" block [ "catch" [ identifier ] block ] [ "finally" block ]
test        ::= "test" string block
block       ::= "{" { statement } "}"
```

A statement ends at a newline (§2.2), a `;`, a `}` or the end of the file.

### 5.1 Declarations and scope

Each block introduces a scope. A declaration is visible from its declaration to
the end of its enclosing block, and may shadow an outer binding. Redeclaring a
name in the same scope is `BAA101`.

`fn` declarations are hoisted to the top of their block, so functions may call
each other regardless of order. `let` and `const` are not: using one before its
declaration is `BAA106`.

Assigning to a `const`, a function name or an import is `BAA103`.

A `for` loop's bindings live in a fresh scope per iteration, so a closure
created inside the body captures that iteration's values.

### 5.2 `baa`

`baa e1, e2, ...` writes each value's text form, separated by a single space,
followed by a newline, to standard output. `baa` with no arguments writes an
empty line.

Text form: strings print as themselves; every other value prints as its
developer representation (`inspect`), so `baa "a"` prints `a` while
`baa ["a"]` prints `["a"]`.

### 5.3 Control flow

`return` is valid only inside a function (`BAA104`). A function that finishes
without one produces `nil`.

`break` and `continue` are valid only inside a loop in the same function
(`BAA105`); a function boundary resets the loop context.

### 5.4 `try`

`try` must have a `catch` block, a `finally` block, or both.

`catch` runs when the `try` block raises anything: a `throw` or a runtime
error. Its binding is optional; when present it receives:

- for `throw v`, the value `v` unchanged;
- for a runtime error, a map with keys `code`, `message`, `file`, `line` and
  `column`.

`finally` runs after the `try` block and any `catch`, whether the block
completed, raised, or returned.

An uncaught throw terminates the program with `BAA308` and exit code 1.

### 5.5 `test`

`test "name" { ... }` registers a test in the enclosing scope. `baa run`
registers tests without running them; `baa test` runs each registered block in
a fresh child scope and reports pass or fail.

## 6. Modules

### 6.1 Resolution

`import <identifier>` resolves, in order:

1. a standard-library module (§7);
2. a dependency declared in `baa.toml` under `[wool]`.

Otherwise `BAA401`.

`import "<path>"` resolves relative to the directory of the *importing file*.
If the path has no `.baa` extension, `<path>.baa` is tried first, then the path
as written.

### 6.2 Binding

Without `as`, the local name is the module name for a standard module, or the
file's stem for a path (`"./flock/pen.baa"` binds `pen`). `as name` overrides
it. Named imports (`import { a, b as c } from m`) bind each name individually;
an absent export is `BAA403`.

### 6.3 Evaluation

A module's top-level statements execute once, the first time it is imported,
in a fresh scope whose parent is the global scope. Its exports are the values
of its `export`ed declarations *after* that execution.

A module that is imported while it is still being evaluated is `BAA402`; Baa
does not produce partially-initialised modules.

## 7. Standard library

Seven modules: `wool` (text), `flock` (collections), `ram` (arithmetic),
`meadow` (time and randomness), `pasture` (files and paths), `shepherd`
(process and environment), `lamb` (JSON), `gate` (web requests and replies).
Every function is documented in
[docs/stdlib.md](docs/stdlib.md).

The prelude, available without an import, is `len`, `type_of`, `to_string`,
`to_number`, `inspect`, `clone`, `assert`, `assert_eq`, `panic` and `exit`.
Prelude names may be shadowed by a local declaration.

## 8. Diagnostics

Every diagnostic has a stable code of the form `BAAnnn`. Codes never change
meaning; new diagnostics take new numbers.

| Range | Meaning |
| --- | --- |
| `BAA0xx` | Lexical and syntax errors |
| `BAA1xx` | Name resolution and scope |
| `BAA2xx` | Calls, arity and parameters |
| `BAA3xx` | Runtime |
| `BAA4xx` | Modules, project and manifest |
| `BAA9xx` | Lints (warnings; never fatal) |

Each diagnostic has two wordings: sheep-flavoured by default, neutral under
`--no-baa`, `BAA_NO_BAA=1` or `CI=true`. Code, severity, source span and
technical content are identical in both. The full catalogue is in
[docs/errors.md](docs/errors.md).

## 9. Execution model

`baa run f.baa` performs: read → lex → parse → resolve → execute. Analysis
errors prevent execution entirely; a program never runs half-checked.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | The program or the check failed |
| 2 | The command line was wrong |
| *n* | `exit(n)` called by the program |
| 70 | Internal error in Baa itself, please report it |

Evaluation is single-threaded and deterministic apart from `meadow.now`,
`meadow.random` and the host environment. `baa run --seed N` makes `meadow`'s
randomness reproducible.

### 9.1 Implementation limits

An implementation may impose limits, but must report reaching one as an
ordinary diagnostic rather than failing in terms of the language it is written
in. Three are specified because programs can observe them:

| Limit | Default | Diagnostic |
| --- | --- | --- |
| Nesting depth of expressions and blocks | 400 | `BAA011` |
| Call depth | 512, `--max-depth` to change | `BAA307` |
| Items in one constructed string or array | 10,000,000 | `BAA312` |

The last covers anything sized by a value the program supplies: `repeat`,
`pad_start`, `pad_end`, `wool.center`, `flock.repeat`, `flock.range`, `..`
materialised with `to_array`, and `"x" * n`.

## 10. Deliberate omissions

Baa 0.1 has no classes, no inheritance, no interfaces, no operator
overloading, no implicit numeric coercion, no `null` distinct from `nil`, no
variadic call spreading (`f(..args)`), no destructuring in `let` or in `match`
patterns, and no concurrency. Each of these was left out to keep the core small
enough to learn in an afternoon; the ones with a plan are listed in
[ROADMAP.md](ROADMAP.md).

Anything not described in this document is unspecified rather than guaranteed.
Programs should not rely on the behaviour of constructs the specification does
not mention.

---

*Baa 0.1: this specification tracks the implementation in this repository.*
