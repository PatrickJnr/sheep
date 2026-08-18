/**
 * A Language Server Protocol server for Baa, spoken over stdin and stdout.
 *
 * The analysis is not reimplemented here. Every reply is the existing pipeline
 * viewed through the protocol's vocabulary: `lint` supplies diagnostics,
 * `format` supplies formatting, and the parsed program supplies symbols. That
 * is the whole reason this is small, and the reason an editor cannot disagree
 * with `baa check` about whether a file is valid.
 *
 * Documents are synchronised in full rather than incrementally. Baa files are
 * small and the parser runs at several megabytes a second, so re-analysing a
 * whole file on each keystroke costs less than maintaining an incremental tree
 * would, and it cannot drift out of step with the file on disk.
 *
 * Go-to-definition, find-references, rename and hover all come from one place:
 * the resolver's symbol table, which records each declaration and the span of
 * every use that binds to it. Nothing here re-implements scoping, so a rename
 * touches exactly the names the interpreter would have resolved to that
 * binding, and no others that merely spell the same.
 */

import type { Program, Statement } from "../ast/ast.ts";
import { bindingNames } from "../ast/ast.ts";
import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import { SourceFile } from "../diagnostics/source.ts";
import { lint, format } from "../api.ts";
import type { SymbolInfo } from "../semantic/resolver.ts";
import { STDLIB_MODULES } from "../stdlib/index.ts";

// ---------------------------------------------------------------- protocol

type Message = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

/** LSP positions are zero-based; `SourceFile` counts from one. */
type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };

const SEVERITY = { error: 1, warning: 2 } as const;

/** Symbol kinds from the protocol, only the ones this server produces. */
const SYMBOL = { function: 12, variable: 13, constant: 14, module: 2, test: 6 } as const;

function toPosition(file: SourceFile, offset: number): LspPosition {
  const { line, column } = file.positionAt(offset);
  return { line: line - 1, character: column - 1 };
}

function toRange(file: SourceFile, span: Span | null): LspRange {
  if (span === null) {
    const zero = { line: 0, character: 0 };
    return { start: zero, end: zero };
  }
  return { start: toPosition(file, span.start), end: toPosition(file, span.end) };
}

/** Absolute offset for a zero-based protocol position. */
function toOffset(file: SourceFile, position: LspPosition): number {
  const lines = file.text.split("\n");
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i]!.length + 1;
  return Math.min(offset + position.character, file.text.length);
}

// ------------------------------------------------------------------ server

export type ServerIO = {
  readonly read: NodeJS.ReadableStream;
  readonly write: (text: string) => void;
};

export class LanguageServer {
  readonly #documents = new Map<string, string>();
  readonly #io: ServerIO;
  #shutdownRequested = false;

  constructor(io: ServerIO) {
    this.#io = io;
  }

  /** Handle one decoded message. Exposed so tests can drive it without pipes. */
  handle(message: Message): Message | null {
    const { method, id, params } = message;
    switch (method) {
      case "initialize":
        return this.#reply(id, {
          capabilities: {
            // 1 is full synchronisation: the client sends the whole document.
            textDocumentSync: { openClose: true, change: 1 },
            documentFormattingProvider: true,
            documentSymbolProvider: true,
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: { prepareProvider: true },
          },
          serverInfo: { name: "baa-lsp" },
        });

      case "initialized":
        return null;

      case "shutdown":
        this.#shutdownRequested = true;
        return this.#reply(id, null);

      case "textDocument/didOpen": {
        const document = (params as { textDocument: { uri: string; text: string } }).textDocument;
        this.#documents.set(document.uri, document.text);
        this.#publish(document.uri);
        return null;
      }

      case "textDocument/didChange": {
        const change = params as {
          textDocument: { uri: string };
          contentChanges: Array<{ text: string }>;
        };
        // Full synchronisation, so the last change carries the whole document.
        const text = change.contentChanges[change.contentChanges.length - 1]?.text;
        if (text !== undefined) {
          this.#documents.set(change.textDocument.uri, text);
          this.#publish(change.textDocument.uri);
        }
        return null;
      }

      case "textDocument/didClose": {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri;
        this.#documents.delete(uri);
        // Clear the squiggles: a closed file has no diagnostics to show.
        this.#notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
        return null;
      }

      case "textDocument/formatting":
        return this.#reply(id, this.#format(params as { textDocument: { uri: string } }));

      case "textDocument/documentSymbol":
        return this.#reply(id, this.#symbols(params as { textDocument: { uri: string } }));

