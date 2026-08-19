/**
 * The playground: editor, run button, output pane.
 *
 * The program runs in a Web Worker with a wall-clock limit, so an accidental
 * `while true { }` costs you a click rather than the tab. If workers are
 * unavailable the playground says so rather than pretending to work.
 */

import { highlight } from "./highlight.js";

const TIMEOUT_MS = 5000;

const editor = document.querySelector("[data-editor]");
const output = document.querySelector("[data-output]");
const status = document.querySelector("[data-status]");
const runButton = document.querySelector("[data-run]");
const formatButton = document.querySelector("[data-format]");
const woollyToggle = document.querySelector("[data-woolly]");

const SAMPLES = {
  hello: `// Welcome to the Baa playground. Press Run, or Ctrl+Enter.

const FLOCK = ["Dolly", "Shaun", "Lambchop"]

fn greet(name) {
    return "Baa, {name}!"
}

for name in FLOCK {
    baa greet(name)
}

baa "That's {len(FLOCK)} sheep accounted for."
`,
  collections: `// Arrays, maps and the methods that come with them.

import flock
import ram

const HERD = [
    { name: "Dolly", farm: "Hill", weight: 46.5 },
    { name: "Shaun", farm: "Hill", weight: 52.0 },
    { name: "Timmy", farm: "Dale", weight: 21.0 },
    { name: "Hazel", farm: "Meadowbank", weight: 49.5 },
]

const by_farm = flock.group_by(HERD, fn(s) { return s.farm })

for farm in by_farm.keys().sort() {
    const members = by_farm[farm]
    const weights = members.map(fn(s) { return s.weight })
    baa "{farm}: {members.length()} sheep, mean {ram.round(ram.mean(weights), 1)}kg"
}

baa "Heaviest: {flock.max_by(HERD, fn(s) { return s.weight }).name}"
`,
  match: `// \`match\` is an expression, and patterns compare structurally.

fn fizzbuzz(n) {
    return match [n % 3 == 0, n % 5 == 0] {
        [true, true] => "FizzBuzz",
        [true, false] => "Fizz",
        [false, true] => "Buzz",
        _ => to_string(n),
    }
}

for n in 1..=15 {
    baa fizzbuzz(n)
}

fn describe(flock) {
    return match flock.length() {
        0 => "empty",
        1 => "one lonely sheep",
        2 || 3 => "a small flock",
        n if n > 50 => "a very large flock",
        _ => "a flock",
    }
}

baa describe([]), describe(["a"]), describe(["a", "b"])
`,
  errors: `// Baa's diagnostics are the point. Try breaking this on purpose.

const flock = ["Dolly", "Shaun"]

// A runtime error you can catch, with a stable code:
try {
    baa flock[99]
} catch problem {
    baa "{problem.code}: {problem.message}"
}

// Structured errors carry any value you like:
fn shear(sheep) {
    if sheep.shorn {
        throw { code: "ALREADY_SHORN", sheep: sheep.name }
    }
    return "snip"
}

try {
    shear({ name: "Dolly", shorn: true })
} catch problem {
    baa "{problem.code}, {problem.sheep}"
}

// Now try uncommenting this line and pressing Run:
// baa flok
`,
  closures: `// Closures capture the scope they were written in.

fn make_counter(start) {
    let count = start
    return fn() {
        count += 1
        return count
    }
}

const next = make_counter(10)
baa next(), next(), next()

// Which gives you objects, without needing classes.
fn make_pen(capacity) {
    let sheep = []
    return {
        admit: fn(name) {
            if sheep.length() >= capacity {
                throw "the pen is full"
            }
            sheep.push(name)
            return sheep.length()
        },
        contents: fn() { return clone(sheep) },
    }
}

const pen = make_pen(2)
pen.admit("Dolly")
pen.admit("Shaun")
baa pen.contents()

try {
    pen.admit("Timmy")
} catch problem {
    baa "rejected: {problem}"
}
`,
};

let worker = null;
let pending = null;
let timer = null;
let nextId = 0;
let workersBroken = false;

function setStatus(text, tone = "") {
  if (status === null) return;
  status.textContent = text;
  status.className = `play__status ${tone}`;
}

function write(html) {
  if (output !== null) output.innerHTML = html;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const tone = diagnostic.severity === "warning" ? "warn" : "err";
      return `<span class="${tone}">${escapeHtml(diagnostic.rendered)}</span>`;
    })
    .join("\n\n");
}

function createWorker() {
  try {
    const instance = new Worker(new URL("./playground-worker.js", import.meta.url), {
      type: "module",
    });
    instance.addEventListener("message", onMessage);
    instance.addEventListener("error", () => {
      workersBroken = true;
      setStatus("The playground could not start. Try reloading the page.", "err");
    });
    return instance;
  } catch {
    workersBroken = true;
    return null;
  }
}

