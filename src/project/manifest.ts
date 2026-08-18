/**
 * `baa.toml`, the project manifest, and `baa.lock`, the resolved wool.
 *
 * Baa reads a deliberately small subset of TOML: tables, and keys whose values
 * are strings, numbers, booleans, arrays of strings, or inline tables of
 * strings. That covers every field the manifest defines, and a subset parser
 * that reports precise errors beats pulling in a dependency to parse a file
 * this project writes itself. Anything outside the subset is a `BAA405` with a
 * line number, never a silent misparse.
 *
 * Dependencies ("wool") are local paths. There is no package registry yet, and
 * pretending otherwise would be worse than saying so, see ROADMAP.md.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { BaaError } from "../diagnostics/diagnostic.ts";
import { SourceFile } from "../diagnostics/source.ts";

export const MANIFEST_NAME = "baa.toml";
export const LOCKFILE_NAME = "baa.lock";

export type Dependency = {
  readonly name: string;
  /** Path to the dependency's directory or entry file, relative to the manifest. */
  readonly path: string;
};

export type Manifest = {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** Entry point, relative to the manifest directory. */
  readonly entry: string;
  readonly license: string;
  readonly authors: readonly string[];
  readonly dependencies: readonly Dependency[];
  /** Directory holding `baa.toml`. */
  readonly root: string;
};

export type TomlValue = string | number | boolean | string[] | Record<string, string>;
export type TomlDocument = Record<string, Record<string, TomlValue>>;

// --------------------------------------------------------------------------
// A small, strict TOML subset
// --------------------------------------------------------------------------

export function parseToml(text: string, path: string): TomlDocument {
  const file = new SourceFile(path, text);
  const document: TomlDocument = { "": {} };
  let table = "";
  let offset = 0;

  for (const line of file.text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const trimmed = stripComment(line).trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith("[")) {
      if (!trimmed.endsWith("]")) {
        throw manifestError(`unclosed table header \`${trimmed}\``, file, start, line);
      }
      table = trimmed.slice(1, -1).trim();
      if (table.length === 0) {
        throw manifestError("empty table name", file, start, line);
      }
      document[table] ??= {};
      continue;
    }

    const equals = trimmed.indexOf("=");
    if (equals === -1) {
      throw manifestError(`expected \`key = value\`, found \`${trimmed}\``, file, start, line);
    }
    const key = trimmed.slice(0, equals).trim().replace(/^"|"$/g, "");
    const rawValue = trimmed.slice(equals + 1).trim();
    if (key.length === 0) {
      throw manifestError("missing key name", file, start, line);
    }
    document[table] ??= {};
    document[table]![key] = parseValue(rawValue, file, start, line);
  }
  return document;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inString = !inString;
    else if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseValue(
  raw: string,
  file: SourceFile,
  start: number,
  line: string,
): TomlValue {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return unescapeToml(raw.slice(1, -1));
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitTopLevel(inner).map((item) => {
      const value = item.trim();
      if (!value.startsWith('"') || !value.endsWith('"')) {
        throw manifestError(`array items must be strings, found \`${value}\``, file, start, line);
      }
      return unescapeToml(value.slice(1, -1));
    });
  }
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const inner = raw.slice(1, -1).trim();
    const table: Record<string, string> = {};
    if (inner.length === 0) return table;
    for (const pair of splitTopLevel(inner)) {
      const equals = pair.indexOf("=");
      if (equals === -1) {
        throw manifestError(`expected \`key = value\` inside \`{ }\``, file, start, line);
      }
      const key = pair.slice(0, equals).trim().replace(/^"|"$/g, "");
      const value = pair.slice(equals + 1).trim();
      if (!value.startsWith('"') || !value.endsWith('"')) {
        throw manifestError(`inline table values must be strings, found \`${value}\``, file, start, line);
      }
      table[key] = unescapeToml(value.slice(1, -1));
    }
    return table;
  }
  throw manifestError(`unsupported value \`${raw}\``, file, start, line);
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (const ch of text) {
    if (ch === '"') inString = !inString;
    if (!inString) {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function unescapeToml(text: string): string {
  return text.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return ch;
    }
  });
}

function manifestError(message: string, file: SourceFile, start: number, line: string): BaaError {
  return BaaError.of("BAA405", [message], {
    span: file.span(start, start + Math.max(1, line.trimEnd().length)),
    note: "here",
    help: "Baa reads a small TOML subset: tables, strings, numbers, booleans, string arrays and inline tables.",
  });
}

