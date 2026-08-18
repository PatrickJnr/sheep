/**
 * Downloads a VS Code build and runs the extension inside it.
 *
 *     npm run test:vscode        (from editors/vscode)
 *
 * Kept out of `npm run ci`: it fetches an editor on first run and needs a
 * display, which is not something the ordinary test suite should assume. CI
 * runs it as its own job.
 */

const { join } = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = join(__dirname, "..");
  const extensionTestsPath = join(__dirname, "suite", "index.js");

  // `Code.exe` is Electron, and Electron with ELECTRON_RUN_AS_NODE set is just
  // Node. Inherit that from the surrounding shell — several editors and agent
  // harnesses export it — and VS Code never starts: it reads its own flags as
  // Node's and answers `bad option: --extensionDevelopmentPath`, which reads
  // like a harness bug and is not one.
  delete process.env["ELECTRON_RUN_AS_NODE"];

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // Pinned. VS Code 1.133's launcher rejects the flags the harness passes it
    // ("bad option: --extensionDevelopmentPath"), so an unpinned run fails on
    // whatever ships that week rather than on anything in this repository.
    // Raise it deliberately, after checking a run still passes.
    version: process.env.BAA_VSCODE_VERSION ?? "1.96.2",
    // A clean profile: the point is what a new install does, and an extension
    // already present in the developer's own VS Code would answer a different
    // question.
    launchArgs: ["--disable-extensions"],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
