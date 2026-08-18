/**
 * Terminal output helpers: colour detection, the banner, diagnostic printing.
 *
 * Colour is on when stdout is a TTY and nothing has asked for it to be off.
 * `NO_COLOR` (the de-facto standard), `--no-color` and `CI` all turn it off,
 * which keeps logs readable when they are piped into a file.
 */

import process from "node:process";

import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import { ANSI, NO_COLOUR, renderDiagnostic } from "../diagnostics/diagnostic.ts";
import type { Palette } from "../diagnostics/diagnostic.ts";

export const BANNER = String.raw`
        __
   .-''  ''-.
  /  o    o  \
 |     __     |
  \  '----'  /
   '-.____.-'
`;

export type OutputOptions = {
  readonly colour: boolean;
  readonly quiet: boolean;
};

export function detectColour(explicit: boolean | null): boolean {
  if (explicit !== null) return explicit;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "1") return true;
  if (process.env.CI !== undefined && process.env.CI !== "") return false;
  return process.stdout.isTTY === true;
}

/**
 * Professional mode. CI environments get plain wording by default so that a
 * failing build reads like a compiler, not like a joke.
 */
export function detectWoolly(explicit: boolean | null): boolean {
  if (explicit !== null) return explicit;
  if (process.env.BAA_NO_BAA !== undefined && process.env.BAA_NO_BAA !== "") return false;
  if (process.env.CI !== undefined && process.env.CI !== "") return false;
  return true;
}

export function paletteFor(colour: boolean): Palette {
  return colour ? ANSI : NO_COLOUR;
}

export function printDiagnostics(
  diagnostics: readonly Diagnostic[],
  colour: boolean,
  stream: NodeJS.WriteStream = process.stderr,
): void {
  if (diagnostics.length === 0) return;
  const palette = paletteFor(colour);
  const blocks = diagnostics.map((diagnostic) => renderDiagnostic(diagnostic, { palette }));
  stream.write(`${blocks.join("\n\n")}\n`);
}

export function summarise(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  return parts.length === 0 ? "no problems" : parts.join(", ");
}

export function write(text: string): void {
  process.stdout.write(text);
}

export function writeLine(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function writeError(text = ""): void {
  process.stderr.write(`${text}\n`);
}

export function success(text: string, colour: boolean): string {
  return colour ? `[32m${text}[0m` : text;
}

export function failure(text: string, colour: boolean): string {
  return colour ? `[31;1m${text}[0m` : text;
}

export function dim(text: string, colour: boolean): string {
  return colour ? `[2m${text}[0m` : text;
}

export function bold(text: string, colour: boolean): string {
  return colour ? `[1m${text}[0m` : text;
}
