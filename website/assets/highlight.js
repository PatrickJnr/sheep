/**
 * Baa syntax highlighting for static code blocks.
 *
 * A small standalone tokenizer rather than the real lexer: doc pages should not
 * have to download the whole interpreter to colour a snippet. It follows the
 * same rules the real lexer does (SPEC §2), including nested interpolations,
 * so the two agree on everything a code sample is likely to contain.
 *
 * The playground uses the real lexer instead, see playground.js.
 */

const KEYWORDS = new Set([
  "let", "const", "fn", "return", "if", "else", "while", "for", "in",
  "break", "continue", "import", "export", "as", "from", "try", "catch",
  "finally", "throw", "test", "match",
]);

const LITERALS = new Set(["true", "false", "nil"]);

const MODULES = new Set(["wool", "flock", "ram", "meadow", "pasture", "shepherd", "lamb"]);

const BUILTINS = new Set([
  "len", "type_of", "to_string", "to_number", "inspect", "clone",
  "assert", "assert_eq", "panic", "exit",
]);

const OPERATOR = /^(\*\*|\.\.=|\.\.|==|!=|<=|>=|&&|\|\||\?\?|=>|[+\-*/%]=|[+\-*/%<>=!])/;

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function span(cls, text) {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

function isIdentStart(ch) {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

/** Highlight a string literal, recursing into `{ ... }` interpolations. */
function highlightString(source, start) {
  let i = start + 1;
  let out = span("string", '"');
  let text = "";

  const flush = () => {
    if (text.length > 0) {
      out += span("string", text);
      text = "";
    }
  };

  while (i < source.length && source[i] !== '"') {
    const ch = source[i];
    if (ch === "\\") {
      flush();
      const escape = source.slice(i, i + 2);
      out += span("escape", escape);
      i += 2;
      continue;
    }
    if (ch === "{") {
      flush();
      let depth = 1;
      let j = i + 1;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") depth--;
        else if (source[j] === '"') {
          j++;
          while (j < source.length && source[j] !== '"') {
            if (source[j] === "\\") j++;
            j++;
          }
        }
        j++;
      }
      const inner = source.slice(i + 1, j - 1);
      out += `${span("interp", "{")}${highlight(inner)}${span("interp", "}")}`;
      i = j;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  if (source[i] === '"') {
    out += span("string", '"');
    i++;
  }
  return { html: out, next: i };
}

/**
 * A raw or block string starting at `i`, or null.
 *
 * Raw strings have no escapes and no interpolation, so the whole literal is one
 * span. Block strings keep interpolation, but highlighting the inside of a
 * multi-line literal adds little, so they are one span too.
 */
function rawOrBlockString(source, i) {
  const forms = ['r"""', 'r"', '"""'];
  const open = forms.find((form) => source.startsWith(form, i));
  if (open === undefined) return null;
  const close = open.endsWith('"""') ? '"""' : '"';
  const at = source.indexOf(close, i + open.length);
  const end = at === -1 ? source.length : at + close.length;
  return { html: span("string", source.slice(i, end)), next: end };
}

/** Turn Baa source into HTML with `tok-*` classes. */
export function highlight(source) {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    // Raw and block strings, before the ordinary string rule: `"""` would
    // otherwise read as an empty string, and `r"` as a name then a string.
    const raw = rawOrBlockString(source, i);
    if (raw !== null) {
      out += raw.html;
      i = raw.next;
      continue;
    }

    // Comments.
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += span("comment", source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < source.length && depth > 0) {
        if (source.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (source.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      }
      out += span("comment", source.slice(i, j));
      i = j;
      continue;
    }

    // Strings.
    if (ch === '"') {
      const result = highlightString(source, i);
      out += result.html;
      i = result.next;
      continue;
    }

    // Numbers.
    if (/[0-9]/.test(ch)) {
      const match = /^(0[xXoObB][0-9A-Fa-f_]+|[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?)/.exec(
        source.slice(i),
      );
      if (match) {
        out += span("number", match[0]);
        i += match[0].length;
        continue;
      }
    }

    // Identifiers and keywords.
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      let rest = j;
      while (rest < source.length && source[rest] === " ") rest++;
      const followedByCall = source[rest] === "(";
      const previous = source.slice(0, i).trimEnd();
      const afterDot = previous.endsWith(".");

      let cls;
      if (word === "baa" && !afterDot) cls = "print";
      else if (KEYWORDS.has(word) && !afterDot) cls = "keyword";
      else if (LITERALS.has(word) && !afterDot) cls = "boolean";
      else if (!afterDot && MODULES.has(word) && source[rest] === ".") cls = "module";
      else if (followedByCall) cls = "fn";
      else if (!afterDot && BUILTINS.has(word)) cls = "fn";
      else if (/^[A-Z][A-Z0-9_]*$/.test(word) && word.length > 1) cls = "const";
      else cls = null;

      out += cls === null ? escapeHtml(word) : span(cls, word);
      i = j;
      continue;
    }

    // Operators and punctuation.
    const operator = OPERATOR.exec(source.slice(i));
    if (operator) {
      out += span("op", operator[0]);
      i += operator[0].length;
      continue;
    }
    if ("(){}[],;:.".includes(ch)) {
      out += span("punct", ch);
      i++;
      continue;
    }

    out += escapeHtml(ch);
    i++;
  }

  return out;
}

/** Highlight every `<code class="language-baa">` on the page, in place. */
export function highlightAll(root = document) {
  const blocks = root.querySelectorAll("code.language-baa:not([data-highlighted])");
  for (const block of blocks) {
    block.innerHTML = highlight(block.textContent ?? "");
    block.setAttribute("data-highlighted", "true");
  }
}
