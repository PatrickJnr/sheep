/**
 * Build the Baa website.
 *
 *     node tools/build-site.ts
 *
 * Everything the site shows about the language comes from the repository's own
 * Markdown, so the site cannot drift from the documentation. The output is
 * plain HTML, CSS and JavaScript with no server-side anything: copy the
 * `website/` directory into `public_html` and it works.
 *
 * Generated:
 *   website/index.html          from website/src/index.body.html
 *   website/playground.html     from website/src/playground.body.html
 *   website/docs/*.html         from the Markdown files listed below
 *   website/docs/search-index.json
 *   website/sitemap.xml
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { escapeHtml, renderMarkdown } from "./markdown.ts";
import type { Heading } from "./markdown.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "website");
const SRC = join(SITE, "src");
const DOCS_OUT = join(SITE, "docs");

const ORIGIN = "https://sheep.grimtech.co.uk";

/** The card social platforms show. */
const SOCIAL_IMAGE = {
  file: "social.png",
  alt: "Baa: a programming language with a little more Baa.",
} as const;

/**
 * Width and height of a PNG, from its IHDR chunk.
 *
 * The card is rendered at 2x, so hard-coding the nominal 1200x630 would have
 * advertised half the real size. Reading the file means the tags cannot drift
 * from it, whatever scale it is next rendered at.
 */
function pngSize(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(0, 24);
  if (header.length < 24 || header.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${path} is not a PNG`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}
const REPO = "https://github.com/PatrickJnr/sheep";
/** The package page. This is the link a visitor can actually follow: the
 * repository is private, so anything pointing at it is a 404 for them. */
const NPM = "https://www.npmjs.com/package/baa-lang";

/**
 * `HEAD`, not a branch name. GitHub resolves it to whatever the default branch
 * is called, so these links survive the repository being renamed from master
 * to main or the other way about. Pinned to `main`, every one of them was a
 * 404 while the default branch was `master`.
 */
const BLOB = `${REPO}/blob/HEAD`;

/**
 * Footer marks. Inline SVG rather than an icon font or a remote sprite: the
 * site loads nothing from another origin, and a test enforces that.
 */
const GITHUB_MARK = `<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

// The square npm mark on a 24x24 grid. The wordmark is roughly 16:6, so
// drawing it into a square viewBox clips it; this is the boxed variant, which
// sits at the same optical weight as the GitHub mark beside it.
const NPM_MARK = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z"/></svg>`;


if (!existsSync(SRC)) {
  process.stdout.write("No website/src here; skipping the site build.\n");
  process.exit(0);
}

const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
}).version;

// --------------------------------------------------------------------------
// Pages
// --------------------------------------------------------------------------

type DocPage = {
  /** Output file name inside `website/docs/`. */
  readonly slug: string;
  /** Source Markdown, relative to the repository root. */
  readonly source: string;
  readonly title: string;
  readonly description: string;
  readonly group: string;
  /** Drop everything before the first `# heading` (README-style banners). */
  readonly stripBanner?: boolean;
};

