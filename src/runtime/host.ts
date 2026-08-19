/**
 * The host interface.
 *
 * Everything the interpreter needs from the outside world goes through here:
 * output streams, the filesystem, the clock, randomness, the environment and
 * the process. Two benefits:
 *
 *  - Tests run programs with a capturing host and assert on exact output
 *    without touching real stdio or the real filesystem.
 *  - Capabilities are visible in one place. `baa run --deny-fs` and friends
 *    wrap the host rather than auditing the standard library: see
 *    `restrictHost` at the bottom of this file.
 *
 * That claim is only true while *everything* goes through here, which is why
 * `runProcess` exists: `shepherd.run` used to reach for `child_process`
 * directly, and a boundary with a hole in it is not a boundary.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";

export type ProcessResult = {
  readonly code: number;
  readonly out: string;
  readonly err: string;
};

export type HostFileStat = {
  readonly size: number;
  readonly isDirectory: boolean;
  readonly modified: number;
};

export type RuntimeHost = {
  write(text: string): void;
  writeError(text: string): void;
  readFile(path: string): string;
  writeFile(path: string, contents: string): void;
  appendFile(path: string, contents: string): void;
  fileExists(path: string): boolean;
  listDir(path: string): string[];
  makeDir(path: string): void;
  stat(path: string): HostFileStat | null;
  cwd(): string;
  resolvePath(...parts: string[]): string;
  envVar(name: string): string | null;
  envVars(): Record<string, string>;
  now(): number;
  random(): number;
  /**
   * Run another program and wait for it. Never through a shell: the argument
   * array is passed as it is, so nothing in it can be read as syntax.
   */
  runProcess(
    program: string,
    args: readonly string[],
    options: { cwd?: string; input?: string },
  ): ProcessResult;
  /** Command-line arguments passed to the Baa program itself. */
  argv(): string[];
  exit(code: number): void;
};

export type NodeHostOptions = {
  argv?: string[];
  /** Deterministic seed. When set, `meadow.random` is reproducible. */
  seed?: number;
};

/**
 * A short reason for a failed filesystem operation, without the path.
 *
 * Both Node and the in-memory host put the path in the message they throw, and
 * every caller prefixes the path it was given, so reporting the raw message
 * printed it twice: `data.txt: ENOENT: no such file or directory, open
 * 'C:\...\data.txt'`. Callers keep the path; this supplies only the reason.
 */
export function describeFileError(error: unknown): string {
  const code = (error as { code?: string }).code;
  switch (code) {
    case "ENOENT":
      return "no such file";
    case "EISDIR":
      return "that is a directory, not a file";
    case "ENOTDIR":
      return "part of that path is not a directory";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EMFILE":
    case "ENFILE":
      return "too many open files";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

export function createNodeHost(options: NodeHostOptions = {}): RuntimeHost {
  const argv = options.argv ?? [];
  const random = options.seed === undefined ? Math.random : makeSeededRandom(options.seed);
  return {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, contents) => writeFileSync(path, contents, "utf8"),
    appendFile: (path, contents) => writeFileSync(path, contents, { encoding: "utf8", flag: "a" }),
    fileExists: (path) => existsSync(path),
    listDir: (path) => readdirSync(path),
    makeDir: (path) => void mkdirSync(path, { recursive: true }),
    stat: (path) => {
      if (!existsSync(path)) return null;
      const info = statSync(path);
      return {
        size: info.size,
        isDirectory: info.isDirectory(),
        modified: info.mtimeMs,
      };
    },
    runProcess: (program, args, options) => {
      const result = spawnSync(program, [...args], {
        cwd: options.cwd ?? process.cwd(),
        encoding: "utf8",
        shell: false,
        ...(options.input === undefined ? {} : { input: options.input }),
      });
      if (result.error !== undefined) throw result.error;
      return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
    },
    cwd: () => process.cwd(),
    resolvePath: (...parts) => resolve(...parts),
    envVar: (name) => process.env[name] ?? null,
    envVars: () => ({ ...process.env }) as Record<string, string>,
    now: () => Date.now(),
    random,
    argv: () => argv,
    exit: (code) => process.exit(code),
  };
}

export type CapturingHost = RuntimeHost & {
  /** Everything written to stdout so far. */
  readonly output: () => string;
  readonly errorOutput: () => string;
};

/** In-memory host used by the test suite and the website playground. */
export function createCapturingHost(
  options: NodeHostOptions & { files?: Record<string, string>; cwd?: string } = {},
): CapturingHost {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map(Object.entries(options.files ?? {}));
  const base = options.cwd ?? "/baa";
  const random = options.seed === undefined ? Math.random : makeSeededRandom(options.seed);
  return {
    write: (text) => void out.push(text),
    writeError: (text) => void err.push(text),
    readFile: (path) => {
      const contents = files.get(path);
      if (contents === undefined) throw Object.assign(new Error(`no such file: ${path}`), {
        code: "ENOENT",
      });
      return contents;
    },
    writeFile: (path, contents) => void files.set(path, contents),
    appendFile: (path, contents) => void files.set(path, (files.get(path) ?? "") + contents),
    fileExists: (path) => files.has(path),
    listDir: (path) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => key.slice(path.length + 1).split("/")[0]!),
    makeDir: () => {},
    stat: (path) => {
      const contents = files.get(path);
      if (contents === undefined) return null;
      return { size: contents.length, isDirectory: false, modified: 0 };
    },
    runProcess: () => {
      // A host that cannot touch the filesystem has no business starting
      // programs either, and the playground runs in a browser where there is
      // nothing to start.
      throw Object.assign(new Error("this host cannot start other programs"), {
        code: "ENOSYS",
      });
    },
    cwd: () => base,
    resolvePath: (...parts) => resolve(base, ...parts),
    envVar: (name) => process.env[name] ?? null,
    envVars: () => ({ ...process.env }) as Record<string, string>,
    now: () => 0,
    random,
    argv: () => options.argv ?? [],
    exit: () => {},
    output: () => out.join(""),
    errorOutput: () => err.join(""),
  };
}

