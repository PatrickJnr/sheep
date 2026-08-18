/**
 * Implementations of every `baa` subcommand.
 *
 * Each command takes an already-parsed argument object and returns a process
 * exit code. Nothing here calls `process.exit` directly, which keeps the
 * commands testable and makes the exit-code contract explicit:
 *
 *   0  success
 *   1  the program or the check failed
 *   2  the command line was wrong
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { checkFile, toDiagnostic } from "../api.ts";
import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import { BaaError, createDiagnostic } from "../diagnostics/diagnostic.ts";
import { SourceFile } from "../diagnostics/source.ts";
import { formatProgram } from "../formatter/formatter.ts";
import { lintProgram } from "../linter/linter.ts";
import { parse } from "../parser/parser.ts";
import type { Lockfile, Manifest } from "../project/manifest.ts";
import {
  buildLockfile,
  findManifest,
  LOCKFILE_NAME,
  MANIFEST_NAME,
  readLockfile,
  readManifest,
  renderManifest,
  resolveDependencies,
  writeLockfile,
} from "../project/manifest.ts";
import { createNodeHost, describeFileError } from "../runtime/host.ts";
import { Interpreter } from "../runtime/interpreter.ts";
import { ExitSignal } from "../runtime/signals.ts";
import { resolveProgram } from "../semantic/resolver.ts";
import { STDLIB_MODULES, STDLIB_SUMMARY } from "../stdlib/index.ts";
import type { GlobalFlags } from "./index.ts";
import {
  bold,
  dim,
  failure,
  printDiagnostics,
  success,
  summarise,
  writeError,
  writeLine,
} from "./output.ts";

const BAA_EXTENSION = ".baa";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".baa-cache"]);

export type CommandContext = {
  readonly flags: GlobalFlags;
  readonly colour: boolean;
};

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------

export function collectFiles(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    const full = resolve(path);
    if (!existsSync(full)) {
      throw BaaError.of("BAA404", [`${path} does not exist`], {
        help: "Check the path. `baa --help` lists what each command expects.",
      });
    }
    if (statSync(full).isDirectory()) walkDirectory(full, files);
    else files.push(full);
  }
  return [...new Set(files)].sort();
}

function walkDirectory(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkDirectory(full, out);
    else if (extname(entry.name).toLowerCase() === BAA_EXTENSION) out.push(full);
  }
}

function shortPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith("..") || isAbsolute(rel) ? path : rel.split(sep).join("/");
}

/**
 * Read a file as a `SourceFile`, reporting a missing or unreadable one as a
 * diagnostic. Most commands reach this through `collectFiles`, which has
 * already checked, but `baa run` takes its entry straight from the argument
 * list: the check belongs here, where every caller passes.
 */
function readSource(path: string): SourceFile {
  try {
    return new SourceFile(shortPath(path), readFileSync(path, "utf8"));
  } catch (error) {
    throw BaaError.of("BAA404", [`${shortPath(path)}: ${describeFileError(error)}`], {
      help: "Check the path and that the file is readable.",
    });
  }
}

/** Load the enclosing project, when there is one. */
export function loadProject(from: string = process.cwd()): Manifest | null {
  const manifestPath = findManifest(from);
  if (manifestPath === null) return null;
  return readManifest(manifestPath);
}

function projectModules(manifest: Manifest | null): {
  names: readonly string[];
  dependencies: ReadonlyMap<string, string>;
} {
  if (manifest === null) return { names: [], dependencies: new Map() };
  const dependencies = resolveDependencies(manifest);
  return { names: [...dependencies.keys()], dependencies };
}

// --------------------------------------------------------------------------
// baa run
// --------------------------------------------------------------------------

export type RunArgs = {
  readonly entry: string | null;
  readonly programArgs: readonly string[];
  readonly seed: number | null;
  readonly maxDepth: number | null;
};

