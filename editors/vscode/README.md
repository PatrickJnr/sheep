# Baa for VS Code

Language support for [Baa](https://sheep.grimtech.co.uk): a small, readable
scripting language with a real lexer, parser, resolver, tree-walking
interpreter, formatter and linter, and diagnostics that try to be useful.

## What you get

| | |
| --- | --- |
| **Diagnostics as you type** | Every error carries a stable `BAAnnn` code, a tight range, and usually a suggestion |
| **Formatting** | Deterministic: running it twice changes nothing the second time |
| **Go to definition, find references, rename** | Read from the resolver's symbol table, so a shadowed name resolves the way the interpreter resolves it |
| **Hover and document outline** | Top-level declarations, with their signatures |
| **Syntax highlighting and snippets** | Including inside string interpolations |

None of that is implemented in this extension. It starts `baa lsp` and connects
the editor to it, so what you see is the same analysis `baa check` runs — the
editor cannot disagree with the command line about whether your program is
valid.

## Requirements

Baa itself, which is where the language server lives:

```bash
npm install -g baa-lang
```

That is all. Open a `.baa` file and the extension starts the server.

If `baa` is somewhere the extension cannot find, set **`baa.server.path`** to
it — either the executable, or a `.js` entry point, which is run under the
editor's own Node.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `baa.server.path` | `""` | Path to `baa`. Empty means "find it on `PATH`". |
| `baa.trace.server` | `off` | `messages` or `verbose` logs the traffic to the **Baa Language Server** output channel. |

`BAA_SERVER_PATH` does the same as the setting, for places with no settings UI:
a container, a CI job, a remote host started by a script. The setting wins when
both are set.

## Not working?

Open **View → Output** and choose **Baa Language Server**. If that channel does
not exist, the client never started, which means `baa` was not found — check
`baa --version` in a terminal.

The two languages are not related: this extension is for **Baa**, not for any
other product with a similar name.

## Links

- [Documentation](https://sheep.grimtech.co.uk/docs/)
- [Language tour](https://sheep.grimtech.co.uk/docs/language.html)
- [Editor setup, including Neovim, Helix and Emacs](https://sheep.grimtech.co.uk/docs/editors.html)
- [Changelog](https://sheep.grimtech.co.uk/docs/changelog.html)

MIT licensed.
