/**
 * The VS Code client for `baa lsp`.
 *
 * There is deliberately no language intelligence in here. Every diagnostic,
 * every hover and every rename comes from the same analysis `baa check` runs,
 * over the language server protocol; this file starts that server and hands
 * VS Code the connection. A second implementation of anything in here would be
 * a second thing that can disagree with the compiler.
 *
 * Finding the server is the only real work, and it is not the one-liner it
 * looks like. See `findServer`.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { ExtensionContext, window, workspace } from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

/**
 * How to start the server, and how that was decided. `module` runs a
 * JavaScript file under the editor's own Node; `command` runs an executable.
 */
type Server =
  | { kind: "module"; module: string; args: string[]; source: string }
  | { kind: "command"; command: string; args: string[]; source: string };

/**
 * Finds `baa lsp`.
 *
 * On Linux and macOS `baa` is an executable and this is the one-liner it
 * looks like. On Windows it is not: `npm install -g` writes `baa.cmd`, and
 * since CVE-2024-27980 Node refuses to spawn a `.cmd` at all without a shell,
 * failing with `EINVAL`. Reaching for `shell: true` to get around that is how
 * the vulnerability worked in the first place, so this does not.
 *
 * Instead it finds the shim, derives the JavaScript entry point npm installed
 * beside it, and hands that to the client as a module — which VS Code runs
 * with the Node that is already running the extension host. No shell, no
 * second Node, and nothing on the command line that could be re-read as
 * syntax.
 */
function findServer(): Server | null {
  const configured = workspace.getConfiguration("baa").get<string>("server.path")?.trim();
  if (configured !== undefined && configured !== "") {
    const source = "the `baa.server.path` setting";
    return configured.endsWith(".js")
      ? { kind: "module", module: configured, args: ["lsp"], source }
      : { kind: "command", command: configured, args: ["lsp"], source };
  }

  // An explicit path from the environment, for the cases that have no settings
  // UI to type one into: a container, a CI job, a remote host started by a
  // script. Checked after the setting, so a user's own configuration wins.
  const fromEnvironment = process.env["BAA_SERVER_PATH"]?.trim();
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    const source = "the BAA_SERVER_PATH environment variable";
    return fromEnvironment.endsWith(".js")
      ? { kind: "module", module: fromEnvironment, args: ["lsp"], source }
      : { kind: "command", command: fromEnvironment, args: ["lsp"], source };
  }

  if (process.platform !== "win32") {
    const probe = spawnSync("baa", ["--version"], { encoding: "utf8", shell: false });
    if (probe.status === 0) {
      return { kind: "command", command: "baa", args: ["lsp"], source: "PATH" };
    }
    return null;
  }

  // `where.exe` is a real executable, so it can be spawned when the thing it
  // is looking for cannot.
  const where = spawnSync("where", ["baa"], { encoding: "utf8", shell: false });
  if (where.status !== 0) return null;

  for (const line of where.stdout.split(/\r?\n/)) {
    const shim = line.trim();
    if (shim === "") continue;
    // npm's global layout: the shim sits beside the tree it installs into.
    const entry = join(dirname(shim), "node_modules", "baa-lang", "dist", "cli", "index.js");
    if (existsSync(entry)) {
      return { kind: "module", module: entry, args: ["lsp"], source: `PATH (${shim})` };
    }
  }
  return null;
}

export async function activate(context: ExtensionContext): Promise<void> {
  const server = findServer();
  if (server === null) {
    // Not an error dialog. An editor that opens a `.baa` file on a machine
    // without Baa installed still highlights it, and saying so once is
    // proportionate to what is missing.
    void window.showWarningMessage(
      "Baa: `baa` was not found, so diagnostics, formatting and navigation are off. " +
        "Install it with `npm install -g baa-lang`, or set `baa.server.path` to the executable.",
    );
    return;
  }

  // `NodeModule` and `Executable` are separate shapes in the client's types,
  // so the union has to be widened here rather than inferred from a ternary.
  const run: ServerOptions =
    server.kind === "module"
      ? { module: server.module, args: server.args, transport: TransportKind.stdio }
      : { command: server.command, args: server.args, transport: TransportKind.stdio };
  const serverOptions: ServerOptions = run;

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "baa" }],
    // The server reads a file's text from the editor, never from disk, so it
    // has nothing to say about files that are not open. Watching them anyway
    // would send it work it would discard.
    synchronize: { configurationSection: "baa" },
    outputChannelName: "Baa Language Server",
  };

  client = new LanguageClient("baa", "Baa Language Server", serverOptions, clientOptions);
  context.subscriptions.push(client);

  try {
    await client.start();
  } catch (error) {
    void window.showErrorMessage(
      `Baa: the language server failed to start (found via ${server.source}). ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
