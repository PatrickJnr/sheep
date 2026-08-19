# Application projects

A native application is an ordinary Baa project. There is no second manifest
format and no application-specific directory layout to learn: `baa.toml` gains
one optional table, and that is the whole difference.

```bash
baa app new pen_counter
```

```
pen_counter/
├── baa.toml          the project, plus an [app] table
├── main.baa          the window
├── counter.baa       the logic, with no window in it
└── tests/
    └── counter_test.baa
```

That shape is the recommendation, not a requirement. `baa app build` follows
the manifest's `entry` and whatever it imports; nothing looks for a directory
by name.

---

## The manifest

```toml
[flock]
name = "pen_counter"
version = "0.1.0"
description = "Counts sheep."
entry = "main.baa"

# Everything under [app] describes the executable rather than the program.
[app]
title = "Pen Counter"
width = "420"
height = "260"
```

`[flock]` is unchanged and is documented in [cli.md](cli.md#the-project-manifest).

| `[app]` key | Effect | Default |
| --- | --- | --- |
| `name` | The executable's filename | the project's `name` |
| `title` | Fallback window title, and the product name Windows shows | the project's `name` |
| `version` | Recorded in the image, and in the executable's Properties | the project's `version` |
| `width`, `height` | Fallback window size, in layout units | 480 × 360 |
| `icon` | Path to an `.ico` file, relative to the project | no icon |
| `company` | Shown in the executable's Properties | empty |
| `copyright` | Shown in the executable's Properties | empty |

Values are strings, because the manifest parser accepts a deliberately small
TOML subset and quoting a number costs nothing.

### Dependencies

`[wool]` dependencies are bundled into the application like the project's own
files, and so are the files they import in turn:

```toml
[wool]
greet = { path = "../shared/greet.baa" }
```

```baa
import greet
baa greet.hello("Dolly")
```

Nothing is fetched and nothing is executed at build time: a dependency is a
local path, the bundler reads it, and the whole tree ends up in the image. A
bare import that is neither a standard module nor a declared dependency stops
the build.

Relative imports may point outside the project — the native calculator imports
the *web* calculator's arithmetic module that way, which is the whole point of
the arrangement.

### What Windows sees

On Windows, `baa app build` writes a resource section into the executable
before appending the image, so the file has an icon in Explorer and a filled-in
Details tab in its Properties: file and product version from `version`, product
name and description from `title`, and `company` and `copyright` if the
manifest sets them.

```toml
[app]
title = "Pen Counter"
icon = "assets/pen.ico"
company = "A Farm"
copyright = "Copyright 2026 A Farm"
```

There is no linker involved, and none is wanted: the build copies a prebuilt
runtime, and the resources are written into the copy by hand. A missing icon
file stops the build rather than producing an executable that quietly lacks
one. On other platforms this does nothing, because resources are a PE idea.

The `[app]` values are fallbacks. A `barn.window({ title: ..., width: ... })`
call wins, because the program is more specific than its manifest. Keeping them
in the manifest as well means the executable's identity does not depend on
reading the source.

---

## Where the split goes

The single most useful thing about this project layout is the file that is not
the window.

```baa
// counter.baa — imports nothing that draws
export fn up(state) {
    return { sheep: state.sheep + 1 }
}
```

```baa
// main.baa — imports barn, and is as small as it can be
import barn
import "./counter.baa" as counter

let state = counter.start()
```

A module that imports neither `gate` nor `barn` belongs to neither target. It
can be tested with `baa test` in milliseconds, it can be reused by a web page,
and it is where the logic that can actually be wrong should live.

[`examples/native/calculator/`](https://github.com/PatrickJnr/sheep/tree/HEAD/examples/native/calculator)
takes this to its conclusion: its arithmetic module is the web calculator's,
imported unchanged across directories, with one set of tests covering both
applications.

## Dependencies

Relative imports are bundled:

```baa
import "./counter.baa" as counter
import "../shared/flock_rules.baa" as rules
```

`[wool]` dependencies from the manifest are **not** bundled yet, and
`baa app build` says so rather than half-working. Import the file directly by
path in the meantime; the module graph is followed wherever it leads, including
outside the project directory.

Standard modules are available as listed in
[native-applications.md](native-applications.md#what-works-today). Importing
one that is not is a build error naming it.

## Building

```bash
baa app run                 # build to a temporary image and run, with a console
baa app build               # build/<name>.exe
baa app build --out dist    # somewhere else
baa app build --console     # a console application rather than a windowed one
baa app test                # run tests/ on the native runtime, not the application
```

`baa app run` writes nothing into the project: it builds to a temporary file
and runs it with the console runtime, so `baa` output lands on your terminal.

`baa app test` runs every `.baa` file under `tests/`, each as its own image,
and deliberately does **not** run the entry point: an application's entry point
opens a window and blocks on the event loop, which is the one thing a test run
must not do. It is the same set of files `baa test` runs, on the other runtime,
which is how you find out whether a module behaves identically on both.

`baa app build` writes an executable and nothing else — no intermediate
directory, no cache, no lockfile of its own.

Both need the native runtime to have been compiled once:

```bash
cargo build --release --manifest-path rust/Cargo.toml
```

The runtime is Rust. The language is not, your application is not, and building
an application after the runtime exists needs no Rust at all.

## What to commit

Commit the manifest, the source and the tests. `build/` and `*.fleece` are in
the default `.gitignore`: an executable is a build artefact, and a 736 KB
binary in a repository is 736 KB in every clone forever.
