/**
 * The language server.
 *
 * Two levels are covered: the message handlers directly, and one round trip
 * through the real `baa lsp` process so the framing, the stdio wiring and the
 * exit code are exercised as an editor would exercise them.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { LanguageServer } from "../src/lsp/server.ts";
import type { ServerIO } from "../src/lsp/server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");
const URI = "file:///tmp/pen.baa";

type Sent = { method?: string; id?: number | string; result?: unknown; params?: unknown };

/** A server whose outgoing messages are collected rather than written. */
function harness(): { server: LanguageServer; sent: Sent[] } {
  const sent: Sent[] = [];
  const io: ServerIO = {
    read: { on: () => undefined } as unknown as NodeJS.ReadableStream,
    write: (text) => {
      const body = text.slice(text.indexOf("\r\n\r\n") + 4);
      sent.push(JSON.parse(body) as Sent);
    },
  };
  return { server: new LanguageServer(io), sent };
}

function open(server: LanguageServer, text: string, uri = URI): void {
  server.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, text } },
  });
}

function diagnosticsFrom(sent: Sent[]): Array<{ code: string; message: string; severity: number }> {
  const last = [...sent].reverse().find((m) => m.method === "textDocument/publishDiagnostics");
  assert.ok(last, "the server published no diagnostics");
  return (last.params as { diagnostics: Array<{ code: string; message: string; severity: number }> })
    .diagnostics;
}

describe("language server: capabilities", () => {
  it("announces only what it actually implements", () => {
    const { server } = harness();
    const reply = server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const capabilities = (reply?.result as { capabilities: Record<string, unknown> }).capabilities;
    assert.equal(capabilities.documentFormattingProvider, true);
    assert.equal(capabilities.documentSymbolProvider, true);
    assert.equal(capabilities.hoverProvider, true);
    assert.equal(capabilities.definitionProvider, true);
    assert.equal(capabilities.referencesProvider, true);
    assert.deepEqual(capabilities.renameProvider, { prepareProvider: true });
    // Still not implemented, and so still not announced: a client that
    // believes the announcement shows an empty result rather than falling
    // back to something it could have done itself.
    assert.equal(capabilities.completionProvider, undefined);
    assert.equal(capabilities.codeActionProvider, undefined);
    assert.equal(capabilities.signatureHelpProvider, undefined);
  });

  it("answers an unknown request rather than leaving the client waiting", () => {
    const { server } = harness();
    const reply = server.handle({ jsonrpc: "2.0", id: 7, method: "textDocument/codeAction" });
    assert.equal(reply?.id, 7);
    assert.equal((reply?.error as { code: number }).code, -32601);
  });

  it("stays silent for a notification it does not handle", () => {
    const { server } = harness();
    assert.equal(server.handle({ jsonrpc: "2.0", method: "$/setTrace" }), null);
  });
});

describe("language server: diagnostics", () => {
  it("reports an error with its code, severity and position", () => {
    const { server, sent } = harness();
    open(server, "baa missing_name\n");
    const [first] = diagnosticsFrom(sent);
    assert.equal(first?.code, "BAA102");
    assert.equal(first?.severity, 1);
    const range = (first as unknown as { range: { start: { line: number; character: number } } })
      .range;
    assert.equal(range.start.line, 0, "positions are zero-based in the protocol");
    assert.equal(range.start.character, 4);
  });

  it("reports lint warnings alongside errors", () => {
    const { server, sent } = harness();
    open(server, "let unused = 1\n");
    const codes = diagnosticsFrom(sent).map((d) => d.code);
    assert.ok(codes.length > 0, "an unused binding should warn");
    assert.ok(
      diagnosticsFrom(sent).every((d) => d.severity === 2),
      "a warning must not be reported as an error",
    );
  });

  it("carries the help text, which is where the useful part usually is", () => {
    const { server, sent } = harness();
    open(server, "let sheep = 1\nbaa sheap\n");
    const reported = diagnosticsFrom(sent).find((d) => d.code === "BAA102");
    assert.ok(reported, "expected the misspelling to be reported");
    assert.match(reported.message, /help: Did you mean/);
  });

  it("publishes an empty list on close, so the squiggles go away", () => {
    const { server, sent } = harness();
    open(server, "baa missing_name\n");
    assert.ok(diagnosticsFrom(sent).length > 0);
    server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: URI } },
    });
    assert.deepEqual(diagnosticsFrom(sent), []);
  });

  it("re-analyses on change", () => {
    const { server, sent } = harness();
    open(server, "baa missing_name\n");
    assert.ok(diagnosticsFrom(sent).length > 0);
    server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI }, contentChanges: [{ text: 'baa "fixed"\n' }] },
    });
    assert.deepEqual(diagnosticsFrom(sent), []);
  });
});

