/**
 * Site behaviour: theme, navigation, copy buttons, tabs and documentation
 * search.
 *
 * Everything here is progressive: with JavaScript disabled the site is still a
 * complete, readable, navigable set of pages. Nothing is rendered client-side
 * except the syntax colours and the search results.
 */

import { highlightAll } from "./highlight.js";

// ------------------------------------------------------------------- theme

const STORAGE_KEY = "baa-theme";

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function currentTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setUpTheme() {
  const button = document.querySelector("[data-theme-toggle]");
  if (button === null) return;

  const label = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", `Switch to ${next} mode`);
    button.setAttribute("title", `Switch to ${next} mode`);
  };

  label();
  button.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    label();
  });
}

// -------------------------------------------------------------- navigation

function setUpNav() {
  const toggle = document.querySelector("[data-nav-toggle]");
  const nav = document.querySelector("[data-nav]");
  if (toggle === null || nav === null) return;

  toggle.addEventListener("click", () => {
    const open = nav.getAttribute("data-open") === "true";
    nav.setAttribute("data-open", String(!open));
    toggle.setAttribute("aria-expanded", String(!open));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.getAttribute("data-open") === "true") {
      nav.setAttribute("data-open", "false");
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    }
  });
}

// ------------------------------------------------------------ copy buttons

function setUpCopyButtons() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const selector = button.getAttribute("data-copy");
      const source =
        selector === "" || selector === null
          ? button.closest(".codeblock, .install")?.querySelector("code, .install-text")
          : document.querySelector(selector);
      const text = source?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text.trim());
        button.setAttribute("data-copied", "true");
        const original = button.textContent;
        button.textContent = "copied";
        setTimeout(() => {
          button.textContent = original;
          button.removeAttribute("data-copied");
        }, 1400);
      } catch {
        button.textContent = "press ⌘C";
        setTimeout(() => {
          button.textContent = "copy";
        }, 1600);
      }
    });
  }
}

// --------------------------------------------------------------------- tabs

function setUpTabs() {
  for (const group of document.querySelectorAll("[data-tabs]")) {
    const tabs = [...group.querySelectorAll("[role='tab']")];
    // Panels are siblings of the tab list, not children of it, so they are
    // looked up by the id each tab already names in `aria-controls`.
    const panels = tabs
      .map((tab) => document.getElementById(tab.getAttribute("aria-controls") ?? ""))
      .filter((panel) => panel !== null);

    const select = (id) => {
      for (const tab of tabs) {
        const selected = tab.getAttribute("aria-controls") === id;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const panel of panels) {
        panel.hidden = panel.id !== id;
      }
    };

    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener("click", () => select(tab.getAttribute("aria-controls")));
      tab.addEventListener("keydown", (event) => {
        const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (offset === 0) return;
        event.preventDefault();
        const next = tabs[(index + offset + tabs.length) % tabs.length];
        next.focus();
        select(next.getAttribute("aria-controls"));
      });
    }
  }
}

// ------------------------------------------------------------------- search

async function setUpSearch() {
  const input = document.querySelector("[data-search]");
  const results = document.querySelector("[data-search-results]");
  if (input === null || results === null) return;

  let index = null;
  const base = input.getAttribute("data-search") || "./";

  const load = async () => {
    if (index !== null) return index;
    try {
      const response = await fetch(`${base}search-index.json`);
      index = await response.json();
    } catch {
      index = [];
    }
    return index;
  };

  const render = (matches, query) => {
    results.innerHTML = "";
    if (query.length < 2) return;
    if (matches.length === 0) {
      results.innerHTML =
        '<li><a href="#" aria-disabled="true">No matches. Try a keyword like <code>match</code> or <code>BAA304</code>.</a></li>';
      return;
    }
    for (const match of matches.slice(0, 12)) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `${base}${match.url}`;
      link.innerHTML = `${escapeHtml(match.title)}<small>${escapeHtml(match.page)}: ${escapeHtml(match.excerpt)}</small>`;
      item.append(link);
      results.append(item);
    }
  };

  const search = async () => {
    const query = input.value.trim().toLowerCase();
    const entries = await load();
    if (query.length < 2) {
      render([], query);
      return;
    }
    const terms = query.split(/\s+/);
    const scored = [];
    for (const entry of entries) {
      const haystack = `${entry.title} ${entry.page} ${entry.text}`.toLowerCase();
      let score = 0;
      let matchedAll = true;
      for (const term of terms) {
        const position = haystack.indexOf(term);
        if (position === -1) {
          matchedAll = false;
          break;
        }
        score += entry.title.toLowerCase().includes(term) ? 12 : 1;
        score += position < 80 ? 2 : 0;
      }
      if (matchedAll) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    render(
      scored.map(({ entry }) => ({
        title: entry.title,
        page: entry.page,
        url: entry.url,
        excerpt: excerptFor(entry.text, terms[0]),
      })),
      query,
    );
  };

  input.addEventListener("input", search);
  input.addEventListener("focus", load);

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== input) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      input.focus();
      input.select();
    }
    if (event.key === "Escape" && document.activeElement === input) {
      input.value = "";
      render([], "");
      input.blur();
    }
  });
}

function excerptFor(text, term) {
  const position = text.toLowerCase().indexOf(term);
  if (position === -1) return text.slice(0, 90);
  const start = Math.max(0, position - 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 100).trim()}…`;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// -------------------------------------------------------------------- start

applyTheme(localStorage.getItem(STORAGE_KEY));
setUpTheme();
setUpNav();
setUpCopyButtons();
setUpTabs();
highlightAll();
void setUpSearch();
