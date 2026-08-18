#!/usr/bin/env node
/**
 * The `baa` command-line interface.
 *
 * Argument parsing is hand-rolled and about a hundred lines, which is smaller
 * than any argument-parsing dependency and makes the `--help` text and the
 * parser impossible to drift apart: they are written next to each other.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BaaError, setWoollyMode } from "../diagnostics/diagnostic.ts";
import { serve } from "../lsp/server.ts";
import {
  commandAdd,
  commandBuild,
  commandCheck,
  commandDoctor,
  commandFormat,
  commandInit,
  commandLint,
  commandModules,
  commandRemove,
  commandRun,
  commandTest,
} from "./commands.ts";
import type { CommandContext } from "./commands.ts";
import { BANNER, bold, detectColour, detectWoolly, dim, printDiagnostics, writeError, writeLine } from "./output.ts";
import { commandServe } from "./serve.ts";
import { startRepl } from "./repl.ts";

export type GlobalFlags = {
  readonly quiet: boolean;
  readonly woolly: boolean;
};

export const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `${bold("baa", false)}: a programming language with a little more Baa.

USAGE
  baa <command> [options]

COMMANDS
  run [file]            Execute a program (defaults to the project entry)
  check [paths...]      Parse and analyse without running
  test [paths...]       Run \`test "..." { ... }\` blocks
  fmt [paths...]        Format source files in place
  lint [paths...]       Report style and correctness warnings
  serve [dir]           Serve a directory of .baa pages over HTTP
  lsp                   Run the language server on stdin and stdout
  repl                  Start an interactive session
  init [dir]            Create a new project
  build                 Validate the project and write baa.lock
  add <name> --path P   Add a local dependency
  remove <name>         Remove a dependency
  doctor                Check the installation and project
  modules               List the standard library
  version               Print the version

GLOBAL OPTIONS
  --no-baa              Plain diagnostics, no sheep wording (also BAA_NO_BAA=1)
  --color / --no-color  Force colour on or off (also NO_COLOR=1)
  --quiet               Print less
  -h, --help            Show help for a command
  -V, --version         Print the version

EXAMPLES
  baa run hello.baa
  baa run -- --name Dolly        Arguments after -- go to the program
  baa test tests/
  baa fmt --check .              Non-zero exit when anything is unformatted
  baa lint --deny-warnings .     Treat warnings as failures in CI

Docs: https://sheep.grimtech.co.uk   Source: https://github.com/PatrickJnr/sheep`;

const COMMAND_HELP: Record<string, string> = {
  run: `baa run [file] [options] [-- program args...]

  Execute a Baa program. With no file, runs the \`entry\` from baa.toml.

  --seed <n>        Seed the random number generator for reproducible runs
  --max-depth <n>   Maximum nested function calls (default 512)`,
  check: `baa check [paths...]

  Parse and analyse without executing. Directories are searched for .baa files.
  Exits non-zero when anything fails to compile.`,
  test: `baa test [paths...] [options]

  Run every \`test "name" { ... }\` block found in the given files.

  --filter <text>   Only run tests whose name contains this text
  --seed <n>        Seed the random number generator`,
  fmt: `baa fmt [paths...] [options]

  Format files in place. Formatting is deterministic: running it twice changes
  nothing the second time.

  --check           Do not write; exit non-zero if anything would change
  --stdout          Write the result to stdout instead of the file
  --indent <n>      Spaces per level (default 4)
  --line-width <n>  Soft maximum line width (default 90)`,
  lint: `baa lint [paths...] [options]

  Report warnings: unused bindings, unreachable code, empty blocks and friends.

  --deny-warnings   Exit non-zero when any warning is reported
  --disable <code>  Skip a rule, e.g. --disable BAA905 (repeatable)`,
  init: `baa init [dir] [options]

  Create baa.toml, main.baa and a starter test.

  --name <name>     Project name (defaults to the directory name)
  --force           Overwrite existing files`,
  add: `baa add <name> --path <path>

  Add a local dependency ("wool") to baa.toml and refresh baa.lock.
  There is no package registry yet; see ROADMAP.md.`,
  remove: `baa remove <name>

  Remove a dependency from baa.toml and refresh baa.lock.`,
  build: `baa build [options]

  Validate every file in the project, check the entry point exists and write
  baa.lock with a hash of each dependency.

  --locked          Verify baa.lock instead of writing it, and exit non-zero
                    if any dependency has changed since it was recorded`,
  serve: `baa serve [dir] [options]

  Run a directory of .baa pages over HTTP, for development.

  Each request executes the matching .baa file in a fresh process with the CGI
  environment set, which is the same thing Apache does, so a page that works
  here works on a real host. Not for production: one process per request, and
  it binds to localhost unless told otherwise.

  --port <n>        Port to listen on (default 8080)
  --host <address>  Address to bind (default 127.0.0.1)`,
  repl: `baa repl [--no-banner]

  Start an interactive session. Bindings persist between lines.`,
  doctor: `baa doctor

  Report the Node version, platform, project state and dependency resolution.`,
  lsp: `baa lsp

  Speak the Language Server Protocol over stdin and stdout. Editors start this
  themselves; there is rarely a reason to run it by hand.

  Provides diagnostics as you type, whole-file formatting, a document symbol
  outline, and hover for top-level declarations. Diagnostics come from the same
  analysis as \`baa check\` and \`baa lint\`, so an editor cannot disagree with
  the command line about whether a file is valid.`,
};

type Parsed = {
  readonly command: string;
  readonly positionals: string[];
  readonly options: Map<string, string[]>;
  readonly booleans: Set<string>;
  readonly passthrough: string[];
};

const VALUE_FLAGS = new Set([
  "port",
  "host",
  "seed",
  "max-depth",
  "filter",
  "indent",
  "line-width",
  "name",
  "path",
  "disable",
]);

function parseArgs(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const booleans = new Set<string>();
  const passthrough: string[] = [];
  let command = "";
  let index = 0;

  for (; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (argument.startsWith("--")) {
      const body = argument.slice(2);
      const equals = body.indexOf("=");
      const key = equals === -1 ? body : body.slice(0, equals);
      if (VALUE_FLAGS.has(key)) {
        const value = equals === -1 ? argv[++index] : body.slice(equals + 1);
        if (value === undefined) {
          throw BaaError.of("BAA301", [`--${key} needs a value`], {
            help: `Try \`--${key} <value>\`.`,
          });
        }
        const existing = options.get(key) ?? [];
        existing.push(value);
        options.set(key, existing);
      } else {
        booleans.add(key);
      }
      continue;
    }
    if (argument.startsWith("-") && argument.length > 1) {
      for (const letter of argument.slice(1)) {
        if (letter === "h") booleans.add("help");
        else if (letter === "V") booleans.add("version");
        else if (letter === "q") booleans.add("quiet");
        else {
          throw BaaError.of("BAA301", [`unknown flag -${letter}`], {
            help: "Run `baa --help` to see the available options.",
          });
        }
      }
      continue;
    }
    if (command === "") command = argument;
    else positionals.push(argument);
  }

  return { command, positionals, options, booleans, passthrough };
}

function numberOption(parsed: Parsed, key: string): number | null {
  const values = parsed.options.get(key);
  if (values === undefined || values.length === 0) return null;
  const value = Number(values[values.length - 1]);
  if (!Number.isFinite(value)) {
    throw BaaError.of("BAA301", [`--${key} must be a number`], {
      help: `Got \`${values[values.length - 1]}\`.`,
    });
  }
  return value;
}

function stringOption(parsed: Parsed, key: string): string | null {
  const values = parsed.options.get(key);
  return values === undefined || values.length === 0 ? null : values[values.length - 1]!;
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof BaaError)) throw error;
    printDiagnostics([error.diagnostic], detectColour(null));
    return 2;
  }

  const colour = detectColour(
    parsed.booleans.has("no-color") ? false : parsed.booleans.has("color") ? true : null,
  );
  const woolly = detectWoolly(parsed.booleans.has("no-baa") ? false : null);
  setWoollyMode(woolly);

  const flags: GlobalFlags = { quiet: parsed.booleans.has("quiet"), woolly };
  const context: CommandContext = { flags, colour };

  if (parsed.booleans.has("version") || parsed.command === "version") {
    writeLine(`baa ${VERSION}`);
    return 0;
  }
  if (parsed.command === "" || parsed.command === "help") {
    const topic = parsed.positionals[0];
    if (topic !== undefined && COMMAND_HELP[topic] !== undefined) {
      writeLine(COMMAND_HELP[topic]!);
      return 0;
    }
    if (parsed.command === "" && !parsed.booleans.has("help")) {
      writeLine(dim(BANNER, colour));
      writeLine(`${bold(`Baa ${VERSION}`, colour)}`);
      writeLine("Ready to herd some code.");
      writeLine("");
    }
    writeLine(HELP);
    return parsed.command === "" && !parsed.booleans.has("help") ? 0 : 0;
  }
  if (parsed.booleans.has("help")) {
    writeLine(COMMAND_HELP[parsed.command] ?? HELP);
    return 0;
  }

  try {
    switch (parsed.command) {
      case "run":
        return commandRun(
          {
            entry: parsed.positionals[0] ?? null,
            programArgs: parsed.passthrough,
            seed: numberOption(parsed, "seed"),
            maxDepth: numberOption(parsed, "max-depth"),
          },
          context,
        );
      case "check":
        return commandCheck(parsed.positionals, context);
      case "lint":
        return commandLint(
          {
            paths: parsed.positionals,
            denyWarnings: parsed.booleans.has("deny-warnings"),
            disable: parsed.options.get("disable") ?? [],
          },
          context,
        );
      case "fmt":
      case "format":
        return commandFormat(
          {
            paths: parsed.positionals,
            check: parsed.booleans.has("check"),
            toStdout: parsed.booleans.has("stdout"),
            indent: numberOption(parsed, "indent"),
            lineWidth: numberOption(parsed, "line-width"),
          },
          context,
        );
      case "test":
        return commandTest(
          {
            paths: parsed.positionals,
            filter: stringOption(parsed, "filter"),
            seed: numberOption(parsed, "seed"),
          },
          context,
        );
      case "build":
        return commandBuild({ locked: parsed.booleans.has("locked") }, context);
      case "init":
        return commandInit(
          {
            directory: parsed.positionals[0] ?? ".",
            name: stringOption(parsed, "name"),
            force: parsed.booleans.has("force"),
          },
          context,
        );
      case "add": {
        const name = parsed.positionals[0];
        if (name === undefined) {
          writeError("baa add needs a name: `baa add my_lib --path ../my_lib`");
          return 2;
        }
        return commandAdd(name, stringOption(parsed, "path"), context);
      }
      case "remove": {
        const name = parsed.positionals[0];
        if (name === undefined) {
          writeError("baa remove needs a name: `baa remove my_lib`");
          return 2;
        }
        return commandRemove(name, context);
      }
      case "lsp":
        // No banner, no colour, no stray writes: stdout is the protocol.
        return await serve({ read: process.stdin, write: (text) => void process.stdout.write(text) });
      case "doctor":
        return commandDoctor(context, VERSION);
      case "modules":
        return commandModules(context);
      case "serve":
        return await commandServe(
          {
            dir: parsed.positionals[0] ?? null,
            port: numberOption(parsed, "port"),
            host: parsed.options.get("host")?.[0] ?? null,
          },
          context,
        );
      case "repl":
        return await startRepl({
          colour,
          version: VERSION,
          banner: !parsed.booleans.has("no-banner") && !flags.quiet,
        });
      default:
        writeError(`Unknown command \`${parsed.command}\`. Run \`baa --help\`.`);
        return 2;
    }
  } catch (error) {
    if (error instanceof BaaError) {
      printDiagnostics([error.diagnostic], colour);
      return 1;
    }
    throw error;
  }
}

/**
 * True when this file is the process entry point rather than an import.
 *
 * Both sides are resolved through `realpathSync`, because npm installs a bin
 * as a symlink: running `node_modules/.bin/baa` gives an `argv[1]` pointing at
 * the link while `import.meta.url` points at the file it targets. Comparing
 * them directly says "this is an import", `main` never runs, and the command
 * exits successfully having done nothing at all.
 *
 * Windows hid this. There npm writes a `.cmd` shim that invokes node with the
 * real path, so the two matched and only Linux and macOS installs were silent.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      writeError(`baa: internal error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      writeError("This is a bug. Please report it: https://github.com/PatrickJnr/sheep/issues");
      process.exitCode = 70;
    });
}
