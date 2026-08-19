/**
 * The terminal half of `baa check --watch`.
 *
 * Kept apart from `watch.ts` so that the part with the cache in it can be
 * tested without timers, watchers or a terminal, and this part stays small
 * enough to read in one go.
 */

import { relative, resolve } from "node:path";
import process from "node:process";

import { loadProject, report } from "./commands.ts";
import type { CommandContext } from "./commands.ts";
import { bold, dim, failure, success, summarise, writeLine } from "./output.ts";
import { resolveDependencies } from "../project/manifest.ts";
import { Session, touchesManifest, untilInterrupted, watchRoots } from "./watch.ts";

export type WatchArgs = {
  readonly paths: readonly string[];
};

function shorten(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel === "" || rel.startsWith("..") ? path : rel.split(/[\\/]/).join("/");
}

export async function commandCheckWatch(
  args: WatchArgs,
  context: CommandContext,
): Promise<number> {
  let manifest = loadProject();
  const roots = args.paths.length > 0 ? args.paths : [manifest === null ? process.cwd() : manifest.root];
  const modules = (): readonly string[] =>
    manifest === null ? [] : [...resolveDependencies(manifest).keys()];

  const session = new Session(roots, modules());

  const round = (changed: readonly string[]): void => {
    if (touchesManifest(changed)) {
      // Which module names are importable is a property of the manifest, so a
      // change there can change any file's answer. Nothing may be reused.
      manifest = loadProject();
      session.invalidateAll(modules());
    }
    const result = session.sweep();
    report(result.diagnostics, context, {
      command: "check",
      files: result.checked.length + result.reused,
      ok: result.errors === 0,
    });
    if (context.format === "json") return;

    const label = `${result.checked.length} checked, ${result.reused} unchanged, ${summarise(result.diagnostics)}`;
    writeLine(result.errors === 0 ? success(label, context.colour) : failure(label, context.colour));
    for (const path of result.removed) writeLine(dim(`  gone: ${shorten(path)}`, context.colour));
  };

  writeLine(bold(`Watching ${roots.map((root) => shorten(resolve(root))).join(", ")}`, context.colour));
  // The watcher goes up before the first sweep, not after it. Checking a large
  // project takes long enough for an edit to land in between, and an edit that
  // arrives during the first check is exactly the one worth not missing.
  const watcher = watchRoots({ roots, onChange: round });
  round([]);
  writeLine(dim("Press Ctrl+C to stop.", context.colour));

  try {
    await untilInterrupted();
  } finally {
    watcher.close();
  }
  writeLine("");
  writeLine(dim("Stopped watching.", context.colour));
  return 0;
}
