/**
 * Source files and source spans.
 *
 * Every token, AST node and runtime frame in Baa carries a `Span`, which is a
 * byte-free (UTF-16 code unit) offset range into exactly one `SourceFile`.
 * Line/column information is computed lazily from a line-start index so that
 * the hot path (lexing) never pays for it.
 */

export type Span = {
  readonly file: SourceFile;
  /** Inclusive start offset. */
  readonly start: number;
  /** Exclusive end offset. */
  readonly end: number;
};

export type Position = {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number, counted in UTF-16 code units. */
  readonly column: number;
};

export class SourceFile {
  readonly path: string;
  readonly text: string;
  /** Offset of the first character of each line. */
  #lineStarts: number[] | null;

  constructor(path: string, text: string) {
    // Normalise line endings so that spans, columns and the formatter behave
    // identically on Windows checkouts and Unix ones.
    this.path = path;
    this.text = text.replace(/\r\n?/g, "\n");
    this.#lineStarts = null;
  }

  get lineStarts(): number[] {
    if (this.#lineStarts === null) {
      const starts = [0];
      for (let i = 0; i < this.text.length; i++) {
        if (this.text.charCodeAt(i) === 10) starts.push(i + 1);
      }
      this.#lineStarts = starts;
    }
    return this.#lineStarts;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** Convert an absolute offset into a 1-based line/column position. */
  positionAt(offset: number): Position {
    const starts = this.lineStarts;
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: clamped - starts[lo]! + 1 };
  }

  /** Text of a 1-based line number, without its trailing newline. */
  lineText(line: number): string {
    const starts = this.lineStarts;
    if (line < 1 || line > starts.length) return "";
    const start = starts[line - 1]!;
    const end = line < starts.length ? starts[line]! - 1 : this.text.length;
    return this.text.slice(start, end);
  }

  span(start: number, end: number): Span {
    return { file: this, start, end };
  }
}

/** A synthetic file used for REPL input and for internal spans. */
export function syntheticFile(name: string, text = ""): SourceFile {
  return new SourceFile(name, text);
}

/** Merge two spans from the same file into one covering span. */
export function joinSpans(a: Span, b: Span): Span {
  return { file: a.file, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

export function spanText(span: Span): string {
  return span.file.text.slice(span.start, span.end);
}