function ensureWorker() {
  if (workersBroken) return null;
  if (worker === null) worker = createWorker();
  return worker;
}

function onMessage(event) {
  const data = event.data;
  if (data.ready === true) {
    setStatus("Ready.");
    return;
  }
  if (pending === null || data.id !== pending.id) return;

  clearTimeout(timer);
  const request = pending;
  pending = null;
  setButtonsBusy(false);

  if (data.fatal !== undefined) {
    write(`<span class="err">The playground hit an internal error:\n${escapeHtml(data.fatal)}</span>`);
    setStatus("Internal error: please report this.", "err");
    return;
  }

  if (request.kind === "format") {
    if (data.ok === true && editor !== null) {
      editor.value = data.source;
      setStatus("Formatted.");
    } else {
      setStatus("Could not format: the program does not parse.", "err");
    }
    return;
  }

  const parts = [];
  if (typeof data.output === "string" && data.output.length > 0) {
    parts.push(escapeHtml(data.output.replace(/\n$/, "")));
  }
  if (Array.isArray(data.diagnostics) && data.diagnostics.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push(renderDiagnostics(data.diagnostics));
  }
  if (parts.length === 0) {
    parts.push('<span class="muted">The program produced no output.</span>');
  }
  write(parts.join("\n"));

  const elapsed = typeof data.elapsed === "number" ? ` in ${data.elapsed.toFixed(1)}ms` : "";
  if (data.ok === true) {
    setStatus(`Finished${elapsed}.`);
  } else {
    const count = data.diagnostics?.length ?? 0;
    setStatus(
      `Exit code ${data.exitCode ?? 1}: ${count} problem${count === 1 ? "" : "s"}${elapsed}.`,
      "err",
    );
  }
}

function setButtonsBusy(busy) {
  for (const button of [runButton, formatButton]) {
    if (button !== null) button.disabled = busy;
  }
  if (runButton !== null) runButton.textContent = busy ? "Running…" : "Run";
}

function send(kind) {
  const instance = ensureWorker();
  if (instance === null) {
    write(
      '<span class="err">This browser cannot run the playground: it does not support module workers.\n\nEverything else on the site works, and Baa itself runs anywhere Node 22.18+ does.</span>',
    );
    setStatus("Playground unavailable.", "err");
    return;
  }
  if (pending !== null) return;

  const id = ++nextId;
  pending = { id, kind };
  setButtonsBusy(true);
  setStatus(kind === "format" ? "Formatting…" : "Running…");

  instance.postMessage({
    id,
    kind,
    source: editor?.value ?? "",
    seed: 7,
    woolly: woollyToggle === null ? true : woollyToggle.checked,
  });

  timer = setTimeout(() => {
    instance.terminate();
    worker = null;
    pending = null;
    setButtonsBusy(false);
    write(
      `<span class="err">Stopped after ${TIMEOUT_MS / 1000} seconds.\n\nThe playground caps how long a program may run. A loop with no way out is the usual cause.</span>`,
    );
    setStatus("Timed out.", "err");
  }, TIMEOUT_MS);
}

// --------------------------------------------------------------- deep links

/** `#sample=match` opens a named example. That is the only link form. */
function loadFromUrl() {
  const hash = location.hash.replace(/^#/, "");
  if (hash.startsWith("sample=") && SAMPLES[hash.slice(7)] !== undefined) {
    return SAMPLES[hash.slice(7)];
  }
  return null;
}

// -------------------------------------------------------------------- start

if (editor !== null) {
  editor.value = loadFromUrl() ?? SAMPLES.hello;

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send("run");
      return;
    }
    // Tab inserts an indent rather than leaving the editor.
    if (event.key === "Tab") {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = editor;
      editor.value = `${value.slice(0, selectionStart)}    ${value.slice(selectionEnd)}`;
      editor.selectionStart = editor.selectionEnd = selectionStart + 4;
    }
  });
}

runButton?.addEventListener("click", () => send("run"));
formatButton?.addEventListener("click", () => send("format"));

for (const button of document.querySelectorAll("[data-sample]")) {
  button.addEventListener("click", () => {
    const name = button.getAttribute("data-sample");
    if (editor !== null && SAMPLES[name] !== undefined) {
      editor.value = SAMPLES[name];
      history.replaceState(null, "", `${location.pathname}#sample=${name}`);
      send("run");
    }
  });
}

// A highlighted, non-interactive copy of the starting program for users who
// arrive before the worker is ready, and for anyone with JavaScript disabled
// the static fallback in the markup remains.
const preview = document.querySelector("[data-preview]");
if (preview !== null && editor !== null) {
  preview.innerHTML = highlight(editor.value);
}

setStatus("Starting the interpreter…");
ensureWorker();