const DOC_PAGES: readonly DocPage[] = [
  {
    slug: "index",
    source: "website/src/docs.index.md",
    title: "Documentation",
    description: "Every Baa document: the language tour, the specification, the CLI, the standard library and the diagnostic catalogue.",
    group: "Start here",
  },
  {
    slug: "language",
    source: "LANGUAGE.md",
    title: "Language tour",
    description: "A guided walk through Baa, from hello world to modules and error handling. Every snippet runs.",
    group: "Start here",
  },
  {
    slug: "cli",
    source: "docs/cli.md",
    title: "CLI reference",
    description: "Every baa command, option, exit code and environment variable, plus the project manifest format.",
    group: "Start here",
  },
  {
    slug: "web",
    source: "docs/web.md",
    title: "Web pages",
    description: "Writing web pages in Baa: the gate module, escaping, baa serve, and putting a page on a real host.",
    group: "Start here",
  },
  {
    slug: "web-applications",
    source: "docs/web-applications.md",
    title: "Web applications",
    description: "The server-rendered application model: state, escaping, testing, what it is good at and what it is not.",
    group: "Start here",
  },
  {
    slug: "editors",
    source: "docs/editors.md",
    title: "Editor support",
    description: "Syntax highlighting, and the baa lsp language server: what it provides, what it does not, and how to point an editor at it.",
    group: "Start here",
  },
  {
    slug: "faq",
    source: "docs/faq.md",
    title: "FAQ",
    description: "Why one number type, why dividing by zero fails, why the language is called Baa, and other reasonable questions.",
    group: "Start here",
  },
  {
    slug: "stdlib",
    source: "docs/stdlib.md",
    title: "Standard library",
    description: "Every function Baa ships with: the prelude, the methods on values, and all eight modules.",
    group: "Reference",
  },
  {
    slug: "errors",
    source: "docs/errors.md",
    title: "Diagnostics",
    description: "The complete BAAnnn diagnostic catalogue, with both the default and the professional wording.",
    group: "Reference",
  },
  {
    slug: "spec",
    source: "SPEC.md",
    title: "Specification",
    description: "The precise definition of Baa: lexical structure, grammar, semantics, modules and the execution model.",
    group: "Reference",
  },
  {
    slug: "architecture",
    source: "ARCHITECTURE.md",
    title: "Architecture",
    description: "How Baa is built: the pipeline, the design decisions, the performance numbers and the route to a bytecode VM.",
    group: "Project",
  },
  {
    slug: "roadmap",
    source: "ROADMAP.md",
    title: "Roadmap",
    description: "What is done, what is next, what is deliberately not planned, and how a Rust implementation would fit.",
    group: "Project",
  },
  {
    slug: "rust",
    source: "rust/README.md",
    title: "Rust implementation",
    description: "The plan for a Rust implementation of Baa, and the conformance suite that would verify it.",
    group: "Project",
  },
  {
    slug: "contributing",
    source: "CONTRIBUTING.md",
    title: "Contributing",
    description: "How to set up, what makes a good contribution, and the house rules.",
    group: "Project",
  },
  {
    slug: "security",
    source: "SECURITY.md",
    title: "Security",
    description: "Baa's threat model, the design decisions made for security reasons, and how to report a vulnerability.",
    group: "Project",
  },
  {
    slug: "changelog",
    source: "CHANGELOG.md",
    title: "Changelog",
    description: "Everything that has changed in Baa, release by release.",
    group: "Project",
  },
];

// --------------------------------------------------------------------------
// Link rewriting
// --------------------------------------------------------------------------

const MARKDOWN_TO_SLUG: Record<string, string> = {
  "LANGUAGE.md": "language",
  "SPEC.md": "spec",
  "ARCHITECTURE.md": "architecture",
  "ROADMAP.md": "roadmap",
  "CONTRIBUTING.md": "contributing",
  "SECURITY.md": "security",
  "CHANGELOG.md": "changelog",
  "docs/cli.md": "cli",
  "docs/stdlib.md": "stdlib",
  "docs/errors.md": "errors",
  "docs/web-applications.md": "web-applications",
  "web-applications.md": "web-applications",
  "docs/editors.md": "editors",
  "editors.md": "editors",
  "docs/faq.md": "faq",
  "docs/web.md": "web",
  "web.md": "web",
  "cli.md": "cli",
  "stdlib.md": "stdlib",
  "errors.md": "errors",
  "faq.md": "faq",
  "rust/README.md": "rust",
};

