/**
 * Measures the native runtime against the reference implementation.
 *
 * Both run the same programs. The point is not to declare a winner — one is a
 * tree-walking interpreter on Node and the other is a tree-walking interpreter
 * in Rust, so nobody should be surprised by the result — it is to have numbers
 * before writing a sentence about speed.
 *
 *     node tools/bench-native.ts
 *     node tools/bench-native.ts --runs 20
 *
 * Startup is measured as a whole process, because that is what a person waits
 * for when they double-click an application.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { bundle } from "../src/native/bundle.ts";
import { hostPath } from "./native-conformance.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

const RUNS = Number(
  process.argv.find((argument) => argument.startsWith("--runs="))?.slice(7) ??
    (process.argv.includes("--runs") ? process.argv[process.argv.indexOf("--runs") + 1] : "") ??
    "10",
) || 10;

const PROGRAMS: ReadonlyArray<{ name: string; source: string }> = [
  {
    name: "start up and print one line",
    source: 'baa "ready"\n',
  },
  {
    name: "one million loop iterations",
    source: "let total = 0\nfor i in 0..1000000 {\n    total += i\n}\nbaa total\n",
  },
  {
    name: "two hundred thousand function calls",
    source:
      "fn add(a, b) {\n    return a + b\n}\n\nlet total = 0\nfor i in 0..200000 {\n    total = add(total, i)\n}\nbaa total\n",
  },
  {
    name: "build and sort fifty thousand items",
    source:
      "import flock\n\nconst items = flock.range(0, 50000).map(fn(n) { return { key: (n * 7919) % 50000 } })\nbaa flock.sort_by(items, fn(item) { return item.key })[0].key\n",
  },
  {
    name: "encode and decode a megabyte of JSON",
    source:
      'import lamb\nimport flock\n\nconst rows = flock.range(0, 20000).map(fn(n) { return { id: n, name: "sheep " + n, ok: true } })\nconst text = lamb.encode(rows)\nbaa lamb.decode(text).length()\n',
  },
];

/** Median wall-clock milliseconds over `RUNS` runs, discarding the first. */
function time(run: () => void): number {
  run();
  const samples: number[] = [];
  for (let index = 0; index < RUNS; index++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function main(): void {
  const host = hostPath();
  if (host === null) {
    process.stderr.write(
      "The native runtime is not built.\n  cargo build --release --manifest-path rust/Cargo.toml\n",
    );
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), "baa-bench-"));
  const width = Math.max(...PROGRAMS.map((program) => program.name.length));

  process.stdout.write(`Median of ${RUNS} runs, in milliseconds. Lower is better.\n\n`);
  process.stdout.write(`${pad("", width)}   node    native   ratio\n`);

  try {
    for (const program of PROGRAMS) {
      const source = join(work, "program.baa");
      const image = join(work, "program.fleece");
      writeFileSync(source, program.source, "utf8");
      writeFileSync(image, bundle({ entry: source, root: work }).bytes);

      const node = time(() => {
        spawnSync(process.execPath, [CLI, "run", source], { stdio: "ignore" });
      });
      const native = time(() => {
        spawnSync(host, [image], { stdio: "ignore" });
      });

      const ratio = native === 0 ? "—" : `${(node / native).toFixed(1)}x`;
      process.stdout.write(
        `${pad(program.name, width)}  ${pad(node.toFixed(0), 6)}  ${pad(native.toFixed(0), 7)}  ${ratio}\n`,
      );
    }

    // Size is not a benchmark, but it is the other number people ask about.
    const runtime = statSync(host).size;
    const source = join(work, "app.baa");
    writeFileSync(source, 'baa "ready"\n', "utf8");
    const image = bundle({ entry: source, root: work }).bytes.length;
    process.stdout.write(
      `\nruntime ${(runtime / 1024).toFixed(0)} KB, ` +
        `image for a one-line program ${image} bytes\n`,
    );

    const started = performance.now();
    execFileSync(process.execPath, [CLI, "app", "build", "--out", join(work, "out")], {
      cwd: join(ROOT, "examples", "native", "calculator"),
      stdio: "ignore",
    });
    process.stdout.write(`building the calculator: ${(performance.now() - started).toFixed(0)} ms\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
