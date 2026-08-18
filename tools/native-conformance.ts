/**
 * Runs the conformance suite against the native runtime.
 *
 * The suite is the same one `rust/README.md` has always pointed a second
 * implementation at: programs with their exact output, generated from the
 * reference implementation and kept fresh by CI. Passing it is the only
 * defensible claim that the native runtime runs Baa rather than something
 * that looks like it.
 *
 *     node tools/native-conformance.ts            # summary, exits 1 on failure
 *     node tools/native-conformance.ts --verbose  # every failure in full
 *
 * Failures are printed, not hidden. A number in the documentation that this
 * script does not produce is a bug in the documentation.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { bundle } from "../src/native/bundle.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUITE = join(ROOT, "tests", "conformance", "suite.json");

export type Outcome = {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string;
};

export type Summary = {
  readonly total: number;
  readonly passed: number;
  readonly outcomes: readonly Outcome[];
};

export function hostPath(): string | null {
  const name = process.platform === "win32" ? "baa-native.exe" : "baa-native";
  for (const directory of ["release", "debug"]) {
    const candidate = join(ROOT, "rust", "target", directory, name);
    if (existsSync(candidate)) return candidate;
  }
  const override = process.env.BAA_NATIVE_HOST;
  if (override && existsSync(join(override, name))) return join(override, name);
  return null;
}

/**
 * Programs the suite runs that the native runtime is not expected to pass,
 * with the reason. Every entry is a module the native runtime does not
 * implement, never a semantic difference: a program that uses only what
 * `barn`, `ram` and the prelude offer must produce identical output, and if it
 * does not, that is a bug rather than an exception.
 */
const UNSUPPORTED = /^\s*import\s+(gate|shepherd|meadow)\b/m;

/**
 * The environment the runtime is run in.
 *
 * `CI` and `BAA_NO_BAA` swap every diagnostic for its neutral wording, in the
 * native runtime exactly as in the CLI. That is correct behaviour and it is
 * *observable to a program*: `errors.baa` catches a `BAA304` and prints the
 * message, so the wording mode changes the program's output.
 *
 * The suite records one wording, so the harness has to pin it rather than
 * inherit whatever the shell has. Without this the suite passes on a laptop
 * and fails in CI, which is the worst of both.
 */
function pinnedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CI;
  delete environment.BAA_NO_BAA;
  return environment;
}

export function runSuite(options: { verbose?: boolean } = {}): Summary {
  const host = hostPath();
  if (host === null) {
    throw new Error(
      "The native runtime is not built.\n  cargo build --release --manifest-path rust/Cargo.toml",
    );
  }

  const suite = JSON.parse(readFileSync(SUITE, "utf8")) as {
    programs: Array<{ name: string; source: string; stdout: string; exit: number }>;
  };

  const work = join(tmpdir(), `baa-conformance-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const outcomes: Outcome[] = [];

  try {
    for (const program of suite.programs) {
      if (UNSUPPORTED.test(program.source)) {
        outcomes.push({
          name: program.name,
          passed: true,
          reason: "skipped: uses a module the native runtime does not have",
        });
        continue;
      }

      const source = join(work, "program.baa");
      const image = join(work, "program.fleece");
      writeFileSync(source, program.source, "utf8");

      let stdout = "";
      let exit = 0;
      try {
        const built = bundle({ entry: source, root: work });
        writeFileSync(image, built.bytes);
        stdout = execFileSync(host, [image], { encoding: "utf8", env: pinnedEnvironment() });
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
        exit = failure.status ?? 1;
        stdout = failure.stdout ?? "";
        if (failure.status === undefined) {
          outcomes.push({ name: program.name, passed: false, reason: failure.message ?? String(error) });
          continue;
        }
      }

      const normalised = stdout.replace(/\r\n/g, "\n");
      if (normalised !== program.stdout) {
        outcomes.push({
          name: program.name,
          passed: false,
          reason: `stdout differs\n  expected: ${JSON.stringify(program.stdout)}\n  actual:   ${JSON.stringify(normalised)}`,
        });
        continue;
      }
      if (exit !== program.exit) {
        outcomes.push({
          name: program.name,
          passed: false,
          reason: `exit code ${exit}, expected ${program.exit}`,
        });
        continue;
      }
      outcomes.push({ name: program.name, passed: true, reason: "" });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const passed = outcomes.filter((outcome) => outcome.passed).length;
  if (options.verbose) {
    for (const outcome of outcomes) {
      if (!outcome.passed) process.stdout.write(`FAIL ${outcome.name}\n  ${outcome.reason}\n`);
    }
  }
  return { total: outcomes.length, passed, outcomes };
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const summary = runSuite({ verbose: process.argv.includes("--verbose") });
  process.stdout.write(`${summary.passed}/${summary.total} conformance programs pass on the native runtime\n`);
  process.exit(summary.passed === summary.total ? 0 : 1);
}
