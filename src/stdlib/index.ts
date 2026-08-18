/**
 * The standard library registry.
 *
 * Modules are built lazily on first import and cached by the interpreter, so a
 * program that never touches `pasture` never constructs it. Every module is a
 * plain `BaaModule` of native functions: there is no privileged module
 * mechanism, which means a Baa file can export the same shape.
 */

import type { Interpreter } from "../runtime/interpreter.ts";
import type { BaaModule } from "../runtime/values.ts";
import { createFlock } from "./flock.ts";
import { createLamb } from "./lamb.ts";
import { createMeadow } from "./meadow.ts";
import { createPasture } from "./pasture.ts";
import { createRam } from "./ram.ts";
import { createShepherd } from "./shepherd.ts";
import { createWool } from "./wool.ts";

/** Every module name `import <name>` accepts, in documentation order. */
export const STDLIB_MODULES: readonly string[] = [
  "wool",
  "flock",
  "ram",
  "meadow",
  "pasture",
  "shepherd",
  "lamb",
];

export const STDLIB_SUMMARY: Readonly<Record<string, string>> = {
  wool: "Text: formatting, casing, wrapping, bytes.",
  flock: "Collections: grouping, chunking, zipping, building maps.",
  ram: "Arithmetic: rounding, integer division, statistics, constants.",
  meadow: "Time and chance: clocks, calendars, seeded randomness.",
  pasture: "Files and paths: reading, writing, listing, joining.",
  shepherd: "The outside world: arguments, environment, stdin, subprocesses.",
  lamb: "Data: JSON encoding and decoding.",
};

export function loadBuiltinModule(name: string, interpreter: Interpreter): BaaModule | null {
  switch (name) {
    case "wool":
      return createWool();
    case "flock":
      return createFlock();
    case "ram":
      return createRam();
    case "meadow":
      return createMeadow(interpreter.host);
    case "pasture":
      return createPasture(interpreter.host);
    case "shepherd":
      return createShepherd(interpreter.host);
    case "lamb":
      return createLamb();
    default:
      return null;
  }
}