      case "textDocument/definition":
        return this.#reply(
          id,
          this.#definition(params as { textDocument: { uri: string }; position: LspPosition }),
        );

      case "textDocument/references":
        return this.#reply(
          id,
          this.#references(params as {
            textDocument: { uri: string };
            position: LspPosition;
            context?: { includeDeclaration?: boolean };
          }),
        );

      case "textDocument/prepareRename":
        return this.#reply(
          id,
          this.#prepareRename(params as { textDocument: { uri: string }; position: LspPosition }),
        );

      case "textDocument/rename":
        return this.#reply(
          id,
          this.#rename(params as {
            textDocument: { uri: string };
            position: LspPosition;
            newName: string;
          }),
        );

      case "textDocument/hover":
        return this.#reply(
          id,
          this.#hover(params as { textDocument: { uri: string }; position: LspPosition }),
        );

      default:
        // Notifications have no id and need no reply. Requests must always get
        // one, or the client waits for a response that never comes.
        if (id === undefined) return null;
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `unsupported method: ${method}` },
        };
    }
  }

  get shutdownRequested(): boolean {
    return this.#shutdownRequested;
  }

  // ------------------------------------------------------------- features

  #publish(uri: string): void {
    const text = this.#documents.get(uri);
    if (text === undefined) return;
    const file = new SourceFile(uriToPath(uri), text);
    const result = lint(text, file.path, { modules: [...STDLIB_MODULES] });
    const all = [...result.diagnostics, ...result.warnings];
    this.#notify("textDocument/publishDiagnostics", {
      uri,
      diagnostics: all.map((diagnostic) => toLspDiagnostic(file, diagnostic)),
    });
  }

  #format(params: { textDocument: { uri: string } }): unknown[] | null {
    const text = this.#documents.get(params.textDocument.uri);
    if (text === undefined) return null;
    let formatted: string;
    try {
      formatted = format(text, uriToPath(params.textDocument.uri));
    } catch {
      // A file that does not parse cannot be formatted. Returning null leaves
      // the buffer untouched, which is better than a partial rewrite.
      return null;
    }
    if (formatted === text) return [];
    const file = new SourceFile(uriToPath(params.textDocument.uri), text);
    return [{ range: toRange(file, file.span(0, text.length)), newText: formatted }];
  }

  #symbols(params: { textDocument: { uri: string } }): unknown[] {
    const text = this.#documents.get(params.textDocument.uri);
    if (text === undefined) return [];
    const file = new SourceFile(uriToPath(params.textDocument.uri), text);
    const { program } = lint(text, file.path, { modules: [...STDLIB_MODULES] });
    return declarationsOf(program).map((declaration) => ({
      name: declaration.name,
      kind: declaration.kind,
      range: toRange(file, declaration.span),
      selectionRange: toRange(file, declaration.nameSpan),
    }));
  }

  /**
   * The symbol whose declaration or one of whose uses covers an offset.
   *
   * This is what makes the three features below exact rather than textual: the
   * resolver already decided which declaration each use binds to, so a local
   * that shadows an outer name is a different symbol here, not the same word
   * twice.
   */
  #symbolAt(file: SourceFile, symbols: readonly SymbolInfo[], offset: number): SymbolInfo | null {
    const covers = (span: Span): boolean => offset >= span.start && offset <= span.end;
    for (const symbol of symbols) {
      if (covers(symbol.span) || symbol.references.some(covers)) return symbol;
    }
    return null;
  }

  /** Document text, file and analysis for a request, or null if unavailable. */
  #analyse(uri: string): { text: string; file: SourceFile; symbols: readonly SymbolInfo[] } | null {
    const text = this.#documents.get(uri);
    if (text === undefined) return null;
    const file = new SourceFile(uriToPath(uri), text);
    const { analysis } = lint(text, file.path, { modules: [...STDLIB_MODULES] });
    if (analysis === null) return null;
    return { text, file, symbols: analysis.symbols };
  }

  #definition(params: { textDocument: { uri: string }; position: LspPosition }): unknown | null {
    const found = this.#analyse(params.textDocument.uri);
    if (found === null) return null;
    const symbol = this.#symbolAt(found.file, found.symbols, toOffset(found.file, params.position));
    if (symbol === null) return null;
    return { uri: params.textDocument.uri, range: toRange(found.file, symbol.span) };
  }

  #references(params: {
    textDocument: { uri: string };
    position: LspPosition;
    context?: { includeDeclaration?: boolean };
  }): unknown[] | null {
    const found = this.#analyse(params.textDocument.uri);
    if (found === null) return null;
    const symbol = this.#symbolAt(found.file, found.symbols, toOffset(found.file, params.position));
    if (symbol === null) return null;
    // The protocol defaults includeDeclaration to true when the client omits it.
    const includeDeclaration = params.context?.includeDeclaration ?? true;
    const spans = includeDeclaration ? [symbol.span, ...symbol.references] : [...symbol.references];
    return spans.map((span) => ({
      uri: params.textDocument.uri,
      range: toRange(found.file, span),
    }));
  }

  /**
   * Answering this lets an editor refuse the rename before prompting, rather
   * than asking for a new name and then doing nothing with it.
   */
  #prepareRename(params: { textDocument: { uri: string }; position: LspPosition }): unknown | null {
    const found = this.#analyse(params.textDocument.uri);
    if (found === null) return null;
    const symbol = this.#symbolAt(found.file, found.symbols, toOffset(found.file, params.position));
    if (symbol === null) return null;
    return { range: toRange(found.file, symbol.span), placeholder: symbol.name };
  }

  #rename(params: {
    textDocument: { uri: string };
    position: LspPosition;
    newName: string;
  }): unknown | null {
    const found = this.#analyse(params.textDocument.uri);
    if (found === null) return null;
    const symbol = this.#symbolAt(found.file, found.symbols, toOffset(found.file, params.position));
    if (symbol === null) return null;
    // A name the lexer would not accept produces a file that no longer parses,
    // so it is refused here rather than written and then complained about.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.newName)) return null;

    const edits = [symbol.span, ...symbol.references].map((span) => ({
      range: toRange(found.file, span),
      newText: params.newName,
    }));
    return { changes: { [params.textDocument.uri]: edits } };
  }

  /**
   * Hover resolves through the symbol table first, so a local that shares a
   * name with a top-level function shows the local. It falls back to the
   * top-level declaration list only for things the resolver does not track as
   * symbols, which is where doc comments live.
   */
  #hover(params: { textDocument: { uri: string }; position: LspPosition }): unknown | null {
    const text = this.#documents.get(params.textDocument.uri);
    if (text === undefined) return null;
    const file = new SourceFile(uriToPath(params.textDocument.uri), text);
    const word = wordAt(text, toOffset(file, params.position));
    if (word === null) return null;

    const { program, analysis } = lint(text, file.path, { modules: [...STDLIB_MODULES] });
    const declarations = declarationsOf(program);

    // The resolver knows which binding this position belongs to. Only when it
    // has nothing (a method name, a field) does the name lookup get a turn.
    const symbol =
      analysis === null
        ? null
        : this.#symbolAt(file, analysis.symbols, toOffset(file, params.position));

    const found =
      symbol === null
        ? declarations.find((declaration) => declaration.name === word)
        : declarations.find(
            (declaration) =>
              declaration.name === symbol.name && declaration.nameSpan.start === symbol.span.start,
          );

    if (found === undefined && symbol === null) return null;

    const signature = found?.signature ?? `${symbol!.kind} ${symbol!.name}`;
    const lines = [`\`\`\`baa\n${signature}\n\`\`\``];
    if (found?.doc != null) lines.push(found.doc);
    return { contents: { kind: "markdown", value: lines.join("\n\n") } };
  }

  // ------------------------------------------------------------ plumbing

  #reply(id: number | string | undefined, result: unknown): Message {
    return { jsonrpc: "2.0", id: id as number, result };
  }

  #notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  send(message: Message): void {
    const body = JSON.stringify(message);
    // The header length counts bytes, not characters, so a document with any
    // non-ASCII in it desynchronises the stream if this measures the string.
    this.#io.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
}

