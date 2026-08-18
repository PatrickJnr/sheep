/**
 * Checks that the test count the README states is true.
 *
 * The README says "620+ tests" and the home page prints that figure, taking it
 * from the README rather than keeping a copy. The page used to say 415 when
 * the suite ran 628, which is the kind of claim nobody re-reads.
 *
 *     node tools/check-test-count.ts
 *
 * This lives outside the test suite on purpose: verifying it means running the
 * suite, and a test that runs the suite runs itself. CI calls it as a separate
 * step, after the tests have already passed.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const stated = /\*\*(\d+)\+ tests\*\*/.exec(readme);
if (stated === null) {
  process.stderr.write("README.md no longer states a test count as `**NNN+ tests**`.\n");
  process.exit(1);
}
const floor = Number(stated[1]);

// The same glob `npm test` uses. Passing the directory instead makes Node try
// to load it as a module, which fails in a way that looks like a broken suite.
const outcome = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", "tests/**/*.test.ts"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: false },
);

const passed = Number(
  outcome.stdout
    ?.split("\n")
    .find((line) => line.startsWith("# pass "))
    ?.slice("# pass ".length) ?? "0",
);

if (passed === 0) {
  process.stderr.write("could not read a pass count from the test runner\n");
  process.exit(1);
}

if (passed < floor) {
  process.stderr.write(
    `README.md says ${floor}+ tests, but the suite runs ${passed}.\n` +
      "Lower the figure, or find out which tests stopped running.\n",
  );
  process.exit(1);
}

// A floor far below the truth is not wrong, but it is a number nobody updated.
// Saying so is cheaper than discovering it two releases later.
if (passed >= floor + 100) {
  process.stdout.write(
    `note: the suite runs ${passed} tests and README.md says ${floor}+. Worth raising.\n`,
  );
}

process.stdout.write(`README.md says ${floor}+ tests; the suite runs ${passed}\n`);