export function commandRun(args: RunArgs, context: CommandContext): number {
  const manifest = loadProject();
  const entryPath = resolveEntry(args.entry, manifest);
  if (entryPath === null) {
    writeError(
      failure("No program to run.", context.colour) +
        "\n  Pass a file (`baa run hello.baa`) or run inside a project with a `baa.toml`.",
    );
    return 2;
  }

  const file = readSource(entryPath);
  const { names, dependencies } = projectModules(manifest);
  const checked = checkFile(file, { modules: names });
  if (!checked.ok) {
    printDiagnostics(checked.diagnostics, context.colour);
    return 1;
  }
  if (checked.diagnostics.length > 0) printDiagnostics(checked.diagnostics, context.colour);

  const host = createNodeHost({
    argv: [...args.programArgs],
    ...(args.seed === null ? {} : { seed: args.seed }),
  });
  const interpreter = new Interpreter({
    host,
    dependencies,
    ...(args.maxDepth === null ? {} : { maxDepth: args.maxDepth }),
  });
  try {
    interpreter.run(checked.program, file);
    return 0;
  } catch (error) {
    if (error instanceof ExitSignal) return error.code;
    const converted = toDiagnostic(error, interpreter);
    if (converted === null) throw error;
    printDiagnostics(converted.diagnostics, context.colour);
    return converted.exitCode;
  }
}

function resolveEntry(entry: string | null, manifest: Manifest | null): string | null {
  if (entry !== null) {
    const direct = resolve(entry);
    if (existsSync(direct)) return direct;
    const withExtension = `${direct}${BAA_EXTENSION}`;
    return existsSync(withExtension) ? withExtension : direct;
  }
  if (manifest === null) return null;
  const main = resolve(manifest.root, manifest.entry);
  return existsSync(main) ? main : null;
}

// --------------------------------------------------------------------------
// baa check
// --------------------------------------------------------------------------

export function commandCheck(paths: readonly string[], context: CommandContext): number {
  const manifest = loadProject();
  const { names } = projectModules(manifest);
  const targets = collectFiles(paths.length > 0 ? paths : [defaultTarget(manifest)]);
  if (targets.length === 0) {
    writeLine("No .baa files found.");
    return 0;
  }
  const all: Diagnostic[] = [];
  for (const path of targets) {
    const result = checkFile(readSource(path), { modules: names });
    all.push(...result.diagnostics);
  }
  printDiagnostics(all, context.colour);
  const errors = all.filter((diagnostic) => diagnostic.severity === "error").length;
  if (!context.flags.quiet) {
    const label = `${targets.length} file${targets.length === 1 ? "" : "s"} checked, ${summarise(all)}`;
    writeLine(errors === 0 ? success(label, context.colour) : failure(label, context.colour));
  }
  return errors === 0 ? 0 : 1;
}

function defaultTarget(manifest: Manifest | null): string {
  return manifest === null ? process.cwd() : manifest.root;
}

/**
 * `baa test` with no paths prefers a `tests/` directory. Running every file in
 * the project would also execute the program itself, and a test run should not
 * print the application's output.
 */
function defaultTestTarget(manifest: Manifest | null): string {
  const root = defaultTarget(manifest);
  const tests = join(root, "tests");
  return existsSync(tests) && statSync(tests).isDirectory() ? tests : root;
}

// --------------------------------------------------------------------------
// baa lint
// --------------------------------------------------------------------------

export type LintArgs = {
  readonly paths: readonly string[];
  readonly denyWarnings: boolean;
  readonly disable: readonly string[];
};

export function commandLint(args: LintArgs, context: CommandContext): number {
  const manifest = loadProject();
  const { names } = projectModules(manifest);
  const targets = collectFiles(args.paths.length > 0 ? args.paths : [defaultTarget(manifest)]);
  const all: Diagnostic[] = [];
  for (const path of targets) {
    const file = readSource(path);
    const checked = checkFile(file, { modules: names });
    all.push(...checked.diagnostics);
    if (!checked.ok) continue;
    const analysis = resolveProgram(checked.program, file, { modules: names });
    all.push(...lintProgram(checked.program, analysis, { disable: args.disable }));
  }
  printDiagnostics(all, context.colour);
  const errors = all.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = all.length - errors;
  if (!context.flags.quiet) {
    const label = `${targets.length} file${targets.length === 1 ? "" : "s"} linted, ${summarise(all)}`;
    writeLine(all.length === 0 ? success(label, context.colour) : label);
  }
  if (errors > 0) return 1;
  return args.denyWarnings && warnings > 0 ? 1 : 0;
}

// --------------------------------------------------------------------------
// baa fmt
// --------------------------------------------------------------------------

export type FormatArgs = {
  readonly paths: readonly string[];
  readonly check: boolean;
  readonly toStdout: boolean;
  readonly indent: number | null;
  readonly lineWidth: number | null;
};

