/**
 * The Baa diagnostic catalogue.
 *
 * Every diagnostic Baa can emit has a stable `BAAnnn` code. Codes never change
 * meaning across releases: new diagnostics take new numbers. Each entry has
 * two renderings of the same fact:
 *
 *   - `woolly`: the default, sheep-flavoured phrasing.
 *   - `plain`:  the phrasing used under `--no-baa`, `BAA_NO_BAA=1` or `CI=true`.
 *
 * The humour lives in the wording only. Codes, spans, severities and the
 * technical explanation are identical in both modes, so CI logs and blog posts
 * describe exactly the same problem.
 *
 * Ranges:
 *   BAA0xx, lexical and syntax errors (the shape of the source is wrong)
 *   BAA1xx, name resolution and scope errors
 *   BAA2xx, call, arity and static-shape errors
 *   BAA3xx, runtime errors
 *   BAA4xx, module, project and CLI errors
 *   BAA9xx, lints (warnings, never fatal)
 */

export type Severity = "error" | "warning";

export type DiagnosticSpec = {
  readonly code: string;
  readonly severity: Severity;
  /** Sheep-flavoured message template. `{0}`-style placeholders are filled in. */
  readonly woolly: string;
  /** Neutral message template, used in professional mode. */
  readonly plain: string;
};

function spec(
  code: string,
  severity: Severity,
  woolly: string,
  plain: string,
): DiagnosticSpec {
  return { code, severity, woolly, plain };
}

