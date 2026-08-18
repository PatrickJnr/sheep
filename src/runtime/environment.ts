/**
 * Lexical scopes ("pastures").
 *
 * A chain of `Map`s. Lookup walks outward until it finds the name. The resolver
 * has already proved that every name exists, so runtime lookup failures are
 * bugs in the interpreter rather than user errors: with one exception, the
 * REPL, where a scope can be mutated between statements.
 *
 * A faster design (flat frames plus resolved slot indices) is the natural next
 * step; the resolver already computes the depth information it would need. See
 * ARCHITECTURE.md, "Path to a bytecode VM".
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import type { Value } from "./values.ts";

type Binding = {
  value: Value;
  readonly mutable: boolean;
};

export class Environment {
  readonly parent: Environment | null;
  readonly #bindings: Map<string, Binding>;
  /** Human label used in stack traces and the REPL. */
  readonly label: string;

  constructor(parent: Environment | null = null, label = "block") {
    this.parent = parent;
    this.#bindings = new Map();
    this.label = label;
  }

  child(label = "block"): Environment {
    return new Environment(this, label);
  }

  define(name: string, value: Value, mutable = true): void {
    this.#bindings.set(name, { value, mutable });
  }

  has(name: string): boolean {
    let scope: Environment | null = this;
    while (scope !== null) {
      if (scope.#bindings.has(name)) return true;
      scope = scope.parent;
    }
    return false;
  }

  hasOwn(name: string): boolean {
    return this.#bindings.has(name);
  }

  get(name: string, span: Span): Value {
    let scope: Environment | null = this;
    while (scope !== null) {
      const binding = scope.#bindings.get(name);
      if (binding !== undefined) return binding.value;
      scope = scope.parent;
    }
    throw BaaError.of("BAA102", [name], {
      span,
      note: "not found in this pasture",
      ...suggestionFor(this, name),
    });
  }

  assign(name: string, value: Value, span: Span): void {
    let scope: Environment | null = this;
    while (scope !== null) {
      const binding = scope.#bindings.get(name);
      if (binding !== undefined) {
        if (!binding.mutable) {
          throw BaaError.of("BAA103", [name], {
            span,
            note: "this value is immutable",
            help: `Declare it with \`let ${name}\` if it needs to change.`,
          });
        }
        binding.value = value;
        return;
      }
      scope = scope.parent;
    }
    throw BaaError.of("BAA102", [name], {
      span,
      note: "not found in this pasture",
      ...suggestionFor(this, name),
    });
  }

  /** Every name visible from this scope, innermost first. Used for suggestions. */
  names(): string[] {
    const seen = new Set<string>();
    let scope: Environment | null = this;
    while (scope !== null) {
      for (const key of scope.#bindings.keys()) seen.add(key);
      scope = scope.parent;
    }
    return [...seen];
  }

  /** Bindings declared directly in this scope. Used by the REPL's `:vars`. */
  ownEntries(): Array<[string, Value]> {
    return [...this.#bindings].map(([name, binding]) => [name, binding.value]);
  }
}

function suggestionFor(scope: Environment, name: string): { help?: string } {
  const candidates = scope.names();
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const limit = Math.max(2, Math.floor(name.length / 2));
  for (const candidate of candidates) {
    const score = distance(name.toLowerCase(), candidate.toLowerCase());
    if (score > 0 && score < bestScore && score <= limit) {
      bestScore = score;
      best = candidate;
    }
  }
  return best === null ? {} : { help: `Did you mean \`${best}\`?` };
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length]!;
}
