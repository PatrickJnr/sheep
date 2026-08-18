/**
 * Checks that the test count the README states is true.
 *
 * The README says "620+ tests" and the home page prints that figure, taking it
 * from the README rather than keeping a copy. The page used to say 415 when
 * the suite ran 628, which is the kind of claim nobody re-reads.
 *
 *     node tools/check-test-count.ts
 *
 * # Why this needs a complete checkout
 *
 * Two suites skip themselves when what they test is absent, and both are
 * absent in a plain checkout:
 *
 *  - `tests/website.test.ts` needs `website/`, which is generated and
 *    gitignored. Twenty-five tests.
 *  - `tests/native.test.ts` needs the native runtime, which is compiled by
 *    cargo. Twelve tests.
 *
 * A skipped suite's tests are not reported at all, so "how many tests are
 * there" answers differently depending on what has been built. This generates
 * the site itself, and refuses to guess when the runtime is missing rather
 * than comparing a floor against a number it knows is short.
 *
 * It lives outside the test suite because verifying it means running the
 * suite, and a test that runs the suite runs itself.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { hostPath } from "./native-conformance.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const stated = /\*\*(\d+)\+ tests\*\*/.exec(readme);
if (stated === null) {
  fail("README.md no longer states a test count as `**NNN+ tests**`.");
}
const floor = Number(stated[1]);

// Without the runtime, twelve tests do not run and the total is short by
// exactly that much. Reporting a shortfall that is really a missing build
// would be a false alarm, and a loud one.
if (hostPath() === null) {
  process.stdout.write(
    "skipped: the native runtime is not built, so twelve tests cannot run and\n" +
      "the total would be short.\n" +
      "  cargo build --release --manifest-path rust/Cargo.toml\n",
  );
  process.exit(0);
}

// `website/src` holds the home page and the other hand-written pages. It is
// gitignored, so a clone does not have it and the site cannot be built there at
// all: `tools/build-site.ts` prints "No website/src here; skipping" and exits
// 0, which is why its exit status alone does not tell you a site exists.
//
// Twenty-five tests need one. Where there is no source they are absent rather
// than broken, and the floor has to hold without them, because that is what a
// clone runs.
const hasSiteSources = existsSync(join(ROOT, "website", "src"));
if (hasSiteSources && !existsSync(join(ROOT, "website", "index.html"))) {
  process.stdout.write("building the site first, so its tests are not skipped\n");
  const built = spawnSync(process.execPath, ["tools/build-site.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (built.status !== 0) {
    fail(`could not build the site:\n${built.stderr ?? ""}`);
  }
}

const outcome = spawnSync(
  process.execPath,
  // The same glob `npm test` uses. Passing the directory instead makes Node
  // try to load it as a module, which fails in a way that looks like a broken
  // suite rather than a wrong argument.
  ["--test", "--test-reporter=tap", "tests/**/*.test.ts"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const summary = (label: string): number =>
  Number(
    outcome.stdout
      ?.split("\n")
      .find((line) => line.startsWith(`# ${label} `))
      ?.slice(`# ${label} `.length) ?? "-1",
  );

const passed = summary("pass");
const failed = summary("fail");

if (passed < 0 || failed < 0) {
  fail(`could not read a summary from the test runner:\n${outcome.stderr ?? ""}`);
}
if (failed > 0) {
  fail(`${failed} test(s) failed, so the count means nothing. Fix those first.`);
}
if (passed < floor) {
  fail(
    `README.md says ${floor}+ tests, but the suite runs ${passed}.\n` +
      (hasSiteSources
        ? "Lower the figure, or find out which tests stopped running."
        : "There is no `website/src` here, so 25 site tests did not run. The\n" +
          "figure still has to hold without them, because a clone does not have\n" +
          "them either."),
  );
}

// A floor far below the truth is not wrong, but it is a number nobody updated.
if (passed >= floor + 100) {
  process.stdout.write(`note: the suite runs ${passed} and README.md says ${floor}+. Worth raising.\n`);
}

process.stdout.write(
  `README.md says ${floor}+ tests; the suite runs ${passed}` +
    (hasSiteSources ? "\n" : " (no `website/src`, so 25 site tests were skipped)\n"),
);
