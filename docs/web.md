# Writing web pages in Baa

A Baa program can answer an HTTP request. `index.baa` is a page: it runs when
somebody asks for the URL, and whatever it writes to standard output is the
reply.

There is a complete working site in [`examples/site/`](../examples/site/), with
screenshots. This document is the reference.

```baa
import gate

gate.fill("<h1>Baa, %s!</h1>", gate.query().get("name", "world"))
```

```sh
baa serve examples/site
```

## How it works: CGI

The protocol is CGI, and that is not a compromise. A Baa program is a
short-lived synchronous process that reads its environment, reads standard
input and writes standard output. That is precisely the shape CGI asks for, so
`gate` is a reading of things Baa could already do rather than a new
capability. Nothing in it opens a socket.

The practical consequences:

- **It runs on shared hosting.** Apache has run CGI for thirty years, and every
  cPanel account can do it. No process manager, no reverse proxy, no port.
- **`baa serve` is a preview, not a simulation.** It sets the same environment
  variables Apache sets and parses the same reply, so a page that works locally
  works on the host.
- **Nothing is stateful.** Each request is a fresh process that remembers
  nothing. That is the simplest thing that can work, and the reason it scales
  badly: a page costs a process start.

If you need to hold state between requests, put it in a file (`pasture`) or a
database you talk to over a subprocess (`shepherd.run`). Baa has no connection
pool, because it has nothing to pool a connection across.

## `baa serve`

```sh
baa serve [dir] [--port <n>] [--host <address>]
```

Runs a directory of pages for development. One process per request, a ten
second limit per page, and it binds to `127.0.0.1` unless told otherwise.
**Do not put it on the internet.**

URLs map to files like this:

| Request | Runs |
| --- | --- |
| `/` | `index.baa`, then `index.html` |
| `/about` | `about.baa`, then `about.html` |
| `/sheep/Shaun` | `sheep.baa`, with `/Shaun` as the path below the script |
| `/style.css` | Served as a static file |

Anything resolving outside the served directory is refused, `..` included.

## The `gate` module

### Reading the request

| Function | Gives you |
| --- | --- |
| `gate.method()` | `"GET"`, `"POST"`, ... always uppercase |
| `gate.path()` | The path below the script, or `"/"` |
| `gate.query()` | The query string as a map, percent-decoded |
| `gate.query_string()` | The raw, undecoded query string |
| `gate.form()` | A urlencoded body as a map |
| `gate.body()` | The raw request body as text |
| `gate.header(name[, fallback])` | One request header, by its ordinary name |
| `gate.headers()` | Every request header as a map |
| `gate.cookies()` | The `Cookie` header as a map |

Repeated keys keep the last value. A key with no `=` maps to an empty string,
so `?debug` is visible to `has("debug")`. Malformed percent-encoding keeps its
raw text rather than failing: a request is not the program's fault, and a page
that dies on `%zz` is one an attacker can take down with a single URL.

The body is read at most once and is capped at 8 MB. `CONTENT_LENGTH` comes
from the client, so an unbounded read would be an allocation an attacker
chooses.

### Writing the reply

| Function | Does |
| --- | --- |
| `gate.status(code)` | Set the status. Before the reply starts |
| `gate.set_header(name, value)` | Set a header. Before the reply starts |
| `gate.html(text)` | Reply with HTML, **exactly as given** |
| `gate.fill(template, ...)` | Reply with HTML, **escaping each `%s`** |
| `gate.text(value)` | Reply with `text/plain` |
| `gate.json(value)` | Reply with JSON |
| `gate.redirect(url[, code])` | Reply with a redirect, 303 by default |
| `gate.format(template, ...)` | Build escaped HTML without sending it |
| `gate.escape(value)` | Escape one value for HTML |
| `gate.safe_url(url[, fallback])` | The URL if its scheme is safe, else `"#"` |

The status and headers go out with the first thing that writes a body, so they
have to be set first; doing it afterwards is an error rather than a silent
no-op. A header value containing a line break is refused, because that would
let request data inject headers or a whole second response.

## Escaping

This is the part to get right, so it has its own section.

**Anything that came from the request is the visitor's text, not yours.**
Putting it into a page unescaped is how a page gets a cross-site scripting
hole in its first line.

```baa
// Wrong. `name` came from the query string.
gate.html("<h1>Baa, " + name + "!</h1>")

// Right. `fill` escapes every value it puts into a `%s`.
gate.fill("<h1>Baa, %s!</h1>", name)
```

`gate.fill` and `gate.format` are deliberately the same shape as
`wool.format`, so the safe one is no harder to write than the unsafe one.
`wool.escape_html` is the primitive underneath if you need it directly.

Five characters are escaped: `&`, `<`, `>`, `"` and `'`. The last two matter
because a value dropped into an attribute escapes its quoting without them.

### Escaping is not the same as a safe link

`escape_html` makes a value safe to **display**. It says nothing about where a
link **goes**:

```baa
gate.format("<a href=\"%s\">click</a>", "javascript:alert(1)")
// <a href="javascript:alert(1)">click</a>
```

Nothing there needed escaping, and it still runs when clicked. A URL that came
from a request needs its scheme checked as well:

