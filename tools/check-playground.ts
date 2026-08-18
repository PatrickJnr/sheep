/// <reference lib="dom" />
/**
 * Drive the playground in a real browser and check that it works.
 *
 * The `dom` lib reference above is for the callbacks handed to
 * `page.evaluate`: they are compiled here but executed in the browser, so they
 * need `document` and friends. Nothing else in this repository targets the
 * DOM.
 *
 *     node tools/check-playground.ts
 *     BAA_BROWSER="/path/to/chrome" node tools/check-playground.ts
 *
 * The playground is the one part of this repository that only runs in a
 * browser: module workers, `structuredClone` over `postMessage`, the clipboard,
 * the URL fragment. Everything else is covered by the Node test suite, so this
 * exists to cover the rest: with the actual engine, not a simulation.
 *
 * It uses `puppeteer-core` against a browser you already have installed rather
 * than downloading one. If no browser is found it says so and exits 0, so the
 * check never fails a machine that simply has nothing to drive.
 */

import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";


import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;

const CANDIDATES = [
  process.env.BAA_BROWSER,
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter((path): path is string => typeof path === "string" && path.length > 0);

function findBrowser(): string | null {
  return CANDIDATES.find((path) => existsSync(path)) ?? null;
}

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `, ${detail}` : ""}\n`);
}

async function outputText(page: Page): Promise<string> {
  return page.$eval("[data-output]", (element) => element.textContent ?? "");
}

async function statusText(page: Page): Promise<string> {
  return page.$eval("[data-status]", (element) => element.textContent ?? "");
}

/** Wait until the status line stops saying it is busy. */
async function settle(page: Page, timeout = 20000): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = document.querySelector("[data-status]")?.textContent ?? "";
      return !/Running|Formatting|Starting|Loading/.test(status);
    },
    { timeout, polling: 100 },
  );
}

async function main(): Promise<void> {
  // The website is built and deployed separately and is not part of the public
  // repository, so there is nothing to drive in a checkout without it.
  if (!existsSync(fileURLToPath(new URL("../website/playground.html", import.meta.url)))) {
    process.stdout.write("No website/ in this checkout; nothing to drive.\n");
    return;
  }

  const executablePath = findBrowser();
  if (executablePath === null) {
    process.stdout.write(
      "No Chrome or Edge found. Set BAA_BROWSER to a browser executable to run this check.\n",
    );
    return;
  }
  process.stdout.write(`Driving ${executablePath}\n`);

  // Start the static server in this process.
  process.env.PORT = String(PORT);
  process.argv[2] = String(PORT);
  await import(new URL("./serve.ts", import.meta.url).href);
  await new Promise((resolve) => setTimeout(resolve, 300));

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error: unknown) =>
      pageErrors.push(error instanceof Error ? error.message : String(error)),
    );
    page.on("requestfailed", (request) =>
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`),
    );

    // ------------------------------------------------------------ homepage
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 20000 });
    const title = await page.title();
    record("homepage loads", title.includes("Baa"), title);

    const highlighted = await page.$$eval("code.language-baa[data-highlighted]", (n) => n.length);
    record("homepage highlights Baa code", highlighted > 0, `${highlighted} blocks`);

    const tabWorks = await page.evaluate(() => {
      const tab = document.querySelector<HTMLButtonElement>("#tab-match");
      tab?.click();
      return document.querySelector("#panel-match")?.hasAttribute("hidden") === false;
    });
    record("homepage tabs switch", tabWorks);

    // The card's link wraps only its title, and a stretched ::after covers the
    // rest. If that pseudo-element ever stops covering it, the card still looks
    // clickable and silently is not, which no markup check would notice.
    // elementFromPoint is viewport-relative and returns null off-screen, and
    // the site scrolls smoothly, so the scroll has to finish before measuring.
    await page.evaluate(() =>
      document.querySelector(".card--link")?.scrollIntoView({ block: "center", behavior: "instant" }),
    );
    const cardHit = await page.evaluate(() => {
      const card = document.querySelector(".card--link");
      const paragraph = card?.querySelector("p");
      const link = card?.querySelector<HTMLAnchorElement>("h3 a");
      if (!card || !paragraph || !link) return { ok: false, why: "no linked card found" };
      const box = paragraph.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        ok: hit === link || link.contains(hit),
        why: `${hit?.tagName ?? "nothing"} is over the card body`,
      };
    });
    record("a card is clickable away from its title", cardHit.ok, cardHit.why);

    const themeWorks = await page.evaluate(() => {
      const before = document.documentElement.getAttribute("data-theme");
      document.querySelector<HTMLButtonElement>("[data-theme-toggle]")?.click();
      const after = document.documentElement.getAttribute("data-theme");
      return before !== after && (after === "dark" || after === "light");
    });
    record("theme toggle switches and persists", themeWorks);

    // ------------------------------------------------------------ docs page
    await page.goto(`${BASE}/docs/language.html`, { waitUntil: "networkidle0" });
    const searchResults = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>("[data-search]");
      if (input === null) return -1;
      input.focus();
      input.value = "closure";
      input.dispatchEvent(new Event("input"));
      await new Promise((resolve) => setTimeout(resolve, 600));
      return document.querySelectorAll("[data-search-results] li").length;
    });
    record("documentation search returns results", searchResults > 0, `${searchResults} hits`);

    // ----------------------------------------------------------- playground
    await page.goto(`${BASE}/playground.html`, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () => (document.querySelector("[data-status]")?.textContent ?? "").includes("Ready"),
      { timeout: 20000, polling: 100 },
    );
    record("worker starts and reports ready", true, await statusText(page));

    // Run the default program.
    await page.click("[data-run]");
    await settle(page);
    const helloOut = await outputText(page);
    record(
      "runs the default program",
      helloOut.includes("Baa, Dolly!") && helloOut.includes("3 sheep accounted for"),
      helloOut.split("\n")[0] ?? "",
    );
    record("reports a finish time", (await statusText(page)).startsWith("Finished"));

    // Every sample button.
    for (const sample of ["collections", "match", "errors", "closures"]) {
      await page.click(`[data-sample="${sample}"]`);
      await settle(page);
      const text = await outputText(page);
      const status = await statusText(page);
      record(
        `sample "${sample}" runs cleanly`,
        status.startsWith("Finished") && text.trim().length > 0 && !text.includes("error["),
        text.split("\n")[0] ?? "",
      );
    }

    // A program with a diagnostic. `flock` exists, so a suggestion is expected.
    await page.$eval(
      "[data-editor]",
      (element) => {
        (element as HTMLTextAreaElement).value =
          'const flock = ["Dolly"]\nbaa "before"\nbaa flok';
      },
    );
    await page.click("[data-run]");
    await settle(page);
    const errorOut = await outputText(page);
    record(
      "renders a diagnostic with span and suggestion",
      errorOut.includes("BAA102") &&
        errorOut.includes("^^^^") &&
        errorOut.includes("Did you mean"),
      errorOut.split("\n")[0] ?? "",
    );
    record("keeps output printed before the failure", errorOut.includes("before"));

    // Professional mode.
    await page.click("[data-woolly]");
    await page.click("[data-run]");
    await settle(page);
    const plainOut = await outputText(page);
    record(
      "the sheep-wording switch changes wording, not the code",
      plainOut.includes("BAA102") && plainOut.includes("Undefined name"),
      plainOut.split("\n").find((line) => line.includes("BAA102")) ?? "",
    );
    await page.click("[data-woolly]");

    // Formatting.
    await page.$eval("[data-editor]", (element) => {
      (element as HTMLTextAreaElement).value = "fn f(){return 1+2}";
    });
    await page.click("[data-format]");
    await settle(page);
    const formatted = await page.$eval(
      "[data-editor]",
      (element) => (element as HTMLTextAreaElement).value,
    );
    record(
      "formats the editor contents",
      formatted === "fn f() {\n    return 1 + 2\n}\n",
      JSON.stringify(formatted),
    );

    // Standard library that needs an operating system.
    await page.$eval("[data-editor]", (element) => {
      (element as HTMLTextAreaElement).value = 'import pasture\nbaa pasture.read("/etc/passwd")';
    });
    await page.click("[data-run]");
    await settle(page);
    const fsOut = await outputText(page);
    record(
      "filesystem access fails with a Baa diagnostic, not a crash",
      fsOut.includes("BAA404"),
      fsOut.split("\n")[0] ?? "",
    );

    // An endless loop must be stopped, and the playground must recover.
    await page.$eval("[data-editor]", (element) => {
      (element as HTMLTextAreaElement).value = "let n = 0\nwhile true {\n  n += 1\n}";
    });
    const startedAt = Date.now();
    await page.click("[data-run]");
    await page.waitForFunction(
      () => (document.querySelector("[data-status]")?.textContent ?? "").includes("Timed out"),
      { timeout: 20000, polling: 100 },
    );
    const elapsed = Date.now() - startedAt;
    record("an endless loop is stopped", elapsed < 15000, `${(elapsed / 1000).toFixed(1)}s`);

    await page.$eval("[data-editor]", (element) => {
      (element as HTMLTextAreaElement).value = 'baa "recovered"';
    });
    await page.click("[data-run]");
    await settle(page);
    record("the playground recovers after a timeout", (await outputText(page)).includes("recovered"));

    // Keyboard shortcut.
    await page.focus("[data-editor]");
    await page.$eval("[data-editor]", (element) => {
      (element as HTMLTextAreaElement).value = 'baa "via keyboard"';
    });
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await settle(page);
    record("Ctrl+Enter runs the program", (await outputText(page)).includes("via keyboard"));

    // ---------------------------------------------------------- diagnostics
    record(
      "no uncaught page errors",
      pageErrors.length === 0,
      pageErrors.slice(0, 2).join(" | "),
    );
    record(
      "no console errors",
      consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(" | "),
    );
    record(
      "no failed requests",
      failedRequests.length === 0,
      failedRequests.slice(0, 2).join(" | "),
    );

    // -------------------------------------------------------- responsiveness
    for (const [label, width, height] of [
      ["mobile", 390, 844],
      ["tablet", 820, 1180],
      ["desktop", 1440, 900],
    ] as Array<[string, number, number]>) {
      await page.setViewport({ width, height });
      await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      record(`no horizontal overflow at ${label} (${width}px)`, overflow <= 1, `${overflow}px`);
    }
  } finally {
    await browser?.close();
  }
}

await main();

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} checks passed.\n`,
);
if (failed.length > 0) process.exitCode = 1;
process.exit(failed.length > 0 ? 1 : 0);