/** Rewrite a link from a Markdown source into a link that works on the site. */
function rewriteFor(fromDocs: boolean) {
  return (href: string): string | null => {
    if (/^(https?:|mailto:|#)/.test(href)) return null;

    const cleaned = href.replace(/^\.\//, "").replace(/^\.\.\//g, "");
    const [path, fragment] = cleaned.split("#");
    const anchor = fragment === undefined ? "" : `#${fragment}`;

    const slug = MARKDOWN_TO_SLUG[path ?? ""];
    if (slug !== undefined) {
      const target = slug === "index" ? "" : `${slug}.html`;
      return fromDocs ? `${target || "./"}${anchor}` : `docs/${target || "index.html"}${anchor}`;
    }

    if (path === "README.md" || path === "") {
      return fromDocs ? `../index.html${anchor}` : `./${anchor}`;
    }
    if (path === "CODE_OF_CONDUCT.md") return `${BLOB}/CODE_OF_CONDUCT.md`;
    if (path === "LICENSE") return `${BLOB}/LICENSE`;

    // Anything else in the repository links to the source on GitHub.
    if (path !== undefined && /^(src|examples|tests|tools|docs|editors|rust|website|\.github)\//.test(path)) {
      return `${BLOB}/${path}`;
    }
    if (path !== undefined && path.endsWith("/")) return `${BLOB}/${path}`;
    if (path !== undefined && /\.(baa|ts|json|toml|yml|svg)$/.test(path)) {
      return `${BLOB}/${path}`;
    }
    return null;
  };
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------

const socialSize = pngSize(join(SITE, "assets", SOCIAL_IMAGE.file));

/**
 * Structured data for the site as a whole.
 *
 * `application/ld+json` is data, not code: the browser never executes it, so
 * `script-src 'self'` does not block it and it introduces no inline script.
 * Emitted on every page so a crawler that only fetches one still learns what
 * this is and who wrote it.
 */
const STRUCTURED_DATA = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${ORIGIN}/#website`,
      url: `${ORIGIN}/`,
      name: "Baa",
      description:
        "Baa is a small, readable programming language with a real lexer, parser, resolver, interpreter, formatter, linter and standard library.",
      inLanguage: "en-GB",
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${ORIGIN}/#software`,
      name: "Baa",
      alternateName: "Baa programming language",
      description:
        "A programming language with readable syntax, fast tooling and diagnostics that explain themselves. Runs on Node.js, with no third-party packages.",
      url: `${ORIGIN}/`,
      codeRepository: REPO,
      programmingLanguage: { "@type": "ComputerLanguage", name: "Baa" },
      runtimePlatform: "Node.js",
      license: "https://opensource.org/licenses/MIT",
      version: VERSION,
      image: `${ORIGIN}/assets/${SOCIAL_IMAGE.file}`,
      isPartOf: { "@id": `${ORIGIN}/#website` },
    },
  ],
});

const LOGO = readFileSync(join(SITE, "assets", "icon.svg"), "utf8")
  .replace(/<\?xml[^>]*\?>\s*/g, "")
  .replace(/\n\s*/g, "")
  .replace('width="64" height="64"', 'width="30" height="30"');

type ShellOptions = {
  readonly title: string;
  readonly description: string;
  readonly body: string;
  /** Path prefix back to the site root, e.g. "" or "../". */
  readonly base: string;
  readonly canonical: string;
  readonly active: "home" | "docs" | "playground" | "";
  readonly bodyClass?: string;
  readonly extraHead?: string;
  readonly extraScripts?: string;
};

