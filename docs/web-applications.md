# Web applications in Baa

Baa applications are **server-rendered**. A request arrives, a Baa program
runs, it writes HTML, the process exits. That is the whole model, and it is
worth being precise about it before building anything, because it decides what
an application can and cannot be.

There is a live one: **<https://sheep.grimtech.co.uk/baa/apps/calculator/>**.

## What exists, and what does not

| | |
| --- | --- |
| Reading a request | `gate`: method, path, query, form, headers, cookies |
| Writing a reply | `gate`: status, headers, HTML, JSON, redirects |
| HTML | Built as strings, escaped at the value boundary |
| CSS | An ordinary stylesheet, served as a static file |
| Application state | Carried in the request: form fields, query, cookies, or a file |
| Persistence | `pasture` for files, `lamb` for JSON |
| Running it | `baa serve` locally, CGI on a host |

**There is no browser runtime.** Nothing in Baa touches a DOM. There is no
`document`, no `addEventListener`, no `fetch`, no `localStorage`, no
`setTimeout`. A `.baa` file is not loaded by a browser and does not execute in
one.

The playground compiles Baa's *interpreter* to JavaScript so that Baa source
can be run on a web page, but a program running there still has no way to reach
the page it is running on. It reads no input and writes to standard output.

So "an interactive application" here means what it meant before client-side
scripting: forms, links, and a server that answers. That is a real constraint
and it is also a real capability. The calculator is proof: it has state,
history, keyboard entry, error handling and precedence, and it contains no
JavaScript at all.

## The shape of an application

```
examples/apps/calculator/
  index.baa        the page: reads the request, writes the reply
  expression.baa   the logic: no `gate`, no HTML, just Baa
  style.css        served as a static file
  tests/           `baa test` runs these
```

The split is the important part. `expression.baa` imports no `gate` and knows
nothing about the web, so it can be tested directly:

```sh
baa test examples/apps/calculator/tests
```

That is also how the build tool decides what to publish: a file that imports
`gate` is a page and gets a shebang, and a file that does not is a module and
does not, so the server has nothing to execute if somebody requests it.

## State

An application has no memory between requests, because each request is a new
process. State has to travel. The calculator carries its own in the form:

```baa
const form = gate.form()
const key = form.get("key", "")
let expression = form.get("expression", "")
let history = read_history(form.get("history", ""))
```

Every button is a submit button with a `name` and a `value`, so a press is a
form submission and the server decides what the next state is. Nothing is
hidden, nothing is reactive, and the whole of the application's behaviour is
one pass of straight-line code.

The alternatives, in rough order of how much you should want them:

| Where | Good for | Cost |
| --- | --- | --- |
| Form fields | Small state belonging to one page | Travels on every request |
| Query string | State worth bookmarking or sharing | Visible, and length-limited |
| Cookies | State that should outlive a page | Sent on every request; needs care |
| A file (`pasture`) | State shared between visitors | Concurrency is yours to handle |

## Escaping

`gate.format` and `gate.fill` escape every value they interpolate. That makes
them right for values and wrong for markup:

```baa
// Right: the value is escaped, the tags are not.
gate.format("<li>%s</li>", name)

// Wrong: renders the tags as visible text.
gate.format("<div>%s</div>", already_built_html)
```

Compose markup by concatenation and escape at the boundary where a value enters
the page:

```baa
"<input value=\"" + gate.escape(expression) + "\">"
```

`gate.html` writes exactly what it is given, so anything reaching it must
already be escaped. This is the one rule in the model that is easy to get
wrong, and getting it wrong is a cross-site scripting hole rather than a
cosmetic bug.

## What this model is bad at

Honestly, so that nobody discovers it the hard way:

- **Anything needing sub-second interactivity.** Every interaction is a round
  trip and a process start. Dragging, live validation as you type, or a canvas
  are not going to work.
- **Anything holding a connection.** No websockets, no server-sent events, no
  polling loop that costs nothing.
- **Client-side keyboard shortcuts.** A text field and the Enter key work,
  because the browser provides them. Intercepting a keypress does not.
- **Scale.** One process per request is the simplest thing that works and the
  reason it does not go fast under load.

If an application genuinely needs those, it needs client-side code, and Baa has
no way to be that code today. Saying so is more useful than pretending
otherwise.

## Testing

Application logic that avoids `gate` is testable with the ordinary test runner,
which is the argument for keeping it out of the page file. The calculator's
arithmetic has twelve tests covering precedence, decimals, negatives, division
by zero, empty input and text that is not arithmetic at all.

Behaviour that needs a request is testable by running the page with the CGI
environment set, which is what `baa serve` does for you.

## Deploying

`tools/build-cgi.ts` writes `website/baa/`, including every application under
`examples/apps/`. The full procedure, and the three things that are easy to get
wrong, are in [web.md](web.md).