export function commandFormat(args: FormatArgs, context: CommandContext): number {
  const manifest = loadProject();
  const targets = collectFiles(args.paths.length > 0 ? args.paths : [defaultTarget(manifest)]);
  const options = {
    ...(args.indent === null ? {} : { indent: args.indent }),
    ...(args.lineWidth === null ? {} : { lineWidth: args.lineWidth }),
  };
  let changed = 0;
  let failed = 0;

  for (const path of targets) {
    const file = readSource(path);
    let formatted: string;
    try {
      const { program, diagnostics } = parse(file);
      const fatal = diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (fatal !== undefined) throw new BaaError(fatal);
      formatted = formatProgram(program, options);
    } catch (error) {
      if (!(error instanceof BaaError)) throw error;
      printDiagnostics([error.diagnostic], context.colour);
      failed++;
      continue;
    }

    if (args.toStdout) {
      process.stdout.write(formatted);
      continue;
    }
    if (formatted === file.text) continue;
    changed++;
    if (args.check) {
      writeLine(`${failure("would reformat", context.colour)} ${shortPath(path)}`);
    } else {
      writeFileSync(path, formatted, "utf8");
      if (!context.flags.quiet) writeLine(`${success("formatted", context.colour)} ${shortPath(path)}`);
    }
  }

  if (failed > 0) return 1;
  if (args.toStdout) return 0;
  if (!context.flags.quiet) {
    const unchanged = targets.length - changed;
    writeLine(
      dim(
        `${targets.length} file${targets.length === 1 ? "" : "s"}: ${changed} ${args.check ? "would change" : "changed"}, ${unchanged} already tidy`,
        context.colour,
      ),
    );
  }
  return args.check && changed > 0 ? 1 : 0;
}

// --------------------------------------------------------------------------
// baa test
// --------------------------------------------------------------------------

export type TestArgs = {
  readonly paths: readonly string[];
  readonly filter: string | null;
  readonly seed: number | null;
};

export function commandTest(args: TestArgs, context: CommandContext): number {
  const manifest = loadProject();
  const { names, dependencies } = projectModules(manifest);
  const targets = collectFiles(args.paths.length > 0 ? args.paths : [defaultTestTarget(manifest)]);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const startedAt = performance.now();

  for (const path of targets) {
    const file = readSource(path);
    const checked = checkFile(file, { modules: names });
    if (!checked.ok) {
      printDiagnostics(checked.diagnostics, context.colour);
      failed++;
      continue;
    }

    const host = createNodeHost(args.seed === null ? {} : { seed: args.seed });
    const interpreter = new Interpreter({ host, dependencies });
    try {
      interpreter.run(checked.program, file);
    } catch (error) {
      if (error instanceof ExitSignal) continue;
      const converted = toDiagnostic(error, interpreter);
      if (converted === null) throw error;
      writeLine(`${failure("FAIL", context.colour)} ${shortPath(path)} (while loading)`);
      printDiagnostics(converted.diagnostics, context.colour);
      failed++;
      continue;
    }

    if (interpreter.tests.length === 0) continue;
    writeLine(bold(shortPath(path), context.colour));
    for (const test of interpreter.tests) {
      if (args.filter !== null && !test.name.includes(args.filter)) {
        skipped++;
        continue;
      }
      const began = performance.now();
      try {
        interpreter.runTestBody(test);
        const elapsed = performance.now() - began;
        writeLine(
          `  ${success("ok", context.colour)} ${test.name} ${dim(`${elapsed.toFixed(1)}ms`, context.colour)}`,
        );
        passed++;
      } catch (error) {
        const converted = toDiagnostic(error, interpreter);
        if (converted === null) throw error;
        writeLine(`  ${failure("FAIL", context.colour)} ${test.name}`);
        printDiagnostics(converted.diagnostics, context.colour, process.stdout);
        failed++;
      }
    }
  }

  const elapsed = (performance.now() - startedAt).toFixed(0);
  const summary = `${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""} in ${elapsed}ms`;
  writeLine("");
  writeLine(failed === 0 ? success(summary, context.colour) : failure(summary, context.colour));
  if (passed === 0 && failed === 0) {
    writeLine(dim('No tests found. Write one with `test "name" { ... }`.', context.colour));
  }
  return failed === 0 ? 0 : 1;
}

// --------------------------------------------------------------------------
// baa build
// --------------------------------------------------------------------------

