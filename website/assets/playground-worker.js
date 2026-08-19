/**
 * The playground's execution worker.
 *
 * Baa programs run here rather than on the main thread for one reason: a Baa
 * program can loop forever, and a worker can be terminated. The page stays
 * responsive and the tab never has to be killed.
 *
 * This imports the genuine interpreter: the same lexer, parser, resolver and
 * runtime the `baa` CLI uses, compiled to JavaScript by
 * `tools/build-playground.ts`.
 */

import { check, format, run, renderDiagnostic, setWoollyMode } from "./baa/api.js";

function describe(diagnostic) {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    rendered: renderDiagnostic(diagnostic),
  };
}

self.addEventListener("message", (event) => {
  const { id, kind, source, seed, woolly } = event.data;
  setWoollyMode(woolly !== false);

  try {
    if (kind === "format") {
      self.postMessage({ id, kind, ok: true, source: format(source, "playground.baa") });
      return;
    }

    if (kind === "check") {
      const result = check(source, "playground.baa");
      self.postMessage({
        id,
        kind,
        ok: result.ok,
        diagnostics: result.diagnostics.map(describe),
      });
      return;
    }

    const started = performance.now();
    const result = run(source, "playground.baa", { seed });
    self.postMessage({
      id,
      kind: "run",
      ok: result.ok,
      output: result.output,
      exitCode: result.exitCode,
      elapsed: performance.now() - started,
      diagnostics: result.diagnostics.map(describe),
    });
  } catch (error) {
    self.postMessage({
      id,
      kind,
      ok: false,
      fatal: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
});

self.postMessage({ ready: true });
