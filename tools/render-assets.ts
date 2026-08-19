/// <reference lib="dom" />
/**
 * Render the brand SVGs to PNG.
 *
 *     node tools/render-assets.ts
 *     node tools/render-assets.ts --check    exit 1 if a PNG is missing
 *
 * The website uses the SVGs. The README uses these PNGs instead, for two
 * reasons that only apply to GitHub:
 *
 *  - GitHub serves README images through its camo proxy, which is fussier
 *    about SVG than a browser loading the file directly.
 *  - The wordmark is live `<text>`, so an SVG renders with whatever serif the
 *    *viewer* happens to have installed. A PNG bakes the intended typeface in.
 *
 * Rendered at 2x through a real browser, so the output matches the site
 * exactly. Skips with a message when no browser is available, which keeps it
 * from failing a machine that simply has nothing to render with.
 *
 * Chrome's PNG encoder is not byte-for-byte reproducible, so re-running this
 * can leave a changed file in `assets/images/` even when the artwork is
 * identical. If the only thing a run produced is a few kilobytes of different
 * compression, discard it: `git checkout -- assets/images`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Where the SVG sources live, alongside the rest of the site. */
const ASSETS = join(ROOT, "website", "assets");

/**
 * Where the rendered PNGs are committed. The website's build output is not in
 * the repository, but the README needs its images to resolve from a plain
 * clone, so the PNGs live here as well as under `website/assets`.
 */
const PUBLISHED = join(ROOT, "assets", "images");

/**
 * Rendering needs the SVG sources; checking does not, because the PNGs are
 * committed. So a checkout without the website can still verify its images.
 */
const HAS_SITE = existsSync(ASSETS);

/** Each SVG, the box it is drawn in, and the PNG it produces. */
const TARGETS = [
  { svg: "social.svg", png: "social.png", width: 1200, height: 630 },
  { svg: "social-dark.svg", png: "social-dark.png", width: 1200, height: 630 },
  { svg: "logo.svg", png: "logo.png", width: 208, height: 64 },
  { svg: "logo-dark.svg", png: "logo-dark.png", width: 208, height: 64 },
  { svg: "icon.svg", png: "icon.png", width: 64, height: 64 },
  // The VS Code marketplace shows the extension's icon at 128 and will not
  // take an SVG, so this is a second size of the same drawing rather than a
  // second drawing.
  { svg: "icon.svg", png: "icon-128.png", width: 128, height: 128 },
] as const;

const SCALE = 2;

const CANDIDATES = [
  process.env.BAA_BROWSER,
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path.length > 0);

if (process.argv.includes("--check")) {
  // Checks the committed copies, which every clone has.
  const missing = TARGETS.filter((target) => !existsSync(join(PUBLISHED, target.png)));
  if (missing.length > 0) {
    process.stderr.write(
      `Missing PNGs in assets/images: ${missing.map((m) => m.png).join(", ")}. Run \`node tools/render-assets.ts\`.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`All ${TARGETS.length} brand PNGs are present.\n`);
  }
} else if (!HAS_SITE) {
  process.stdout.write(
    "No website/ directory here, so there are no SVG sources to render from.\n",
  );
} else {
  // The rendered PNGs are not committed under `website/`, but byte-identical
  // copies are, in `assets/images/`. Copying them back first is what lets
  // `npm run gen:site` work on a fresh clone with no browser installed:
  // `build-site.ts` reads `social.png` to write the card's real dimensions
  // into every page, and dies on the missing file rather than guessing.
  const restored = TARGETS.filter(
    (target) =>
      !existsSync(join(ASSETS, target.png)) && existsSync(join(PUBLISHED, target.png)),
  );
  for (const target of restored) {
    copyFileSync(join(PUBLISHED, target.png), join(ASSETS, target.png));
  }
  if (restored.length > 0) {
    process.stdout.write(
      `restored ${restored.length} PNG(s) from assets/images; they are rendered output, so they are not committed under website/.\n`,
    );
  }

  const executablePath = CANDIDATES.find((path) => existsSync(path));
  if (executablePath === undefined) {
    process.stdout.write(
      "No Chrome or Edge found. Set BAA_BROWSER to render the brand PNGs.\n",
    );
  } else {
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--force-device-scale-factor=1"],
    });
    try {
      for (const target of TARGETS) {
        const svg = readFileSync(join(ASSETS, target.svg), "utf8");
        const page = await browser.newPage();
        await page.setViewport({
          width: target.width,
          height: target.height,
          deviceScaleFactor: SCALE,
        });
        // A transparent page, so a mark with no background stays transparent.
        await page.setContent(
          `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`,
          { waitUntil: "load" },
        );
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(ASSETS, target.png),
          omitBackground: true,
        });
        await page.close();
        // The committed copy the README links to.
        mkdirSync(PUBLISHED, { recursive: true });
        copyFileSync(join(ASSETS, target.png), join(PUBLISHED, target.png));
        process.stdout.write(
          `rendered ${target.png} (${target.width * SCALE}x${target.height * SCALE})\n`,
        );
      }
    } finally {
      await browser.close();
    }
  }
}