export type BuildArgs = {
  /**
   * Verify `baa.lock` instead of writing it. Without this the lockfile is
   * rewritten on every build, so a dependency whose contents changed updates
   * the recorded hash silently and the hash records nothing worth knowing.
   */
  readonly locked: boolean;
};

export function commandBuild(args: BuildArgs, context: CommandContext): number {
  const manifest = loadProject();
  if (manifest === null) {
    writeError(
      failure(`No ${MANIFEST_NAME} found.`, context.colour) +
        "\n  Run `baa init` first, or `baa check <file>` to validate a single file.",
    );
    return 2;
  }

  writeLine(`${bold(manifest.name, context.colour)} ${dim(manifest.version, context.colour)}`);
  const { names } = projectModules(manifest);
  const targets = collectFiles([manifest.root]);
  const all: Diagnostic[] = [];
  for (const path of targets) {
    all.push(...checkFile(readSource(path), { modules: names }).diagnostics);
  }
  printDiagnostics(all, context.colour);
  const errors = all.filter((diagnostic) => diagnostic.severity === "error").length;
  if (errors > 0) {
    writeLine(failure(`build failed: ${summarise(all)}`, context.colour));
    return 1;
  }

  const entry = resolve(manifest.root, manifest.entry);
  if (!existsSync(entry)) {
    printDiagnostics(
      [
        createDiagnostic("BAA404", [`entry \`${manifest.entry}\` does not exist`], {
          help: `Set \`entry\` in ${MANIFEST_NAME}, or create the file.`,
        }),
      ],
      context.colour,
    );
    return 1;
  }

  const lock = buildLockfile(manifest);
  writeLine(`  ${targets.length} file${targets.length === 1 ? "" : "s"} validated`);
  writeLine(`  entry: ${manifest.entry}`);
  writeLine(`  wool:  ${lock.wool.length === 0 ? "none" : lock.wool.map((w) => w.name).join(", ")}`);

  if (args.locked) {
    const drift = describeLockDrift(readLockfile(manifest.root), lock);
    if (drift !== null) {
      printDiagnostics(
        [
          createDiagnostic("BAA406", [drift], {
            help: "Run `baa build` to record the current wool, and commit the result.",
          }),
        ],
        context.colour,
      );
      return 1;
    }
    writeLine(`  ${LOCKFILE_NAME} matches`);
    writeLine(success("Ready to herd.", context.colour));
    return 0;
  }

  writeLine(`  wrote ${shortPath(writeLockfile(manifest, lock))}`);
  writeLine(success("Ready to herd.", context.colour));
  return 0;
}

/**
 * What changed between the lockfile on disk and the one this build produced,
 * or null when they agree. Phrased for a person reading a failing CI job, so
 * it names the wool rather than printing two JSON documents to compare by eye.
 */
function describeLockDrift(previous: Lockfile | null, current: Lockfile): string | null {
  if (previous === null) return `there is no ${LOCKFILE_NAME}`;
  if (previous.version !== current.version) {
    return `it was written in format ${previous.version}, and this is format ${current.version}`;
  }

  const before = new Map(previous.wool.map((entry) => [entry.name, entry]));
  const after = new Map(current.wool.map((entry) => [entry.name, entry]));
  const changes: string[] = [];
  for (const [name, entry] of after) {
    const old = before.get(name);
    if (old === undefined) changes.push(`\`${name}\` is new`);
    else if (old.sha256 !== entry.sha256) changes.push(`\`${name}\` has changed`);
    else if (old.path !== entry.path) changes.push(`\`${name}\` moved to ${entry.path}`);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changes.push(`\`${name}\` is gone`);
  }
  return changes.length === 0 ? null : changes.sort().join(", ");
}

// --------------------------------------------------------------------------
// baa init
// --------------------------------------------------------------------------

export type InitArgs = {
  readonly directory: string;
  readonly name: string | null;
  readonly force: boolean;
};

