/**
 * `baa app`: native applications.
 *
 * Baa is a web and scripting language, and `.baa` keeps meaning what it always
 * meant. A native application is not a different kind of file, it is a
 * different way of running the same files: instead of a web server executing a
 * page per request, a runtime built for the desktop holds the program open and
 * draws a window for it.
 *
 * So there is no new extension and no second language. What `baa app build`
 * produces is one executable containing this runtime and the program, and the
 * only thing that makes a program an application rather than a script is that
 * it imports `barn` and asks for a window.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { bundle, BundleError, NATIVE_MODULES } from "../native/bundle.ts";
import { addResources, parseVersion } from "../native/resources.ts";
import { findManifest, parseToml, readManifest } from "../project/manifest.ts";
import type { CommandContext } from "./commands.ts";
import { printDiagnostics, writeError, writeLine } from "./output.ts";

/** Marks the end of an executable that has an image appended to it. */
const FOOTER = "BAAFLEECE";

export type AppArgs = {
  readonly action: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, string>;
};

export function commandApp(args: AppArgs, context: CommandContext): number {
  switch (args.action) {
    case "new":
      return appNew(args);
    case "build":
      return appBuild(args, context, { run: false });
    case "run":
      return appBuild(args, context, { run: true });
    case "test":
      return appBuild(args, context, { run: true, tests: true });
    case "":
    case "help":
      writeLine(usage());
      return 0;
    default:
      writeError(`Unknown \`baa app\` action \`${args.action}\`.\n\n${usage()}`);
      return 2;
  }
}

function usage(): string {
  return `baa app <action>

  new <dir>     Create a native application project
  build         Build a Windows executable
  run           Build and run, with output on this terminal
  test          Run the project's \`test\` blocks on the native runtime

Options:
  --out <dir>   Where to write the executable (default: build/)
  --console     Build the console runtime, so \`baa\` output has somewhere to go
  --entry <f>   Entry file, when there is no baa.toml

A native application imports \`barn\` and draws a window. Standard modules a
native application can use: ${NATIVE_MODULES.join(", ")}.
See docs/native-applications.md.
`;
}

// ------------------------------------------------------------------ scaffold

function appNew(args: AppArgs): number {
  const target = resolve(args.positionals[0] ?? ".");
  const name = args.options.get("name") ?? basename(target);
  mkdirSync(target, { recursive: true });

  if (existsSync(join(target, "baa.toml")) && !args.flags.has("force")) {
    writeError(`${join(target, "baa.toml")} already exists. Use --force to overwrite.`);
    return 1;
  }

  writeFileSync(join(target, "baa.toml"), manifestFor(name), "utf8");
  writeFileSync(join(target, "main.baa"), STARTER, "utf8");
  mkdirSync(join(target, "tests"), { recursive: true });
  writeFileSync(join(target, "tests", "counter_test.baa"), STARTER_TEST, "utf8");
  writeFileSync(join(target, "counter.baa"), STARTER_LOGIC, "utf8");

  writeLine(
    `Created ${name}.\n\n` +
      `  cd ${basename(target)}\n` +
      "  baa app run          # build and run it\n" +
      "  baa test             # its logic, with no window involved\n",
  );
  return 0;
}

function manifestFor(name: string): string {
  return `# Baa project manifest.
[flock]
name = "${name}"
version = "0.1.0"
description = "A native Baa application."
entry = "main.baa"

# Everything under [app] describes the executable rather than the program.
[app]
title = "${name}"
width = "420"
height = "260"
`;
}

const STARTER = `/// A native application: a window, a label and a button.
///
/// The counting lives in counter.baa, which imports no \`barn\` and so can be
/// tested without a screen. That split is the point: the window is the part
/// that needs a person to look at it, and it should be the smallest part.
import barn
import "./counter.baa" as counter

let state = counter.start()

const window = barn.window({ title: "Counter", width: 320, height: 160 })
const layout = barn.column(window, { weight: 1, spacing: 12 })
const display = barn.label(layout, { text: counter.label(state), align: "center", size: 22, weight: 1 })
const buttons = barn.row(layout, { spacing: 8 })
const down = barn.button(buttons, { text: "Fewer" })
const up = barn.button(buttons, { text: "More" })

fn refresh() {
    barn.set_text(display, counter.label(state))
}

barn.on(up, "click", fn() {
    state = counter.up(state)
    refresh()
})

barn.on(down, "click", fn() {
    state = counter.down(state)
    refresh()
})

barn.show(window)
barn.run()
`;

