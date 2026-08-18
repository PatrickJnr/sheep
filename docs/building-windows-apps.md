# Building Windows applications

The practical guide: what to install, what to run, what you get, and what to
check before giving it to anybody.

---

## Once, on the machine that builds

Baa itself needs Node.js 22.18 or newer and nothing else. Building applications
needs one more thing, once:

```bash
cargo build --release --manifest-path rust/Cargo.toml
```

That compiles the native runtime, which is Rust. It takes about half a minute
and produces two binaries in `rust/target/release/`:

| | |
| --- | --- |
| `baa-nativew.exe` | The windowed runtime. What `baa app build` uses |
| `baa-native.exe` | The console runtime. What `baa app run` uses, and what `--console` builds |

There are two because the subsystem — whether Windows gives the process a
console — is a flag in the executable header, fixed when the runtime is linked.
It cannot be chosen later, when an application is built from it. This is the
same reason `python.exe` and `pythonw.exe` both exist.

If you have no Rust toolchain, [rustup](https://rustup.rs) installs one. On
Windows it wants the MSVC build tools, which Visual Studio's "Desktop
development with C++" workload provides.

**The npm package does not carry the runtime.** `npm install -g baa-lang` gives
you the whole language and every other command; it does not give you a compiled
Rust binary, because that would be one per platform.

You do not have to build one. Every release publishes them:

| Archive | Contains |
| --- | --- |
| `baa-native-windows-x64.tar.gz` | `baa-native.exe` and `baa-nativew.exe` |
| `baa-native-linux-x64.tar.gz` | `baa-native` |

Unpack it where Baa looks, and nothing else needs configuring:

```bash
mkdir -p ~/.baa/runtime
curl -L https://github.com/PatrickJnr/sheep/releases/latest/download/baa-native-linux-x64.tar.gz   | tar -xz -C ~/.baa/runtime
```

Each archive carries a `.sha256` beside the binaries, because an artefact
nobody can verify is an artefact nobody should run. Check it before you run
anything:

```bash
cd ~/.baa/runtime && sha256sum -c baa-native-*.sha256
```

If you would rather not pipe a download straight into `tar`, fetch it first
and check it:

```bash
gh release download v0.7.0 -R PatrickJnr/sheep -p "baa-native-*"
```

**The Linux runtime has no window backend.** It runs a Baa application that
does not import `barn` — arguments, files, JSON, subprocesses, the whole
language — and `barn.show` reports that there is nothing to draw with.
`baa app build` warns at build time rather than letting you find out when the
window does not appear. Windows is the only target that can show a window
today; the Linux backend is on [ROADMAP.md](../ROADMAP.md).

Building it yourself still works, and is what a contributor does:

```bash
git clone https://github.com/PatrickJnr/sheep
cd sheep
cargo build --release --manifest-path rust/Cargo.toml
export BAA_NATIVE_HOST=$PWD/rust/target/release
```

`baa app build` names the archive for your platform when it cannot find a
runtime, and `baa doctor` reports whether it has one.

`baa app build` looks for the runtime in this order: `BAA_NATIVE_HOST`, a
`native/` directory beside the installed CLI, `~/.baa/runtime`, then
`rust/target/release` and `rust/target/debug`. A downloaded runtime is checked
before a checkout's, so an old `cargo build` in a clone cannot shadow the one
you just installed. When it finds none, it prints the download for your
platform rather than an error about a missing file.

## Every time

```bash
cd my_app
baa check .          # the same check the build runs, but faster to read
baa test             # the logic, with no window involved
baa app run          # the window, with a console attached
baa app build        # build/MyApp.exe
```

```
Built C:\pens\my_app\build\MyApp.exe
  2 modules, using barn, pasture
  736 KB, windowed
```

## What you get

One file. It contains the runtime and your program, and it runs on any Windows
machine of the same architecture with nothing installed — no Node, no Rust, no
Visual C++ redistributable, no unpacking on first run.

The file is the runtime with your program appended to it, followed by an
eight-byte length and the marker `BAAFLEECE`. Windows ignores trailing bytes in
a PE file, and the runtime reads its own path to find them.

That has two consequences worth planning around:

- **Signing works normally.** `signtool` appends its signature the same way,
  after the image, and both survive.
- **The icon and version metadata belong to the runtime**, not to your
  application. Changing them means rewriting PE resources, which the appending
  build deliberately avoids so that building an application needs no linker. If
  you need a custom icon today, run a resource editor over the output as a
  post-build step. It is on [ROADMAP.md](../ROADMAP.md).

## Before you give it to anybody

The list here is short because most of it is checked for you: a program that
does not pass `baa check` produces no executable at all.

1. **Run it from somewhere else.** `copy build\MyApp.exe %TEMP%` and run it
   there. An application must not depend on the directory it was built in, and
   this catches it immediately if it does.

2. **Check what it says when something fails.** A windowed application has no
   console, so an uncaught error appears in a message box with its `BAAnnn`
   code, the line, and the call stack. Cause one on purpose and read it.

3. **Try it at 150% scaling.** Settings → System → Display → Scale. The window
   should be larger with sharp text, not blurry. If it is blurry, the DPI
   awareness is not being applied and that is a bug worth reporting.

4. **Resize it, including very small.** The layout runs on every resize; a
   negative width is clamped rather than crashing, but a layout can still be
   unusable long before that.

5. **Close it with unsaved work**, if it has any. `"close"` with no handler
   closes the window; if you handle it, make sure every path either closes or
   explains why it did not.

## Shipping it

**Copy the file.** That is the whole portable story, and it is the one to start
with.

**An installer** is a normal Windows installer around one executable: Inno
Setup and WiX both handle that in a dozen lines. Nothing about a Baa
application makes it unusual.

**Antivirus.** A small, unsigned, freshly built executable that is not
recognised is exactly the shape of a false positive, and SmartScreen may warn
about it. A code-signing certificate is the only real fix; it is the same fix
every small Windows application needs.

## Other platforms

`baa app build` runs on Linux and macOS and produces a working executable for
programs that do not draw. Applications that import `barn` build there too, and
report at `barn.show` that the platform has no window backend, naming the
platform.

That is deliberate: the window model has no Win32 in it, and adding a backend
is an addition rather than a rewrite. Until somebody writes one, Windows is
the only platform where a Baa application has a window, and no part of this
documentation should be read as saying otherwise.

## When something goes wrong

| Symptom | Cause |
| --- | --- |
| `The native runtime (baa-nativew.exe) is not built` | Run the `cargo build` above |
| `Cannot write …: it is running` | Close the application you are rebuilding |
| `imports \`gate\`, which native applications do not have` | `gate` serves web pages; use `barn` |
| `\`barn.window\` needs the native runtime` | You ran it with `baa run`. Use `baa app run` |
| Nothing appears, no error | The program built the tree but never called `barn.show` and `barn.run` |
| `this image is version N` | The executable and the runtime came from different releases. Rebuild |

## See also

- [native-applications.md](native-applications.md) — what the platform is, and what it cannot do yet
- [gui.md](gui.md) — every `barn` function
- [application-projects.md](application-projects.md) — the manifest and the layout
- [native-runtime.md](native-runtime.md) — the image format and the runtime's insides
