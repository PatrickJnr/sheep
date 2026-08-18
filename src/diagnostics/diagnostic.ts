/**
 * Diagnostics: construction, rendering and the `BaaError` carrier.
 *
 * A rendered diagnostic looks like this:
 *
 *   error[BAA102]: `sheap` is not part of the current flock.
 *     ┌─ examples/hello.baa:4:19
 *     │
 *   4 │     baa "Baa, " + sheap
 *     │                   ^^^^^ not found in this pasture
 *     │
 *     = help: did you mean `sheep`?
 *
 * Rendering is pure: it takes a `Diagnostic` and produces a string. Nothing in
 * this module writes to a stream, which keeps it trivially testable.
 */

import type { DiagnosticCode, Severity } from "./codes.ts";
import { formatTemplate, lookup } from "./codes.ts";
import type { Span } from "./source.ts";

export type Label = {
  readonly span: Span;
  /** Short note rendered next to the underline. */
  readonly note?: string;
};

export type Diagnostic = {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  /** Already-rendered message text (placeholders substituted). */
  readonly message: string;
  readonly primary: Label | null;
  readonly secondary: readonly Label[];
  /** Actionable suggestions rendered as `= help:` lines. */
  readonly help: readonly string[];
  /** Runtime call stack, innermost frame first. */
  readonly trace: readonly TraceFrame[];
};

export type TraceFrame = {
  readonly name: string;
  readonly span: Span | null;
};

export type DiagnosticOptions = {
  span?: Span | null;
  note?: string;
  secondary?: readonly Label[];
  help?: readonly string[] | string;
  trace?: readonly TraceFrame[];
  /** Overrides catalogue severity (used by `lint --deny`). */
  severity?: Severity;
};

/**
 * Global humour switch. Set once at CLI start-up. Kept as module state on
 * purpose: every diagnostic in a process should agree on its own tone, and
 * threading a flag through the lexer, parser, resolver and runtime would be a
 * lot of plumbing for one boolean.
 */
let woolly = true;

export function setWoollyMode(enabled: boolean): void {
  woolly = enabled;
}

export function isWoollyMode(): boolean {
  return woolly;
}

export function createDiagnostic(
  code: DiagnosticCode,
  args: readonly string[] = [],
  options: DiagnosticOptions = {},
): Diagnostic {
  const spec = lookup(code);
  const template = woolly ? spec.woolly : spec.plain;
  const primary = options.span
    ? { span: options.span, ...(options.note ? { note: options.note } : {}) }
    : null;
  const help =
    options.help === undefined
      ? []
      : typeof options.help === "string"
        ? [options.help]
        : options.help;
  return {
    code,
    severity: options.severity ?? spec.severity,
    message: formatTemplate(template, args),
    primary,
    secondary: options.secondary ?? [],
    help,
    trace: options.trace ?? [],
  };
}

/**
 * The single error type thrown by every stage of the Baa pipeline. It carries a
 * fully-formed `Diagnostic` so that any layer can catch it and render it
 * identically.
 */
export class BaaError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "BaaError";
    this.diagnostic = diagnostic;
  }

  static of(
    code: DiagnosticCode,
    args: readonly string[] = [],
    options: DiagnosticOptions = {},
  ): BaaError {
    return new BaaError(createDiagnostic(code, args, options));
  }
}

// --------------------------------------------------------------------------
// Colour handling
// --------------------------------------------------------------------------

export type Palette = {
  readonly error: (s: string) => string;
  readonly warning: (s: string) => string;
  readonly bold: (s: string) => string;
  readonly dim: (s: string) => string;
  readonly gutter: (s: string) => string;
  readonly accent: (s: string) => string;
};

const identity = (s: string): string => s;

export const NO_COLOUR: Palette = {
  error: identity,
  warning: identity,
  bold: identity,
  dim: identity,
  gutter: identity,
  accent: identity,
};

const wrap = (open: string, close = "[0m") => (s: string) => `${open}${s}${close}`;

export const ANSI: Palette = {
  error: wrap("[31;1m"),
  warning: wrap("[33;1m"),
  bold: wrap("[1m"),
  dim: wrap("[2m"),
  gutter: wrap("[34m"),
  accent: wrap("[36m"),
};

export type RenderOptions = {
  palette?: Palette;
  /** Lines of context shown above the primary span. */
  contextLines?: number;
};

const BOX = {
  topLeft: "┌─", // ┌─
  vertical: "│", // │
  dot: "=",
};

function severityLabel(severity: Severity, palette: Palette): string {
  return severity === "error"
    ? palette.error("error")
    : palette.warning("warning");
}

function underline(width: number, char: string): string {
  return char.repeat(Math.max(1, width));
}

