/**
 * Collecting an application into one image.
 *
 * A native application ships as a single file, so every module it imports has
 * to be found, checked and packed at build time. That is the point where an
 * import can still be an error a person reads rather than a crash a user sees.
 *
 * Two rules make the result honest:
 *
 *  - Every module is checked with the same analysis `baa check` runs. A build
 *    that would not pass `baa check` does not produce an executable.
 *  - A standard-library module the native runtime does not implement is a
 *    build error naming the module, not a runtime failure. `gate` is the one
 *    that matters: web pages and native applications are different targets,
 *    and finding that out at build time is the difference between a sentence
 *    and an afternoon.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Statement } from "../ast/ast.ts";
import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import { SourceFile } from "../diagnostics/source.ts";
import { parse } from "../parser/parser.ts";
import { resolveProgram } from "../semantic/resolver.ts";
import { STDLIB_MODULES } from "../stdlib/index.ts";
import { encodeImage } from "./image.ts";
import type { ImageModule } from "./image.ts";

/**
 * Standard-library modules the native runtime implements.
 *
 * This list is the promise. Anything on it works in a built application;
 * anything off it is refused at build time with the reason. It is asserted
 * against the runtime's own list by `tests/native.test.ts`, so the two cannot
 * drift apart without a test failing.
 */
export const NATIVE_MODULES: readonly string[] = [
  "barn",
  "flock",
  "lamb",
  "meadow",
  "pasture",
  "ram",
  "shepherd",
  "wool",
];

/** Why a standard module is not available natively, when there is more to say. */
const UNAVAILABLE: Readonly<Record<string, string>> = {
  gate: "`gate` serves web pages over CGI. A native application draws its own window: use `barn`.",
};

export class BundleError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message);
    this.name = "BundleError";
    this.diagnostics = diagnostics;
  }
}

type Collected = {
  readonly absolute: string;
  readonly module: ImageModule;
  /** Import source text as written, mapped to the module index it resolved to. */
  readonly imports: Map<string, number>;
};

export type BundleOptions = {
  /** Absolute path of the entry `.baa` file. */
  readonly entry: string;
  /** Directory paths in the image are made relative to. */
  readonly root: string;
  /** `[app]` metadata from `baa.toml`. */
  readonly app?: Readonly<Record<string, string>>;
  /**
   * `[wool]` dependencies, as name → the file `import <name>` means.
   *
   * Given these, `import my_lib` is bundled like any other file. Without them
   * it is refused, which is what happens when this function is called by
   * something that has no manifest to resolve them from.
   */
  readonly dependencies?: ReadonlyMap<string, string>;
};

export type BundleResult = {
  readonly bytes: Uint8Array;
  readonly modules: readonly string[];
  /** Standard modules the application imports, in the order first seen. */
  readonly stdlib: readonly string[];
};

