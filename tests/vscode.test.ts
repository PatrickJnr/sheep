/**
 * The VS Code extension.
 *
 * None of this starts VS Code. The language server it talks to is tested for
 * real over stdio in `tests/lsp.test.ts`, which is where the protocol lives;
 * what is left is the manifest, and a manifest is exactly the kind of file
 * that goes quietly wrong. An `activationEvents` entry naming a language that
 * no longer exists, a `main` pointing at a file the build does not produce, or
 * a setting the code reads under a name the manifest never declares all
 * install cleanly and simply do nothing.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = join(ROOT, "editors", "vscode");

const manifest = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  main?: string;
  activationEvents?: string[];
  engines: Record<string, string>;
  dependencies?: Record<string, string>;
  contributes: {
    languages: Array<{ id: string; extensions: string[]; configuration?: string }>;
    grammars: Array<{ language: string; path: string }>;
    snippets: Array<{ language: string; path: string }>;
    configuration?: { properties: Record<string, unknown> };
  };
};

const source = readFileSync(join(EXT, "src", "extension.ts"), "utf8");

/**
 * The source with comments removed.
 *
 * The checks below look for constructs that must not appear, and the file
 * explains at length why it does not use them. Searching the prose finds the
 * explanation and calls it the offence.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("vscode extension: the manifest an editor reads", () => {
  it("has an entry point, and it is the one the compiler writes", () => {
    assert.ok(manifest.main, "the extension declares no `main`, so it starts nothing");

    const tsconfig = JSON.parse(readFileSync(join(EXT, "tsconfig.json"), "utf8")) as {
      compilerOptions: { outDir: string; rootDir: string };
    };
    const expected = `./${tsconfig.compilerOptions.outDir}/extension.js`;
    assert.equal(manifest.main, expected, "`main` and the compiler's `outDir` disagree");

    // The source must exist; the output only has to match when it has been
    // built, so a checkout that has never run `npm run compile` still passes.
    assert.ok(existsSync(join(EXT, "src", "extension.ts")), "the entry source is missing");
    const compiled = join(EXT, manifest.main);
    if (existsSync(join(EXT, tsconfig.compilerOptions.outDir))) {
      assert.ok(existsSync(compiled), "out/ exists but the entry point is not in it");
    }
  });

  it("activates on every language it claims to support", () => {
    const declared = manifest.contributes.languages.map((language) => language.id);
    for (const id of declared) {
      assert.ok(
        manifest.activationEvents?.includes(`onLanguage:${id}`),
        `nothing activates the extension for \`${id}\``,
      );
    }
    for (const event of manifest.activationEvents ?? []) {
      const id = event.startsWith("onLanguage:") ? event.slice("onLanguage:".length) : null;
      if (id !== null) {
        assert.ok(declared.includes(id), `activates on \`${id}\`, which it does not contribute`);
      }
    }
  });

  it("declares every setting the extension reads, and reads every one it declares", () => {
    // `getConfiguration("baa").get("server.path")` is the shape the source
    // uses, so a declared key is `baa.` plus what `get` is passed.
    const read = new Set(
      [...source.matchAll(/getConfiguration\("(\w+)"\)[\s\S]{0,40}?get<[^>]*>\("([\w.]+)"\)/g)].map(
        (match) => `${match[1]}.${match[2]}`,
      ),
    );
    const declared = new Set(Object.keys(manifest.contributes.configuration?.properties ?? {}));

    for (const key of read) {
      assert.ok(declared.has(key), `the code reads \`${key}\`, which the manifest never declares`);
    }
    // `baa.trace.server` is read by vscode-languageclient rather than by this
    // file, and is the conventional name it looks for.
    for (const key of declared) {
      assert.ok(
        read.has(key) || key.endsWith(".trace.server"),
        `the manifest declares \`${key}\`, which nothing reads`,
      );
    }
  });

  it("points every contribution at a file that exists", () => {
    const paths = [
      ...manifest.contributes.languages.flatMap((language) =>
        language.configuration === undefined ? [] : [language.configuration],
      ),
      ...manifest.contributes.grammars.map((grammar) => grammar.path),
      ...manifest.contributes.snippets.map((snippet) => snippet.path),
    ];
    for (const path of paths) {
      assert.ok(existsSync(join(EXT, path)), `${path} is contributed but does not exist`);
    }
  });

  it("is versioned with the language it supports", () => {
    // The extension ships the client for one version of the server. Letting
    // the two numbers drift apart makes "which extension do I need" a question
    // nobody can answer from the marketplace page.
    const project = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(manifest.version, project.version);
  });

  it("takes one dependency, and it is the protocol client", () => {
    // Baa's runtime has no dependencies and this file is not the runtime, but
    // an extension that quietly grows a tree of packages is still a supply
    // chain nobody asked for. The client is here because a hand-written one
    // would have to convert positions, and getting that wrong edits the wrong
    // characters in somebody's file.
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["vscode-languageclient"]);
  });
});

describe("vscode extension: what it does with the server", () => {
  it("starts `baa lsp` over stdio, and never through a shell", () => {
    assert.match(code, /args:\s*\["lsp"\]/, "the extension must run `baa lsp`");
    assert.match(code, /TransportKind\.stdio/);
    // A configured path reaching a shell is a configured path that can carry
    // arguments with it. Windows makes this the interesting case: `npm install
    // -g` writes `baa.cmd`, which Node will not spawn without one.
    assert.match(code, /shell:\s*false/);
    assert.doesNotMatch(code, /\bexec\(|execSync\(|shell:\s*true/);
  });

  it("says what to do when the server is missing rather than failing silently", () => {
    assert.match(source, /npm install -g baa-lang/);
    assert.match(source, /baa\.server\.path/);
  });

  it("implements no language intelligence of its own", () => {
    // Every feature comes from the server, which runs the same analysis as
    // `baa check`. A provider registered here would be a second opinion.
    for (const provider of [
      "registerHoverProvider",
      "registerDefinitionProvider",
      "registerReferenceProvider",
      "registerRenameProvider",
      "registerDocumentSymbolProvider",
      "registerDocumentFormattingEditProvider",
      "createDiagnosticCollection",
    ]) {
      assert.doesNotMatch(code, new RegExp(provider), `${provider} duplicates the server`);
    }
  });
});
