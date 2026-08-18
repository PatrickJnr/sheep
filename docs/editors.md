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
| Hover on a top-level declaration | `baa lsp` | Any LSP client |

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

### Not implemented yet

Go to definition, find references and rename are **not** implemented, and the
server does not advertise them, so a client will fall back to its own
word-based behaviour rather than showing you an empty result.

All three need the resolver to hand back its symbol table with the span of
every binding and every use. It collects exactly that while analysing and keeps
it internal. Widening that interface is the work; the protocol handlers on top
are small.

Hover is implemented as a **name lookup, not a scope-aware one**: it finds the
word under the cursor among the file's top-level declarations. A local variable
that shares a name with a top-level function will show that function's
documentation. It is useful far more often than it is wrong, and it becomes
exact once the symbol table is available.

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
