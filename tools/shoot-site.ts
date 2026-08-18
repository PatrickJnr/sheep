/// <reference lib="dom" />
/**
 * Screenshot a running `baa serve` site, as evidence that it renders.
 *
 * `curl` proves bytes came back. It does not prove a browser draws a page from
 * them, that the form posts, or that an escaped value stays escaped once the
 * HTML parser has had it. This drives a real browser and writes PNGs.
 *
 *     node tools/serve-site.ts &                   # or: baa serve examples/site
 *     node tools/shoot-site.ts http://127.0.0.1:8080 out/
 *
 * Skips with a message when no browser is installed, like the other checks.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const args = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const BASE = args[0] ?? "http://127.0.0.1:8080";
const OUT = args[1] ?? "shots";

/**
 * With `--publish`, also write the two images the example's README shows,
 * cropped to the content rather than the viewport. Generated rather than taken
 * by hand so they cannot quietly stop matching the pages they document.
 */
const PUBLISH = process.argv.includes("--publish");

const CANDIDATES = [
  process.env.BAA_BROWSER,
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path.length > 0);

const executablePath = CANDIDATES.find((path) => existsSync(path));
if (executablePath === undefined) {
  process.stdout.write("No Chrome or Edge found. Set BAA_BROWSER to take screenshots.\n");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox"],
});

const failures: string[] = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 720, deviceScaleFactor: 2 });

  const consoleErrors: string[] = [];
  page.on("pageerror", (error: unknown) =>
    consoleErrors.push(error instanceof Error ? error.message : String(error)),
  );

  const shoot = async (name: string, url: string, expect: RegExp): Promise<void> => {
    const response = await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    const text = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    const status = response?.status() ?? 0;
    const ok = expect.test(text);
    process.stdout.write(
      `${ok ? "  ok  " : "  FAIL"} ${name.padEnd(18)} ${status}  ${text.split("\n")[0] ?? ""}\n`,
    );
    if (!ok) failures.push(`${name}: expected ${expect}, page said ${JSON.stringify(text.slice(0, 80))}`);
  };

  await shoot("home", `${BASE}/`, /Baa, world!/);
  await shoot("greeting", `${BASE}/?name=Dolly`, /Baa, Dolly!/);
  await shoot("sheep", `${BASE}/sheep/Shaun`, /Mossy Bottom Farm/);
  await shoot("missing", `${BASE}/sheep/Nobody`, /No sheep called Nobody/);

  // The important one. If escaping failed, the browser parses a real <script>
  // element, which never appears as text and would run instead.
  await page.goto(`${BASE}/?name=%3Cscript%3Ewindow.PWNED%3D1%3C%2Fscript%3E`, {
    waitUntil: "networkidle0",
  });
  await page.screenshot({ path: join(OUT, "escaping.png") });
  const pwned = await page.evaluate(() => "PWNED" in window);
  const shown = await page.evaluate(() => document.body.innerText);
  const injected = await page.$$eval("h1 script", (nodes) => nodes.length);
  const escaped = !pwned && injected === 0 && shown.includes("<script>");
  process.stdout.write(
    `${escaped ? "  ok  " : "  FAIL"} escaping           script ran: ${pwned}, script elements: ${injected}\n`,
  );
  if (!escaped) failures.push("escaping: the injected script was not neutralised");

  // Fill the form in and submit it, the way a person would.
  await page.goto(`${BASE}/count`, { waitUntil: "networkidle0" });
  await page.$eval("input[name=n]", (element) => {
    (element as HTMLInputElement).value = "169";
  });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click("button"),
  ]);
  await page.screenshot({ path: join(OUT, "posted.png") });
  const posted = await page.evaluate(() => document.body.innerText);
  const postOk = /169 sheep/.test(posted) && /Square root: 13/.test(posted);
  process.stdout.write(`${postOk ? "  ok  " : "  FAIL"} form post         ${posted.split("\n")[0] ?? ""}\n`);
  if (!postOk) failures.push(`form post: ${JSON.stringify(posted.slice(0, 80))}`);

  if (consoleErrors.length > 0) failures.push(`page errors: ${consoleErrors.join(" | ")}`);

  if (PUBLISH) {
    // Relative to this tool, not to the output directory, which may be a
    // scratch folder anywhere on the disk.
    const published = fileURLToPath(new URL("../assets/images/", import.meta.url));
    mkdirSync(published, { recursive: true });

    /** Shoot just the content, so the image is not mostly empty page. */
    const crop = async (name: string, url: string): Promise<void> => {
      await page.goto(url, { waitUntil: "networkidle0" });
      const box = await page.$eval("main", (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const pad = 24;
      await page.screenshot({
        path: join(published, `${name}.png`),
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: box.width + pad * 2,
          height: box.height + pad * 2,
        },
      });
      process.stdout.write(`  published assets/images/${name}.png\n`);
    };

    await page.setViewport({ width: 780, height: 900, deviceScaleFactor: 2 });
    await crop("site-home", `${BASE}/?name=Dolly`);
    await crop("site-escaped", `${BASE}/?name=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
  }
} finally {
  await browser.close();
}

process.stdout.write(`\nScreenshots in ${OUT}/\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exit(1);
}
process.stdout.write("Every page rendered as expected.\n");
