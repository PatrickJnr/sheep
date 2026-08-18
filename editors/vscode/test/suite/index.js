/**
 * Runs inside the VS Code extension host.
 *
 * This is the only test that answers the question the milestone actually
 * asked: does installing the extension and opening a `.baa` file produce
 * diagnostics with no configuration? Everything else about the extension can
 * be checked by reading the manifest, and reading the manifest cannot tell you
 * whether the server started.
 *
 * No test framework. The contract with `@vscode/test-electron` is a module
 * exporting `run()` that resolves on success and rejects on failure, which
 * `node:assert` satisfies on its own.
 */

const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const vscode = require("vscode");

/** Polls until `read` returns something truthy, or the deadline passes. */
async function eventually(what, read, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) {
      return value;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function run() {
  const work = mkdtempSync(join(tmpdir(), "baa-vscode-"));
  const file = join(work, "broken.baa");
  // `nope` is not declared anywhere, which is BAA102. Chosen because it is a
  // resolver diagnostic: producing it means the server parsed and analysed the
  // file, not merely tokenised it.
  writeFileSync(file, 'baa "sheep"\nbaa nope\n', "utf8");

  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document);

  assert.equal(document.languageId, "baa", "the .baa extension was not recognised");

  const extension = vscode.extensions.getExtension("baa-lang.baa-lang");
  assert.ok(extension, "the extension is not installed in this host");
  await eventually("the extension to activate", () => extension.isActive || null);

  const diagnostics = await eventually("diagnostics", () =>
    vscode.languages.getDiagnostics(document.uri),
  );
  const codes = diagnostics.map((diagnostic) => String(diagnostic.code));
  assert.ok(
    codes.includes("BAA102"),
    `expected BAA102 for an undeclared name, got ${JSON.stringify(codes)}`,
  );

  // The diagnostic has to land on `nope`, not merely somewhere in the file.
  const found = diagnostics.find((diagnostic) => String(diagnostic.code) === "BAA102");
  assert.equal(found.range.start.line, 1, "the diagnostic is on the wrong line");
  assert.equal(document.getText(found.range), "nope", "the range does not cover the name");

  // Formatting goes through the same server. A file with sloppy spacing comes
  // back as the formatter would write it.
  const messy = join(work, "messy.baa");
  writeFileSync(messy, 'let   x=1\nbaa    x\n', "utf8");
  const second = await vscode.workspace.openTextDocument(messy);
  await vscode.window.showTextDocument(second);
  // The options argument is not optional in practice: without it the command
  // reads them from the active editor and fails on `tabSize` being null.
  const edits = await eventually("formatting edits", () =>
    vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", second.uri, {
      tabSize: 4,
      insertSpaces: true,
    }),
  );
  assert.ok(edits.length > 0, "the server offered no formatting edits");

  // Go to definition, which is the feature that proves the resolver's symbol
  // table reached the editor rather than a text search.
  const uses = join(work, "uses.baa");
  writeFileSync(uses, "const flock = 3\nbaa flock\n", "utf8");
  const third = await vscode.workspace.openTextDocument(uses);
  await vscode.window.showTextDocument(third);
  const locations = await eventually("a definition", () =>
    vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider",
      third.uri,
      new vscode.Position(1, 5),
    ),
  );
  assert.equal(locations[0].range.start.line, 0, "definition did not point at the declaration");
}

module.exports = { run };