const STARTER_LOGIC = `/// The counting. No window in sight, which is what makes it testable.

export fn start() {
    return { sheep: 0 }
}

export fn up(state) {
    return { sheep: state.sheep + 1 }
}

export fn down(state) {
    if state.sheep == 0 {
        return state
    }
    return { sheep: state.sheep - 1 }
}

export fn label(state) {
    if state.sheep == 1 {
        return "1 sheep"
    }
    return "{state.sheep} sheep"
}
`;

const STARTER_TEST = `import "../counter.baa" as counter

test "starts empty" {
    assert_eq(counter.start().sheep, 0)
}

test "counts up and down" {
    let state = counter.up(counter.up(counter.start()))
    assert_eq(state.sheep, 2)
    assert_eq(counter.down(state).sheep, 1)
}

test "never counts below zero" {
    assert_eq(counter.down(counter.start()).sheep, 0)
}

test "says sheep properly" {
    assert_eq(counter.label({ sheep: 1 }), "1 sheep")
    assert_eq(counter.label({ sheep: 4 }), "4 sheep")
}
`;

// --------------------------------------------------------------------- build

function appBuild(
  args: AppArgs,
  context: CommandContext,
  mode: { run: boolean; tests?: boolean },
): number {
  const cwd = process.cwd();
  const manifestPath = findManifest(cwd);
  let entry = args.options.get("entry");
  let root = cwd;
  let name = basename(cwd);
  let app: Record<string, string> = {};

  if (manifestPath !== null) {
    const manifest = readManifest(manifestPath);
    root = manifest.root;
    name = manifest.name;
    entry = entry ?? join(manifest.root, manifest.entry);
    app = appSection(manifestPath);
    app.name = app.name ?? manifest.name;
    app.version = app.version ?? manifest.version;
    app.title = app.title ?? manifest.name;
  }
  if (entry === undefined) {
    writeError(
      "No `baa.toml` here and no `--entry`.\n" +
        "Run `baa app new .` to create a project, or name the file: `baa app build --entry main.baa`.",
    );
    return 2;
  }
  entry = resolve(root, entry);

  // `app test` runs the project's tests, not the application. Running the
  // entry point would show the window and block on the event loop, which is
  // exactly what a test run must not do.
  if (mode.tests && args.options.get("entry") === undefined) {
    const suite = collectTests(root);
    if (suite.length === 0) {
      writeError(
        `No tests found. \`baa app test\` runs every .baa file under ${join(root, "tests")}.\n` +
          "Name one directly with --entry, or write one: see docs/application-projects.md.",
      );
      return 1;
    }
    return runTests(suite, root, app);
  }

  let built;
  try {
    built = bundle({ entry, root, app });
  } catch (error) {
    if (error instanceof BundleError) {
      writeError(error.message);
      printDiagnostics(error.diagnostics, context.colour);
      return 1;
    }
    throw error;
  }

  // Running is a build to a temporary image plus the console runtime, so that
  // `baa` output lands on this terminal. Nothing is written to the project.
  if (mode.run) {
    const host = findHost({ windowed: false });
    if (host === null) return 1;
    const image = join(tmpdir(), `baa-${process.pid}.fleece`);
    writeFileSync(image, built.bytes);
    const runArgs = mode.tests ? ["--test", image] : [image];
    const outcome = spawnSync(host, runArgs, { stdio: "inherit" });
    if (outcome.error) {
      writeError(`could not run ${host}: ${outcome.error.message}`);
      return 1;
    }
    return outcome.status ?? 0;
  }

  const windowed = !args.flags.has("console");
  const host = findHost({ windowed });
  if (host === null) return 1;

  const outDir = resolve(root, args.options.get("out") ?? "build");
  mkdirSync(outDir, { recursive: true });
  const executable = join(outDir, `${app.name ?? name}${process.platform === "win32" ? ".exe" : ""}`);

  try {
    copyFileSync(host, executable);
    // Resources go on before the image: everything after the last section is
    // an overlay, and the image is exactly that.
    const described = describeExecutable(executable, app, context);
    if (described !== null) return described;
    appendImage(executable, built.bytes);
  } catch (error) {
    // Windows locks a running executable, so the second build of an
    // application you left open fails here. The system's message for that is
    // `EBUSY: resource busy or locked`, which is true and unhelpful.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "ETXTBSY") {
      writeError(
        `Cannot write ${executable}: it is running.
` +
          "Close the application and build again.",
      );
      return 1;
    }
    throw error;
  }
  if (process.platform !== "win32") chmodSync(executable, 0o755);

  const size = statSync(executable).size;
  writeLine(
    `Built ${executable}\n` +
      `  ${built.modules.length} module${built.modules.length === 1 ? "" : "s"}` +
      (built.stdlib.length > 0 ? `, using ${built.stdlib.join(", ")}` : "") +
      `\n  ${(size / 1024).toFixed(0)} KB, ${windowed ? "windowed" : "console"}\n`,
  );

  // The window model is platform-independent and only Windows has a backend,
  // so this executable is real, runs, and cannot open a window. Saying that at
  // build time is the difference between a documented limit and a program that
  // starts and does nothing.
  if (built.stdlib.includes("barn") && process.platform !== "win32") {
    writeError(
      `This build runs on ${process.platform}, where \`barn\` has no window backend yet.\n` +
        "The executable works, but `barn.show` will report that there is nothing to\n" +
        "draw with. Only Windows can run a Baa application with a window today; see\n" +
        "ROADMAP.md for the Linux backend.\n",
    );
  }
  return 0;
}