export function commandInit(args: InitArgs, context: CommandContext): number {
  const root = resolve(args.directory);
  const manifestPath = join(root, MANIFEST_NAME);
  if (existsSync(manifestPath) && !args.force) {
    writeError(
      failure(`${MANIFEST_NAME} already exists in ${shortPath(root)}.`, context.colour) +
        "\n  Pass --force to overwrite it.",
    );
    return 2;
  }
  const name = args.name ?? sanitiseName(root.split(sep).pop() ?? "flock");

  mkdirSync(root, { recursive: true });
  writeFileSync(
    manifestPath,
    renderManifest({
      name,
      version: "0.1.0",
      description: "A new Baa flock.",
      entry: "main.baa",
      license: "MIT",
      authors: [],
      dependencies: [],
    }),
    "utf8",
  );

  const mainPath = join(root, "main.baa");
  if (!existsSync(mainPath) || args.force) {
    writeFileSync(mainPath, STARTER_PROGRAM, "utf8");
  }
  const greetingsPath = join(root, "greetings.baa");
  if (!existsSync(greetingsPath) || args.force) {
    writeFileSync(greetingsPath, STARTER_MODULE, "utf8");
  }
  const testDir = join(root, "tests");
  mkdirSync(testDir, { recursive: true });
  const testPath = join(testDir, "greetings_test.baa");
  if (!existsSync(testPath) || args.force) {
    writeFileSync(testPath, STARTER_TEST, "utf8");
  }
  const gitignorePath = join(root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${LOCKFILE_NAME}\n.baa-cache/\n`, "utf8");
  }

  writeLine(`${success("Created", context.colour)} ${name} in ${shortPath(root)}`);
  writeLine(`  ${MANIFEST_NAME}`);
  writeLine("  main.baa");
  writeLine("  greetings.baa");
  writeLine("  tests/greetings_test.baa");
  writeLine("");
  writeLine("Next:");
  writeLine(`  cd ${shortPath(root)}`);
  writeLine("  baa run");
  writeLine("  baa test");
  return 0;
}

function sanitiseName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "flock";
}

const STARTER_PROGRAM = `// Welcome to Baa. Run this with \`baa run\`.

import "./greetings.baa"

const FLOCK = ["Dolly", "Shaun", "Lambchop"]

baa "Hello, flock!"

for name in FLOCK {
    baa greetings.greet(name)
}

baa "That's {len(FLOCK)} sheep accounted for."
`;

const STARTER_MODULE = `// Anything marked \`export\` can be imported by another file.

/// Greet one sheep by name.
export fn greet(name) {
    return "Baa, {name}!"
}
`;

const STARTER_TEST = `// Run these with \`baa test\`.

import "../greetings.baa"

test "greets a sheep by name" {
    assert_eq(greetings.greet("Dolly"), "Baa, Dolly!")
}

test "greets every sheep in a flock" {
    const names = ["Dolly", "Shaun"]
    assert_eq(names.map(greetings.greet), ["Baa, Dolly!", "Baa, Shaun!"])
}
`;

// --------------------------------------------------------------------------
// baa add / baa remove
// --------------------------------------------------------------------------

export function commandAdd(
  name: string,
  path: string | null,
  context: CommandContext,
): number {
  const manifest = loadProject();
  if (manifest === null) return noProject(context);

  if (STDLIB_MODULES.includes(name)) {
    writeError(
      failure(`\`${name}\` is part of the standard library.`, context.colour) +
        `\n  Just write \`import ${name}\`: no dependency needed.`,
    );
    return 2;
  }
  if (path === null) {
    writeError(
      failure("Baa has no package registry yet.", context.colour) +
        "\n  Add a local dependency instead: `baa add my_lib --path ../my_lib`." +
        "\n  See ROADMAP.md for where the registry sits in the plan.",
    );
    return 2;
  }
  const target = isAbsolute(path) ? path : resolve(manifest.root, path);
  if (!existsSync(target)) {
    writeError(failure(`No such path: ${path}`, context.colour));
    return 2;
  }

  const dependencies = manifest.dependencies.filter((dependency) => dependency.name !== name);
  dependencies.push({ name, path: normaliseRelative(manifest.root, target) });
  dependencies.sort((a, b) => (a.name < b.name ? -1 : 1));
  writeManifestFile(manifest, dependencies);
  writeLine(`${success("Added", context.colour)} ${name} (${normaliseRelative(manifest.root, target)})`);
  return refreshLock(manifest, context);
}

export function commandRemove(name: string, context: CommandContext): number {
  const manifest = loadProject();
  if (manifest === null) return noProject(context);
  if (!manifest.dependencies.some((dependency) => dependency.name === name)) {
    writeError(failure(`\`${name}\` is not a dependency of ${manifest.name}.`, context.colour));
    return 2;
  }
  const dependencies = manifest.dependencies.filter((dependency) => dependency.name !== name);
  writeManifestFile(manifest, dependencies);
  writeLine(`${success("Removed", context.colour)} ${name}`);
  return refreshLock(manifest, context);
}

