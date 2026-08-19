/**
 * `baa doc`: a reference for a project's own code, from its `///` comments.
 *
 * The parser already keeps doc comments on declarations, because the language
 * server shows them on hover. This turns the same information into Markdown, so
 * a library written in Baa can publish a reference the way the standard library
 * has one.
 *
 * Only *exported* declarations are documented. A module's API is what it
 * exports; everything else is how it works, and a reference that lists both
 * teaches a reader to depend on things that will move.
 *
 * The output is deterministic — files in sorted order, declarations in source
 * order, no timestamps and no paths from the machine that generated it — which
 * is what makes `--check` in CI meaningful.
 */

import { basename, relative, resolve, sep } from "node:path";

import { bindingNames } from "../ast/ast.ts";
import type { Param, Program } from "../ast/ast.ts";

export type DocEntry = {
  readonly kind: "fn" | "let" | "const";
  readonly name: string;
  /** `up(state, by = 1)` for a function, the bare name otherwise. */
  readonly signature: string;
  readonly doc: string | null;
  readonly line: number;
};

export type DocModule = {
  /** Path as written in the reference: relative, with forward slashes. */
  readonly path: string;
  readonly entries: readonly DocEntry[];
};

export type DocOptions = {
  readonly title?: string;
  /** Sentence under the title. Written by the caller, not invented here. */
  readonly intro?: string;
};

/** Render one parameter the way the source would write it. */
function renderParam(param: Param): string {
  const name = param.rest ? `..${param.name}` : param.name;
  if (param.defaultValue === null) return name;
  return `${name} = ${literalOf(param.defaultValue)}`;
}

/**
 * A default value as text.
 *
 * Only literals are written out. Anything else is shown as `...`: a default
 * that is a call or an expression is a fact about the implementation, and
 * printing it into a reference invites a reader to depend on it.
 */
function literalOf(expression: Param["defaultValue"]): string {
  if (expression === null) return "...";
  switch (expression.kind) {
    case "IntLiteral":
    case "FloatLiteral":
      // `raw`, so `0xFF` and `1_000` read in the reference the way they read
      // in the source.
      return expression.raw;
    case "BoolLiteral":
      return expression.value ? "true" : "false";
    case "NilLiteral":
      return "nil";
    case "StringLiteral": {
      const parts = expression.segments;
      if (parts.length === 1 && parts[0]!.kind === "text") {
        return JSON.stringify(parts[0]!.value);
      }
      return "...";
    }
    case "ArrayLiteral":
      return expression.elements.length === 0 ? "[]" : "...";
    case "MapLiteral":
      return expression.entries.length === 0 ? "{}" : "...";
    default:
      return "...";
  }
}

/** Everything a program exports, in source order. */
export function collectDocs(program: Program, path: string): DocModule {
  const entries: DocEntry[] = [];
  for (const statement of program.body) {
    if (statement.kind === "FunctionDeclaration" && statement.exported) {
      entries.push({
        kind: "fn",
        name: statement.name,
        signature: `${statement.name}(${statement.params.map(renderParam).join(", ")})`,
        doc: statement.doc,
        line: statement.span.file.positionAt(statement.span.start).line,
      });
      continue;
    }
    if (statement.kind === "LetStatement" && statement.exported) {
      // `let [a, b] = ...` exports both names, and each is its own entry: a
      // reader looking one of them up should find it.
      for (const bound of bindingNames(statement.binding).map((entry) => entry.name)) {
        entries.push({
          kind: statement.mutable ? "let" : "const",
          name: bound,
          signature: bound,
          doc: statement.doc,
          line: statement.span.file.positionAt(statement.span.start).line,
        });
      }
    }
  }
  return { path, entries };
}

/** The path a reference shows for a file: relative to the root, forward slashes. */
export function documentedPath(path: string, root: string): string {
  const rel = relative(resolve(root), resolve(path));
  // A file outside the project is named, not traced: `../../../tmp/pen.baa`
  // says more about the machine that ran the command than about the code.
  if (rel === "" || rel.startsWith("..")) return basename(path);
  return rel.split(sep).join("/");
}

/**
 * Render modules as one Markdown document.
 *
 * A module with nothing exported still gets a heading and a line saying so:
 * silence would read as "not documented yet" when the truth is "this file is
 * internal", and the difference matters to somebody deciding what to import.
 */
export function renderDocs(modules: readonly DocModule[], options: DocOptions = {}): string {
  const out: string[] = [];
  out.push(`# ${options.title ?? "Reference"}`);
  out.push("");
  if (options.intro !== undefined && options.intro !== "") {
    out.push(options.intro);
    out.push("");
  }

  const sorted = [...modules].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const documented = sorted.filter((module) => module.entries.length > 0);
  if (documented.length > 1) {
    for (const module of documented) {
      out.push(`- [\`${module.path}\`](#${anchor(module.path)})`);
    }
    out.push("");
  }

  for (const module of sorted) {
    out.push(`## \`${module.path}\``);
    out.push("");
    if (module.entries.length === 0) {
      out.push("Exports nothing.");
      out.push("");
      continue;
    }
    for (const entry of module.entries) {
      const prefix = entry.kind === "fn" ? "fn " : `${entry.kind} `;
      out.push(`### \`${prefix}${entry.signature}\``);
      out.push("");
      out.push(entry.doc ?? "_Undocumented._");
      out.push("");
    }
  }

  out.push("---");
  out.push("");
  out.push("Generated by `baa doc` from `///` comments.");
  out.push("");
  return out.join("\n");
}

/** GitHub's heading anchor rule, which the site generator also follows. */
function anchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s/.-]/g, "")
    .replace(/[/.]/g, "")
    .replace(/\s/g, "-");
}
