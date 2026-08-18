/**
 * Benchmarks for the Baa front end and runtime.
 *
 *     node tools/bench.ts            # everything
 *     node tools/bench.ts lexer      # one group
 *
 * Reports the median of several runs rather than the mean, so one unlucky GC
 * pause does not dominate the number. These are not micro-benchmarks of
 * anything clever: they exist to catch a change that makes the pipeline
 * dramatically slower.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { checkFile } from "../src/api.ts";
import { SourceFile } from "../src/diagnostics/source.ts";
import { tokenize } from "../src/lexer/lexer.ts";
import { parse } from "../src/parser/parser.ts";
import { createCapturingHost } from "../src/runtime/host.ts";
import { Interpreter } from "../src/runtime/interpreter.ts";
import { resolveProgram } from "../src/semantic/resolver.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Benchmark = {
  readonly group: string;
  readonly name: string;
  readonly unit: string;
  readonly amount: number;
  readonly run: () => void;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function measure(benchmark: Benchmark, samples = 15): { ms: number; rate: number } {
  for (let i = 0; i < 3; i++) benchmark.run(); // warm up
  const timings: number[] = [];
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    benchmark.run();
    timings.push(performance.now() - started);
  }
  const ms = median(timings);
  return { ms, rate: benchmark.amount / (ms / 1000) };
}

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

const largeProgram = readFileSync(join(ROOT, "examples", "large_program.baa"), "utf8");

/** A synthetic file, repeated until it is big enough to time meaningfully. */
const synthetic = Array.from({ length: 400 }, (_, i) => {
  return `
// sheep number ${i}
fn handler_${i}(flock, weight = ${i}) {
    const total = flock.map(fn(s) { return s.weight + weight }).sum()
    if total > ${i * 10} {
        return "heavy: {total}"
    } else if total > ${i} {
        return "fine"
    }
    return match total {
        0 => "empty",
        _ => "light",
    }
}
`;
}).join("\n");

const fibProgram = `
fn fib(n) {
    if n < 2 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}
baa fib(22)
`;

const loopProgram = `
let total = 0
for i in 0..300000 {
    total += i % 7
}
baa total
`;

const collectionProgram = `
const numbers = []
for i in 0..20000 {
    numbers.push(i)
}
const squares = numbers.map(fn(n) { return n * n })
const evens = squares.filter(fn(n) { return n % 2 == 0 })
baa evens.sum()
`;

function runProgram(source: string, name: string): void {
  const file = new SourceFile(name, source);
  const checked = checkFile(file);
  if (!checked.ok) throw new Error(`${name} failed to compile`);
  const interpreter = new Interpreter({ host: createCapturingHost() });
  interpreter.run(checked.program, file);
}

const syntheticFile = new SourceFile("synthetic.baa", synthetic);
const largeFile = new SourceFile("large_program.baa", largeProgram);
const syntheticParsed = parse(syntheticFile);

const BENCHMARKS: Benchmark[] = [
  {
    group: "lexer",
    name: "synthetic.baa",
    unit: "KB/s",
    amount: synthetic.length / 1024,
    run: () => void tokenize(syntheticFile),
  },
  {
    group: "lexer",
    name: "large_program.baa",
    unit: "KB/s",
    amount: largeProgram.length / 1024,
    run: () => void tokenize(largeFile),
  },
  {
    group: "parser",
    name: "synthetic.baa",
    unit: "KB/s",
    amount: synthetic.length / 1024,
    run: () => void parse(syntheticFile),
  },
  {
    group: "resolver",
    name: "synthetic.baa",
    unit: "KB/s",
    amount: synthetic.length / 1024,
    run: () => void resolveProgram(syntheticParsed.program, syntheticFile),
  },
  {
    group: "runtime",
    name: "fib(22)",
    unit: "calls/s",
    amount: 57314,
    run: () => runProgram(fibProgram, "fib.baa"),
  },
  {
    group: "runtime",
    name: "300k loop iterations",
    unit: "iterations/s",
    amount: 300000,
    run: () => runProgram(loopProgram, "loop.baa"),
  },
  {
    group: "runtime",
    name: "20k map/filter/sum",
    unit: "items/s",
    amount: 60000,
    run: () => runProgram(collectionProgram, "collections.baa"),
  },
  {
    group: "pipeline",
    name: "large_program.baa end to end",
    unit: "runs/s",
    amount: 1,
    run: () => runProgram(largeProgram, "large_program.baa"),
  },
];

// --------------------------------------------------------------------------

const filter = process.argv[2];
const selected = filter === undefined
  ? BENCHMARKS
  : BENCHMARKS.filter((b) => b.group === filter || b.name.includes(filter));

if (selected.length === 0) {
  process.stderr.write(`No benchmarks match \`${filter}\`.\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`Baa benchmarks: node ${process.versions.node} on ${process.platform}\n\n`);
  let currentGroup = "";
  for (const benchmark of selected) {
    if (benchmark.group !== currentGroup) {
      currentGroup = benchmark.group;
      process.stdout.write(`${currentGroup}\n`);
    }
    const { ms, rate } = measure(benchmark);
    const rateText =
      rate >= 1000 ? `${Math.round(rate).toLocaleString("en-GB")}` : rate.toFixed(1);
    process.stdout.write(
      `  ${benchmark.name.padEnd(32)} ${ms.toFixed(2).padStart(8)} ms   ${rateText.padStart(12)} ${benchmark.unit}\n`,
    );
  }
  process.stdout.write("\nMedian of 15 runs after 3 warm-up runs.\n");
}
