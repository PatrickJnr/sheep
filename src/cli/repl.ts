/**
 * `baa repl`: the interactive shell.
 *
 * The REPL keeps one `Environment` alive across inputs, so bindings, functions
 * and imports persist. Input that is obviously incomplete (an unclosed block,
 * a line that ends mid-expression) opens a continuation prompt instead of
 * reporting an error, which makes pasting a multi-line function work.
 */

import { createInterface } from "node:readline/promises";
import process from "node:process";

import { toDiagnostic } from "../api.ts";
import { BaaError } from "../diagnostics/diagnostic.ts";
import { SourceFile } from "../diagnostics/source.ts";
import { parse } from "../parser/parser.ts";
import { createNodeHost } from "../runtime/host.ts";
import { Environment } from "../runtime/environment.ts";
import { Interpreter } from "../runtime/interpreter.ts";
import { ExitSignal } from "../runtime/signals.ts";
import { inspect, typeOf } from "../runtime/values.ts";
import type { Value } from "../runtime/values.ts";
import { resolveProgram } from "../semantic/resolver.ts";
import { STDLIB_MODULES } from "../stdlib/index.ts";
import { bold, dim, printDiagnostics, writeLine } from "./output.ts";

const PROMPT = "baa> ";
const CONTINUATION = "...  ";

const HELP = `Commands
  :help            show this message
  :vars            list bindings you have created
  :type <expr>     show the type of an expression
  :modules         list standard library modules
  :clear           forget every binding
  :quit            leave (Ctrl+D also works)

Anything else is Baa. Expressions print their value; statements do not.`;

export type ReplOptions = {
  readonly colour: boolean;
  readonly version: string;
  readonly banner: boolean;
};

export async function startRepl(options: ReplOptions): Promise<number> {
  const host = createNodeHost();
  let interpreter = new Interpreter({ host });
  let scope = interpreter.globals.child("repl");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 500,
    terminal: process.stdin.isTTY === true,
  });

  if (options.banner) {
    writeLine(bold(`Baa ${options.version}`, options.colour));
    writeLine(dim("Type :help for commands, :quit to leave.", options.colour));
  }

  let buffer = "";

  // The line iterator works the same for a terminal and for piped input, which
  // `question()` does not: with a pipe it can drop buffered lines between calls.
  rl.setPrompt(PROMPT);
  rl.prompt();

  /** Handle one input line. Returns false when the session should end. */
  const handleLine = (line: string): boolean => {
    if (buffer === "") {
      const command = line.trim();
      if (command === ":quit" || command === ":exit" || command === ":q") return false;
      if (command === "") return true;
      if (command === ":help" || command === ":?") {
        writeLine(HELP);
        return true;
      }
      if (command === ":modules") {
        writeLine(STDLIB_MODULES.join(", "));
        return true;
      }
      if (command === ":clear") {
        interpreter = new Interpreter({ host });
        scope = interpreter.globals.child("repl");
        writeLine(dim("Pasture cleared.", options.colour));
        return true;
      }
      if (command === ":vars") {
        printVars(scope, options.colour);
        return true;
      }
      if (command.startsWith(":type ")) {
        const value = evaluateSnippet(
          interpreter,
          scope,
          command.slice(6),
          options.colour,
        );
        if (value !== undefined) writeLine(typeOf(value));
        return true;
      }
      if (command.startsWith(":")) {
        writeLine(dim(`Unknown command \`${command}\`. Try :help.`, options.colour));
        return true;
      }
    }

    buffer = buffer === "" ? line : `${buffer}\n${line}`;
    if (isIncomplete(buffer)) return true;

    const source = buffer;
    buffer = "";
    const value = evaluateSnippet(interpreter, scope, source, options.colour);
    if (value !== undefined && value !== null) writeLine(inspect(value));
    return true;
  };

  try {
    for await (const line of rl) {
      if (!handleLine(line)) break;
      rl.setPrompt(buffer === "" ? PROMPT : CONTINUATION);
      rl.prompt();
    }
  } finally {
    rl.close();
  }
  return 0;
}

function printVars(scope: Environment, colour: boolean): void {
  const entries = scope.ownEntries();
  if (entries.length === 0) {
    writeLine(dim("No bindings yet.", colour));
    return;
  }
  const width = Math.max(...entries.map(([name]) => name.length));
  for (const [name, value] of entries) {
    writeLine(`${name.padEnd(width)}  ${dim(inspect(value), colour)}`);
  }
}

/**
 * Decide whether to keep reading. Only "the input ran out" errors continue:
 * a genuine syntax error is reported immediately rather than swallowing the
 * rest of the session.
 */
function isIncomplete(source: string): boolean {
  const file = new SourceFile("<repl>", source);
  try {
    const { diagnostics } = parse(file);
    return diagnostics.some(
      (diagnostic) =>
        (diagnostic.code === "BAA010" || diagnostic.code === "BAA001") &&
        atEndOfInput(diagnostic.primary?.span.start ?? 0, source),
    );
  } catch (error) {
    if (error instanceof BaaError) {
      return (
        (error.diagnostic.code === "BAA010" || error.diagnostic.code === "BAA003") &&
        atEndOfInput(error.diagnostic.primary?.span.start ?? 0, source)
      );
    }
    return false;
  }
}

function atEndOfInput(offset: number, source: string): boolean {
  return source.slice(offset).trim().length <= 1;
}

function evaluateSnippet(
  interpreter: Interpreter,
  scope: Environment,
  source: string,
  colour: boolean,
): Value | undefined {
  const file = new SourceFile("<repl>", source);
  const { program, diagnostics } = parse(file);
  const analysis = resolveProgram(program, file, { modules: [] });
  // The REPL's scope is built incrementally, so name resolution is left to the
  // runtime; only structural problems are reported ahead of time.
  const problems = [
    ...diagnostics,
    ...analysis.diagnostics.filter(
      (diagnostic) => diagnostic.code !== "BAA102" && diagnostic.code !== "BAA101",
    ),
  ].filter((diagnostic) => diagnostic.severity === "error");

  if (problems.length > 0) {
    printDiagnostics(problems, colour, process.stdout);
    return undefined;
  }

  try {
    const last = program.body[program.body.length - 1];
    const value = interpreter.run(program, file, scope);
    return last !== undefined && last.kind === "ExpressionStatement" ? value : undefined;
  } catch (error) {
    if (error instanceof ExitSignal) throw error;
    const converted = toDiagnostic(error, interpreter);
    if (converted === null) throw error;
    printDiagnostics(converted.diagnostics, colour, process.stdout);
    return undefined;
  }
}