/**
 * Every `.baa` file under the project's `tests/` directory.
 *
 * The same place `baa test` looks with no arguments, so a project has one
 * answer to "where are the tests" whichever runtime is running them.
 */
function collectTests(root: string): string[] {
  const directory = join(root, "tests");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".baa")) found.push(full);
    }
  };
  walk(directory);
  return found;
}

/**
 * Runs each test file as its own image.
 *
 * One image per file rather than one for all of them: a test file is a
 * complete program, and bundling several together would give them a shared
 * global scope they do not have under `baa test`.
 */
function runTests(files: readonly string[], root: string, app: Record<string, string>): number {
  const host = findHost({ windowed: false });
  if (host === null) return 1;

  let failed = 0;
  for (const file of files) {
    writeLine(relative(root, file).split(sep).join("/"));
    let bytes: Uint8Array;
    try {
      bytes = bundle({ entry: file, root, app }).bytes;
    } catch (error) {
      if (error instanceof BundleError) {
        writeError(error.message);
        failed++;
        continue;
      }
      throw error;
    }
    const image = join(tmpdir(), `baa-test-${process.pid}.fleece`);
    writeFileSync(image, bytes);
    const outcome = spawnSync(host, ["--test", image], { stdio: "inherit" });
    if ((outcome.status ?? 1) !== 0) failed++;
  }

  if (failed > 0) {
    writeError(`${failed} of ${files.length} test file(s) failed on the native runtime`);
    return 1;
  }
  writeLine(`${files.length} test file(s) passed on the native runtime`);
  return 0;
}

/**
 * Appends the image and a footer naming its length.
 *
 * Appending rather than embedding as a resource means `baa app build` needs no
 * compiler and no linker: it copies a file and adds bytes to the end of it,
 * which Windows ignores and which the runtime knows to look for. The cost is
 * that the icon and version metadata belong to the runtime rather than to the
 * application; ROADMAP.md has that as the next piece of work here.
 */
function appendImage(executable: string, image: Uint8Array): void {
  const host = readFileSync(executable);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(image.length));
  writeFileSync(executable, Buffer.concat([host, Buffer.from(image), length, Buffer.from(FOOTER, "ascii")]));
}

/**
 * Give the executable an icon and the version its Properties dialog shows.
 *
 * Windows only, because resources are a PE idea: on any other platform this
 * does nothing rather than pretending. Returns an exit code when it fails and
 * `null` when it did what it could, which is what the caller wants: a build
 * that cannot read the icon it was pointed at should stop, but a runtime with
 * nowhere to put resources should not fail a Linux build.
 */