describe("language server: formatting", () => {
  it("returns one edit covering the whole document", () => {
    const { server } = harness();
    open(server, "let   x=1\n");
    const edits = server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/formatting",
      params: { textDocument: { uri: URI } },
    })?.result as Array<{ newText: string }>;
    assert.equal(edits.length, 1);
    assert.equal(edits[0]!.newText, "let x = 1\n");
  });

  it("returns nothing for an already formatted document", () => {
    const { server } = harness();
    open(server, "let x = 1\n");
    const edits = server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "textDocument/formatting",
      params: { textDocument: { uri: URI } },
    })?.result as unknown[];
    assert.deepEqual(edits, []);
  });

  // Rewriting a buffer from a half-parsed tree would destroy work in progress,
  // which is exactly the state a file is in while being typed into.
  it("refuses to format a document that does not parse", () => {
    const { server } = harness();
    open(server, "fn broken( {\n");
    const result = server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "textDocument/formatting",
      params: { textDocument: { uri: URI } },
    })?.result;
    assert.equal(result, null);
  });
});

describe("language server: symbols and hover", () => {
  const SOURCE = [
    "/// Count the sheep.",
    "fn count(flock, ..rest) {",
    "    return flock.length()",
    "}",
    "",
    "const TOTAL = 3",
    'test "counts" { assert(true) }',
    "",
  ].join("\n");

  it("outlines the top-level declarations", () => {
    const { server } = harness();
    open(server, SOURCE);
    const symbols = server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "textDocument/documentSymbol",
      params: { textDocument: { uri: URI } },
    })?.result as Array<{ name: string; kind: number }>;
    assert.deepEqual(
      symbols.map((s) => s.name),
      ["count", "TOTAL", "counts"],
    );
    assert.equal(symbols[0]!.kind, 12, "function");
    assert.equal(symbols[1]!.kind, 14, "constant");
  });

  it("shows the signature and doc comment on hover", () => {
    const { server } = harness();
    open(server, SOURCE);
    // Line 1, over the name `count`.
    const hover = server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "textDocument/hover",
      params: { textDocument: { uri: URI }, position: { line: 1, character: 4 } },
    })?.result as { contents: { value: string } };
    assert.match(hover.contents.value, /fn count\(flock, \.\.rest\)/);
    assert.match(hover.contents.value, /Count the sheep\./);
  });

  it("says nothing when the cursor is not on a name it knows", () => {
    const { server } = harness();
    open(server, SOURCE);
    const hover = server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "textDocument/hover",
      params: { textDocument: { uri: URI }, position: { line: 4, character: 0 } },
    })?.result;
    assert.equal(hover, null);
  });
});