/** Small xorshift PRNG so `--seed` gives reproducible runs across platforms. */
function makeSeededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Cryptographically strong bytes, exposed to `meadow.token`. */
export function secureBytes(count: number): Uint8Array {
  return new Uint8Array(randomBytes(count));
}

// --------------------------------------------------------------------------
// Capabilities
// --------------------------------------------------------------------------

/**
 * What a run is allowed to reach. Everything is allowed by default: Baa is a
 * scripting language, and a program run from a shell already has whatever the
 * shell has. These are for the other case — running something you have not
 * read, or running it from a program that has.
 *
 * There is deliberately no `network` here. Baa cannot open a socket: `gate`
 * reads a CGI request from the environment and writes a reply to stdout, and
 * nothing in the standard library connects to anything. A flag denying a
 * capability that does not exist would be theatre, and it would suggest the
 * other flags are the same kind of thing.
 *
 * Randomness is not here either, for a different reason: it is not a boundary.
 * `--seed` already makes a run reproducible, which is what asking to "deny
 * randomness" is usually after.
 */
export type Capabilities = {
  /** Read files, list directories, stat paths. */
  readonly readFiles: boolean;
  /** Write files, append to them, make directories. */
  readonly writeFiles: boolean;
  /** Read environment variables. */
  readonly env: boolean;
  /** Start other programs. */
  readonly process: boolean;
};

export const ALL_CAPABILITIES: Capabilities = {
  readFiles: true,
  writeFiles: true,
  env: true,
  process: true,
};

/** True when nothing has been taken away, so wrapping the host is pointless. */
export function isUnrestricted(capabilities: Capabilities): boolean {
  return (
    capabilities.readFiles && capabilities.writeFiles && capabilities.env && capabilities.process
  );
}

/**
 * The error a denied capability raises. It is an ordinary Baa runtime error, so
 * a program can catch it, and it carries the same code wherever it comes from.
 *
 * This is thrown rather than returned as a null or an empty string on purpose:
 * a program that reads a file it is not allowed to read should fail, not
 * quietly behave as though the file were empty.
 */
export class DeniedError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`this run may not ${capability}`);
    this.name = "DeniedError";
    this.capability = capability;
  }
}

const denied = (capability: string): never => {
  throw new DeniedError(capability);
};

/**
 * Wrap a host so that the capabilities that were taken away refuse.
 *
 * Nothing else changes: an allowed operation goes to the underlying host
 * untouched, so a restricted run behaves exactly like an unrestricted one right
 * up to the point where it reaches for something it may not have.
 */
export function restrictHost(host: RuntimeHost, capabilities: Capabilities): RuntimeHost {
  if (isUnrestricted(capabilities)) return host;
  const read = <T>(what: () => T): T => (capabilities.readFiles ? what() : denied("read files"));
  const write = <T>(what: () => T): T => (capabilities.writeFiles ? what() : denied("write files"));
  return {
    ...host,
    readFile: (path) => read(() => host.readFile(path)),
    fileExists: (path) => read(() => host.fileExists(path)),
    listDir: (path) => read(() => host.listDir(path)),
    stat: (path) => read(() => host.stat(path)),
    writeFile: (path, contents) => write(() => host.writeFile(path, contents)),
    appendFile: (path, contents) => write(() => host.appendFile(path, contents)),
    makeDir: (path) => write(() => host.makeDir(path)),
    envVar: (name) => (capabilities.env ? host.envVar(name) : denied("read the environment")),
    envVars: () => (capabilities.env ? host.envVars() : denied("read the environment")),
    runProcess: (program, args, options) =>
      capabilities.process
        ? host.runProcess(program, args, options)
        : denied("start other programs"),
  };
}

/**
 * Turn a denial into the diagnostic a program sees, at the place that asked.
 *
 * Called from the standard library's `catch` blocks, before they decide the
 * failure was about a file: "this run may not read files" is a different fact
 * from "no such file", and reporting the second for the first sends the reader
 * looking for a path that is perfectly fine.
 */
export function rethrowIfDenied(error: unknown, span: Span): void {
  if (!(error instanceof DeniedError)) return;
  throw BaaError.of("BAA313", [error.capability], {
    span,
    note: "denied by the capabilities this run was given",
    help: "Drop the matching `--deny-` flag if the program is meant to do this.",
  });
}
