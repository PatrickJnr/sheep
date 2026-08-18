/**
 * `llms.txt` and `llms-full.txt`.
 *
 * These exist to be read by a language model writing Baa, which makes them the
 * documents least likely to be re-read by a person and most damaging when
 * wrong: a model given a stale signature writes code that does not run, and
 * has no way to notice.
 *
 * So the examples in them are compiled, the links are checked against the
 * pages that exist, and the counts are checked against the implementation.
 * They are generated, and `--check` fails when they are stale.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ALL_CODES } from "../src/diagnostics/codes.ts";
import { NATIVE_MODULES } from "../src/native/bundle.ts";
import { STDLIB_MODULES } from "../src/stdlib/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INDEX = join(ROOT, "website", "llms.txt");
const FULL = join(ROOT, "website", "llms-full.txt");

// Generated into `website/`, which is not in the repository. A checkout that
// has not built them cannot test them, and says so rather than failing.
const present = existsSync(INDEX) && existsSync(FULL);
const needsFiles = {
  skip: present ? false : "website/llms.txt not built here (npm run gen:llms)",
};

describe("llms.txt", needsFiles, () => {
  const index = present ? readFileSync(INDEX, "utf8") : "";
  const full = present ? readFileSync(FULL, "utf8") : "";

  it("follows the convention: a title, a summary, then links", () => {
    const lines = index.split("\n");
    assert.match(lines[0]!, /^# /, "must open with an H1");
    assert.ok(
      lines.slice(0, 4).some((line) => line.startsWith("> ")),
      "must carry a blockquote summary",
    );
  });

  it("says which import decides which target, in both files", () => {
    for (const [name, text] of [["llms.txt", index], ["llms-full.txt", full]] as const) {
      assert.match(text, /\bgate\b/, `${name} does not mention gate`);
      assert.match(text, /\bbarn\b/, `${name} does not mention barn`);
    }
  });

  it("states the real number of diagnostics", () => {
    assert.match(index, new RegExp(`all ${ALL_CODES.length} BAAnnn codes`));
  });

  it("lists every standard module, and says where each one runs", () => {
    for (const name of STDLIB_MODULES) {
      const row = new RegExp(`^\\| \`${name}\` \\|.*\\|.*\\|.*\\|$`, "m");
      const match = row.exec(full);
      assert.ok(match, `llms-full.txt has no row for \`${name}\``);

      const columns = match[0].split("|").map((cell) => cell.trim());
      const native = columns[4];
      assert.equal(
        native,
        NATIVE_MODULES.includes(name) ? "yes" : "no",
        `\`${name}\` is described as ${native === "yes" ? "available" : "unavailable"} natively, which is wrong`,
      );
    }
  });

  it("links only to pages the site actually builds", () => {
    const docs = join(ROOT, "website", "docs");
    if (!existsSync(docs)) return; // the site itself has not been built here
    for (const match of index.matchAll(/\]\(https:\/\/sheep\.grimtech\.co\.uk\/([^)]+)\)/g)) {
      const path = match[1] ?? "";
      if (!path.startsWith("docs/")) continue;
      assert.ok(
        existsSync(join(ROOT, "website", path)),
        `llms.txt links to /${path}, which the site does not build`,
      );
    }
  });
});

describe("llms-full.txt: the examples compile", needsFiles, () => {
  const full = present ? readFileSync(FULL, "utf8") : "";
  const work = mkdtempSync(join(tmpdir(), "baa-llms-"));

  // The test example imports a module beside it; give it one so the example
  // is checked as written rather than trimmed to suit the test.
  writeFileSync(join(work, "basket.baa"), "export fn total(items) {\n    return 0\n}\n", "utf8");

  const blocks = [...full.matchAll(/```baa\n([\s\S]*?)```/g)].map((match) => match[1]!);

  it("has examples to check", () => {
    assert.ok(blocks.length >= 4, `expected several examples, found ${blocks.length}`);
  });

  // Every snippet a model might copy has to be a program the analyser accepts.
  // A reference that teaches code which does not compile is worse than none.
  blocks.forEach((block, index) => {
    it(`example ${index + 1} passes \`baa check\``, () => {
      const file = join(work, `example${index}.baa`);
      writeFileSync(file, block, "utf8");
      try {
        execFileSync(process.execPath, [join(ROOT, "src", "cli", "index.ts"), "check", file], {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        assert.fail(
          `example ${index + 1} does not compile:\n${(failure.stdout ?? "") + (failure.stderr ?? "")}`,
        );
      }
    });
  });

  after(() => rmSync(work, { recursive: true, force: true }));
});

describe("llms: the generator is deterministic", needsFiles, () => {
  it("is not stale", () => {
    try {
      execFileSync(process.execPath, [join(ROOT, "tools", "gen-llms.ts"), "--check"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      assert.fail(
        `the generated files do not match the implementation:\n${(failure.stderr ?? "") + (failure.stdout ?? "")}`,
      );
    }
  });
});
