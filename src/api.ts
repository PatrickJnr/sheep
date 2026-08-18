/**
 * The programmatic Baa API.
 *
 * Everything the CLI does is available here as a plain function over strings,
 * which is what makes the test suite and the website playground possible
 * without spawning processes.
 */

import type { Program } from "./ast/ast.ts";
import type { Diagnostic } from "./diagnostics/diagnostic.ts";
import { BaaError, createDiagnostic } from "./diagnostics/diagnostic.ts";
import { SourceFile } from "./diagnostics/source.ts";
import { formatProgram } from "./formatter/formatter.ts";
import type { FormatOptions } from "./formatter/formatter.ts";
import { lintProgram } from "./linter/linter.ts";
import { parse } from "./parser/parser.ts";
import { resolveProgram } from "./semantic/resolver.ts";
import type { ResolveResult, SymbolInfo } from "./semantic/resolver.ts";
import type { RuntimeHost } from "./runtime/host.ts";
import { createCapturingHost } from "./runtime/host.ts";
import { Interpreter } from "./runtime/interpreter.ts";
import { ExitSignal, ThrownValue } from "./runtime/signals.ts";
import { display, inspect } from "./runtime/values.ts";
import type { Value } from "./runtime/values.ts";

export type CheckResult = {
  readonly file: SourceFile;
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
  readonly ok: boolean;
  /**
   * What the resolver worked out: every declaration, and every place each name
   * is used. Editors need this to answer "where is this defined" and "what
   * would rename touch", and only the resolver knows which declaration a use
   * binds to. Null when parsing failed badly enough that nothing was resolved.
   */
  readonly analysis: ResolveResult | null;
};

export type CheckOptions = {
  /** Extra importable module names, e.g. dependencies declared in `baa.toml`. */
  readonly modules?: readonly string[];
};

/** Parse and analyse without executing. Never throws for user errors. */
export function check(text: string, path = "<input>", options: CheckOptions = {}): CheckResult {
  const file = new SourceFile(path, text);
  return checkFile(file, options);
}

export function checkFile(file: SourceFile, options: CheckOptions = {}): CheckResult {
  let program: Program;
  let diagnostics: Diagnostic[];
  try {
    const parsed = parse(file);
    program = parsed.program;
    diagnostics = [...parsed.diagnostics];
  } catch (error) {
    if (!(error instanceof BaaError)) throw error;
    return {
      file,
      program: {
        kind: "Program",
        span: file.span(0, 0),
        body: [],
        trailingComments: [],
        shebang: null,
      },
      diagnostics: [error.diagnostic],
      ok: false,
      analysis: null,
    };
  }
  const analysis = resolveProgram(program, file, { modules: options.modules ?? [] });
  diagnostics.push(...analysis.diagnostics);
  return {
    file,
    program,
    diagnostics,
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    analysis,
  };
}

export type LintResult = CheckResult & { readonly warnings: readonly Diagnostic[] };

export function lint(text: string, path = "<input>", options: CheckOptions = {}): LintResult {
  const file = new SourceFile(path, text);
  const result = checkFile(file, options);
  if (result.analysis === null) return { ...result, warnings: [] };
  const warnings = lintProgram(result.program, result.analysis);
  return { ...result, warnings };
}

export type RunOptions = {
  host?: RuntimeHost;
  maxDepth?: number;
  argv?: string[];
  seed?: number;
  modules?: readonly string[];
  dependencies?: ReadonlyMap<string, string>;
};

export type RunResult = {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly diagnostics: readonly Diagnostic[];
  /** Captured stdout when the default capturing host is used. */
  readonly output: string;
  readonly errorOutput: string;
  readonly value: Value;
};

/**
 * Parse, analyse and execute a Baa program. Errors are returned as diagnostics
 * rather than thrown, so callers can render them however they like.
 */
export function run(text: string, path = "<input>", options: RunOptions = {}): RunResult {
  const file = new SourceFile(path, text);
  const checked = checkFile(file, { modules: options.modules ?? [] });
  const capturing =
    options.host ?? createCapturingHost({ argv: options.argv, ...(options.seed === undefined ? {} : { seed: options.seed }) });

  if (!checked.ok) {
    return {
      ok: false,
      exitCode: 1,
      diagnostics: checked.diagnostics,
      output: readOutput(capturing),
      errorOutput: readErrorOutput(capturing),
      value: null,
    };
  }

  const interpreter = new Interpreter({
    host: capturing,
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  try {
    const value = interpreter.run(checked.program, file);
    return {
      ok: true,
      exitCode: 0,
      diagnostics: checked.diagnostics,
      output: readOutput(capturing),
      errorOutput: readErrorOutput(capturing),
      value,
    };
  } catch (error) {
    const diagnostic = toDiagnostic(error, interpreter);
    if (diagnostic === null) throw error;
    return {
      ok: false,
      exitCode: diagnostic.exitCode,
      diagnostics: [...checked.diagnostics, ...diagnostic.diagnostics],
      output: readOutput(capturing),
      errorOutput: readErrorOutput(capturing),
      value: null,
    };
  }
}

/** Convert a thrown runtime object into diagnostics plus an exit code. */
export function toDiagnostic(
  error: unknown,
  interpreter?: Interpreter,
): { diagnostics: Diagnostic[]; exitCode: number } | null {
  if (error instanceof ExitSignal) {
    return { diagnostics: [], exitCode: error.code };
  }
  if (error instanceof BaaError) {
    return { diagnostics: [error.diagnostic], exitCode: 1 };
  }
  if (error instanceof ThrownValue) {
    return {
      diagnostics: [
        createDiagnostic("BAA308", [describeThrown(error.value)], {
          span: error.span,
          note: "thrown here",
          trace: interpreter?.stackTrace() ?? [],
          help: "Wrap the call in `try { ... } catch e { ... }` to handle it.",
        }),
      ],
      exitCode: 1,
    };
  }
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return {
      diagnostics: [
        createDiagnostic("BAA307", [], {
          help: "A function is recursing without a base case.",
        }),
      ],
      exitCode: 1,
    };
  }
  return null;
}

function describeThrown(value: Value): string {
  return typeof value === "string" ? value : inspect(value);
}

export type { FormatOptions };

export function format(text: string, path = "<input>", options: FormatOptions = {}): string {
  const file = new SourceFile(path, text);
  const { program, diagnostics } = parse(file);
  const fatal = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (fatal !== undefined) throw new BaaError(fatal);
  return formatProgram(program, options);
}

function readOutput(host: RuntimeHost): string {
  const capturing = host as { output?: () => string };
  return typeof capturing.output === "function" ? capturing.output() : "";
}

function readErrorOutput(host: RuntimeHost): string {
  const capturing = host as { errorOutput?: () => string };
  return typeof capturing.errorOutput === "function" ? capturing.errorOutput() : "";
}

export { display, inspect, SourceFile, Interpreter };
export type { Diagnostic, Value, RuntimeHost, ResolveResult, SymbolInfo };
export { renderDiagnostic, renderDiagnostics, setWoollyMode } from "./diagnostics/diagnostic.ts";
export { createCapturingHost, createNodeHost } from "./runtime/host.ts";
export { STDLIB_MODULES, STDLIB_SUMMARY } from "./stdlib/index.ts";