function shell(options: ShellOptions): string {
  const { base } = options;
  const navLink = (href: string, label: string, key: string): string =>
    `<a href="${base}${href}"${options.active === key ? ' aria-current="page"' : ""}>${label}</a>`;

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<meta name="description" content="${escapeHtml(options.description)}">
<link rel="canonical" href="${options.canonical}">
<meta name="theme-color" content="#2f4b3f" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#12160f" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Baa">
<meta property="og:title" content="${escapeHtml(options.title)}">
<meta property="og:description" content="${escapeHtml(options.description)}">
<meta property="og:url" content="${options.canonical}">
<meta property="og:locale" content="en_GB">
<!--
  PNG, not SVG. Every social scraper worth the meta tag (Facebook, X, LinkedIn,
  Slack, Discord, iMessage) refuses to render an SVG card, and several fall back
  to no image at all rather than to the next candidate. The dimensions are here
  because scrapers that have not fetched the file yet use them to reserve the
  right shape, and an absolute URL because most of them do not resolve relative
  ones.
-->
<meta property="og:image" content="${ORIGIN}/assets/${SOCIAL_IMAGE.file}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${socialSize.width}">
<meta property="og:image:height" content="${socialSize.height}">
<meta property="og:image:alt" content="${escapeHtml(SOCIAL_IMAGE.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(options.title)}">
<meta name="twitter:description" content="${escapeHtml(options.description)}">
<meta name="twitter:image" content="${ORIGIN}/assets/${SOCIAL_IMAGE.file}">
<meta name="twitter:image:alt" content="${escapeHtml(SOCIAL_IMAGE.alt)}">
<link rel="icon" href="${base}assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${base}assets/icon.png">
<link rel="stylesheet" href="${base}assets/styles.css">
<!--
  Not inline, and not deferred: it has to run before first paint to avoid a
  flash of the wrong theme, and it has to be a file so the site's
  Content-Security-Policy can refuse inline scripts outright.
-->
<script src="${base}assets/theme.js"></script>
<script type="application/ld+json">${STRUCTURED_DATA}</script>
${options.extraHead ?? ""}</head>
<body${options.bodyClass ? ` class="${options.bodyClass}"` : ""}>
<a class="skip" href="#main">Skip to content</a>

<header class="site-header">
  <div class="wrap site-header__inner">
    <a class="brand" href="${base}index.html">${LOGO}<span>Baa</span></a>
    <button class="icon-button nav-toggle" type="button" data-nav-toggle aria-expanded="false" aria-controls="site-nav" aria-label="Menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    <nav class="site-nav" id="site-nav" data-nav aria-label="Main">
      ${navLink("docs/index.html", "Docs", "docs")}
      ${navLink("docs/language.html", "Tour", "")}
      ${navLink("playground.html", "Playground", "playground")}
      ${navLink("docs/stdlib.html", "Library", "")}
      <a class="nav-mark" href="${REPO}" rel="noopener" aria-label="Source on GitHub" title="GitHub">${GITHUB_MARK}</a>
      <a class="nav-mark" href="${NPM}" rel="noopener" aria-label="Package on npm" title="npm">${NPM_MARK}</a>
      <button class="icon-button" type="button" data-theme-toggle aria-label="Switch theme">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
      </button>
    </nav>
  </div>
</header>

<main id="main">
${options.body}
</main>

<footer class="site-footer">
  <div class="wrap">
    <div class="site-footer__grid">
      <div>
        <a class="brand" href="${base}index.html">${LOGO}<span>Baa</span></a>
        <p style="margin-top:.75rem;color:var(--ink-soft);max-width:26rem">
          A small, readable scripting language with fast tooling, beautiful
          diagnostics and extremely questionable sheep-related naming decisions.
        </p>
      </div>
      <div>
        <h3>Learn</h3>
        <ul>
          <li><a href="${base}docs/language.html">Language tour</a></li>
          <li><a href="${base}docs/spec.html">Specification</a></li>
          <li><a href="${base}docs/faq.html">FAQ</a></li>
          <li><a href="${base}playground.html">Playground</a></li>
        </ul>
      </div>
      <div>
        <h3>Reference</h3>
        <ul>
          <li><a href="${base}docs/cli.html">CLI</a></li>
          <li><a href="${base}docs/stdlib.html">Standard library</a></li>
          <li><a href="${base}docs/errors.html">Diagnostics</a></li>
          <li><a href="${base}docs/architecture.html">Architecture</a></li>
        </ul>
      </div>
      <div>
        <h3>Project</h3>
        <ul>
          <li><a href="${NPM}" rel="noopener">Package on npm</a></li>
          <li><a href="${REPO}" rel="noopener">Source on GitHub</a></li>
          <li><a href="${base}docs/roadmap.html">Roadmap</a></li>
          <li><a href="${base}docs/contributing.html">Contributing</a></li>
          <li><a href="${base}docs/rust.html">Rust port</a></li>
        </ul>
      </div>
    </div>
    <div class="colophon">
      <span>Baa ${VERSION} · MIT licensed · No third-party packages</span>
      <span class="colophon__marks">
        <a href="${REPO}" rel="noopener" aria-label="Source on GitHub" title="GitHub">${GITHUB_MARK}</a>
        <a href="${NPM}" rel="noopener" aria-label="Package on npm" title="npm">${NPM_MARK}</a>
      </span>
      <span>Built with a lexer, a parser and a great deal of wool.</span>
    </div>
  </div>
</footer>

<script type="module" src="${base}assets/site.js"></script>
${options.extraScripts ?? ""}</body>
</html>
`;
}

// --------------------------------------------------------------------------
// Sidebar
// --------------------------------------------------------------------------

function sidebar(activeSlug: string, headings: readonly Heading[]): string {
  const groups = new Map<string, DocPage[]>();
  for (const page of DOC_PAGES) {
    const list = groups.get(page.group) ?? [];
    list.push(page);
    groups.set(page.group, list);
  }

  const sections: string[] = [];
  sections.push(
    `<div class="search"><label class="visually-hidden" for="doc-search">Search the documentation</label><input id="doc-search" type="search" placeholder="Search docs…  /" autocomplete="off" data-search="./"><ul class="search__results" data-search-results></ul></div>`,
  );

  for (const [group, pages] of groups) {
    const items = pages
      .map((page) => {
        const href = page.slug === "index" ? "./" : `${page.slug}.html`;
        const current = page.slug === activeSlug ? ' aria-current="page"' : "";
        return `<li><a href="${href}"${current}>${escapeHtml(page.title)}</a></li>`;
      })
      .join("");
    sections.push(`<h2>${escapeHtml(group)}</h2><ul>${items}</ul>`);
  }

  const onThisPage = headings.filter((heading) => heading.level === 2);
  if (onThisPage.length > 1) {
    const items = onThisPage
      .map((heading) => `<li><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
      .join("");
    sections.push(`<h2>On this page</h2><ul>${items}</ul>`);
  }

  return `<nav class="sidebar" aria-label="Documentation">${sections.join("")}</nav>`;
}