export const CATALOGUE = {
  // ---------------------------------------------------------------- BAA0xx
  BAA001: spec(
    "BAA001",
    "error",
    "The sheep expected a closing {0} here.",
    "Expected a closing {0}.",
  ),
  BAA002: spec(
    "BAA002",
    "error",
    "This character isn't part of the Baa alphabet: {0}",
    "Unexpected character: {0}",
  ),
  BAA003: spec(
    "BAA003",
    "error",
    "This string wandered off without a closing quote.",
    "Unterminated string literal.",
  ),
  BAA004: spec(
    "BAA004",
    "error",
    "This block comment never found its way back to the pen.",
    "Unterminated block comment.",
  ),
  BAA005: spec(
    "BAA005",
    "error",
    "This number is a bit malformed: {0}",
    "Malformed number literal: {0}",
  ),
  BAA006: spec(
    "BAA006",
    "error",
    "The flock expected {0} here, but found {1}.",
    "Expected {0}, found {1}.",
  ),
  BAA007: spec(
    "BAA007",
    "error",
    "This escape sequence isn't one the sheep recognise: \\{0}",
    "Unknown escape sequence: \\{0}",
  ),
  BAA008: spec(
    "BAA008",
    "error",
    "You can only put a name on the left of `=`. This isn't somewhere a value can graze.",
    "Invalid assignment target.",
  ),
  BAA009: spec(
    "BAA009",
    "error",
    "This interpolation `{{...}}` is empty: there's nothing to print.",
    "Empty interpolation expression.",
  ),
  BAA010: spec(
    "BAA010",
    "error",
    "This statement trails off before the sheep could finish reading it.",
    "Unexpected end of input.",
  ),
  BAA011: spec(
    "BAA011",
    "error",
    "This is nested deeper than the flock can follow: more than {0} levels.",
    "Nesting depth exceeds the limit of {0}.",
  ),
  BAA012: spec(
    "BAA012",
    "error",
    "This block string isn't laid out the way the sheep expect.",
    "Malformed block string literal.",
  ),

  // ---------------------------------------------------------------- BAA1xx
  BAA101: spec(
    "BAA101",
    "error",
    "`{0}` has already been counted in this pasture.",
    "`{0}` is already declared in this scope.",
  ),
  BAA102: spec(
    "BAA102",
    "error",
    "`{0}` is not part of the current flock.",
    "Undefined name `{0}`.",
  ),
  BAA103: spec(
    "BAA103",
    "error",
    "`{0}` was shorn with `const`: its value can't grow back.",
    "Cannot assign to constant `{0}`.",
  ),
  BAA104: spec(
    "BAA104",
    "error",
    "`return` only makes sense inside a function. Out here it just echoes across the meadow.",
    "`return` outside of a function.",
  ),
  BAA105: spec(
    "BAA105",
    "error",
    "`{0}` only makes sense inside a loop.",
    "`{0}` outside of a loop.",
  ),
  BAA106: spec(
    "BAA106",
    "error",
    "`{0}` is used here before the flock has been introduced to it.",
    "`{0}` is used before it is declared.",
  ),

  // ---------------------------------------------------------------- BAA2xx
  BAA201: spec(
    "BAA201",
    "error",
    "`{0}` was called with too many sheep: it takes {1} but got {2}.",
    "`{0}` expects {1} argument(s) but received {2}.",
  ),
  BAA202: spec(
    "BAA202",
    "error",
    "`{0}` was called with too few sheep: it takes {1} but got {2}.",
    "`{0}` expects {1} argument(s) but received {2}.",
  ),
  BAA203: spec(
    "BAA203",
    "error",
    "This parameter name `{0}` is used twice in the same function.",
    "Duplicate parameter name `{0}`.",
  ),
  BAA204: spec(
    "BAA204",
    "error",
    "This parameter list doesn't line up: {0}",
    "Invalid parameter list: {0}",
  ),

  // ---------------------------------------------------------------- BAA3xx
  BAA301: spec(
    "BAA301",
    "error",
    "The flock wandered somewhere unexpected: {0}",
    "Runtime error: {0}",
  ),
  BAA302: spec(
    "BAA302",
    "error",
    "You can't {0} {1} and {2}. These sheep don't herd together.",
    "Unsupported operand types for {0}: {1} and {2}.",
  ),
  BAA303: spec(
    "BAA303",
    "error",
    "`{0}` isn't something you can call. Only functions answer when called.",
    "`{0}` is not callable.",
  ),
  BAA304: spec(
    "BAA304",
    "error",
    "Index {0} is outside the fence: this {1} has length {2}.",
    "Index {0} out of range for {1} of length {2}.",
  ),
  BAA305: spec(
    "BAA305",
    "error",
    "There is no field called `{1}` on {0}.",
    "`{1}` is not a property of {0}.",
  ),
  BAA306: spec(
    "BAA306",
    "error",
    "Dividing by zero. Even sheep know better than that.",
    "Division by zero.",
  ),
  BAA307: spec(
    "BAA307",
    "error",
    "The flock has been counting too deep, the stack is full. (Is a function calling itself forever?)",
    "Maximum call depth exceeded.",
  ),
  BAA308: spec(
    "BAA308",
    "error",
    "Uncaught: {0}",
    "Uncaught exception: {0}",
  ),
  BAA309: spec(
    "BAA309",
    "error",
    "You can't herd {0}: only arrays, maps, strings and ranges can be looped over.",
    "Cannot iterate over {0}.",
  ),
  BAA310: spec(
    "BAA310",
    "error",
    "This key isn't in the map: {0}",
    "Missing map key: {0}",
  ),
  BAA311: spec(
    "BAA311",
    "error",
    "`{0}` expected {1} for argument {2}, but got {3}.",
    "`{0}`: argument {2} must be {1}, received {3}.",
  ),
  BAA312: spec(
    "BAA312",
    "error",
    "`{0}` was asked to build {1} items. The pen only holds {2}.",
    "`{0}`: requested size {1} exceeds the limit of {2}.",
  ),

  // ---------------------------------------------------------------- BAA4xx
  BAA401: spec(
    "BAA401",
    "error",
    "No module named `{0}` is grazing anywhere the shepherd can see.",
    "Module `{0}` could not be resolved.",
  ),
  BAA402: spec(
    "BAA402",
    "error",
    "This flock has wandered in a circle: {0}",
    "Circular import detected: {0}",
  ),
  BAA403: spec(
    "BAA403",
    "error",
    "`{0}` doesn't export anything called `{1}`.",
    "Module `{0}` has no export named `{1}`.",
  ),
  BAA404: spec(
    "BAA404",
    "error",
    "Couldn't read the file: {0}",
    "Could not read file: {0}",
  ),
  BAA405: spec(
    "BAA405",
    "error",
    "`baa.toml` is not well formed: {0}",
    "Invalid manifest: {0}",
  ),

  // ---------------------------------------------------------------- BAA9xx
  BAA901: spec(
    "BAA901",
    "warning",
    "`{0}` is declared but never joins the flock.",
    "`{0}` is declared but never used.",
  ),
  BAA902: spec(
    "BAA902",
    "warning",
    "This code is past a `return`: no sheep will ever reach it.",
    "Unreachable code after `return`.",
  ),
  BAA903: spec(
    "BAA903",
    "warning",
    "`{0}` is imported but never used.",
    "`{0}` is imported but never used.",
  ),
  BAA904: spec(
    "BAA904",
    "warning",
    "This condition is always {0}, so the branch never really decides anything.",
    "Condition is constantly {0}.",
  ),
  BAA905: spec(
    "BAA905",
    "warning",
    "`let {0}` is never reassigned: `const {0}` says what you mean.",
    "`{0}` is never reassigned; consider `const`.",
  ),
  BAA906: spec(
    "BAA906",
    "warning",
    "This empty block does nothing at all. Was something meant to graze here?",
    "Empty block.",
  ),
} as const satisfies Record<string, DiagnosticSpec>;

export type DiagnosticCode = keyof typeof CATALOGUE;

export function lookup(code: DiagnosticCode): DiagnosticSpec {
  return CATALOGUE[code];
}

/** Fill `{0}`, `{1}`, ... placeholders. `{{` and `}}` are literal braces. */
export function formatTemplate(template: string, args: readonly string[]): string {
  return template
    .replace(/\{\{|\}\}|\{(\d+)\}/g, (match, index: string | undefined) => {
      if (match === "{{") return "{";
      if (match === "}}") return "}";
      const value = args[Number(index)];
      return value === undefined ? match : value;
    });
}

export const ALL_CODES: readonly DiagnosticCode[] = Object.keys(
  CATALOGUE,
) as DiagnosticCode[];
