/**
 * Working out how to start `baa lsp`.
 *
 * Separated from `extension.ts` so it can be tested without VS Code. The rule
 * it encodes is short and the reason it exists is not obvious, which is
 * exactly the combination that gets quietly broken later:
 *
 * `npm install -g` does not install an executable on Windows. It installs
 * `baa.cmd`, and since CVE-2024-27980 Node refuses to spawn a `.cmd` at all
 * without a shell, failing with `EINVAL`. Asking for a shell is how that
 * vulnerability worked, so instead the JavaScript entry point npm laid down
 * beside the shim is found and run as a module — under the Node already
 * hosting the extension, with no shell anywhere.
 */

/** How to start the server. `module` is JavaScript; `command` is executable. */
export type Server =
  | { kind: "module"; module: string; args: string[]; source: string }
  | { kind: "command"; command: string; args: string[]; source: string };

/** A path given by a human: a `.js` file is a module, anything else is run. */
export function fromPath(path: string, source: string): Server {
  return path.endsWith(".js")
    ? { kind: "module", module: path, args: ["lsp"], source }
    : { kind: "command", command: path, args: ["lsp"], source };
}

/**
 * The entry point npm installs beside a shim, in npm's global layout.
 *
 * `join` is passed in rather than imported so this stays a pure function of
 * its inputs, which is what makes it testable with a fake filesystem.
 */
export function entryBesideShim(
  shim: string,
  helpers: { dirname: (path: string) => string; join: (...parts: string[]) => string },
): string {
  return helpers.join(
    helpers.dirname(shim),
    "node_modules",
    "baa-lang",
    "dist",
    "cli",
    "index.js",
  );
}

/**
 * Reads `where baa` output and returns the first shim whose entry point is
 * really there. `where` lists both `baa` and `baa.cmd`; either leads to the
 * same directory, so the first one that checks out wins.
 */
export function fromWhereOutput(
  stdout: string,
  exists: (path: string) => boolean,
  helpers: { dirname: (path: string) => string; join: (...parts: string[]) => string },
): Server | null {
  for (const line of stdout.split(/\r?\n/)) {
    const shim = line.trim();
    if (shim === "") continue;
    const entry = entryBesideShim(shim, helpers);
    if (exists(entry)) {
      return { kind: "module", module: entry, args: ["lsp"], source: `PATH (${shim})` };
    }
  }
  return null;
}
