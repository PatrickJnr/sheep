/**
 * The machine-readable rendering of Baa diagnostics: `--format json`.
 *
 * This is a second *presentation* of the diagnostic model, not a second model.
 * It reads the same `Diagnostic` values the human renderer reads, so a tool
 * consuming JSON and a person reading the terminal are looking at one analysis.
 * Nothing here parses formatted text, and nothing here can report a diagnostic
 * the terminal would not.
 *
 * The schema is versioned. `version` is a number that only ever increases, and
 * within one version fields are added but never removed or repurposed, so a
 * consumer written today keeps working. Diagnostic codes are stable across
 * releases by the same promise `codes.ts` already makes.
 *
 * Both wordings are always present. A CI annotation usually wants `plain`, a
 * developer's editor usually wants `woolly`, and neither should have to re-run
 * Baa with a different flag to get the other one.
 *
 * Documented in `docs/diagnostics-json.md`.
 */

import type { Diagnostic, Label, TraceFrame } from "./diagnostic.ts";
import { formatTemplate, lookup } from "./codes.ts";
import type { Span } from "./source.ts";

/** Bumped only for a breaking change. Additive changes keep the number. */
export const SCHEMA_VERSION = 1;

export type JsonPosition = {
  /** 1-based, matching the terminal renderer and the `file:line:column` form. */
  readonly line: number;
  /** 1-based, counted in UTF-16 code units. */
  readonly column: number;
  /** 0-based offset into the file, for tools that index rather than count. */
  readonly offset: number;
};

export type JsonRange = {
  readonly start: JsonPosition;
  /** Exclusive, so a zero-width range has `start` equal to `end`. */
  readonly end: JsonPosition;
};

export type JsonLabel = {
  readonly file: string;
  readonly range: JsonRange;
  readonly note: string | null;
};

export type JsonFrame = {
  readonly name: string;
  readonly file: string | null;
  readonly range: JsonRange | null;
};

export type JsonDiagnostic = {
  readonly code: string;
  readonly severity: "error" | "warning";
  /** The wording this run would print, so `message` never surprises anyone. */
  readonly message: string;
  /** Every wording of the same fact. */
  readonly messages: { readonly woolly: string; readonly plain: string };
  /** Null for diagnostics that are about a command rather than a place. */
  readonly file: string | null;
  readonly range: JsonRange | null;
  /** The short note the terminal renders next to the underline. */
  readonly note: string | null;
  readonly related: readonly JsonLabel[];
  readonly help: readonly string[];
  readonly trace: readonly JsonFrame[];
};

export type JsonReport = {
  readonly version: number;
  /** The Baa release that produced this report. */
  readonly baa: string;
  /** The subcommand, so a log holding several reports stays readable. */
  readonly command: string;
  /** Which wording `message` carries: `--no-baa` and CI select `plain`. */
  readonly wording: "woolly" | "plain";
  /**
   * True when the command exited zero. This is not simply `errors === 0`:
   * `lint --deny-warnings` fails on warnings and `fmt` fails when a file would
   * change, and a consumer should not have to re-derive either rule.
   */
  readonly ok: boolean;
  readonly errors: number;
  readonly warnings: number;
  /** Number of files the command looked at. */
  readonly files: number;
  readonly diagnostics: readonly JsonDiagnostic[];
  /** Present only for `fmt`: the files whose formatting would change. */
  readonly changed?: readonly string[];
};

function position(span: Span, offset: number): JsonPosition {
  const clamped = Math.max(0, Math.min(offset, span.file.text.length));
  const { line, column } = span.file.positionAt(clamped);
  return { line, column, offset: clamped };
}

function range(span: Span): JsonRange {
  return {
    start: position(span, span.start),
    end: position(span, Math.max(span.start, span.end)),
  };
}

function label(item: Label): JsonLabel {
  return {
    file: item.span.file.path,
    range: range(item.span),
    note: item.note ?? null,
  };
}

function frame(item: TraceFrame): JsonFrame {
  return {
    name: item.name,
    file: item.span?.file.path ?? null,
    range: item.span === null || item.span === undefined ? null : range(item.span),
  };
}

export function toJsonDiagnostic(diagnostic: Diagnostic): JsonDiagnostic {
  const spec = lookup(diagnostic.code);
  const primary = diagnostic.primary;
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    messages: {
      woolly: formatTemplate(spec.woolly, diagnostic.args),
      plain: formatTemplate(spec.plain, diagnostic.args),
    },
    file: primary === null ? null : primary.span.file.path,
    range: primary === null ? null : range(primary.span),
    note: primary?.note ?? null,
    related: diagnostic.secondary.map(label),
    help: [...diagnostic.help],
    trace: diagnostic.trace.map(frame),
  };
}

export type ReportOptions = {
  readonly command: string;
  readonly baa: string;
  readonly woolly: boolean;
  readonly files: number;
  readonly changed?: readonly string[];
  /** Defaults to "no errors"; commands with a stricter exit rule pass their own. */
  readonly ok?: boolean;
};

export function buildReport(
  diagnostics: readonly Diagnostic[],
  options: ReportOptions,
): JsonReport {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  return {
    version: SCHEMA_VERSION,
    baa: options.baa,
    command: options.command,
    wording: options.woolly ? "woolly" : "plain",
    ok: options.ok ?? errors === 0,
    errors,
    warnings: diagnostics.length - errors,
    files: options.files,
    diagnostics: diagnostics.map(toJsonDiagnostic),
    ...(options.changed === undefined ? {} : { changed: [...options.changed] }),
  };
}

/**
 * Render a report as one line of JSON followed by a newline.
 *
 * One line on purpose: a report is then a record, so `baa check --format json`
 * can be appended to a log, split by lines, or piped into a tool that reads
 * JSON Lines, without anyone having to find where one object ends.
 */
export function renderReport(report: JsonReport): string {
  return `${JSON.stringify(report)}\n`;
}
