/**
 * `shepherd`: the world outside the program: arguments, environment, input,
 * and running other programs.
 *
 * Security note. `shepherd.run` never uses a shell. It takes a program name and
 * an explicit array of arguments and passes them straight to the operating
 * system, so there is no string that could be re-interpreted as shell syntax
 * and nothing to quote-escape. A program that wants a shell has to ask for one
 * by name (`shepherd.run("bash", ["-c", ...])`), which makes the decision
 * visible in the source and in review. See SECURITY.md.
 */

import { spawnSync } from "node:child_process";
import { readSync } from "node:fs";
import process from "node:process";

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { BaaArray, BaaMap } from "../runtime/values.ts";
import type { MapKey, Value } from "../runtime/values.ts";
import { argArray, argString, defineModule, fn, mapOf } from "./define.ts";

export function createShepherd(host: RuntimeHost) {
  return defineModule("shepherd", {
    PLATFORM: process.platform,
    ARCH: process.arch,

    args: fn(0, 0, "Arguments passed to the Baa program after `--`.", () =>
      new BaaArray([...host.argv()]),
    ),

    env: fn(1, 2, "An environment variable, or a fallback when it is unset.", (args, ctx) => {
      const name = argString("shepherd.env", args, 0, ctx.span);
      const value = host.envVar(name);
      return value ?? (args.length > 1 ? args[1]! : null);
    }),

    env_all: fn(0, 0, "Every environment variable as a map.", () => {
      const entries = new Map<MapKey, Value>();
      for (const [key, value] of Object.entries(host.envVars())) entries.set(key, value);
      return new BaaMap(entries);
    }),

    write: fn(1, Number.MAX_SAFE_INTEGER, "Write to stdout without a trailing newline.", (args) => {
      host.write(args.map((value) => (typeof value === "string" ? value : String(value))).join(""));
      return null;
    }),

    write_error: fn(1, Number.MAX_SAFE_INTEGER, "Write to stderr without a trailing newline.", (args) => {
      host.writeError(
        args.map((value) => (typeof value === "string" ? value : String(value))).join(""),
      );
      return null;
    }),

    input: fn(0, 1, "Read one line from stdin, or nil at end of input.", (args, ctx) => {
      if (args.length > 0) host.write(argString("shepherd.input", args, 0, ctx.span));
      return readLine();
    }),

    read_all: fn(0, 0, "Read all of stdin as a single string.", () => {
      const chunks: string[] = [];
      for (;;) {
        const line = readLine();
        if (line === null) break;
        chunks.push(line);
      }
      return chunks.join("\n");
    }),

    run: fn(
      1,
      3,
      "Run a program with an explicit argument array. Never uses a shell.",
      (args, ctx) => {
        const program = argString("shepherd.run", args, 0, ctx.span);
        const programArgs =
          args.length > 1
            ? argArray("shepherd.run", args, 1, ctx.span).items.map((item, index) => {
                if (typeof item !== "string") {
                  throw BaaError.of(
                    "BAA311",
                    ["shepherd.run", "an array of strings", "2", `a non-string at index ${index}`],
                    { span: ctx.span, note: "arguments must all be strings" },
                  );
                }
                return item;
              })
            : [];
        const options = args.length > 2 ? args[2] : null;
        const cwd =
          options instanceof BaaMap && typeof options.entries.get("cwd") === "string"
            ? (options.entries.get("cwd") as string)
            : host.cwd();
        const input =
          options instanceof BaaMap && typeof options.entries.get("input") === "string"
            ? (options.entries.get("input") as string)
            : undefined;

        const result = spawnSync(program, programArgs, {
          cwd,
          encoding: "utf8",
          shell: false,
          ...(input === undefined ? {} : { input }),
        });
        if (result.error !== undefined) {
          throw BaaError.of("BAA301", [`could not run \`${program}\`: ${result.error.message}`], {
            span: ctx.span,
            note: "the program did not start",
            help: "Check that it is installed and on PATH.",
          });
        }
        return mapOf({
          code: result.status ?? -1,
          out: result.stdout ?? "",
          err: result.stderr ?? "",
        });
      },
    ),

    exit: fn(0, 1, "Exit with a status code (default 0).", (args, ctx) => {
      const code = args.length > 0 ? args[0] : 0;
      if (typeof code !== "number" || !Number.isInteger(code)) {
        throw BaaError.of("BAA311", ["shepherd.exit", "a whole number", "1", typeof code], {
          span: ctx.span,
        });
      }
      host.exit(code);
      return null;
    }),
  });
}

/**
 * Synchronous line read from stdin. Baa's interpreter is synchronous, so this
 * blocks by design. Returns `null` at end of input.
 */
function readLine(): string | null {
  const buffer = Buffer.alloc(1);
  let line = "";
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, 1, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") break;
      throw error;
    }
    if (read === 0) break;
    const ch = buffer.toString("utf8");
    if (ch === "\n") return line.endsWith("\r") ? line.slice(0, -1) : line;
    line += ch;
  }
  return line.length > 0 ? line : null;
}