function docNav(slug: string): string {
  const index = DOC_PAGES.findIndex((page) => page.slug === slug);
  const previous = index > 0 ? DOC_PAGES[index - 1] : undefined;
  const next = index >= 0 && index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : undefined;
  if (previous === undefined && next === undefined) return "";

  const link = (page: DocPage | undefined, label: string, align: string): string =>
    page === undefined
      ? "<span></span>"
      : `<a href="${page.slug === "index" ? "./" : `${page.slug}.html`}" style="text-align:${align}"><small>${label}</small>${escapeHtml(page.title)}</a>`;

  return `<div class="doc-nav">${link(previous, "Previous", "left")}${link(next, "Next", "right")}</div>`;
}

// --------------------------------------------------------------------------
// Build
// --------------------------------------------------------------------------

type SearchEntry = {
  title: string;
  page: string;
  url: string;
  text: string;
};

rmSync(DOCS_OUT, { recursive: true, force: true });
mkdirSync(DOCS_OUT, { recursive: true });

const searchIndex: SearchEntry[] = [];
const sitemap: string[] = [];

for (const page of DOC_PAGES) {
  let markdown = readFileSync(join(ROOT, page.source), "utf8");
  if (page.stripBanner === true) {
    const firstHeading = markdown.indexOf("\n# ");
    if (firstHeading !== -1) markdown = markdown.slice(firstHeading + 1);
  }

  const rendered = renderMarkdown(markdown, { rewriteLink: rewriteFor(true) });
  const url = page.slug === "index" ? "docs/" : `docs/${page.slug}.html`;

  const body = `<div class="wrap docs">
${sidebar(page.slug, rendered.headings)}
<article class="doc">
${rendered.html}
${docNav(page.slug)}
</article>
</div>`;

  writeFileSync(
    join(DOCS_OUT, `${page.slug}.html`),
    shell({
      title: `${page.title} · Baa`,
      description: page.description,
      body,
      base: "../",
      canonical: `${ORIGIN}/${url}`,
      active: "docs",
    }),
    "utf8",
  );

  sitemap.push(url);

  // One search entry per section, so a hit lands on the right heading.
  const sections = splitSections(rendered.text, rendered.headings);
  searchIndex.push({
    title: page.title,
    page: page.title,
    url: page.slug === "index" ? "./" : `${page.slug}.html`,
    text: `${page.description} ${sections.intro}`.slice(0, 600),
  });
  for (const section of sections.parts) {
    searchIndex.push({
      title: section.title,
      page: page.title,
      url: `${page.slug === "index" ? "./" : `${page.slug}.html`}#${section.id}`,
      text: section.text.slice(0, 600),
    });
  }
}

