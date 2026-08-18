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
provides highlighting, snippets and editing configuration. Copy or symlink the
directory into `~/.vscode/extensions/` and reload the window.

It does **not** yet start the language server. VS Code has no built-in way to
attach one, unlike the editors above: it needs an extension with a JavaScript
entry point using `vscode-languageclient`. The extension is currently
declarative only, so wiring that up is the next piece of work here, and until
it is done VS Code gets highlighting and snippets but not live diagnostics.

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
