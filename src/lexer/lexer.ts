/**
 * The Baa lexer.
 *
 * Turns a `SourceFile` into a flat token stream. Design notes:
 *
 *  - Comments are *trivia*: they never appear as tokens, but they are attached
 *    to the token that follows them (`leading`) or, when on the same line, to
 *    the token they follow (`trailing`). The formatter relies on this to keep
 *    comments where the author put them.
 *
 *  - Newlines are significant: they terminate statements. The lexer suppresses
 *    a newline when the line clearly continues: inside `(` or `[`, after a
 *    dangling operator or comma, or when the next line starts with `.` for
 *    method chaining. Everything else is a statement boundary, which keeps the
 *    rule easy to predict without semicolons.
 *
 *  - String interpolation is lexed structurally: a string token carries an
 *    array of text and expression parts, with absolute source offsets so the
 *    parser can report errors *inside* an interpolation accurately.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { SourceFile, Span } from "../diagnostics/source.ts";
import type { Comment, StringPart, Token, TokenKind } from "./token.ts";
import { KEYWORDS } from "./token.ts";

const EOF_CHAR = "\0";

/** Tokens after which a newline cannot end a statement. */
const CONTINUES_AFTER: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "+", "-", "*", "/", "%", "**",
  "==", "!=", "<", "<=", ">", ">=",
  "&&", "||", "!", "??",
  "=", "+=", "-=", "*=", "/=", "%=",
  "..", "..=",
  ",", ":", ".", "(", "[", "{", "=>",
  "else", "in", "as", "from", "import", "let", "const", "fn",
]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

export class Lexer {
  readonly #file: SourceFile;
  readonly #text: string;
  readonly #end: number;
  #pos: number;
  #tokens: Token[];
  /** Nesting depth of `(` and `[`, inside which newlines are insignificant. */
  #groupDepth: number;
  #pendingComments: Comment[];
  #pendingBlankLines: number;
  /** Whether a token or comment has appeared on the current physical line. */
  #lineOpen: boolean;

  /**
   * `start`/`end` restrict lexing to a slice of the file while keeping absolute
   * offsets. String interpolation uses this to lex an embedded expression with
   * spans that still point at the right place in the original source.
   */
  constructor(file: SourceFile, start = 0, end = file.text.length) {
    this.#file = file;
    this.#text = file.text;
    this.#end = end;
    this.#pos = start;
    this.#tokens = [];
    this.#groupDepth = 0;
    this.#pendingComments = [];
    this.#pendingBlankLines = 0;
    this.#lineOpen = false;
  }

  static tokenize(file: SourceFile): Token[] {
    return new Lexer(file).run();
  }

  /** Tokenize `file.text.slice(start, end)` with absolute spans. */
  static tokenizeRange(file: SourceFile, start: number, end: number): Token[] {
    return new Lexer(file, start, end).run();
  }

  run(): Token[] {
    for (;;) {
      this.#skipTrivia();
      if (this.#pos >= this.#end) break;
      this.#scanToken();
    }
    this.#push("eof", "", this.#file.span(this.#end, this.#end));
    return this.#tokens;
  }

  // ------------------------------------------------------------------ chars

  #peek(offset = 0): string {
    const index = this.#pos + offset;
    return index < this.#end ? this.#text[index]! : EOF_CHAR;
  }