/** Render one diagnostic as a multi-line, human-facing block. */
export function renderDiagnostic(
  diagnostic: Diagnostic,
  options: RenderOptions = {},
): string {
  const palette = options.palette ?? NO_COLOUR;
  const contextLines = options.contextLines ?? 1;
  const out: string[] = [];
  const tint = diagnostic.severity === "error" ? palette.error : palette.warning;

  out.push(
    `${severityLabel(diagnostic.severity, palette)}${palette.bold(`[${diagnostic.code}]`)}: ${palette.bold(diagnostic.message)}`,
  );

  const primary = diagnostic.primary;
  if (primary) {
    const file = primary.span.file;
    const start = file.positionAt(primary.span.start);
    const end = file.positionAt(Math.max(primary.span.start, primary.span.end));
    const lastLine = Math.min(end.line, start.line + 4);
    const gutterWidth = String(lastLine).length;
    const pad = " ".repeat(gutterWidth);
    const bar = palette.gutter(BOX.vertical);

    out.push(
      `${pad} ${palette.gutter(BOX.topLeft)} ${file.path}:${start.line}:${start.column}`,
    );
    out.push(`${pad} ${bar}`);

    const firstShown = Math.max(1, start.line - contextLines);
    for (let line = firstShown; line < start.line; line++) {
      out.push(
        `${palette.gutter(String(line).padStart(gutterWidth))} ${bar} ${palette.dim(file.lineText(line))}`,
      );
    }

    for (let line = start.line; line <= lastLine; line++) {
      const text = file.lineText(line);
      out.push(`${palette.gutter(String(line).padStart(gutterWidth))} ${bar} ${text}`);

      const markStart = line === start.line ? start.column - 1 : 0;
      const markEnd =
        line === end.line ? Math.max(end.column - 1, markStart + 1) : text.length;
      const caret = `${" ".repeat(markStart)}${tint(underline(markEnd - markStart, "^"))}`;
      const note = line === start.line && primary.note ? ` ${tint(primary.note)}` : "";
      out.push(`${pad} ${bar} ${caret}${note}`);

      if (line === end.line) break;
      if (line === lastLine && end.line > lastLine) {
        out.push(`${pad} ${bar} ${palette.dim("...")}`);
      }
    }

    for (const label of diagnostic.secondary) {
      const p = label.span.file.positionAt(label.span.start);
      const where = `${label.span.file.path}:${p.line}:${p.column}`;
      out.push(
        `${pad} ${bar} ${palette.dim(`${label.note ?? "related"} → ${where}`)}`,
      );
      const text = label.span.file.lineText(p.line);
      if (text.trim().length > 0) {
        out.push(`${pad} ${bar}   ${palette.dim(text.trim())}`);
      }
    }

    if (diagnostic.help.length > 0 || diagnostic.trace.length > 0) {
      out.push(`${pad} ${bar}`);
    }
    for (const help of diagnostic.help) {
      out.push(`${pad} ${palette.gutter(BOX.dot)} ${palette.accent("help")}: ${help}`);
    }
    if (diagnostic.trace.length > 0) {
      out.push(`${pad} ${palette.gutter(BOX.dot)} ${palette.accent("trace")}:`);
      for (const frame of diagnostic.trace) {
        out.push(`${pad}   ${palette.dim(formatFrame(frame))}`);
      }
    }
  } else {
    for (const help of diagnostic.help) {
      out.push(`  ${palette.gutter(BOX.dot)} ${palette.accent("help")}: ${help}`);
    }
    if (diagnostic.trace.length > 0) {
      out.push(`  ${palette.gutter(BOX.dot)} ${palette.accent("trace")}:`);
      for (const frame of diagnostic.trace) {
        out.push(`    ${palette.dim(formatFrame(frame))}`);
      }
    }
  }

  return out.join("\n");
}

function formatFrame(frame: TraceFrame): string {
  if (!frame.span) return `at ${frame.name}`;
  const p = frame.span.file.positionAt(frame.span.start);
  return `at ${frame.name} (${frame.span.file.path}:${p.line}:${p.column})`;
}

/** Render a list of diagnostics plus a `2 errors, 1 warning` summary. */
export function renderDiagnostics(
  diagnostics: readonly Diagnostic[],
  options: RenderOptions = {},
): string {
  if (diagnostics.length === 0) return "";
  const palette = options.palette ?? NO_COLOUR;
  const blocks = diagnostics.map((d) => renderDiagnostic(d, options));
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  blocks.push(palette.bold(parts.join(", ")));
  return blocks.join("\n\n");
}

/**
 * Levenshtein-based "did you mean" suggestion. Used by the resolver and the
 * runtime for undefined names, unknown methods and unknown module exports.
 */
export function suggest(
  target: string,
  candidates: Iterable<string>,
): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const limit = Math.max(2, Math.floor(target.length / 2));
  for (const candidate of candidates) {
    if (candidate === target) continue;
    const score = editDistance(target.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore && score <= limit) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length]!;
}
