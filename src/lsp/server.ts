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
 * What is deliberately not here: go-to-definition, find-references and rename.
 * Each needs the resolver to hand back its symbol table with the span of every
 * binding and every use, which it collects internally and does not currently
 * expose. Adding them means widening that interface, not writing another
 * protocol handler, so they wait for that rather than shipping as something
 * that guesses.
 */

import type { Program, Statement } from "../ast/ast.ts";
import { bindingNames } from "../ast/ast.ts";
import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import { SourceFile } from "../diagnostics/source.ts";
import { lint, format } from "../api.ts";
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
   * Hover looks the word under the cursor up among the file's top-level
   * declarations. It is a name lookup, not a scope-aware one, so a local that
   * shares a name with a top-level function shows that function's
   * documentation. Resolving it properly needs the symbol table this server
   * does not yet get, and a name lookup is right often enough to be worth
   * having in the meantime.
   */
  #hover(params: { textDocument: { uri: string }; position: LspPosition }): unknown | null {
    const text = this.#documents.get(params.textDocument.uri);
    if (text === undefined) return null;
    const file = new SourceFile(uriToPath(params.textDocument.uri), text);
    const word = wordAt(text, toOffset(file, params.position));
    if (word === null) return null;

    const { program } = lint(text, file.path, { modules: [...STDLIB_MODULES] });
    const found = declarationsOf(program).find((declaration) => declaration.name === word);
    if (found === undefined) return null;

    const lines = [`\`\`\`baa\n${found.signature}\n\`\`\``];
    if (found.doc !== null) lines.push(found.doc);
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
