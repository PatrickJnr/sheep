/** Token kinds, keyword table and trivia types produced by the Baa lexer. */

import type { Span } from "../diagnostics/source.ts";

export type TokenKind =
  // literals
  | "int"
  | "float"
  | "string"
  | "ident"
  // keywords
  | "let"
  | "const"
  | "fn"
  | "return"
  | "if"
  | "else"
  | "while"
  | "for"
  | "in"
  | "break"
  | "continue"
  | "baa"
  | "import"
  | "export"
  | "as"
  | "from"
  | "true"
  | "false"
  | "nil"
  | "try"
  | "catch"
  | "throw"
  | "test"
  | "match"
  // punctuation
  | "("
  | ")"
  | "["
  | "]"
  | "{"
  | "}"
  | ","
  | "."
  | ":"
  | ";"
  | "=>"
  // operators
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "!"
  | "="
  | "+="
  | "-="
  | "*="
  | "/="
  | "%="
  | ".."
  | "..="
  | "??"
  // structural
  | "newline"
  | "eof";

export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["let", "let"],
  ["const", "const"],
  ["fn", "fn"],
  ["return", "return"],
  ["if", "if"],
  ["else", "else"],
  ["while", "while"],
  ["for", "for"],
  ["in", "in"],
  ["break", "break"],
  ["continue", "continue"],
  ["baa", "baa"],
  ["import", "import"],
  ["export", "export"],
  ["as", "as"],
  ["from", "from"],
  ["true", "true"],
  ["false", "false"],
  ["nil", "nil"],
  ["try", "try"],
  ["catch", "catch"],
  ["throw", "throw"],
  ["test", "test"],
  ["match", "match"],
] satisfies ReadonlyArray<readonly [string, TokenKind]>);

export const KEYWORD_LIST: readonly string[] = [...KEYWORDS.keys()];

/**
 * A piece of a string literal. `text` parts are already unescaped; `expr` parts
 * hold the raw source of an interpolated expression plus its absolute offset so
 * the parser can produce accurate spans inside interpolations.
 */
export type StringPart =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "expr"; readonly source: string; readonly offset: number };

/** A comment attached to a token as leading or trailing trivia. */
export type Comment = {
  readonly text: string;
  readonly span: Span;
  readonly block: boolean;
  /** True when the comment sits on its own line. */
  readonly ownLine: boolean;
  /** Number of blank lines directly above this comment. */
  readonly blankLinesBefore: number;
};

export type Token = {
  readonly kind: TokenKind;
  /** Raw source text of the token. */
  readonly text: string;
  readonly span: Span;
  /** Numeric value for `int` / `float` tokens. */
  readonly value?: number;
  /** Segments for `string` tokens. */
  readonly parts?: readonly StringPart[];
  /** True for a `"""` block string, which the formatter re-emits verbatim. */
  readonly block?: boolean;
  /** True for an `r"..."` raw string: no escapes, no interpolation. */
  readonly raw?: boolean;
  /** Comments appearing before this token. */
  readonly leading: readonly Comment[];
  /** A comment on the same line, after this token. */
  readonly trailing: Comment | null;
  /** Blank lines directly above this token (used by the formatter). */
  readonly blankLinesBefore: number;
};

/** Human-facing name for a token kind, used in `expected X, found Y` errors. */
export function describeKind(kind: TokenKind): string {
  switch (kind) {
    case "int":
      return "a whole number";
    case "float":
      return "a decimal number";
    case "string":
      return "a string";
    case "ident":
      return "a name";
    case "newline":
      return "a line break";
    case "eof":
      return "the end of the file";
    default:
      return `\`${kind}\``;
  }
}

export function describeToken(token: Token): string {
  switch (token.kind) {
    case "ident":
      return `\`${token.text}\``;
    case "int":
    case "float":
      return `the number \`${token.text}\``;
    case "string":
      return "a string";
    case "newline":
      return "a line break";
    case "eof":
      return "the end of the file";
    default:
      return `\`${token.text}\``;
  }
}
