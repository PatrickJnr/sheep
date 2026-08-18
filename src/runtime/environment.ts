/**
 * Lexical scopes ("pastures").
 *
 * A chain of scopes, each holding its bindings in declaration order. The
 * resolver records, for every name it placed, how many scopes out the
 * declaration lives and which position it holds there, so reading a variable
 * is two array indexes: no hashing, no walking outward, and no failed lookups
 * on the way.
 *
 * The position is *checked* rather than trusted. A slot carries the name it was
 * resolved from, and a mismatch falls back to the name walk, which is always
 * right. That keeps the fast path an optimisation rather than a second set of
 * scope rules that could disagree with the first: if the resolver's idea of the
 * scope chain ever stops matching the interpreter's, programs keep working and
 * `slotStats.misses` starts counting, which a test asserts stays at zero.
 *
 * Lookup by name is still needed — the prelude, the REPL, and anything the
 * resolver could not place statically — and is a scan of the scope's own
 * bindings. Almost every scope holds a handful of names, where comparing four
 * interned strings beats hashing one; a scope that grows past `INDEX_AT` builds
 * a `Map` so that the globals, which hold the whole prelude, do not pay for the
 * scan.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import type { Span } from "../diagnostics/source.ts";
import type { Value } from "./values.ts";

type Binding = {
  /** Kept so a slot can be verified before it is trusted. */
  readonly name: string;
  value: Value;
  readonly mutable: boolean;
};

/**
 * Where a linear scan stops paying. Function bodies, loop bodies and blocks sit
 * far below this; the globals, with the prelude in them, sit far above.
 */
const INDEX_AT = 8;

/**
 * How often a resolved slot did not hold the name it was resolved from, and so
 * fell back to the name walk. Zero for every program in the test suite; a
 * non-zero count means the resolver and the interpreter have drifted apart
 * about the shape of the scope chain.
 */
export const slotStats = { misses: 0 };

export class Environment {
  readonly parent: Environment | null;
  /** Bindings in declaration order. A slot is an index into this. */
  readonly #ordered: Binding[];
  /** Built only once a scope is big enough for a scan to cost more. */
  #index: Map<string, Binding> | null;
  /** Human label used in stack traces and the REPL. */
  readonly label: string;

  constructor(parent: Environment | null = null, label = "block") {
    this.parent = parent;
    this.#ordered = [];
    this.#index = null;
    this.label = label;
  }

  child(label = "block"): Environment {
    return new Environment(this, label);
  }

  #own(name: string): Binding | undefined {
    const index = this.#index;
    if (index !== null) return index.get(name);
    const ordered = this.#ordered;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const binding = ordered[i]!;
      if (binding.name === name) return binding;
    }
    return undefined;
  }

  define(name: string, value: Value, mutable = true): void {
    const binding: Binding = { name, value, mutable };
    // Redefining a name in the same scope keeps its position: the resolver
    // reports that as BAA101, but the REPL does it legitimately every time a
    // line redeclares something, and appending would leave a slot pointing at
    // the value that was replaced.
    const existing = this.#own(name);
    if (existing === undefined) {
      this.#ordered.push(binding);
      if (this.#index !== null) this.#index.set(name, binding);
      else if (this.#ordered.length > INDEX_AT) this.#buildIndex();
      return;
    }
    this.#ordered[this.#ordered.indexOf(existing)] = binding;
    if (this.#index !== null) this.#index.set(name, binding);
  }

  #buildIndex(): void {
    const index = new Map<string, Binding>();
    for (const binding of this.#ordered) index.set(binding.name, binding);
    this.#index = index;
  }

  has(name: string): boolean {
    let scope: Environment | null = this;
    while (scope !== null) {
      if (scope.#own(name) !== undefined) return true;
      scope = scope.parent;
    }
    return false;
  }

  hasOwn(name: string): boolean {
    return this.#own(name) !== undefined;
  }

  /**
   * Read a name the resolver placed: `hops` scopes out, at `index`.
   *
   * Falls back to the name walk when the slot does not hold what it should,
   * which keeps this an optimisation rather than a second opinion.
   */
  getSlot(hops: number, index: number, name: string, span: Span): Value {
    let scope: Environment = this;
    for (let step = 0; step < hops; step++) {
      const parent: Environment | null = scope.parent;
      if (parent === null) {
        slotStats.misses++;
        return this.get(name, span);
      }
      scope = parent;
    }
    const binding = scope.#ordered[index];
    if (binding !== undefined && binding.name === name) return binding.value;
    slotStats.misses++;
    return this.get(name, span);
  }

  /** Assign through a resolved slot, with the same fallback as `getSlot`. */
  assignSlot(hops: number, index: number, name: string, value: Value, span: Span): void {
    let scope: Environment = this;
    for (let step = 0; step < hops; step++) {
      const parent: Environment | null = scope.parent;
      if (parent === null) {
        slotStats.misses++;
        this.assign(name, value, span);
        return;
      }
      scope = parent;
    }
    const binding = scope.#ordered[index];
    if (binding === undefined || binding.name !== name) {
      slotStats.misses++;
      this.assign(name, value, span);
      return;
    }
    if (!binding.mutable) throw immutable(name, span);
    binding.value = value;
  }

  get(name: string, span: Span): Value {
    let scope: Environment | null = this;
    while (scope !== null) {
      const binding = scope.#own(name);
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
      const binding = scope.#own(name);
      if (binding !== undefined) {
        if (!binding.mutable) throw immutable(name, span);
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
      for (const binding of scope.#ordered) seen.add(binding.name);
      scope = scope.parent;
    }
    return [...seen];
  }

  /** Bindings declared directly in this scope. Used by the REPL's `:vars`. */
  ownEntries(): Array<[string, Value]> {
    return this.#ordered.map((binding) => [binding.name, binding.value]);
  }
}

function immutable(name: string, span: Span): BaaError {
  return BaaError.of("BAA103", [name], {
    span,
    note: "this value is immutable",
    help: `Declare it with \`let ${name}\` if it needs to change.`,
  });
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
