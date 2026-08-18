/**
 * The host interface.
 *
 * Everything the interpreter needs from the outside world goes through here:
 * output streams, the filesystem, the clock, randomness, the environment and
 * the process. Two benefits:
 *
 *  - Tests run programs with a capturing host and assert on exact output
 *    without touching real stdio or the real filesystem.
 *  - Capabilities are visible in one place. A future sandboxed `baa run
 *    --deny-fs` only has to swap the host, not audit the standard library.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

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
