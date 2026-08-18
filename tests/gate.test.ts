/**
 * `gate` and `baa serve`.
 *
 * `gate` is tested by running programs against a host with a made-up CGI
 * environment, which is exactly what a web server supplies. `baa serve` is
 * tested by starting it and making real requests, because the thing worth
 * checking is that a page written for Apache works unchanged.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../src/api.ts";
import { createCapturingHost } from "../src/runtime/host.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "cli", "index.ts");

/** Run a program with a CGI environment, returning everything it wrote. */
function serve(source: string, env: Record<string, string> = {}): string {
  const host = createCapturingHost();
  // `envVar` reads the real environment by default; a request has its own.
  const request: Record<string, string> = { REQUEST_METHOD: "GET", ...env };
  const patched = {
    ...host,
    envVar: (name: string) => request[name] ?? null,
    envVars: () => request,
  };
  const result = run(source, "page.baa", { host: patched });
  assert.ok(
    result.ok,
    `page failed: ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")}`,
  );
  return result.output;
}

/** Everything after the header block. */
function body(raw: string): string {
  const at = raw.indexOf("\r\n\r\n");
  return at === -1 ? raw : raw.slice(at + 4);
}

describe("gate: reading the request", () => {
  it("reads the method, defaulting to GET", () => {
    assert.match(body(serve("import gate\ngate.text(gate.method())", {})), /GET/);
    assert.match(
      body(serve("import gate\ngate.text(gate.method())", { REQUEST_METHOD: "post" })),
      /POST/,
    );
  });

  it("parses the query string, decoding as it goes", () => {
    const out = body(
      serve('import gate\ngate.text(gate.query().get("name"))', {
        QUERY_STRING: "name=Shaun+the+Sheep&n=1",
      }),
    );
    assert.equal(out, "Shaun the Sheep");
  });

  it("keeps a key that has no value, so `?debug` is visible", () => {
    const out = body(
      serve('import gate\ngate.text(gate.query().has("debug"))', { QUERY_STRING: "debug" }),
    );
    assert.equal(out, "true");
  });

  // A request is not the program's fault. A page that dies on `%zz` is one an
  // attacker can take down with a single URL.
  it("keeps malformed percent-encoding as raw text rather than failing", () => {
    const out = body(
      serve('import gate\ngate.text(gate.query().get("x"))', { QUERY_STRING: "x=%zz" }),
    );
    assert.equal(out, "%zz");
  });

  it("reads a header by its ordinary name", () => {
    const out = body(
      serve('import gate\ngate.text(gate.header("User-Agent", "none"))', {
        HTTP_USER_AGENT: "baa/1",
      }),
    );
    assert.equal(out, "baa/1");
  });

  it("parses cookies", () => {
    const out = body(
      serve('import gate\ngate.text(gate.cookies().get("session"))', {
        HTTP_COOKIE: "session=abc123; theme=dark",
      }),
    );
    assert.equal(out, "abc123");
  });

  it("reports the path below the script", () => {
    assert.equal(body(serve("import gate\ngate.text(gate.path())", { PATH_INFO: "/Shaun" })), "/Shaun");
    assert.equal(body(serve("import gate\ngate.text(gate.path())", {})), "/");
  });
});

