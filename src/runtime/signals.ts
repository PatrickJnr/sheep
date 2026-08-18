/**
 * Non-local control flow.
 *
 * `return`, `break` and `continue` are implemented as JavaScript exceptions.
 * They are cheap here because they carry no stack trace (the classes never call
 * `Error.captureStackTrace`), and they keep the tree-walking evaluator free of
 * a completion-record type threaded through every `execute` call.
 *
 * `ThrownValue` carries a user `throw`. Runtime errors travel as `BaaError`.
 */

import type { Span } from "../diagnostics/source.ts";
import type { Value } from "./values.ts";

export class ReturnSignal {
  readonly value: Value;
  constructor(value: Value) {
    this.value = value;
  }
}

export class BreakSignal {
  readonly span: Span;
  constructor(span: Span) {
    this.span = span;
  }
}

export class ContinueSignal {
  readonly span: Span;
  constructor(span: Span) {
    this.span = span;
  }
}

/** A value thrown by a Baa `throw` statement. */
export class ThrownValue {
  readonly value: Value;
  readonly span: Span;
  constructor(value: Value, span: Span) {
    this.value = value;
    this.span = span;
  }
}

/** Raised when a program calls `exit(code)`. */
export class ExitSignal {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

/**
 * Whether a caught value is control flow rather than a failure. Anything that
 * catches broadly has to let these through untouched, or `return` from inside
 * a callback turns into an error.
 */
export function isSignal(value: unknown): boolean {
  return (
    value instanceof ReturnSignal ||
    value instanceof BreakSignal ||
    value instanceof ContinueSignal ||
    value instanceof ThrownValue ||
    value instanceof ExitSignal
  );
}
