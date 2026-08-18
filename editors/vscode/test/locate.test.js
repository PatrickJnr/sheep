/**
 * How the extension finds `baa lsp`.
 *
 * This is the logic that was wrong the first time and produced an extension
 * which silently did nothing on Windows, so it is tested against a fake
 * filesystem rather than a real global npm install: a hosted CI runner does
 * not lay one out the way a user's machine does, and a test that needs the
 * runner to be a workstation tests the runner.
 *
 * It runs from this package rather than the repository's suite because the
 * extension is CommonJS and the repository is not.
 *
 *     npm test        (from editors/vscode, after npm run compile)
 */

const assert = require("node:assert/strict");
const { posix } = require("node:path");
const { describe, it } = require("node:test");

const { entryBesideShim, fromPath, fromWhereOutput } = require("../out/locate.js");

// Posix joining throughout, so the expectations read the same on every
// platform. The logic does no path parsing of its own; it is handed both.
const helpers = { dirname: posix.dirname, join: posix.join };

describe("locating the server", () => {
  it("derives the entry point npm installs beside a shim", () => {
    assert.equal(
      entryBesideShim("C:/Users/x/AppData/Roaming/npm/baa.cmd", helpers),
      "C:/Users/x/AppData/Roaming/npm/node_modules/baa-lang/dist/cli/index.js",
    );
  });

  it("takes the first shim whose entry point is really there", () => {
    // `where` lists `baa` and `baa.cmd`, and may list a stale directory first.
    const stdout = "C:/stale/baa\r\nC:/real/baa\r\nC:/real/baa.cmd\r\n";
    const real = "C:/real/node_modules/baa-lang/dist/cli/index.js";
    assert.deepEqual(fromWhereOutput(stdout, (path) => path === real, helpers), {
      kind: "module",
      module: real,
      args: ["lsp"],
      source: "PATH (C:/real/baa)",
    });
  });

  it("finds nothing rather than guessing when no entry point exists", () => {
    assert.equal(fromWhereOutput("C:/somewhere/baa.cmd\r\n", () => false, helpers), null);
    assert.equal(fromWhereOutput("", () => true, helpers), null);
  });

  it("runs a `.js` path as a module and anything else as a program", () => {
    // A `.js` file has to go through the editor's Node, because Node is what
    // runs it; anything else is spawned as the executable it claims to be.
    assert.equal(fromPath("/usr/local/bin/baa", "s").kind, "command");
    assert.equal(fromPath("C:/x/dist/cli/index.js", "s").kind, "module");
    assert.deepEqual(fromPath("/usr/local/bin/baa", "s").args, ["lsp"]);
  });
});