describe("gate: writing the reply", () => {
  it("sends a status line and a default content type", () => {
    const raw = serve('import gate\ngate.html("<p>hi</p>")');
    assert.match(raw, /^Status: 200 OK\r\n/);
    assert.match(raw, /content-type: text\/html; charset=utf-8/);
    assert.equal(body(raw), "<p>hi</p>");
  });

  it("uses the status and headers set before the reply starts", () => {
    const raw = serve(
      'import gate\ngate.status(404)\ngate.set_header("X-Sheep", "one")\ngate.html("gone")',
    );
    assert.match(raw, /^Status: 404 Not Found\r\n/);
    assert.match(raw, /x-sheep: one/);
  });

  it("refuses to change the status once the reply has started", () => {
    const result = run('import gate\ngate.html("hi")\ngate.status(500)', "page.baa", {
      host: createCapturingHost(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "BAA301");
  });

  // A newline in a header value would let request data inject headers, or a
  // whole second response, out of what looks like an ordinary string.
  it("refuses a header carrying a line break", () => {
    for (const source of [
      'import gate\ngate.set_header("X-A", "one\\r\\nX-Evil: yes")\ngate.html("x")',
      'import gate\ngate.redirect("/ok\\r\\nX-Evil: yes")',
    ]) {
      const result = run(source, "page.baa", { host: createCapturingHost() });
      assert.equal(result.ok, false, source);
      assert.equal(result.diagnostics[0]?.code, "BAA311");
    }
  });

  it("redirects with a location and a 303 by default", () => {
    const raw = serve('import gate\ngate.redirect("/elsewhere")');
    assert.match(raw, /^Status: 303 See Other\r\n/);
    assert.match(raw, /location: \/elsewhere/);
  });

  it("encodes JSON by the same rules as lamb", () => {
    const raw = serve('import gate\ngate.json({ a: 1, b: [true, nil] })');
    assert.match(raw, /content-type: application\/json/);
    assert.equal(body(raw), '{"a":1,"b":[true,null]}');
  });
});

describe("gate: escaping", () => {
  const payload = '<script>alert("x")</script>';

  it("escapes every value it interpolates", () => {
    const out = body(serve(`import gate\ngate.fill("<h1>%s</h1>", ${JSON.stringify(payload)})`));
    assert.equal(out, "<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h1>");
  });

  it("escapes the quotes that would break out of an attribute", () => {
    const out = body(
      serve('import gate\ngate.fill("<img alt=\\"%s\\">", "\\" onerror=\\"boom")'),
    );
    assert.ok(!out.includes('onerror="'), out);
  });

  it("leaves gate.html alone, since that is markup the page built", () => {
    assert.equal(body(serve('import gate\ngate.html("<b>bold</b>")')), "<b>bold</b>");
  });

  it("fails when the template has more placeholders than values", () => {
    const result = run('import gate\ngate.fill("%s %s", "one")', "page.baa", {
      host: createCapturingHost(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "BAA301");
  });

  // Escaping cannot help here: there is nothing in `javascript:alert(1)` to
  // escape, and it still runs once it reaches an href.
  it("rejects a URL whose scheme is not safe to link to", () => {
    const out = body(
      serve(
        'import gate\nimport wool\nfor u in ["javascript:alert(1)", "JaVaScRiPt:x", "  javascript:x", "data:text/html,x", "vbscript:x"] {\n' +
          "  gate.text(wool.inspect(wool.safe_url(u)))\n}",
      ),
    );
    assert.equal(out, "nilnilnilnilnil");
  });

  it("keeps a URL that is relative or uses an ordinary scheme", () => {
    for (const url of ["/a/b", "https://example.com", "mailto:a@b.c", "tel:+441234"]) {
      const out = body(
        serve(`import wool\nimport gate\ngate.text(wool.safe_url(${JSON.stringify(url)}))`),
      );
      assert.equal(out, url);
    }
  });

  it("substitutes a fallback rather than nil in a page", () => {
    const out = body(
      serve('import gate\ngate.fill("<a href=\\"%s\\">x</a>", gate.safe_url("javascript:alert(1)"))'),
    );
    assert.equal(out, '<a href="#">x</a>');
  });
});

describe("baa serve", () => {
  let dir = "";
  let server: ChildProcess | undefined;
  let base = "";

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "baa-serve-"));
    writeFileSync(
      join(dir, "index.baa"),
      'import gate\ngate.fill("<h1>Baa, %s!</h1>", gate.query().get("name", "world"))\n',
    );
    writeFileSync(
      join(dir, "echo.baa"),
      'import gate\ngate.json({ method: gate.method(), path: gate.path(), n: gate.form().get("n", "") })\n',
    );
    writeFileSync(join(dir, "style.css"), "body{color:red}\n");

    // Port 0 would be ideal, but the port has to be known to make requests, so
    // a high fixed one is used and the wait below covers a slow start.
    const port = 8234;
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [CLI, "serve", dir, "--port", String(port)], {
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await fetch(`${base}/`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("the server never started");
  });

  after(() => {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs index.baa for the root", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<h1>Baa, world!<\/h1>/);
  });

  it("passes the query string through", async () => {
    const response = await fetch(`${base}/?name=Dolly`);
    assert.match(await response.text(), /<h1>Baa, Dolly!<\/h1>/);
  });

  it("serves a static file beside the pages", async () => {
    const response = await fetch(`${base}/style.css`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/css/);
  });

  it("gives a page the rest of the path", async () => {
    const response = await fetch(`${base}/echo/deep/path`);
    const data = (await response.json()) as { path: string };
    assert.equal(data.path, "/deep/path");
  });

  it("delivers a posted form", async () => {
    const response = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "n=42",
    });
    const data = (await response.json()) as { method: string; n: string };
    assert.equal(data.method, "POST");
    assert.equal(data.n, "42");
  });

  it("uses the status the page asked for", async () => {
    writeFileSync(join(dir, "gone.baa"), 'import gate\ngate.status(404)\ngate.html("gone")\n');
    const response = await fetch(`${base}/gone`);
    assert.equal(response.status, 404);
  });

  it("answers 404 for a path with no page", async () => {
    assert.equal((await fetch(`${base}/nothing-here`)).status, 404);
  });

  // The served directory is a boundary, not a suggestion.
  it("refuses to serve anything outside the directory", async () => {
    for (const path of ["/../../package.json", "/..%2f..%2fpackage.json", "/./../../src/api.ts"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(await response.text(), /baa-lang|Interpreter/);
    }
  });

  it("reports a failing page as a 500 rather than a blank reply", async () => {
    writeFileSync(join(dir, "broken.baa"), "import gate\nbaa undefined_name\n");
    const response = await fetch(`${base}/broken`);
    assert.equal(response.status, 500);
    assert.match(await response.text(), /BAA102/);
  });
});