type Declaration = {
  readonly name: string;
  readonly kind: number;
  readonly span: Span;
  readonly nameSpan: Span;
  readonly signature: string;
  readonly doc: string | null;
};

/** Top-level declarations, in source order. */
function declarationsOf(program: Program): Declaration[] {
  const out: Declaration[] = [];
  for (const statement of program.body as readonly Statement[]) {
    switch (statement.kind) {
      case "FunctionDeclaration": {
        const params = statement.params
          .map((param) => (param.rest ? `..${param.name}` : param.name))
          .join(", ");
        out.push({
          name: statement.name,
          kind: SYMBOL.function,
          span: statement.span,
          nameSpan: statement.nameSpan,
          signature: `fn ${statement.name}(${params})`,
          doc: statement.doc,
        });
        break;
      }
      case "LetStatement":
        for (const bound of bindingNames(statement.binding)) {
          out.push({
            name: bound.name,
            kind: statement.mutable ? SYMBOL.variable : SYMBOL.constant,
            span: statement.span,
            nameSpan: bound.span,
            signature: `${statement.mutable ? "let" : "const"} ${bound.name}`,
            doc: null,
          });
        }
        break;
      case "ImportDeclaration":
        out.push({
          name: statement.alias,
          kind: SYMBOL.module,
          span: statement.span,
          nameSpan: statement.aliasSpan,
          signature: `import ${statement.source}`,
          doc: null,
        });
        break;
      case "TestDeclaration":
        out.push({
          name: statement.name,
          kind: SYMBOL.test,
          span: statement.span,
          nameSpan: statement.nameSpan,
          signature: `test "${statement.name}"`,
          doc: null,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function toLspDiagnostic(file: SourceFile, diagnostic: Diagnostic): unknown {
  const related = diagnostic.secondary.map((label) => ({
    location: { uri: pathToUri(file.path), range: toRange(file, label.span) },
    message: label.note ?? "related",
  }));
  return {
    range: toRange(file, diagnostic.primary?.span ?? null),
    severity: SEVERITY[diagnostic.severity],
    code: diagnostic.code,
    source: "baa",
    // The help lines are where the useful part of a Baa diagnostic usually is,
    // so they belong in the message rather than being dropped at the boundary.
    message: [diagnostic.message, ...diagnostic.help.map((help) => `help: ${help}`)].join("\n"),
    ...(related.length > 0 ? { relatedInformation: related } : {}),
  };
}

/** The identifier surrounding an offset, or null if there is not one. */
function wordAt(text: string, offset: number): string | null {
  const isWord = (character: string): boolean => /[A-Za-z0-9_]/.test(character);
  if (offset > 0 && offset >= text.length) offset = text.length - 1;
  if (offset < 0 || !isWord(text[offset] ?? "")) return null;
  let start = offset;
  let end = offset;
  while (start > 0 && isWord(text[start - 1]!)) start--;
  while (end + 1 < text.length && isWord(text[end + 1]!)) end++;
  return text.slice(start, end + 1);
}

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const path = decodeURIComponent(uri.slice("file://".length));
  // Windows URIs carry a leading slash before the drive letter.
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

function pathToUri(path: string): string {
  const normalised = path.split("\\").join("/");
  return `file://${normalised.startsWith("/") ? "" : "/"}${normalised}`;
}

// -------------------------------------------------------------------- loop

/**
 * Read `Content-Length` framed messages until the stream ends. The buffer is
 * kept as bytes rather than a string because the header counts bytes: slicing
 * a string would cut a multi-byte character in half on any document that is
 * not pure ASCII.
 */
export function serve(io: ServerIO): Promise<number> {
  const server = new LanguageServer(io);
  let buffer = Buffer.alloc(0);

  return new Promise((resolve) => {
    /**
     * Stop reading before resolving. A `data` listener on stdin keeps Node's
     * event loop alive on its own, so a server that merely resolved would
     * answer `exit` correctly and then hang forever instead of exiting.
     */
    const finish = (code: number): void => {
      io.read.removeAllListeners("data");
      io.read.removeAllListeners("end");
      io.read.pause?.();
      // `pause` stops the flow but leaves the underlying handle referenced, so
      // on Windows the process stays alive with nothing to do. `unref` lets
      // the loop drain while still allowing buffered stdout writes to flush,
      // which `process.exit` would cut off.
      (io.read as { unref?: () => void }).unref?.();
      resolve(code);
    };

    io.read.on("data", (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const length = /content-length:\s*(\d+)/i.exec(header)?.[1];
        if (length === undefined) {
          // Unparseable header: there is no way to find the next boundary, so
          // stopping beats reading the body as if it were a header.
          finish(1);
          return;
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(length);
        if (buffer.length < bodyEnd) return;

        const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
        buffer = buffer.subarray(bodyEnd);

        let message: Message;
        try {
          message = JSON.parse(body) as Message;
        } catch {
          continue;
        }
        if (message.method === "exit") {
          finish(server.shutdownRequested ? 0 : 1);
          return;
        }
        const reply = server.handle(message);
        if (reply !== null) server.send(reply);
      }
    });

    io.read.on("end", () => finish(server.shutdownRequested ? 0 : 1));
  });
}
