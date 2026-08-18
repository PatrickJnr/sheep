# Editor support

Baa ships two things for editors: a TextMate grammar with snippets, and a
language server.

## What you get

| Feature | Source | Status |
| --- | --- | --- |
| Syntax highlighting, including inside interpolations | TextMate grammar | Works in any editor that reads one |
| Bracket matching, comment toggling, indentation | Language configuration | VS Code |
| Snippets | Snippet file | VS Code |
| Diagnostics as you type | `baa lsp` | Any LSP client |
| Format on save, or on command | `baa lsp` | Any LSP client |
| Outline and breadcrumbs | `baa lsp` | Any LSP client |
| Hover | `baa lsp` | Any LSP client |
| Go to definition | `baa lsp` | Any LSP client |
| Find references | `baa lsp` | Any LSP client |
| Rename a binding | `baa lsp` | Any LSP client |

The diagnostics are not a second implementation. `baa lsp` runs the same
analysis as `baa check` and `baa lint`, so an editor cannot disagree with the
command line about whether a file is valid, and a diagnostic's code in the
editor is the code you can look up in [the catalogue](errors.md).

## The language server

```bash
baa lsp
```

It speaks the Language Server Protocol over stdin and stdout. Editors start it
themselves; there is rarely a reason to run it by hand.

Documents are synchronised in full rather than incrementally, which is a
deliberate simplification: Baa files are small, the parser runs at several
megabytes a second, and re-analysing a whole file per keystroke costs less than
keeping an incremental tree correct would.

### Why the answers are exact

Go to definition, find references and rename all read the resolver's symbol
table, which records each declaration together with the span of every use that
binds to it. Nothing re-implements scoping, so shadowing is handled the way the
interpreter handles it:

```baa
let count = 1

fn tally(items) {
    let count = 0        // a different binding entirely
    for item in items {
        count += 1
    }
    return count
}

count = count + 1
```

Renaming the inner `count` rewrites three lines and leaves the outer one alone.
A search-and-replace across the file would touch all of them. That distinction
is the whole reason these features go through the resolver rather than the
text.

Rename refuses a new name the lexer would not accept, rather than writing a
file that no longer parses.

### Not implemented yet

Completion, signature help and code actions. None is advertised, so a client
falls back to its own word-based behaviour instead of showing an empty list.

## Setting it up

### Neovim

```lua
vim.filetype.add({ extension = { baa = "baa" } })

vim.api.nvim_create_autocmd("FileType", {
  pattern = "baa",
  callback = function(args)
    vim.lsp.start({
      name = "baa",
      cmd = { "baa", "lsp" },
      root_dir = vim.fs.root(args.buf, { "baa.toml", ".git" }),
    })
  end,
})
```

### Helix

In `languages.toml`:

```toml
[language-server.baa]
command = "baa"
args = ["lsp"]

[[language]]
name = "baa"
scope = "source.baa"
file-types = ["baa"]
roots = ["baa.toml"]
language-servers = ["baa"]
indent = { tab-width = 4, unit = "    " }
```

### Emacs

With `eglot`:

```elisp
(add-to-list 'auto-mode-alist '("\\.baa\\'" . prog-mode))
(add-to-list 'eglot-server-programs '(prog-mode . ("baa" "lsp")))
```

### VS Code

The extension in [`editors/vscode/`](https://github.com/PatrickJnr/sheep/tree/HEAD/editors/vscode)
starts the language server for you. Install the `.vsix` attached to a
[release](https://github.com/PatrickJnr/sheep/releases):

```bash
code --install-extension baa-lang.vsix
```

Open a `.baa` file and diagnostics, formatting, hover, go to definition, find
references and rename all work with no configuration, provided `baa` is on your
`PATH` — which `npm install -g baa-lang` arranges. If it is somewhere else, set
`baa.server.path`:

| Setting | What it does |
| --- | --- |
| `baa.server.path` | Path to `baa`, or to a `.js` entry point. Empty means "find it on `PATH`". |
| `baa.trace.server` | `off`, `messages` or `verbose`. Logs the traffic to the **Baa Language Server** output channel. |

`BAA_SERVER_PATH` does the same job as the setting, for places with no settings
UI to type one into: a container, a CI job, a remote host started by a script.
The setting wins when both are present.

The extension is not on the marketplace, so there is no publisher to trust and
no auto-update; the `.vsix` on each release is built by the same workflow that
publishes the npm package.

Nothing in the extension analyses Baa. It starts `baa lsp` and connects VS Code
to it, so the editor sees exactly what `baa check` sees. A test asserts the
extension registers no providers of its own, because a second opinion about
what a program means is worse than no opinion.

**Building it from a checkout:**

```bash
cd editors/vscode
npm ci
npm run compile
npm run package        # writes baa-lang.vsix
npm run test:vscode    # downloads VS Code and drives the real extension
```

## Checking it works

If diagnostics do not appear, check the server runs at all:

```bash
baa doctor          # is `baa` on PATH?
echo | baa lsp      # should exit without printing anything
```

A client that starts the server but shows nothing is usually a root-directory
or file-type association problem rather than a server problem. Most clients can
log the traffic; the server writes nothing to stdout that is not a protocol
message, so a log with no messages in it means the client never sent any.