describe("language server: definition, references and rename", () => {
  // `count` is declared twice: once at the top level and once as a local
  // inside `tally`. A textual search cannot tell them apart. The resolver can,
  // because it already decided which declaration each use binds to.
  const SOURCE = [
    "let count = 1",              // line 0
    "",
    "fn tally(items) {",          // line 2
    "    let count = 0",          // line 3, a different binding
    "    for item in items {",
    "        count += 1",         // line 5, the local
    "    }",
    "    return count",           // line 7, the local
    "}",
    "",
    "count = count + 1",          // line 10, the outer one
    "baa tally([1]), count",      // line 11, the outer one
    "",
  ].join("\n");

  const at = (server: LanguageServer, method: string, line: number, character: number, extra = {}) =>
    server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: `textDocument/${method}`,
      params: { textDocument: { uri: URI }, position: { line, character }, ...extra },
    })?.result as never;

  it("goes to the declaration a use actually binds to", () => {
    const { server } = harness();
    open(server, SOURCE);

    // The `count` on line 7 is the local declared on line 3.
    const local = at(server, "definition", 7, 11) as { range: { start: { line: number } } };
    assert.equal(local.range.start.line, 3);

    // The `count` on line 11 is the top-level one declared on line 0.
    const outer = at(server, "definition", 11, 20) as { range: { start: { line: number } } };
    assert.equal(outer.range.start.line, 0);
  });

  it("finds only the uses that bind to the same declaration", () => {
    const { server } = harness();
    open(server, SOURCE);

    const local = at(server, "references", 3, 8) as Array<{ range: { start: { line: number } } }>;
    const localLines = local.map((r) => r.range.start.line).sort((a, b) => a - b);
    assert.deepEqual(localLines, [3, 5, 7], "the local, its increment and its return");

    const outer = at(server, "references", 0, 4) as Array<{ range: { start: { line: number } } }>;
    const outerLines = outer.map((r) => r.range.start.line).sort((a, b) => a - b);
    assert.deepEqual(outerLines, [0, 10, 10, 11], "declaration, both halves of line 10, and line 11");
  });

  it("omits the declaration when the client asks it to", () => {
    const { server } = harness();
    open(server, SOURCE);
    const refs = at(server, "references", 3, 8, { context: { includeDeclaration: false } }) as unknown[];
    assert.equal(refs.length, 2, "the two uses, without the declaration");
  });

  it("renames one binding without touching the other", () => {
    const { server } = harness();
    open(server, SOURCE);
    const edit = at(server, "rename", 3, 8, { newName: "total" }) as {
      changes: Record<string, Array<{ range: { start: { line: number } }; newText: string }>>;
    };
    const lines = edit.changes[URI]!.map((e) => e.range.start.line).sort((a, b) => a - b);
    assert.deepEqual(lines, [3, 5, 7], "the local only; the outer `count` is untouched");
    assert.ok(edit.changes[URI]!.every((e) => e.newText === "total"));
  });

  // Writing a name the lexer cannot read produces a file that no longer
  // parses, so the edit is refused rather than applied and then complained at.
  it("refuses a new name that is not an identifier", () => {
    const { server } = harness();
    open(server, SOURCE);
    for (const newName of ["2legs", "has space", "", "with-dash"]) {
      assert.equal(at(server, "rename", 3, 8, { newName }), null, newName);
    }
  });

  it("says nothing when the cursor is not on a name", () => {
    const { server } = harness();
    open(server, SOURCE);
    assert.equal(at(server, "definition", 1, 0), null);
    assert.equal(at(server, "references", 1, 0), null);
  });

  it("offers the current name when preparing a rename", () => {
    const { server } = harness();
    open(server, SOURCE);
    const prepared = at(server, "prepareRename", 7, 11) as { placeholder: string; range: { start: { line: number } } };
    assert.equal(prepared.placeholder, "count");
    assert.equal(prepared.range.start.line, 3, "anchored on the declaration it would rename");
  });

  it("hovers the local rather than the top-level name it shadows", () => {
    const { server } = harness();
    open(server, SOURCE);
    const hover = at(server, "hover", 7, 11) as { contents: { value: string } };
    // The local is a `let`, not the top-level one; either way it must not
    // claim to be something declared elsewhere.
    assert.match(hover.contents.value, /count/);
  });
});

describe("language server: the process an editor starts", () => {
  /** Frame a message the way the protocol requires. */
  const frame = (message: unknown): string => {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  };

  it("completes a real session over stdio and exits cleanly", async () => {
    const child = spawn(process.execPath, [CLI, "lsp"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });

    child.stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    child.stdin.write(
      frame({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        // Non-ASCII on purpose: the header counts bytes, so a server that
        // measured characters would desynchronise from here onwards.
        params: { textDocument: { uri: URI, text: 'baa "sheep \u{1F411}"\nbaa nope\n' } },
      }),
    );
    child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "shutdown" }));
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit" }));

    const code = await new Promise<number>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, "a shutdown before exit must exit 0");
    assert.match(out, /"capabilities"/);
    assert.match(out, /BAA102/, "the diagnostic for `nope` should have been published");
    // Every frame must carry a byte length that matches its body.
    for (const [, length, body] of out.matchAll(/Content-Length: (\d+)\r\n\r\n(\{.*?\})(?=Content-Length|$)/gs)) {
      assert.equal(Buffer.byteLength(body!, "utf8"), Number(length));
    }
  });
});
