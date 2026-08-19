# Changelog

All notable changes to Baa are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Baa follows [semantic versioning](https://semver.org/) from 1.0; before then,
minor versions may change the language, and every such change appears here with
a migration note.

## [0.8.0], 2026-08-19

The tooling release: Baa's diagnostics can be read by a program, its formatter
can show its work, its checker can stay running, and a program can be given
less than the shell that started it.

### Added

- **`--format json` on `check`, `lint` and `fmt`.** One JSON object on stdout
  per run, carrying every diagnostic with its stable code, both wordings, file,
  range, notes, help and trace. It is a second *presentation* of the same
  `Diagnostic` values the terminal renders — nothing parses formatted text — so
  JSON cannot report a problem the terminal would not, or miss one it does. One
  line per run, so a log of reports is also valid JSON Lines. The schema is
  documented in [docs/diagnostics-json.md](docs/diagnostics-json.md) and
  versioned: within a version, fields are added and never removed.

  `run` and `test` refuse the flag with `BAA301`. Their stdout belongs to the
  program, and a report written into that stream could not be told apart from
  what the program printed.

- **`baa fmt --diff`.** A unified diff of what formatting would change, without
  changing it. Exits exactly like `--check`, and prints nothing at all for a
  file that is already formatted, so any output means "this would change".

- **`baa check --watch`.** Re-checks only what changed: 92 ms cold on a
  200-file project, 12 ms after one edit. There is no dependency graph, and
  that is not a shortcut — Baa's analysis is per-file, because a module's
  diagnostics do not depend on the modules it imports, so a graph would always
  report no dependents. Changing `baa.toml` drops the whole cache, since it
  decides which module names are importable.

- **Capability flags on `baa run` and `baa test`**: `--deny-fs`,
  `--deny-fs-write`, `--deny-env`, `--deny-process`. They wrap the host rather
  than auditing the standard library, so an allowed operation is untouched and
  a denied one raises the new `BAA313` where it happens, which a program can
  catch. Nothing is denied by default.

  `--allow-fs <dir>` confines rather than refuses, and is repeatable. A path is
  judged by where it leads: resolved first, so `..` cannot climb out, and with
  the part of it that exists followed to its real location, so a link inside an
  allowed directory cannot point out of one.

  There is deliberately no `--deny-network` — Baa cannot open a socket, and a
  flag denying a capability the language lacks would suggest the others are the
  same gesture — and no `--deny-randomness`, because `--seed` already does what
  that usually means. [SECURITY.md](SECURITY.md) says what this claims and what
  it does not.

- **Application icons and version metadata on Windows.** `[app] icon` points at
  an `.ico`, and `title`, `version`, `company` and `copyright` fill in the
  Details tab of the executable's Properties. Written into the PE by hand,
  because the build has no linker: a section header after the last one, the
  bytes at the end of the file, three numbers corrected. It refuses rather than
  guessing on anything it does not recognise.

- **Timers in `barn`**: `barn.every(millis, handler)`, `barn.after(millis,
  handler)` and `barn.cancel(id)`. Ticks arrive on the event loop, in the same
  single thread as every other handler, so there is no second concurrency model
  to reason about: a handler that takes 200ms delays the next tick rather than
  overlapping it. The handler is called with the timer's id, so a timer can stop
  itself, and `after` cancels itself once it has fired.

  `examples/native/clock` is a stopwatch built on it, and a test drives the real
  event loop on a real window: three ticks, a cancel from inside the handler,
  then a one-shot that quits.

- **`baa doc`**, a Markdown reference for everything a project exports, from the
  `///` comments the parser already keeps for the language server's hovers.
  `--out` writes a file, `--check` fails when that file is stale, and the output
  is deterministic so `--check` in CI means something.

- **Nine standard-library functions, in both runtimes.** `pasture.walk`,
  `pasture.glob` and `pasture.matches`; `flock.union`, `flock.intersect`,
  `flock.difference` and `flock.is_subset`; `meadow.duration` and
  `meadow.format_duration`. `meadow.parts` and `meadow.iso` take an optional
  UTC offset in whole minutes, and the ISO text then ends in `+01:00` rather
  than lying with `Z`.

  The glob subset is `?`, `*` and `**` and nothing else. There are no time-zone
  *names*: an offset is a fact about an instant, while a zone name is a rule
  that changes twice a year and needs a database shipping updates.

### Changed

- **Reading a variable is an array index.** The resolver records how many
  scopes out each name lives and which position it holds there; `Environment`
  keeps its bindings in declaration order. Measured back to back on one
  machine, best of three: 300k loop iterations 56.0 ms → 46.6 ms,
  `map`/`filter`/`sum` 42.1 ms → 36.1 ms, `fib(22)` unchanged within noise,
  because a call defines its parameters and that bookkeeping offsets what its
  lookups save.

  The slot carries the name it was resolved from and is checked before it is
  trusted: a disagreement falls back to the name walk rather than reading the
  wrong binding, and a test asserts the fallback never fires. Nothing about the
  language changed, and the native runtime is untouched — the image format
  carries no slots.

- `docs/stdlib.md` now carries prose beside the signatures where a one-line
  description cannot carry the rules, which is how the glob subset and the
  offset range are published.

### Fixed

- **`shepherd.run` bypassed the capability boundary.** It called
  `child_process` directly, so the most dangerous operation in the language was
  the one operation `RuntimeHost` could not see — while `host.ts` claimed
  everything went through it. It now goes through `host.runProcess`, still
  without a shell, and a test asserts the module does not import
  `child_process` at all.

- `baa check --watch` installs its watcher before the first sweep rather than
  after it, so an edit that lands during a long first check is not lost.

[0.8.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.8.0

## [0.7.1], 2026-08-19

### Fixed

- **The marketplace listing had no description.** The extension published as
  0.7.0 was built before the README and icon existed, so its page read "No
  README available" — the package on disk carried both by then, and the upload
  did not. A version cannot be replaced once published, so this is the release
  that carries them.

  The same version number therefore existed as two different packages, which is
  the actual lesson: `vsce publish --packagePath` uploads whatever file it is
  handed, and nothing checks that the file matches the working tree it was
  named from. The release workflow builds the package it publishes in the same
  job, so it cannot drift.

[0.7.1]: https://github.com/PatrickJnr/sheep/releases/tag/v0.7.1

## [0.7.0], 2026-08-18

The native runtime is published, so building a desktop application no longer
means installing Rust.

### Added

- **Prebuilt native runtimes on every release.**
  `baa-native-windows-x64.tar.gz` carries `baa-native.exe` and
  `baa-nativew.exe`; `baa-native-linux-x64.tar.gz` carries `baa-native`. Each
  archive has a `sha256` beside the binaries, because an artefact nobody can
  verify is an artefact nobody should run. CI has compiled the runtime on both
  platforms every commit since 0.4.0 and thrown the result away.

  Unpack one into `~/.baa/runtime` and `baa app build` finds it. That directory
  is searched before any checkout, so a downloaded runtime cannot be shadowed
  by a stale `cargo build` in a clone. When no runtime is found, the message
  names the archive for the platform it is running on.

- **`BAA_SERVER_PATH`** points the VS Code extension at a language server, for
  the places with no settings UI to type one into: a container, a CI job, a
  remote host started by a script. The `baa.server.path` setting still wins.

### Changed

- **A Linux build that imports `barn` now warns.** The window model is
  platform-independent and only Windows has a backend, so the executable is
  real, runs, and cannot draw. Saying that at build time is the difference
  between a documented limit and a program somebody ships and then discovers.
  A test asserts the CLI only ever offers a download the release workflow
  actually builds, so the link cannot outlive the job that produces it.

### Fixed

- **The VS Code integration test could not pass on a hosted runner.** It
  assumed a global npm install puts `baa` on `PATH`, which is true on a
  developer's machine and not on a runner, so the job failed for being right
  about the wrong thing. The logic that matters — deriving the server's entry
  point from the shim, because Node will not spawn a `.cmd` — is now a module
  with no `vscode` import, tested against a fake filesystem.

[0.7.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.7.0

## [0.6.0], 2026-08-18

VS Code gets the language server it has been able to run for two releases.

### Added

- **A VS Code extension that actually starts `baa lsp`.** Diagnostics as you
  type, formatting, an outline, hover, go to definition, find references and
  rename — all from the same analysis `baa check` runs, with no configuration
  when `baa` is on `PATH`. Install the `.vsix` attached to this release with
  `code --install-extension baa-lang.vsix`.

  The extension implements no language intelligence of its own, and a test
  asserts it registers no providers: a second opinion about what a program
  means is worse than no opinion.

- **An integration test that launches a real VS Code**, loads the extension,
  opens a `.baa` file and checks that `BAA102` arrives on the right range, that
  formatting returns edits and that go to definition lands on the declaration.
  `npm run test:vscode` in `editors/vscode`, and a CI job on Windows.

  It earned itself immediately. `npm install -g` writes `baa.cmd` on Windows,
  and since CVE-2024-27980 Node refuses to spawn a `.cmd` without a shell, so
  the obvious implementation found nothing on the platform most people use and
  failed silently. `shell: true` would have been re-opening that hole; the
  extension resolves the JavaScript entry npm installed beside the shim and
  runs it under the editor's own Node.

- **The `.vsix` is built by CI** and attached to every release, since the
  extension is not on the marketplace and there is no publisher to trust.

### Changed

- `actions/checkout` and `actions/setup-node` moved from v4 to v7. Both were
  targeting Node 20 and being forced onto Node 24 with a warning on every run.

[0.6.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.6.0

## [0.5.0], 2026-08-18

An audit release. The largest gap between Baa's two runtimes is closed, and
three things the documentation asserted turned out not to be true — including
one the tooling had been asserting louder.

### Added

- **`shepherd` and `meadow` in the native runtime.** An application can read
  its own command line, its environment and standard input, start a program
  without a shell, ask what time it is, and shuffle a list. Both modules match
  the reference function for function and arity for arity, and the calendar
  arithmetic is written out rather than pulled in, so the crate still has no
  dependencies.

  With them, **all 50 conformance programs run on the native runtime and all 50
  pass**. Nothing is skipped.

  One case is refused rather than approximated. `meadow.parse_iso` on a
  date-time with no zone — `2026-08-18T09:30` — means *local* time in
  JavaScript, so the same program would produce a different number on a machine
  in a different place. The native runtime raises `BAA301` naming the fix. Text
  with `Z` or an explicit offset, and date-only text, are read identically by
  both.

- **A drift guard over every native module**, not just `barn`. It compares each
  module's function names and argument counts against the reference
  implementation's own module objects, so a function that quietly takes one
  argument fewer on one side fails a test rather than a program.

- **`/llms.txt` and `/llms-full.txt`**, generated by `tools/gen-llms.ts` from
  the same catalogue the compiler reads. Every standard-library signature, the
  rule that decides whether a file is a web page or a native application, which
  modules exist on which target, and the mistakes that compile and do the wrong
  thing. The examples in them are compiled by the test suite and
  `npm run gen:check` fails when the published copy is stale, because a wrong
  signature handed to a language model produces code that cannot run and gives
  it no way to notice.

### Fixed

- **The language tour contained a truncated copy of itself.** A `$` inside a
  shell heredoc ate the rest of a sentence about regular-expression flags, and
  the whole document landed in the gap, so
  [LANGUAGE.md](LANGUAGE.md) introduced itself twice and one explanation
  stopped mid-clause. It shipped that way in the npm package and on the website
  for two releases, because every link still resolved and the duplicate was
  valid Markdown. The document is repaired and a test now asserts that no
  document states its own title twice.

- **A skipped conformance program was counted as a pass.** The native
  conformance harness marked a program it had decided not to run as passing, so
  its summary line read `50/50` when 49 programs had executed. The
  documentation had said 49 all along; the tool contradicted it and the tool
  was believed.

  Skips are counted separately now, printed as `SKIP` under `--verbose`, and a
  test asserts a skip can never become a pass. With `shepherd` and `meadow`
  landing in this same release the count is genuinely 50 of 50, which is the
  point: the number is true rather than reworded.

- **Heading anchors matched neither GitHub nor themselves.** The site's slug
  generator collapsed a run of spaces into one hyphen where GitHub emits one
  per space, so a link to a heading such as `Goal — **NEXT**` worked in one
  renderer and 404'd in the other. It now uses GitHub's algorithm.

- **A web-page module answered 500 with the server's absolute path.** A `.baa`
  file the CGI handler could not execute was still claimed by
  `AddHandler cgi-script .baa`, which matches by extension regardless of
  permissions. Modules now deploy as `.baalib`, which the handler does not
  claim, with `RedirectMatch 403` refusing them outright.

- **Two CI checks believed things that had not happened.** The test-count check
  counted an environment rather than a suite, and treated a site build that had
  silently skipped as a build that had succeeded.

### Changed

- **The documentation index lists every page**, including the web and native
  application guides and the files written for language models, and reads its
  module and diagnostic counts out of the implementation rather than stating
  them by hand.

[0.5.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.5.0

## [0.4.0], 2026-08-18

Baa runs in a second place. A `.baa` file has always been a web page, executed
by a server per request; it is now also a desktop application, held open by a
runtime that draws a real window. Nothing about the language changed to make
that true.

### Added

- **Native applications.** `baa app new | build | run | test` turns a project
  into a single Windows executable containing the runtime and the program. No
  Node.js on the machine that runs it, no browser inside it, no unpacking.

  The architecture, and the reasoning for it, is in
  [ARCHITECTURE.md](ARCHITECTURE.md#native-applications). In short: the
  reference implementation stays the only frontend. `baa app build` runs
  exactly the analysis `baa check` runs, writes the resolved tree into a
  `.fleece` image, and appends that image to a runtime written in Rust. One
  frontend cannot disagree with itself, and a program that fails `baa check`
  produces no executable.

- **`barn`**, the ninth standard-library module: windows, rows and columns with
  weights, labels, buttons, inputs, text areas, lists, checkboxes, a real menu
  bar, message boxes, file dialogs, the clipboard, and per-monitor DPI so text
  is sharp on a scaled display rather than stretched.

  It is `gate`'s opposite number — a program imports one or the other — and
  importing `gate` into an application is a build error naming it. `barn`
  exists in the reference implementation too, where every function reports that
  it needs the native runtime, so that `baa check`, the linter and the language
  server all work on an application's source.

- **The native runtime**, `rust/crates/baa-native`: a tree-walking interpreter
  in Rust with no dependencies at all, including its own JSON parser and its
  own Win32 declarations. It implements `barn`, `flock`, `lamb`, `pasture`,
  `ram` and `wool`, and **passes every one of the 49 conformance programs it
  can run, byte for byte**. The fiftieth imports `shepherd`, which it does not
  have, and the harness reports that as a skip.

- **Three applications that are also the tests.**
  [`examples/native/calculator`](examples/native/calculator) imports the *web*
  calculator's arithmetic module unchanged — the same tokeniser and
  precedence-climbing parser, the same tests, two front ends.
  [`examples/native/notepad`](examples/native/notepad) is a text editor with
  menus, file dialogs and unsaved-change tracking derived from the text rather
  than from a flag.
  [`examples/native/json-viewer`](examples/native/json-viewer) parses a
  document and walks the result into an outline. All three are driven through
  Win32 by the test suite, which sends the messages a click actually is and
  reads back what the window says.

- **Documentation**: [native applications](docs/native-applications.md),
  [`barn`](docs/gui.md), [application projects](docs/application-projects.md),
  [building for Windows](docs/building-windows-apps.md) and
  [the runtime's insides](docs/native-runtime.md), plus `tools/bench-native.ts`
  so the numbers in them can be checked rather than believed.

### Changed

- **A newline inside `{` ends a statement again, even inside `(`.** The lexer
  counted open brackets and suppressed every newline while any `(` or `[` was
  open. That made a multi-line function literal impossible to pass as an
  argument:

  ```baa
  on(button, "click", fn() {
      state = next(state)
      refresh()          // BAA006: expected the end of the statement
  })
  ```

  It now tracks which bracket is innermost: `(` and `[` suppress newlines, `{`
  restores them. The rule in [SPEC.md §2.2](SPEC.md) is corrected to match.

  **Migration:** nothing. The whole test suite passed unchanged, because the
  old behaviour had no use — it turned working-looking code into a syntax error
  reported against the wrong line. Map literals are unaffected: their entries
  end in `,`, which a different rule already covers.

### Fixed

- `baa app build` over a running application says "it is running" rather than
  printing `EBUSY: resource busy or locked` and a Node stack trace.

[0.4.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.4.0

## [0.3.2], 2026-08-18

### Changed

- **A page costs less to serve.** The CLI imported the language server, the
  development HTTP server and the REPL at module scope on every invocation.
  Each is needed by exactly one command, and `lsp` pulls in the whole analysis
  stack. That is invisible when a command runs once on a developer's machine
  and is paid on every request under CGI, where each request is a fresh
  process.

  All three are imported at their call site now. Measured by building the
  previous commit into a worktree and running both alternately, so drift in the
  machine hit each equally: what Baa adds to a request fell from 217ms to
  161ms, a 26% cut. What remains is the lexer, parser, runtime and standard
  library, which a page genuinely needs.

### Fixed

- **The example site works wherever it is mounted.** Every link was
  root-absolute, so a deployment under a subdirectory rendered its pages and
  broke its stylesheet and every link. `layout.baa` exports `base()`, which
  reads CGI's `SCRIPT_NAME` and returns the directory the page is served from,
  and every link goes through it. Nothing has to be configured.
- **`baa serve` accepts a URL that names the page file.** Its walk-up looked
  for the rest of a path under `<name>.baa` and never considered that the URL
  might already say `.baa`. Apache maps a URL to a file and will not invent the
  extension, so the spelling a deployed site has to use was the one the
  development server rejected.

[0.3.2]: https://github.com/PatrickJnr/sheep/releases/tag/v0.3.2

## [0.3.1], 2026-08-18

### Fixed

- **`baa page.baa` runs the file.** A page executed by its shebang arrives as
  `baa /path/to/page.baa`, because the kernel appends the script to the
  interpreter's arguments. The CLI looked for a subcommand of that name and
  reported `Unknown command`, so every CGI page was a 500 and every
  `./script.baa` failed, with an error blaming the part that was correct.

  A first argument ending in `.baa`, or naming something that exists, is now
  run. Anything else still gets the command list, so a mistyped `buidl` is not
  reported as a missing file. Remaining arguments reach the program through
  `shepherd.args()`.

  This also makes `baa hello.baa` work without `run`, the way `python x.py`
  does.

### Added

- `tools/build-cgi.ts` generates `website/baa/`: the example site with the
  shebang, `.htaccess` and a diagnostic page a real web server needs. The
  interpreter path differs on every host, so `BAA_CGI_SHEBANG` sets it.

[0.3.1]: https://github.com/PatrickJnr/sheep/releases/tag/v0.3.1

## [0.3.0], 2026-08-18

### Added

- **Go to definition, find references and rename**, in the language server.
  All three read the resolver's symbol table rather than the text, so a
  binding that shadows an outer one of the same name is a different symbol:
  renaming the inner `count` in a function rewrites its own uses and leaves the
  outer `count` alone. A search and replace would touch both.
- **Prepare-rename**, so an editor can refuse a rename before prompting for a
  name. Rename itself rejects anything the lexer would not accept as an
  identifier, rather than writing a file that no longer parses.
- `ResolveResult` now carries `symbols`, and each `SymbolInfo` carries
  `references`: the span of every use that binds to that declaration. The
  resolver already decided this while checking for unused bindings; it simply
  threw the positions away afterwards.
- `CheckResult.analysis` exposes that from `check` and `lint`.

### Changed

- **Hover is scope-aware.** It resolved names against the file's top-level
  declarations, so a local sharing a name with a top-level function showed that
  function's documentation. It now asks the symbol table first.
- `lint` no longer resolves the program twice. It re-ran the whole resolver to
  get an analysis that `check` had already produced, which an editor paid for
  on every keystroke.

[0.3.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.3.0

## [0.2.2], 2026-08-18

### Fixed

- **The installed `baa` command did nothing and exited successfully.** npm
  installs a bin as a symlink, so running `node_modules/.bin/baa` gives an
  `argv[1]` pointing at the link while `import.meta.url` points at the file it
  targets. The entry-point check compared the two directly, decided it was
  being imported rather than run, and skipped `main` entirely. Both sides are
  now resolved through `realpathSync`.

  Windows hid it: there npm writes a `.cmd` shim that invokes node with the
  real path, so the paths matched and only Linux and macOS were affected. The
  CI step added in 0.2.1 runs on Linux and caught it on its first outing.

0.2.1 reached the GitHub releases but never reached npm, so the only version
published before this one is 0.2.0.

[0.2.2]: https://github.com/PatrickJnr/sheep/releases/tag/v0.2.2

## [0.2.1], 2026-08-18

### Fixed

- **The published package could not run.** 0.2.0 shipped its TypeScript
  sources with `bin` pointing at `src/cli/index.ts`. It installed cleanly and
  then failed on the first command with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`: Node refuses to strip types
  from files under `node_modules`. The package now ships compiled JavaScript,
  built by `npm run build` and invoked automatically by `prepack`.

  Nothing changes for a clone. Development still runs `src` directly and still
  has no build step; the build exists only to produce the tarball.

  0.2.0 is deprecated on npm. Use 0.2.1.

### Added

- A CI step that packs the tarball, installs it into a scratch project and
  runs a program through the installed binary. Every other check runs from the
  checkout, which is why a package that only fails once installed passed all of
  them.

[0.2.1]: https://github.com/PatrickJnr/sheep/releases/tag/v0.2.1

## [0.2.0], 2026-08-18

An audit release. Nothing in the language changed shape; several things that
were wrong about it are now right, and the tooling grew a language server.

### Added

- **`baa lsp`**, a language server over stdin and stdout: diagnostics as you
  type, whole-file formatting, a document outline, and hover for top-level
  declarations. It runs the same analysis as `baa check` and `baa lint` rather
  than a second copy of it. Go to definition, find references and rename are
  not implemented and are not advertised. See [docs/editors.md](docs/editors.md).
- **`baa build --locked`**, which verifies `baa.lock` instead of rewriting it
  and reports `BAA406` naming the wool that arrived, changed, moved or went
  away. Every build previously rewrote the file, so a dependency whose contents
  had changed silently updated its own recorded hash.
- `BAA406`, for a lockfile that no longer describes the project.
- Eight conformance programs covering the semantics newly written down below.

### Fixed

- **Diagnostic messages no longer double their articles.** Four templates wrote
  the article themselves while every call site also supplied one, so programs
  were told "You can't add a an array and a a number", "A an array has no field
  called `merge`" and "expected a count of 0 or more, but got a a negative
  number". `BAA302`, `BAA305`, `BAA309` and `BAA311` are affected. Codes and
  spans are unchanged; only the wording is.
- **Two diagnostics reported JavaScript type names**, so `ram.parse([1])` and
  `shepherd.exit("x")` could tell a program it had passed "a object".
- **Array growth is bounded.** `push`, `unshift`, `insert` and `concat` had no
  size limit, though `repeat` and `flock.range` have had one since 0.1.
  Appending to an array while iterating it allocated for about forty seconds
  and then surfaced a JavaScript `RangeError` wrapped in `BAA301`. It is now
  `BAA312`, reported against the call.
- The standard-library module count said seven in seven different files, in
  `SPEC.md` among them, while eight were listed. The diagnostic count was given
  as 41 in one place and 44 in another, against 45. The dependencies badge said
  "none" while three development dependencies are installed.

### Documented

- `SPEC.md` now states what `for` binds (one name is the value, two are the
  position and the value, and for a `map` a single name binds the *value*), that
  `for` re-reads a collection's length rather than taking a snapshot, how a
  `finally` block that returns or throws replaces the outcome that was pending,
  and that map keys are not coerced so `1` and `"1"` are two entries. All four
  were well defined in the implementation and absent from the document a second
  implementation would be written against.
- `docs/editors.md`, covering the language server and configuration for Neovim,
  Helix and Emacs.

### Changed

- Diagnostic wording only, as above. No code, span, severity or exit code
  changed, so anything grepping CI logs for `BAAnnn` is unaffected.

[0.2.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.2.0

## [0.1.0], 2026-08-17

The first release. Baa is a complete, working language rather than a prototype:
every feature listed here is implemented, tested and exercised by a real
program in `examples/`.

### Language

- Values: `nil`, `bool`, `number`, `string`, `array`, `map`, `range`, plus
  first-class `function` and `module`.
- One numeric type (IEEE-754 double). Literals in decimal, hex (`0xFF`), octal
  (`0o17`) and binary (`0b1010`), with `_` separators and exponents.
- `let` and `const` bindings, block-scoped, with shadowing, and destructuring
  of arrays and maps (`let [a, ..rest] = xs`, `let { name as who } = sheep`).
- Four string spellings: plain, `"""` block strings indented by their closing
  delimiter, and `r"..."` / `r"""..."""` raw strings with no escapes and no
  interpolation.
- String interpolation (`"{expr}"`), with full expressions and nested string
  literals inside the braces.
- Operators: arithmetic including `**`, comparison, `&&`, `||`, `??`, `!`,
  `in`, ranges `..` and `..=`, and compound assignment.
- Structural equality for arrays and maps.
- `if` / `else if` / `else`, `while`, `for ... in`, `break`, `continue`.
- `for` over arrays, strings, maps and ranges, with one or two bindings.
- Functions with default parameters, rest parameters (`..rest`), closures and
  hoisting.
- `match` expressions with literal, binding and wildcard patterns, `||`
  alternatives and `if` guards.
- `throw`, `try` / `catch` / `finally`, and catchable runtime errors that
  arrive as a map with a stable code.
- Modules: `export`, `import` by name or path, aliases, named imports,
  load-once semantics and cycle detection.
- `test "name" { ... }` blocks as a language construct.
- Comments: `//`, nesting `/* */`, and `///` doc comments.
- Optional semicolons, via a three-rule newline policy handled in the lexer.

### Tooling

- `baa run`, `check`, `test`, `fmt`, `lint`, `serve`, `repl`, `init`, `build`,
  `add`, `remove`, `doctor`, `modules`, `version`.
- Deterministic formatter that preserves comments and is a fixed point.
- Linter with six rules (`BAA901`–`BAA906`) and `_`-prefix and `--disable`
  escape hatches.
- REPL with persistent scope, multi-line continuation and `:` commands.
- Project manifest `baa.toml`, lockfile `baa.lock`, local path dependencies.
- `--seed` for reproducible runs of anything using `meadow`.

### Diagnostics

- 45 diagnostic codes across six ranges, each with a stable `BAAnnn` code.
- Rendered with the file, line, column, the source line and an underline of the
  exact span, plus suggestions where possible.
- Runtime errors carry a real call stack captured at the point of failure.
- Two wordings per diagnostic: sheep-flavoured by default, neutral under
  `--no-baa`, `BAA_NO_BAA=1` or `CI=true`, with identical codes and spans.
- Parser recovery: `baa check` reports many syntax errors in one pass.
- "Did you mean" suggestions for names, methods, module names and map keys.

### Standard library

- `wool`, text: formatting, case conversion, wrapping, centring, bytes,
  regular expressions, HTML and URL escaping.
- `flock`, collections: grouping, chunking, zipping, partitioning, map
  construction.
- `ram`, arithmetic: rounding, integer division, statistics, constants.
- `meadow`, time and randomness, seedable for reproducibility.
- `pasture`, files and platform-aware paths.
- `shepherd`, arguments, environment, stdin, and shell-free subprocesses.
- `lamb`: JSON encoding and decoding.
- `gate`, the web: reading a request and writing a reply over CGI, with
  escaping that is safe by default.
- Prelude: `len`, `type_of`, `to_string`, `to_number`, `inspect`, `clone`,
  `assert`, `assert_eq`, `panic`, `exit`.
- Methods on strings, arrays, maps, ranges and numbers.

### Project

- 536 automated tests across lexer, parser, resolver, runtime, standard
  library, diagnostics, formatter, linter, modules, CLI and examples.
- Baa's own test blocks, run by `baa test`.
- Recorded example transcripts, asserted by the suite.
- Benchmarks for the front end and the runtime.
- Documentation: README, language tour, specification, architecture, CLI
  reference, generated standard-library and diagnostic references, FAQ,
  roadmap, contributing guide, security policy.
- Static website, deployable to any web host.
- VS Code extension with syntax highlighting, snippets and language
  configuration.
- CI across Windows, Linux and macOS.
- No third-party packages at runtime.

[0.1.0]: https://github.com/PatrickJnr/sheep/releases/tag/v0.1.0