```baa
gate.format("<a href=\"%s\">click</a>", gate.safe_url(url))
// <a href="#">click</a>
```

`wool.safe_url` allows relative URLs and the `http`, `https`, `mailto`, `tel`
and `ftp` schemes, and returns `nil` for everything else; `gate.safe_url`
substitutes a fallback instead. Whitespace and control characters are stripped
before the scheme is read, because browsers ignore them inside a URL and
`java<tab>script:` would otherwise pass.

### What is still your job

`gate` escapes for HTML text and attributes. It does not know about:

- **Inside `<script>`.** Do not build JavaScript from request data. If a page
  needs to pass data to a script, put it in a `data-` attribute and read it
  from there.
- **Inside CSS.** Same answer.
- **SQL, shell, file paths.** Different problem, different escaping.
  `shepherd.run` never uses a shell, which removes one of these by design.

## Putting a page on a real host

There is a live example: **<https://sheep.grimtech.co.uk/baa/index.baa>**. That
page is the `index.baa` in [`examples/site/`](../examples/site/), running per
request on ordinary cPanel shared hosting. Everything below is how it got
there, including the parts that are not obvious.

`tools/build-cgi.ts` does all of it for you:

```sh
BAA_CGI_BIN=$(dirname $(which baa)) BAA_CGI_DIR=/home/you/public_html/example.com/baa node tools/build-cgi.ts
```

That writes `website/baa/`: the pages, a wrapper, an `.htaccess`, a diagnostic
page and a README. Upload it, `chmod 755 *.baa baa-cgi`, and open `probe.baa`.

### Doing it by hand

Three pieces, in the order they bite.

**The handler.** In the directory holding the pages:

```apache
Options +ExecCGI
AddHandler cgi-script .baa
DirectoryIndex index.baa
```

Keep it to directives every server has. An `.htaccess` containing one the
server does not recognise, such as `Header` without `mod_headers`, makes every
request in that directory a 500 whatever the page does, and the error reads as
a fault in the program.

**The wrapper.** Pages should point at a small shell script rather than at
`baa`:

```sh
#!/bin/sh
PATH="/home/you/.nvm/versions/node/v22.23.2/bin:$PATH"
export PATH
exec "/home/you/.nvm/versions/node/v22.23.2/bin/baa" "$@"
```

`baa` is itself a Node script beginning `#!/usr/bin/env node`, so running a
page starts a chain: the page names `baa`, and `baa` asks the environment for
`node`. An interactive shell has that directory on its `PATH` and the chain
resolves. CGI runs with a minimal `PATH` and it does not, which is a page that
works perfectly from a terminal and returns 500 in a browser with nothing in
the error log.

Naming node and Baa's entry point together in the shebang avoids the extra
file, but Linux reads at most 128 bytes of a shebang line and silently
truncates the rest, which two `nvm` paths comfortably exceed.

**The pages.** Each needs the wrapper's absolute path on its first line, and
the executable bit:

```baa
#!/home/you/public_html/example.com/baa/baa-cgi
import gate

gate.html("<h1>Baa</h1>")
```

```sh
chmod 755 *.baa baa-cgi
```

Baa skips a `#!` line at the very start of a file and `baa fmt` preserves it,
so the same file still runs under `baa run` and `baa serve`. Note that FTP
resets permissions on every upload, so the `chmod` has to be repeated.

### Links, and where the site lives

A page cannot assume it sits at the root of a domain. Write links against the
directory the page is being served from, which CGI supplies as `SCRIPT_NAME`:

```baa
export fn base() {
    const parts = (shepherd.env("SCRIPT_NAME") ?? "/").split("/")
    return parts.slice(0, parts.length() - 1).join("/") + "/"
}
```

At `/index.baa` that gives `/`, and at `/baa/index.baa` it gives `/baa/`. The
example site uses it for every link, which is why the same files serve from
`baa serve` at the root and from a subdirectory on a host.

Link to the page file rather than to a pretty path. Apache maps a URL to a file
and will not invent the extension, so `/sheep.baa/Shaun` works and
`/sheep/Shaun` does not without a `mod_rewrite` rule. Everything after the
script name is `PATH_INFO`, which `gate.path()` reads. `baa serve` accepts both
spellings.

### When it does not work

Open the diagnostic page first. It answers the question worth asking before any
other, which is whether the server ran a Baa program at all.

| Symptom | Cause |
| --- | --- |
| The source downloads | The handler is not applied, or the file is not executable |
| 403 | `ExecCGI` is off for the directory; some hosts require it via their panel |
| 500, and the page works from a shell | `PATH`, an unrecognised `.htaccess` directive, or suEXEC |

For that last row, reproduce the `PATH` case directly:

```sh
env -i ./probe.baa
```

An empty environment is what CGI approximates. If that fails and `./probe.baa`
succeeds, the wrapper is missing or wrong. suEXEC refuses a script whose
directory anyone but the owner can write to, so check `ls -ld .` shows `755`
rather than `775`.

## What Baa does not have

No sessions, no cookie *setting* helper, no `multipart/form-data` parsing (use
`gate.body()` and do it yourself), no templating language, no router beyond
mapping URLs to files, no database driver, and no concurrency.

This is enough to write a small site and honest about being no more than that.
See [ROADMAP.md](../ROADMAP.md).
