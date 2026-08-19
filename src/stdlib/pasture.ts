/**
 * `pasture`: the ground your program stands on: files and paths.
 *
 * Every filesystem call goes through the `RuntimeHost`, so a sandboxed or
 * in-memory host can swap the whole module's behaviour without changing a line
 * here. Path helpers are pure string operations and use Node's platform-aware
 * `path` module, which keeps Windows separators correct without any of the
 * `"/" + name` guesswork.
 */

import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { BaaError } from "../diagnostics/diagnostic.ts";
import { describeFileError, rethrowIfDenied } from "../runtime/host.ts";
import type { RuntimeHost } from "../runtime/host.ts";
import { BaaArray } from "../runtime/values.ts";
import { argArray, argString, checkPath, defineModule, fn, mapOf } from "./define.ts";

export function createPasture(host: RuntimeHost) {
  const readPath = (name: string, args: unknown[], span: import("../diagnostics/source.ts").Span): string =>
    checkPath(name, argString(name, args as never, 0, span), span);

  return defineModule("pasture", {
    SEPARATOR: sep,

    read: fn(1, 1, "Read a whole text file as a string.", (args, ctx) => {
      const path = readPath("pasture.read", args, ctx.span);
      try {
        return host.readFile(path);
      } catch (error) {
        rethrowIfDenied(error, ctx.span);
        throw BaaError.of("BAA404", [`${path}: ${describeFileError(error)}`], {
          span: ctx.span,
          note: "could not read this file",
          help: "Check the path, and that the file exists: `pasture.exists(path)`.",
        });
      }
    }),

    read_lines: fn(1, 1, "Read a text file and split it into lines.", (args, ctx) => {
      const path = readPath("pasture.read_lines", args, ctx.span);
      try {
        const text = host.readFile(path).replace(/\r\n?/g, "\n");
        const lines = text.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        return new BaaArray(lines);
      } catch (error) {
        rethrowIfDenied(error, ctx.span);
        throw BaaError.of("BAA404", [`${path}: ${describeFileError(error)}`], { span: ctx.span });
      }
    }),

    write: fn(2, 2, "Write text to a file, replacing anything already there.", (args, ctx) => {
      const path = readPath("pasture.write", args, ctx.span);
      const contents = argString("pasture.write", args, 1, ctx.span);
      try {
        host.writeFile(path, contents);
      } catch (error) {
        rethrowIfDenied(error, ctx.span);
        throw BaaError.of("BAA404", [`${path}: ${describeFileError(error)}`], { span: ctx.span });
      }
      return null;
    }),

    append: fn(2, 2, "Append text to a file, creating it when missing.", (args, ctx) => {
      const path = readPath("pasture.append", args, ctx.span);
      const contents = argString("pasture.append", args, 1, ctx.span);
      try {
        host.appendFile(path, contents);
      } catch (error) {
        rethrowIfDenied(error, ctx.span);
        throw BaaError.of("BAA404", [`${path}: ${describeFileError(error)}`], { span: ctx.span });
      }
      return null;
    }),

    write_lines: fn(2, 2, "Write an array of lines to a file.", (args, ctx) => {
      const path = readPath("pasture.write_lines", args, ctx.span);
      const lines = argArray("pasture.write_lines", args, 1, ctx.span);
      const text = lines.items
        .map((line, index) => {
          if (typeof line !== "string") {
            throw BaaError.of("BAA311", ["pasture.write_lines", "an array of strings", "2", `a non-string at index ${index}`], {
              span: ctx.span,
            });
          }
          return line;
        })
        .join("\n");
      host.writeFile(path, `${text}\n`);
      return null;
    }),

    exists: fn(1, 1, "True when a file or directory exists.", (args, ctx) =>
      host.fileExists(readPath("pasture.exists", args, ctx.span)),
    ),

    list: fn(1, 1, "Names inside a directory.", (args, ctx) => {
      const path = readPath("pasture.list", args, ctx.span);
      try {
        return new BaaArray(host.listDir(path).sort());
      } catch (error) {
        rethrowIfDenied(error, ctx.span);
        throw BaaError.of("BAA404", [`${path}: ${describeFileError(error)}`], {
          span: ctx.span,
          note: "could not list this directory",
        });
      }
    }),

    make_dir: fn(1, 1, "Create a directory, including any missing parents.", (args, ctx) => {
      host.makeDir(readPath("pasture.make_dir", args, ctx.span));
      return null;
    }),

    info: fn(1, 1, "Size, kind and modification time of a path, or nil.", (args, ctx) => {
      const path = readPath("pasture.info", args, ctx.span);
      const stat = host.stat(path);
      if (stat === null) return null;
      return mapOf({
        path,
        size: stat.size,
        is_directory: stat.isDirectory,
        modified: stat.modified,
      });
    }),

    // ------------------------------------------------------------- path maths

    join: fn(1, Number.MAX_SAFE_INTEGER, "Join path segments with the platform separator.", (args, ctx) =>
      join(...args.map((_, index) => argString("pasture.join", args, index, ctx.span))),
    ),

    resolve: fn(1, Number.MAX_SAFE_INTEGER, "Turn path segments into one absolute path.", (args, ctx) =>
      resolve(...args.map((_, index) => argString("pasture.resolve", args, index, ctx.span))),
    ),

    dir_name: fn(1, 1, "The directory part of a path.", (args, ctx) =>
      dirname(argString("pasture.dir_name", args, 0, ctx.span)),
    ),

    base_name: fn(1, 2, "The final component of a path, optionally without a suffix.", (args, ctx) =>
      args.length > 1
        ? basename(
            argString("pasture.base_name", args, 0, ctx.span),
            argString("pasture.base_name", args, 1, ctx.span),
          )
        : basename(argString("pasture.base_name", args, 0, ctx.span)),
    ),

    extension: fn(1, 1, "The file extension, including the dot.", (args, ctx) =>
      extname(argString("pasture.extension", args, 0, ctx.span)),
    ),

    normalise: fn(1, 1, "Collapse `.` and `..` segments.", (args, ctx) =>
      normalize(argString("pasture.normalise", args, 0, ctx.span)),
    ),

    relative_to: fn(2, 2, "The path from one location to another.", (args, ctx) =>
      relative(
        argString("pasture.relative_to", args, 0, ctx.span),
        argString("pasture.relative_to", args, 1, ctx.span),
      ),
    ),

    is_absolute: fn(1, 1, "True when a path is absolute.", (args, ctx) =>
      isAbsolute(argString("pasture.is_absolute", args, 0, ctx.span)),
    ),

    cwd: fn(0, 0, "The current working directory.", () => host.cwd()),
  });
}