function noProject(context: CommandContext): number {
  writeError(
    failure(`No ${MANIFEST_NAME} found.`, context.colour) + "\n  Run `baa init` first.",
  );
  return 2;
}

function normaliseRelative(root: string, target: string): string {
  const rel = relative(root, target).split(sep).join("/");
  return rel.length === 0 ? "." : rel.startsWith(".") ? rel : `./${rel}`;
}

function writeManifestFile(
  manifest: Manifest,
  dependencies: readonly { name: string; path: string }[],
): void {
  writeFileSync(
    join(manifest.root, MANIFEST_NAME),
    renderManifest({ ...manifest, dependencies }),
    "utf8",
  );
}

function refreshLock(manifest: Manifest, context: CommandContext): number {
  const updated = readManifest(join(manifest.root, MANIFEST_NAME));
  try {
    writeLockfile(updated, buildLockfile(updated));
    return 0;
  } catch (error) {
    if (!(error instanceof BaaError)) throw error;
    printDiagnostics([error.diagnostic], context.colour);
    return 1;
  }
}

// --------------------------------------------------------------------------
// baa doctor
// --------------------------------------------------------------------------

export function commandDoctor(context: CommandContext, version: string): number {
  const rows: Array<[string, boolean, string]> = [];

  const nodeVersion = process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);
  const minor = Number(nodeVersion.split(".")[1] ?? "0");
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  rows.push([
    "Node.js",
    nodeOk,
    nodeOk ? `v${nodeVersion}` : `v${nodeVersion}: Baa needs v22.18 or newer`,
  ]);

  rows.push(["Platform", true, `${process.platform} ${process.arch}`]);
  rows.push(["Baa", true, version]);

  let manifest: Manifest | null = null;
  try {
    manifest = loadProject();
  } catch (error) {
    if (error instanceof BaaError) {
      rows.push(["Project", false, error.diagnostic.message]);
    } else throw error;
  }
  if (manifest !== null) {
    rows.push(["Project", true, `${manifest.name} ${manifest.version} (${shortPath(manifest.root)})`]);
    try {
      const resolved = resolveDependencies(manifest);
      rows.push([
        "Wool",
        true,
        resolved.size === 0 ? "no dependencies" : `${resolved.size} resolved`,
      ]);
    } catch (error) {
      rows.push(["Wool", false, error instanceof BaaError ? error.diagnostic.message : String(error)]);
    }
    const entry = resolve(manifest.root, manifest.entry);
    rows.push([
      "Entry",
      existsSync(entry),
      existsSync(entry) ? manifest.entry : `${manifest.entry} is missing`,
    ]);
  } else {
    rows.push(["Project", true, `no ${MANIFEST_NAME} here (single-file mode)`]);
  }

  rows.push(["Standard library", true, `${STDLIB_MODULES.length} modules`]);
  rows.push([
    "Colour",
    true,
    context.colour ? "enabled" : "disabled (NO_COLOR, CI or not a terminal)",
  ]);

  const width = Math.max(...rows.map(([label]) => label.length));
  let problems = 0;
  for (const [label, ok, detail] of rows) {
    if (!ok) problems++;
    const mark = ok ? success("ok  ", context.colour) : failure("fail", context.colour);
    writeLine(`${mark} ${label.padEnd(width)}  ${detail}`);
  }
  writeLine("");
  writeLine(
    problems === 0
      ? success("The flock is healthy.", context.colour)
      : failure(`${problems} problem${problems === 1 ? "" : "s"} found.`, context.colour),
  );
  return problems === 0 ? 0 : 1;
}

// --------------------------------------------------------------------------
// baa modules (documentation helper)
// --------------------------------------------------------------------------

export function commandModules(context: CommandContext): number {
  writeLine(bold("Standard library", context.colour));
  const width = Math.max(...STDLIB_MODULES.map((name) => name.length));
  for (const name of STDLIB_MODULES) {
    writeLine(`  ${name.padEnd(width)}  ${dim(STDLIB_SUMMARY[name] ?? "", context.colour)}`);
  }
  writeLine("");
  writeLine(dim("Import one with `import wool`, or a few names with `import { trim } from wool`.", context.colour));
  return 0;
}
