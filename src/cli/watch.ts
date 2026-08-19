/**
 * `baa check --watch`: re-check what changed, and nothing else.
 *
 * The unit of work is a file. Baa's analysis is per-file — a module's
 * diagnostics do not depend on the modules it imports, because imports are
 * resolved when a program runs rather than when it is checked — so a file whose
 * bytes have not changed cannot have changed its answer, and re-checking it
 * would be pure waste. That is the whole of the incremental story, and it is
 * worth stating plainly rather than building a dependency graph that would
 * always report "no dependents".
 *
 * The exception is the project manifest, which decides which module names are
 * importable. A change there can change any file's answer, so it drops the
 * whole cache.
 *
 * `Session` below holds the cache and does the work; it takes no timers and
 * touches no streams, so it can be driven directly by a test. Watching is the
 * thin part on top.
 */

import { existsSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, resolve } from "node:path";
import process from "node:process";

import { checkFile } from "../api.ts";
import type { Diagnostic } from "../diagnostics/diagnostic.ts";
import { SourceFile } from "../diagnostics/source.ts";
import { readFileSync } from "node:fs";
import { MANIFEST_NAME } from "../project/manifest.ts";
import { collectFiles } from "./commands.ts";

export type SweepResult = {
  /** Files that were read and analysed this time round. */
  readonly checked: readonly string[];
  /** Files taken from the cache untouched. */
  readonly reused: number;
  /** Files that have gone away since the last sweep. */
  readonly removed: readonly string[];
  /** Every diagnostic, from the fresh files and the cached ones alike. */
  readonly diagnostics: readonly Diagnostic[];
  readonly errors: number;
  readonly warnings: number;
};

type Entry = {
  /** Cheap identity: a file whose size and mtime are unchanged has not changed. */
  readonly stamp: string;
  readonly diagnostics: readonly Diagnostic[];
};

export class Session {
  readonly #paths: readonly string[];
  #modules: readonly string[];
  readonly #cache = new Map<string, Entry>();

  constructor(paths: readonly string[], modules: readonly string[]) {
    this.#paths = paths;
    this.#modules = modules;
  }

  /** Forget everything, for when the manifest changed under us. */
  invalidateAll(modules: readonly string[]): void {
    this.#modules = modules;
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }

  sweep(): SweepResult {
    const targets = collectFiles(this.#paths);
    const present = new Set(targets);
    const removed: string[] = [];
    for (const path of this.#cache.keys()) {
      if (!present.has(path)) removed.push(path);
    }
    for (const path of removed) this.#cache.delete(path);

    const checked: string[] = [];
    const diagnostics: Diagnostic[] = [];
    let reused = 0;

    for (const path of targets) {
      const stamp = stampOf(path);
      const cached = this.#cache.get(path);
      if (cached !== undefined && stamp !== null && cached.stamp === stamp) {
        reused++;
        diagnostics.push(...cached.diagnostics);
        continue;
      }
      const fresh = this.#check(path);
      // A file being written to as we read it gets no cache entry, so the next
      // sweep looks again rather than trusting a half-written read.
      if (stamp !== null) this.#cache.set(path, { stamp, diagnostics: fresh });
      else this.#cache.delete(path);
      checked.push(path);
      diagnostics.push(...fresh);
    }

    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    return {
      checked,
      reused,
      removed,
      diagnostics,
      errors,
      warnings: diagnostics.length - errors,
    };
  }

  #check(path: string): readonly Diagnostic[] {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // Deleted between the listing and the read. The next sweep will notice.
      return [];
    }
    return checkFile(new SourceFile(path, text), { modules: this.#modules }).diagnostics;
  }
}

function stampOf(path: string): string | null {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

export type WatcherOptions = {
  /** Directories and files to watch. */
  readonly roots: readonly string[];
  /** Called after each settled batch of changes. */
  readonly onChange: (paths: readonly string[]) => void;
  /** How long to wait for a burst of events to finish. */
  readonly settle?: number;
};

/**
 * Watch some roots and call back once a burst of changes has settled.
 *
 * An editor writes a file as several events — truncate, write, rename a
 * temporary over the top — and a save can touch a whole directory. Waiting for
 * quiet turns that into one re-check instead of four.
 */
export function watchRoots(options: WatcherOptions): { close: () => void } {
  const settle = options.settle ?? 60;
  const watchers: FSWatcher[] = [];
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    timer = null;
    const paths = [...pending];
    pending.clear();
    options.onChange(paths);
  };

  for (const root of options.roots) {
    const at = resolve(root);
    if (!existsSync(at)) continue;
    const directory = statSync(at).isDirectory();
    const watcher = watch(
      at,
      { recursive: directory, persistent: true },
      (_event, name) => {
        const changed = name === null ? at : String(name);
        if (!changed.endsWith(".baa") && basename(changed) !== MANIFEST_NAME) return;
        pending.add(changed);
        if (timer !== null) clearTimeout(timer);
        // `unref` is deliberate: the watchers keep the process alive, and the
        // debounce timer should never be the reason it lingers.
        timer = setTimeout(fire, settle);
        timer.unref();
      },
    );
    watcher.on("error", () => {
      // A directory that disappears takes its watcher with it. The remaining
      // ones still work, and a re-check will notice the files are gone.
    });
    watchers.push(watcher);
  }

  return {
    close: () => {
      if (timer !== null) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    },
  };
}

/** True when a batch of changed paths includes the project manifest. */
export function touchesManifest(paths: readonly string[]): boolean {
  return paths.some((path) => basename(path) === MANIFEST_NAME);
}

/** Wait for the process to be interrupted. Resolves on SIGINT or SIGTERM. */
export function untilInterrupted(): Promise<void> {
  return new Promise<void>((resolve_) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve_();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