// --------------------------------------------------------------------------
// Manifest
// --------------------------------------------------------------------------

export function findManifest(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, MANIFEST_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readManifest(manifestPath: string): Manifest {
  const text = readFileSync(manifestPath, "utf8");
  const document = parseToml(text, manifestPath);
  const pkg = document.flock ?? document.package ?? {};
  const wool = document.wool ?? {};
  const root = dirname(resolve(manifestPath));

  const dependencies: Dependency[] = [];
  for (const [name, value] of Object.entries(wool)) {
    if (typeof value === "string") {
      dependencies.push({ name, path: value });
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const path = (value as Record<string, string>).path;
      if (typeof path === "string") {
        dependencies.push({ name, path });
        continue;
      }
    }
    throw BaaError.of("BAA405", [`dependency \`${name}\` needs a path, e.g. ${name} = { path = "../${name}" }`], {
      help: "There is no package registry yet, so every dependency is a local path.",
    });
  }

  return {
    name: stringField(pkg, "name", "unnamed-flock"),
    version: stringField(pkg, "version", "0.1.0"),
    description: stringField(pkg, "description", ""),
    entry: stringField(pkg, "entry", "main.baa"),
    license: stringField(pkg, "license", ""),
    authors: Array.isArray(pkg.authors) ? (pkg.authors as string[]) : [],
    dependencies,
    root,
  };
}

function stringField(
  table: Record<string, TomlValue>,
  key: string,
  fallback: string,
): string {
  const value = table[key];
  return typeof value === "string" ? value : fallback;
}

export function renderManifest(manifest: Omit<Manifest, "root">): string {
  const lines: string[] = [];
  lines.push("# Baa project manifest. `baa help manifest` explains every field.");
  lines.push("[flock]");
  lines.push(`name = ${quote(manifest.name)}`);
  lines.push(`version = ${quote(manifest.version)}`);
  if (manifest.description) lines.push(`description = ${quote(manifest.description)}`);
  lines.push(`entry = ${quote(manifest.entry)}`);
  if (manifest.license) lines.push(`license = ${quote(manifest.license)}`);
  if (manifest.authors.length > 0) {
    lines.push(`authors = [${manifest.authors.map(quote).join(", ")}]`);
  }
  lines.push("");
  lines.push("# Dependencies are called wool. Each one is a local path for now.");
  lines.push("[wool]");
  for (const dependency of manifest.dependencies) {
    lines.push(`${dependency.name} = { path = ${quote(dependency.path)} }`);
  }
  return `${lines.join("\n")}\n`;
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Resolve every dependency to an entry file. Returns a map of module name to
 * absolute path, ready to hand to the interpreter.
 */
export function resolveDependencies(manifest: Manifest): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const dependency of manifest.dependencies) {
    const base = isAbsolute(dependency.path)
      ? dependency.path
      : resolve(manifest.root, dependency.path);
    const candidates = base.endsWith(".baa")
      ? [base]
      : [join(base, `${dependency.name}.baa`), join(base, "main.baa"), `${base}.baa`];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found === undefined) {
      throw BaaError.of("BAA401", [dependency.name], {
        note: "dependency path does not exist",
        help: `Looked for ${candidates.map((c) => relative(manifest.root, c)).join(", ")} under \`${dependency.path}\`.`,
      });
    }
    resolved.set(dependency.name, found);
  }
  return resolved;
}

// --------------------------------------------------------------------------
// Lockfile
// --------------------------------------------------------------------------

export type LockEntry = {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
};

export type Lockfile = {
  readonly version: 1;
  readonly flock: string;
  readonly wool: readonly LockEntry[];
};

export function buildLockfile(manifest: Manifest): Lockfile {
  const resolved = resolveDependencies(manifest);
  const wool: LockEntry[] = [];
  for (const [name, path] of [...resolved].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const contents = readFileSync(path);
    wool.push({
      name,
      path: relative(manifest.root, path).split("\\").join("/"),
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return { version: 1, flock: manifest.name, wool };
}

export function writeLockfile(manifest: Manifest, lock: Lockfile): string {
  const path = join(manifest.root, LOCKFILE_NAME);
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return path;
}

export function readLockfile(root: string): Lockfile | null {
  const path = join(root, LOCKFILE_NAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Lockfile;
  } catch {
    return null;
  }
}