  #advance(): string {
    const ch = this.#peek();
    this.#pos++;
    return ch;
  }

  #match(expected: string): boolean {
    if (this.#text.startsWith(expected, this.#pos)) {
      this.#pos += expected.length;
      return true;
    }
    return false;
  }

  #span(start: number): Span {
    return this.#file.span(start, this.#pos);
  }

  // ----------------------------------------------------------------- trivia

  /**
   * Consume whitespace, comments and insignificant newlines. Significant
   * newlines are emitted as tokens here so that trivia handling stays in one
   * place.
   */
  #skipTrivia(): void {
    for (;;) {
      const ch = this.#peek();
      if (ch === " " || ch === "\t") {
        this.#pos++;
        continue;
      }
      if (ch === "\n") {
        this.#handleNewline();
        continue;
      }
      if (ch === "/" && this.#peek(1) === "/") {
        this.#scanLineComment();
        continue;
      }
      if (ch === "/" && this.#peek(1) === "*") {
        this.#scanBlockComment();
        continue;
      }
      return;
    }
  }

  /**
   * A newline either terminates the current line or, when the line held
   * nothing at all, counts as a blank line. Blank-line counts are what let the
   * formatter preserve paragraph breaks without preserving whitespace noise.
   */
  #handleNewline(): void {
    const start = this.#pos;
    this.#pos++;
    if (this.#suppressNewline()) {
      this.#lineOpen = false;
      return;
    }
    if (!this.#lineOpen) {
      this.#pendingBlankLines++;
      return;
    }
    this.#lineOpen = false;
    const last = this.#tokens[this.#tokens.length - 1];
    // A line holding only a comment produces no token, just a terminator.
    if (last === undefined || last.kind === "newline") return;
    this.#push("newline", "\n", this.#span(start));
  }

  #suppressNewline(): boolean {
    if (this.#groupDepth > 0) return true;
    const last = this.#tokens[this.#tokens.length - 1];
    if (last !== undefined && CONTINUES_AFTER.has(last.kind)) return true;
    return this.#nextLineContinues();
  }

  /** Look past whitespace/comments: a leading `.` continues a method chain. */
  #nextLineContinues(): boolean {
    let i = this.#pos;
    for (;;) {
      while (i < this.#end && " \t\n".includes(this.#text[i]!)) i++;
      if (this.#text.startsWith("//", i)) {
        while (i < this.#end && this.#text[i] !== "\n") i++;
        continue;
      }
      if (this.#text.startsWith("/*", i)) {
        const end = this.#text.indexOf("*/", i + 2);
        i = end === -1 ? this.#end : end + 2;
        continue;
      }
      break;
    }
    return this.#text[i] === "." && this.#text[i + 1] !== ".";
  }

  #scanLineComment(): void {
    const start = this.#pos;
    this.#pos += 2;
    while (this.#peek() !== "\n" && this.#pos < this.#end) this.#pos++;
    this.#addComment(start, false);
  }

  #scanBlockComment(): void {
    const start = this.#pos;
    this.#pos += 2;
    let depth = 1;
    while (depth > 0) {
      if (this.#pos >= this.#end) {
        throw BaaError.of("BAA004", [], {
          span: this.#file.span(start, Math.min(start + 2, this.#end)),
          note: "started here",
          help: "Close it with `*/`. Block comments in Baa can nest.",
        });
      }
      if (this.#match("/*")) depth++;
      else if (this.#match("*/")) depth--;
      else this.#pos++;
    }
    this.#addComment(start, true);
  }

  #addComment(start: number, block: boolean): void {
    const span = this.#span(start);
    const text = this.#text.slice(start, this.#pos);
    const ownLine = this.#isStartOfLine(start);
    this.#lineOpen = true;
    const comment: Comment = {
      text,
      span,
      block,
      ownLine,
      blankLinesBefore: this.#pendingBlankLines,
    };
    if (!ownLine) {
      const last = this.#tokens[this.#tokens.length - 1];
      if (last !== undefined && last.kind !== "newline" && last.trailing === null) {
        this.#tokens[this.#tokens.length - 1] = { ...last, trailing: comment };
        return;
      }
    }
    this.#pendingComments.push(comment);
    this.#pendingBlankLines = 0;
  }

  #isStartOfLine(offset: number): boolean {
    let i = offset - 1;
    while (i >= 0) {
      const ch = this.#text[i]!;
      if (ch === "\n") return true;
      if (ch !== " " && ch !== "\t") return false;
      i--;
    }
    return true;
  }

  // ------------------------------------------------------------------ scan

  #push(
    kind: TokenKind,
    text: string,
    span: Span,
    extra: { value?: number; parts?: readonly StringPart[] } = {},
  ): void {
    this.#tokens.push({
      kind,
      text,
      span,
      ...extra,
      leading: this.#pendingComments,
      trailing: null,
      blankLinesBefore: this.#pendingBlankLines,
    });
    this.#pendingComments = [];
    this.#pendingBlankLines = 0;
    if (kind !== "newline") this.#lineOpen = true;
  }

  #scanToken(): void {
    const start = this.#pos;
    const ch = this.#advance();

    if (isDigit(ch)) {
      this.#pos = start;
      this.#scanNumber();
      return;
    }
    if (isIdentStart(ch)) {
      this.#pos = start;
      this.#scanIdentifier();
      return;
    }
    if (ch === '"') {
      this.#pos = start;
      this.#scanString();
      return;
    }

    const three = this.#text.slice(start, start + 3);
    if (three === "..=") {
      this.#pos = start + 3;
      this.#push("..=", three, this.#span(start));
      return;
    }

    const two = this.#text.slice(start, start + 2);
    const twoCharKinds: Record<string, TokenKind> = {
      "==": "==",
      "!=": "!=",
      "<=": "<=",
      ">=": ">=",
      "&&": "&&",
      "||": "||",
      "+=": "+=",
      "-=": "-=",
      "*=": "*=",
      "/=": "/=",
      "%=": "%=",
      "**": "**",
      "..": "..",
      "??": "??",
      "=>": "=>",
    };
    const twoKind = twoCharKinds[two];
    if (twoKind !== undefined) {
      this.#pos = start + 2;
      this.#push(twoKind, two, this.#span(start));
      return;
    }

    const singles: Record<string, TokenKind> = {
      "(": "(",
      ")": ")",
      "[": "[",
      "]": "]",
      "{": "{",
      "}": "}",
      ",": ",",
      ".": ".",
      ":": ":",
      ";": ";",
      "+": "+",
      "-": "-",
      "*": "*",
      "/": "/",
      "%": "%",
      "<": "<",
      ">": ">",
      "!": "!",
      "=": "=",
    };
    const kind = singles[ch];
    if (kind !== undefined) {
      if (ch === "(" || ch === "[") this.#groupDepth++;
      if (ch === ")" || ch === "]") this.#groupDepth = Math.max(0, this.#groupDepth - 1);
      this.#push(kind, ch, this.#span(start));
      return;
    }

    throw BaaError.of("BAA002", [JSON.stringify(ch)], {
      span: this.#span(start),
      note: "unexpected here",
      help: "Baa source is plain ASCII outside of strings and comments.",
    });
  }

  #scanIdentifier(): void {
    const start = this.#pos;
    while (isIdentPart(this.#peek())) this.#pos++;
    const text = this.#text.slice(start, this.#pos);
    const keyword = KEYWORDS.get(text);
    this.#push(keyword ?? "ident", text, this.#span(start));
  }

  #scanNumber(): void {
    const start = this.#pos;

    // Radix-prefixed integers: 0x1F, 0o17, 0b1010.
    if (this.#peek() === "0" && "xXoObB".includes(this.#peek(1))) {
      const marker = this.#peek(1).toLowerCase();
      const radix = marker === "x" ? 16 : marker === "o" ? 8 : 2;
      this.#pos += 2;
      const digitsStart = this.#pos;
      while (isRadixDigit(this.#peek(), radix) || this.#peek() === "_") this.#pos++;
      const digits = this.#text.slice(digitsStart, this.#pos).replace(/_/g, "");
      const text = this.#text.slice(start, this.#pos);
      if (digits.length === 0) {
        throw BaaError.of("BAA005", [`\`${text}\``], {
          span: this.#span(start),
          help: `Write at least one digit after \`0${marker}\`.`,
        });
      }
      // A digit that is valid in some other base stopped the scan above, so it
      // is still sitting there waiting to be lexed as a separate number. Saying
      // so here beats the baffling "expected end of statement" that follows.
      if (isDigit(this.#peek()) || isIdentStart(this.#peek())) {
        const badStart = this.#pos;
        while (isIdentPart(this.#peek())) this.#pos++;
        throw BaaError.of("BAA005", [`\`${this.#text.slice(start, this.#pos)}\``], {
          span: this.#file.span(badStart, this.#pos),
          note: `not a base-${radix} digit`,
          help: `Base ${radix} uses ${radixDigitHelp(radix)}.`,
        });
      }
      const value = parseInt(digits, radix);
      if (!Number.isFinite(value)) {
        throw BaaError.of("BAA005", [`\`${text}\``], {
          span: this.#span(start),
          help: "That number is too large to represent.",
        });
      }
      this.#push("int", text, this.#span(start), { value });
      return;
    }

    while (isDigit(this.#peek()) || this.#peek() === "_") this.#pos++;

    let isFloat = false;
    // A `.` is only a decimal point when followed by a digit, so `1..5` is a
    // range and `1.abs()` is a method call.
    if (this.#peek() === "." && isDigit(this.#peek(1))) {
      isFloat = true;
      this.#pos++;
      while (isDigit(this.#peek()) || this.#peek() === "_") this.#pos++;
    }
    if (this.#peek() === "e" || this.#peek() === "E") {
      const save = this.#pos;
      this.#pos++;
      if (this.#peek() === "+" || this.#peek() === "-") this.#pos++;
      if (isDigit(this.#peek())) {
        isFloat = true;
        while (isDigit(this.#peek()) || this.#peek() === "_") this.#pos++;
      } else {
        this.#pos = save;
      }
    }

    const text = this.#text.slice(start, this.#pos);
    const value = Number(text.replace(/_/g, ""));
    if (!Number.isFinite(value)) {
      throw BaaError.of("BAA005", [`\`${text}\``], {
        span: this.#span(start),
        help: "That number is too large to represent.",
      });
    }
    if (isIdentStart(this.#peek())) {
      const suffixStart = this.#pos;
      while (isIdentPart(this.#peek())) this.#pos++;
      throw BaaError.of("BAA005", [`\`${this.#text.slice(start, this.#pos)}\``], {
        span: this.#file.span(suffixStart, this.#pos),
        note: "unexpected suffix",
        help: "Baa numbers have no type suffixes. Remove the trailing letters.",
      });
    }
    this.#push(isFloat ? "float" : "int", text, this.#span(start), { value });
  }

  #scanString(): void {
    const start = this.#pos;
    this.#pos++; // opening quote
    const parts: StringPart[] = [];
    let text = "";

    for (;;) {
      if (this.#pos >= this.#end || this.#peek() === "\n") {
        throw BaaError.of("BAA003", [], {
          span: this.#file.span(start, start + 1),
          note: "opened here",
          help: 'Close it with `"`. Baa strings do not span multiple lines.',
        });
      }
      const ch = this.#peek();
      if (ch === '"') {
        this.#pos++;
        break;
      }
      if (ch === "\\") {
        text += this.#scanEscape();
        continue;
      }
      if (ch === "{") {
        if (text.length > 0) {
          parts.push({ kind: "text", value: text });
          text = "";
        }
        parts.push(this.#scanInterpolation());
        continue;
      }
      text += ch;
      this.#pos++;
    }

    if (text.length > 0 || parts.length === 0) {
      parts.push({ kind: "text", value: text });
    }
    this.#push("string", this.#text.slice(start, this.#pos), this.#span(start), {
      parts,
    });
  }

  #scanEscape(): string {
    const start = this.#pos;
    this.#pos++; // backslash
    const ch = this.#advance();
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      case "e":
        return "";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "{":
        return "{";
      case "}":
        return "}";
      case "u": {
        if (this.#peek() !== "{") break;
        this.#pos++;
        const digitsStart = this.#pos;
        while (this.#peek() !== "}" && this.#pos < this.#end) this.#pos++;
        const digits = this.#text.slice(digitsStart, this.#pos);
        this.#pos++; // closing brace
        // `parseInt` stops at the first character it does not understand, so
        // `\u{41xyz}` would otherwise pass as `A` with the rest thrown away.
        const code = /^[0-9A-Fa-f]+$/.test(digits) ? Number.parseInt(digits, 16) : Number.NaN;
        if (!Number.isFinite(code) || digits.length === 0 || code > 0x10ffff) {
          throw BaaError.of("BAA007", [`u{${digits}}`], {
            span: this.#span(start),
            help: "Write a Unicode escape as `\\u{1F411}`.",
          });
        }
        return String.fromCodePoint(code);
      }
      default:
        break;
    }
    throw BaaError.of("BAA007", [ch === EOF_CHAR ? "" : ch], {
      span: this.#span(start),
      note: "unknown escape",
      help: "Valid escapes: \\n \\t \\r \\0 \\e \\\\ \\\" \\{ \\} \\u{...}",
    });
  }

  /**
   * Scan `{ expression }` inside a string, tracking nested braces and nested
   * string literals so that `"{ m[\"key\"] }"` lexes correctly.
   */
  #scanInterpolation(): StringPart {
    const braceStart = this.#pos;
    this.#pos++; // opening brace
    const exprStart = this.#pos;
    let depth = 1;
    while (depth > 0) {
      if (this.#pos >= this.#end || this.#peek() === "\n") {
        throw BaaError.of("BAA001", ["`}`"], {
          span: this.#file.span(braceStart, braceStart + 1),
          note: "this interpolation is never closed",
          help: "Every `{` inside a string needs a matching `}`.",
        });
      }
      const ch = this.#peek();
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === '"') {
        this.#pos++;
        while (this.#pos < this.#end && this.#peek() !== '"') {
          if (this.#peek() === "\\") this.#pos++;
          this.#pos++;
        }
      }
      this.#pos++;
    }
    const source = this.#text.slice(exprStart, this.#pos - 1);
    if (source.trim().length === 0) {
      throw BaaError.of("BAA009", [], {
        span: this.#file.span(braceStart, this.#pos),
        help: 'Put an expression inside, or escape the brace as `\\{`.',
      });
    }
    return { kind: "expr", source, offset: exprStart };
  }
}

function radixDigitHelp(radix: number): string {
  if (radix === 2) return "0 and 1";
  if (radix === 8) return "0 to 7";
  return "0 to 9 and a to f";
}

function isRadixDigit(ch: string, radix: number): boolean {
  const code = ch.toLowerCase().charCodeAt(0);
  const value =
    code >= 48 && code <= 57
      ? code - 48
      : code >= 97 && code <= 122
        ? code - 87
        : Number.NaN;
  return Number.isFinite(value) && value < radix;
}

export function tokenize(file: SourceFile): Token[] {
  return Lexer.tokenize(file);
}