/** Split a document's plain text into per-heading sections for the search index. */
function splitSections(
  text: string,
  headings: readonly Heading[],
): { intro: string; parts: Array<{ title: string; id: string; text: string }> } {
  const parts: Array<{ title: string; id: string; text: string }> = [];
  let remaining = text;
  let intro = text.slice(0, 400);

  for (const [index, heading] of headings.entries()) {
    if (heading.level > 3) continue;
    const start = remaining.indexOf(heading.text);
    if (start === -1) continue;
    if (index === 0) intro = remaining.slice(0, start);
    const after = remaining.slice(start + heading.text.length);
    const nextHeading = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= 3 && after.includes(candidate.text));
    const end = nextHeading === undefined ? after.length : after.indexOf(nextHeading.text);
    parts.push({ title: heading.text, id: heading.id, text: after.slice(0, end).trim() });
    remaining = after;
  }
  return { intro, parts };
}

writeFileSync(
  join(DOCS_OUT, "search-index.json"),
  JSON.stringify(searchIndex),
  "utf8",
);

// ------------------------------------------------------------ static pages

type StaticPage = {
  readonly file: string;
  readonly partial: string;
  readonly title: string;
  readonly description: string;
  readonly active: ShellOptions["active"];
  readonly extraScripts?: string;
  /** Excluded from the sitemap. */
  readonly unlisted?: boolean;
};

const STATIC_PAGES: readonly StaticPage[] = [
  {
    file: "index.html",
    partial: "index.body.html",
    title: "Baa: a programming language with a little more Baa",
    description:
      "A modern, readable programming language for people who enjoy clean syntax, fast tools and extremely questionable sheep-related naming decisions.",
    active: "home",
  },
  {
    file: "playground.html",
    partial: "playground.body.html",
    title: "Playground · Baa",
    description:
      "Run Baa in your browser. The real interpreter, the same lexer, parser and runtime the CLI uses, compiled to JavaScript.",
    active: "playground",
    extraScripts: '<script type="module" src="assets/playground.js"></script>\n',
  },
  {
    file: "404.html",
    partial: "404.body.html",
    title: "Page not found · Baa",
    description:
      "That page has wandered off. The documentation, the playground and the source are all still here.",
    active: "",
    unlisted: true,
  },
];

for (const page of STATIC_PAGES) {
  const body = readFileSync(join(SRC, page.partial), "utf8")
    .replace(/\{\{version\}\}/g, VERSION)
    .replace(/\{\{repo\}\}/g, REPO)
    .replace(/\{\{npm\}\}/g, NPM);
  writeFileSync(
    join(SITE, page.file),
    shell({
      title: page.title,
      description: page.description,
      body,
      base: "",
      canonical: `${ORIGIN}/${page.file === "index.html" ? "" : page.file}`,
      active: page.active,
      ...(page.extraScripts === undefined ? {} : { extraScripts: page.extraScripts }),
    }),
    "utf8",
  );
  if (page.unlisted !== true) sitemap.push(page.file === "index.html" ? "" : page.file);
}

// ---------------------------------------------------------------- sitemap

const today = new Date(
  Number(process.env.SOURCE_DATE_EPOCH ?? Date.now()),
).toISOString().slice(0, 10);

writeFileSync(
  join(SITE, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap
  .map(
    (path) =>
      `  <url><loc>${ORIGIN}/${path}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq></url>`,
  )
  .join("\n")}
</urlset>
`,
  "utf8",
);

const pageCount = DOC_PAGES.length + STATIC_PAGES.length;
process.stdout.write(
  `Built the site: ${pageCount} pages, ${searchIndex.length} search entries.\n`,
);

// A cheap guard against the commonest build mistake.
const missingAssets = [
  "styles.css",
  "site.js",
  "theme.js",
  "highlight.js",
  "icon.svg",
  "icon.png",
  SOCIAL_IMAGE.file,
].filter(
  (name) => !readdirSync(join(SITE, "assets")).includes(name),
);
if (missingAssets.length > 0) {
  process.stderr.write(`Missing assets: ${missingAssets.join(", ")}\n`);
  process.exitCode = 1;
}
