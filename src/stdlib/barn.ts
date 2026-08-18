/**
 * `barn`: windows, controls and events, for native applications.
 *
 * This is the reference implementation's copy, and it draws nothing. Node has
 * no window system, so every function here reports the same thing: this
 * program needs the native runtime, and here is the command that runs it.
 *
 * The module exists in the reference anyway, deliberately. Without it,
 * `baa check` on an application's entry point would report `BAA401` for
 * `import barn`, the language server would underline the first line of every
 * native application, and the linter would call the import unused. Analysis
 * and execution are different questions, and only one of them needs a screen.
 *
 * The signatures are real: arity is enforced here exactly as it is in the
 * native runtime, and `tests/native.test.ts` asserts the two lists of
 * functions match, so a function added to one and forgotten in the other
 * fails a test rather than a user.
 */

import { BaaError } from "../diagnostics/diagnostic.ts";
import { BaaModule, NativeFunction } from "../runtime/values.ts";
import type { Value } from "../runtime/values.ts";

/** `[name, minimum arguments, maximum arguments, summary]`. */
const FUNCTIONS: ReadonlyArray<readonly [string, number, number, string]> = [
  ["window", 0, 1, "Create a window. Options: title, width, height, padding, spacing."],
  ["row", 1, 2, "A container that lays its children out left to right."],
  ["column", 1, 2, "A container that lays its children out top to bottom."],
  ["label", 1, 2, "Text that cannot be edited."],
  ["button", 1, 2, "A push button."],
  ["input", 1, 2, "A single-line text field."],
  ["text_area", 1, 2, "A multi-line text editor with scrollbars."],
  ["list", 1, 2, "A list of selectable rows."],
  ["checkbox", 1, 2, "A checkbox."],
  ["spacer", 1, 2, "Empty space that takes a share of the layout."],
  ["on", 3, 3, 'Register a handler: "click", "change", "select", "toggle" or "close".'],
  ["text", 1, 1, "The widget's current text."],
  ["set_text", 2, 2, "Replace the widget's text."],
  ["items", 1, 1, "A list's rows, as an array of strings."],
  ["set_items", 2, 2, "Replace a list's rows."],
  ["selected", 1, 1, "The selected row's index, or -1."],
  ["select", 2, 2, "Select a row by index."],
  ["checked", 1, 1, "Whether a checkbox is ticked."],
  ["set_checked", 2, 2, "Tick or untick a checkbox."],
  ["enable", 2, 2, "Enable or disable a widget."],
  ["focus", 1, 1, "Give a widget keyboard focus."],
  ["title", 2, 2, "Set a window's title."],
  ["show", 1, 1, "Put a window on screen."],
  ["run", 0, 0, "Run the event loop until every window has closed."],
  ["close", 1, 1, "Close a window."],
  ["quit", 0, 0, "Close every window, ending the event loop."],
  ["alert", 2, 3, "Show a message box."],
  ["confirm", 2, 3, "Ask a yes/no question. Returns true for yes."],
  ["open_file", 0, 2, "Ask for a file to open. Returns a path, or nil if cancelled."],
  ["save_file", 0, 2, "Ask where to save. Returns a path, or nil if cancelled."],
  ["clipboard", 0, 0, "The clipboard's text, or nil."],
  ["set_clipboard", 1, 1, "Put text on the clipboard."],
];

export const BARN_FUNCTIONS: readonly string[] = FUNCTIONS.map(([name]) => name);

export function createBarn(): BaaModule {
  const exports = new Map<string, Value>();
  for (const [name, min, max, doc] of FUNCTIONS) {
    exports.set(
      name,
      new NativeFunction(
        `barn.${name}`,
        min,
        max,
        (_args, ctx) => {
          throw BaaError.of("BAA301", [`\`barn.${name}\` needs the native runtime`], {
            span: ctx.span,
            note: "there is no window here",
            help:
              "`baa run` executes Baa on Node, which has no window system. Run this " +
              "with `baa app run`, or build it with `baa app build`. See docs/gui.md.",
          });
        },
        doc,
      ),
    );
  }
  return new BaaModule("barn", exports);
}
