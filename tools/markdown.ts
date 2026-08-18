/**
 * A small Markdown to HTML converter.
 *
 * Purpose-built for this repository's own documentation, which is why it is
 * ninety lines instead of a dependency: it needs to handle exactly the subset
 * we write: headings, paragraphs, fenced code, lists, tables, blockquotes,
 * rules, links, emphasis and inline code: and to rewrite links between `.md`
 * files into links between the generated `.html` pages.
 *
 * It is deliberately not a general-purpose Markdown implementation. If a
 * document needs something this does not support, the converter should learn
 * it, or the document should stop using it.
 */

export type Heading = { level: number; text: string; id: string };

export type RenderResult = {
  html: string;
  headings: Heading[];
  /** Plain text, for the search index. */
  text: string;
};

export type RenderOptions = {
  /** Rewrites a Markdown link target. Return null to leave it unchanged. */
  rewriteLink?: (href: string) => string | null;
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ESCAPES[ch]!);
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Inline formatting: code, links, images, emphasis. */
function inline(source: string, options: RenderOptions): string {
  const codeSpans: string[] = [];
  // Pull inline code out first so emphasis inside it is left alone.
  let text = source.replace(/`([^`]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, src: string) => {
    const href = options.rewriteLink?.(src) ?? src;
    return `<img src="${href}" alt="${alt}" loading="lazy">`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    const target = options.rewriteLink?.(href) ?? href;
    const external = /^https?:/.test(target);
    const attributes = external ? ' rel="noopener"' : "";
    return `<a href="${target}"${attributes}>${label}</a>`;
  });

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codeSpans[Number(index)]!);
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

export function renderMarkdown(source: string, options: RenderOptions = {}): RenderResult {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  const headings: Heading[] = [];
  const plain: string[] = [];
  const seenIds = new Map<string, number>();

  let index = 0;

  const uniqueId = (text: string): string => {
    const base = slug(text) || "section";
    const count = seenIds.get(base) ?? 0;
    seenIds.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  while (index < lines.length) {
    const line = lines[index]!;

    // Fenced code.
    if (line.startsWith("```")) {
      const language = line.slice(3).trim() || "text";
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        body.push(lines[index]!);
        index++;
      }
      index++;
      const code = body.join("\n");
      const cls = `language-${language.replace(/[^a-z0-9-]/gi, "") || "text"}`;
      html.push(
        `<div class="codeblock"><div class="codeblock__bar"><span class="codeblock__name">${escapeHtml(language)}</span><button class="copy" type="button" data-copy="">copy</button></div><pre><code class="${cls}">${escapeHtml(code)}</code></pre></div>`,
      );
      continue;
    }

    // HTML comments are dropped, not escaped and not passed through. They are
    // notes to whoever reads the Markdown, a generator warning, a reviewer
    // aside, and have no business appearing in, or even inside, the page.
    if (line.trimStart().startsWith("<!--")) {
      while (index < lines.length) {
        const done = lines[index]!.includes("-->");
        index++;
        if (done) break;
      }
      continue;
    }

    // Raw HTML blocks pass straight through.
    if (/^<(div|p|img|table|details|section|figure|br|hr)\b/i.test(line.trim())) {
      const block: string[] = [];
      while (index < lines.length && lines[index]!.trim() !== "") {
        block.push(lines[index]!);
        index++;
      }
      html.push(block.join("\n"));
      continue;
    }

    // Headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const raw = heading[2]!.trim();
      const id = uniqueId(raw);
      headings.push({ level, text: raw.replace(/`/g, ""), id });
      plain.push(raw.replace(/[`*]/g, ""));
      const anchor =
        level >= 2 && level <= 3
          ? `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`
          : "";
      html.push(`<h${level} id="${id}">${inline(raw, options)}${anchor}</h${level}>`);
      index++;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      html.push("<hr>");
      index++;
      continue;
    }

    // Tables.
    if (line.trim().startsWith("|") && lines[index + 1]?.trim().startsWith("|") === true &&
        /^\|[\s:|-]+\|?$/.test(lines[index + 1]!.trim())) {
      const header = tableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.trim().startsWith("|")) {
        rows.push(tableRow(lines[index]!));
        index++;
      }
      const head = header.map((cell) => `<th>${inline(cell, options)}</th>`).join("");
      const body = rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${inline(cell, options)}</td>`).join("")}</tr>`,
        )
        .join("");
      plain.push(...header, ...rows.flat());
      html.push(
        `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      );
      continue;
    }

    // Blockquote.
    if (line.trim().startsWith(">")) {
      const block: string[] = [];
      while (index < lines.length && lines[index]!.trim().startsWith(">")) {
        block.push(lines[index]!.replace(/^\s*>\s?/, ""));
        index++;
      }
      const inner = renderMarkdown(block.join("\n"), options);
      plain.push(inner.text);
      html.push(`<blockquote>${inner.html}</blockquote>`);
      continue;
    }

    // Lists.
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]!);
      const items: string[] = [];
      const baseIndent = listMatch[1]!.length;

      while (index < lines.length) {
        const current = lines[index]!;
        const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(current);
        if (match && match[1]!.length === baseIndent) {
          let content = match[3]!;
          index++;
          const continuation: string[] = [];
          while (index < lines.length) {
            const next = lines[index]!;
            if (next.trim() === "") break;
            const nextItem = /^(\s*)([-*+]|\d+\.)\s+/.exec(next);
            if (nextItem && nextItem[1]!.length <= baseIndent) break;
            continuation.push(next.replace(new RegExp(`^\\s{0,${baseIndent + 2}}`), ""));
            index++;
          }
          const checkbox = /^\[([ xX])\]\s+/.exec(content);
          let prefix = "";
          if (checkbox) {
            prefix = `<input type="checkbox" disabled${checkbox[1]!.toLowerCase() === "x" ? " checked" : ""}> `;
            content = content.slice(checkbox[0]!.length);
          }
          plain.push(content.replace(/[`*]/g, ""));
          const nested =
            continuation.length > 0 ? renderMarkdown(continuation.join("\n"), options).html : "";
          items.push(`<li>${prefix}${inline(content, options)}${nested}</li>`);
          continue;
        }
        if (current.trim() === "" && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[index + 1] ?? "")) {
          index++;
          continue;
        }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      index++;
      continue;
    }

    // Paragraph.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== "") {
      const current = lines[index]!;
      if (
        current.startsWith("```") ||
        /^#{1,6}\s/.test(current) ||
        current.trim().startsWith("|") ||
        current.trim().startsWith(">") ||
        /^(\s*)([-*+]|\d+\.)\s+/.test(current) ||
        /^(-{3,}|_{3,})$/.test(current.trim())
      ) {
        break;
      }
      paragraph.push(current);
      index++;
    }
    if (paragraph.length > 0) {
      const joined = paragraph.join(" ").trim();
      plain.push(joined.replace(/[`*[\]]/g, ""));
      html.push(`<p>${inline(joined, options)}</p>`);
    }
  }

  return { html: html.join("\n"), headings, text: plain.join(" ") };
}