function describeExecutable(
  executable: string,
  app: Record<string, string>,
  context: CommandContext,
): number | null {
  if (process.platform !== "win32") return null;

  let icon: Uint8Array | undefined;
  const iconPath = app.icon;
  if (iconPath !== undefined) {
    const full = isAbsolute(iconPath) ? iconPath : resolve(dirname(executable), "..", iconPath);
    const candidate = existsSync(full) ? full : resolve(process.cwd(), iconPath);
    if (!existsSync(candidate)) {
      writeError(`No icon at ${iconPath}. \`[app] icon\` is a path to an .ico file, relative to the project.`);
      return 1;
    }
    icon = new Uint8Array(readFileSync(candidate));
  }

  const version = parseVersion(app.version ?? "0.0.0");
  const title = app.title ?? app.name ?? basename(executable);
  try {
    const patched = addResources(new Uint8Array(readFileSync(executable)), {
      version: {
        version,
        productName: title,
        fileDescription: title,
        companyName: app.company ?? "",
        copyright: app.copyright ?? "",
        originalFilename: basename(executable),
      },
      ...(icon === undefined ? {} : { icon }),
    });
    writeFileSync(executable, patched);
    return null;
  } catch (error) {
    writeError(
      `Could not describe ${basename(executable)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!context.flags.quiet) {
      writeError("The executable would have run, but with no icon and no version information.");
    }
    return 1;
  }
}

function appSection(manifestPath: string): Record<string, string> {
  const document = parseToml(readFileSync(manifestPath, "utf8"), manifestPath);
  const table = document.app ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

/**
 * The native runtime binary.
 *
 * It is a compiled artefact, so it is either built from `rust/` in this
 * repository or shipped beside the CLI. When it is missing, saying how to
 * build it is more useful than saying it is missing.
 */
/**
 * The release archive for this machine, named so the message can be followed
 * rather than interpreted. A platform with no published runtime says so
 * instead of naming a file that does not exist.
 */
function platformArchive(): string {
  const target =
    process.platform === "win32" ? "windows-x64" : process.platform === "linux" ? "linux-x64" : null;
  const releases = "https://github.com/PatrickJnr/sheep/releases";
  return target === null
    ? `no runtime is published for ${process.platform}; build it from the repository`
    : `${releases}/latest/download/baa-native-${target}.tar.gz`;
}

function findHost(options: { windowed: boolean }): string | null {
  const exe = process.platform === "win32" ? ".exe" : "";
  const name = `${options.windowed ? "baa-nativew" : "baa-native"}${exe}`;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.BAA_NATIVE_HOST ? join(process.env.BAA_NATIVE_HOST, name) : null,
    join(here, "..", "..", "native", name),
    // Where the archive from a release unpacks to, if somebody put it in the
    // obvious place. Checked before the repository paths so a downloaded
    // runtime is not shadowed by a stale `cargo build` in a checkout.
    join(homedir(), ".baa", "runtime", name),
    join(here, "..", "..", "rust", "target", "release", name),
    join(here, "..", "..", "rust", "target", "debug", name),
    join(process.cwd(), "rust", "target", "release", name),
    join(process.cwd(), "rust", "target", "debug", name),
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // The advice depends on where `baa` came from. An npm install has no `rust/`
  // directory, so telling somebody to run cargo in one is telling them to run
  // a command that cannot work.
  const fromRepository = existsSync(join(here, "..", "..", "rust", "Cargo.toml"));
  writeError(
    fromRepository
      ? `The native runtime (${name}) is not built.\n\n` +
          "  cargo build --release --manifest-path rust/Cargo.toml\n\n" +
          "Or point BAA_NATIVE_HOST at the directory holding it. The runtime is\n" +
          "Rust and needs a Rust toolchain; the language itself does not."
      : `The native runtime (${name}) does not ship with the npm package.\n\n` +
          "Download it from a release and unpack it where Baa looks:\n\n" +
          `  ${platformArchive()}\n` +
          `  -> ${join(homedir(), ".baa", "runtime")}\n\n` +
          "Or point BAA_NATIVE_HOST at whichever directory holds it.\n\n" +
          "Everything else in Baa works from the npm package. See\n" +
          "https://sheep.grimtech.co.uk/docs/building-windows-apps.html",
  );
  return null;
}