export function bundle(options: BundleOptions): BundleResult {
  const collected: Collected[] = [];
  const indexByPath = new Map<string, number>();
  const stdlib: string[] = [];
  const dependencies = options.dependencies ?? new Map<string, string>();

  // There is deliberately no check that a bundled file lies under the project.
  // A relative import is a path the author wrote in their own source, and the
  // native calculator imports `../../apps/calculator/expression.baa` on purpose:
  // one arithmetic module, two front ends. Refusing that would break the
  // arrangement the native platform exists to demonstrate, and it would buy
  // nothing — every path here comes from the program being built, never from
  // input it was given.

  const collect = (absolute: string, importedFrom: string | null): number => {
    const existing = indexByPath.get(absolute);
    if (existing !== undefined) return existing;

    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      const where = importedFrom === null ? "" : `, imported by ${display(options.root, importedFrom)}`;
      throw new BundleError(`cannot read ${display(options.root, absolute)}${where}`);
    }

    const file = new SourceFile(absolute, text);
    const { program, diagnostics } = parse(file);
    // The dependency names go in, or the resolver reports `BAA401` for an
    // import this bundler is about to satisfy.
    const analysis = resolveProgram(program, file, { modules: [...dependencies.keys()] });
    const errors = [...diagnostics, ...analysis.diagnostics].filter((d) => d.severity === "error");
    if (errors.length > 0) {
      throw new BundleError(`${display(options.root, absolute)} does not compile`, errors);
    }

    // Reserved before the imports are followed, so a cycle finds the index
    // rather than recursing until the stack runs out. Cycles are legal in Baa
    // and the runtime resolves them the same way the interpreter does.
    const index = collected.length;
    indexByPath.set(absolute, index);
    const entry: Collected = {
      absolute,
      module: {
        name: moduleName(absolute),
        path: display(options.root, absolute),
        source: text,
        body: program.body as readonly Statement[],
      },
      imports: new Map(),
    };
    collected.push(entry);

    for (const statement of program.body) {
      if (statement.kind !== "ImportDeclaration") continue;
      if (!statement.relative) {
        const dependency = dependencies.get(statement.source);
        if (dependency !== undefined) {
          // A `[wool]` dependency, bundled like any other file. Its own
          // relative imports are followed by the same code, so a dependency
          // made of several files works without saying anything more.
          entry.imports.set(statement.source, collect(resolve(dependency), absolute));
          continue;
        }
        if (!STDLIB_MODULES.includes(statement.source)) {
          throw new BundleError(
            `\`import ${statement.source}\` in ${display(options.root, absolute)} is neither a standard module nor a dependency.\n` +
              "Add it to `[wool]` in baa.toml with `baa add`, or import the file " +
              'directly: `import "./path/to/it.baa"`.',
          );
        }
        if (!NATIVE_MODULES.includes(statement.source)) {
          const why = UNAVAILABLE[statement.source] ?? `\`${statement.source}\` is not in the native runtime.`;
          throw new BundleError(
            `${display(options.root, absolute)} imports \`${statement.source}\`, which native applications do not have.\n${why}\n` +
              `Available natively: ${NATIVE_MODULES.join(", ")}.`,
          );
        }
        if (!stdlib.includes(statement.source)) stdlib.push(statement.source);
        continue;
      }
      const target = resolveRelative(dirname(absolute), statement.source);
      if (target === null) {
        throw new BundleError(
          `cannot find \`${statement.source}\`, imported by ${display(options.root, absolute)}`,
        );
      }
      entry.imports.set(statement.source, collect(target, absolute));
    }

    return index;
  };

  const entryIndex = collect(resolve(options.entry), null);

  const bytes = encodeImage({
    modules: collected.map((item) => item.module),
    entry: entryIndex,
    app: options.app ?? {},
    hasImport: (fromModule, source) => collected[fromModule]?.imports.has(source) === true,
    resolveImport: (fromModule, source) => {
      const found = collected[fromModule]?.imports.get(source);
      if (found === undefined) {
        throw new BundleError(`import \`${source}\` was not collected: this is a bug in the bundler`);
      }
      return found;
    },
  });

  return {
    bytes,
    modules: collected.map((item) => item.module.path),
    stdlib,
  };
}

/**
 * The same candidate order the interpreter uses for a relative import, so a
 * program that runs with `baa run` finds the same files when it is built.
 */
function resolveRelative(fromDir: string, source: string): string | null {
  const candidates = source.endsWith(".baa") ? [source] : [`${source}.baa`, source];
  for (const candidate of candidates) {
    const full = resolve(fromDir, candidate);
    try {
      readFileSync(full);
      return full;
    } catch {
      continue;
    }
  }
  return null;
}

function moduleName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.baa$/i, "");
}

/**
 * Paths in the image are relative to the project root and use forward slashes,
 * so a stack trace from a built application reads the same on every machine
 * and does not carry the build machine's directory layout to whoever runs it.
 */
function display(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path.split(sep).join("/");
  return rel.split(sep).join("/");
}
