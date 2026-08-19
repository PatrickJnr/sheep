# `barn`: windows and controls

The module a native application uses to put something on the screen. It is the
opposite number of [`gate`](web.md): a program imports one or the other, never
both, and importing `gate` into an application is a build error.

```baa
import barn

const window = barn.window({ title: "Hello", width: 320, height: 140 })
const layout = barn.column(window, { weight: 1 })
const label = barn.label(layout, { text: "Baa", align: "center", size: 20 })
const button = barn.button(layout, { text: "Again" })

fn on_click() {
    barn.set_text(label, "Baa baa")
}

barn.on(button, "click", on_click)

barn.show(window)
barn.run()
```

Run it with `baa app run`. `baa run` reports that `barn` needs the native
runtime, because Node has no window system: the module exists in the reference
implementation so that `baa check`, the linter and the language server all work
on an application's source, not so that it can draw.

---

## The model

**A widget is a number.** `barn.button(...)` returns a handle, and every other
function takes one. Baa has no classes, and a map of functions pretending to be
an object would be a worse lie than a plain handle.

**Build the tree, then show it.** Every widget is created before
`barn.show(window)`; adding one afterwards is an error that says so. This is a
real constraint and the reason for it is honest: creating controls after the
window exists is possible in Win32 and awkward everywhere else, and no
application here has needed it.

**Changing something is a call.** `barn.set_text(label, "…")` rather than
assigning a field. There is one place where the tree and the operating system
are made to agree, which runs after your handlers and before the next event.

**Handlers run between events, never inside one.** A window procedure records
what happened; the event loop then calls your Baa function with nothing else in
progress. So a handler can do anything a Baa function can do, including opening
a dialog, closing the window, or failing with a diagnostic.

---

## Layout

Two containers, `row` and `column`, and one number: `weight`.

A child with no weight takes its natural size. Whatever is left over is shared
between the weighted children in proportion. That is the whole algorithm, and
it is recomputed on every resize.

```baa
const layout = barn.column(window, { weight: 1, spacing: 8, padding: 12 })
const toolbar = barn.row(layout, { spacing: 4 })      // as tall as a button
const editor = barn.text_area(layout, { weight: 1 })  // takes the rest
const status = barn.label(layout, { height: 20 })     // exactly 20
```

A row inside a column is as tall as its tallest child, not as tall as the sum
of them: without that, a grid of buttons grows down the screen.

| Option | Applies to | Meaning |
| --- | --- | --- |
| `weight` | anything | Share of the leftover space. `0`, the default, means natural size |
| `width`, `height` | anything | An exact size, in layout units |
| `padding` | containers | Space inside the container's edge |
| `spacing` | containers | Space between children |
| `align` | labels, inputs | `"start"`, `"center"` or `"end"` |
| `size` | anything with text | Font size in points |
| `text` | anything with text | Its text; `title` on a window |
| `items` | lists | An array of rows |
| `selected` | lists | The selected index |
| `enabled`, `checked` | anything, checkboxes | Booleans |

Sizes are in layout units, not pixels. The backend multiplies by the monitor's
scale factor, so a 320-unit window is 320 pixels at 100% and 480 at 150%, and
the text is drawn at the matching size rather than stretched.

---

## Creating widgets

| Function | Returns |
| --- | --- |
| `barn.window(options)` | A top-level window |
| `barn.row(parent, options)` | A container laying children left to right |
| `barn.column(parent, options)` | A container laying children top to bottom |
| `barn.label(parent, options)` | Text that cannot be edited |
| `barn.button(parent, options)` | A push button |
| `barn.input(parent, options)` | A single-line text field |
| `barn.text_area(parent, options)` | A multi-line editor with scrollbars |
| `barn.list(parent, options)` | A list of selectable rows |
| `barn.checkbox(parent, options)` | A checkbox |
| `barn.spacer(parent, options)` | Empty space that takes a share of the layout |
| `barn.menu(window, title)` | A menu on the window's menu bar |
| `barn.item(menu, label)` | An entry in a menu; fires `click` |
| `barn.separator(menu)` | A dividing line in a menu |

Menus take their label directly rather than in a map, because a label is all
they have.

```baa
const file = barn.menu(window, "File")
const open = barn.item(file, "Open…")
barn.separator(file)
const quit = barn.item(file, "Exit")
```

## Events

```baa
barn.on(widget, event, handler)
```

The handler is called with the widget's handle, so one function can serve
several widgets.

| Event | Fires when |
| --- | --- |
| `"click"` | A button is pressed, or a menu item is chosen |
| `"change"` | An input or text area's contents changed |
| `"select"` | A list's selection changed |
| `"toggle"` | A checkbox was ticked or unticked |
| `"close"` | The window was asked to close |

`"close"` does not close the window. With no handler the window closes, which
is what everyone expects; with one, the handler decides, which is what makes
"save before closing?" possible:

```baa
fn on_close() {
    if !document.is_modified(doc) || barn.confirm(window, "Unsaved changes. Close anyway?") {
        barn.close(window)
    }
}

barn.on(window, "close", on_close)
```

An unknown event name is an error listing the ones that exist. A handler that
is not a function is an error too, at the `barn.on` call rather than later.

## Reading and changing

| Function | Effect |
| --- | --- |
| `barn.text(widget)` | Its current text, as the person has typed it |
| `barn.set_text(widget, text)` | Replace it |
| `barn.items(list)` | The rows, as an array |
| `barn.set_items(list, array)` | Replace them; the selection is cleared |
| `barn.selected(list)` | The selected index, or `-1` |
| `barn.select(list, index)` | Select a row |
| `barn.checked(checkbox)` | Whether it is ticked |
| `barn.set_checked(checkbox, flag)` | Tick or untick it |
| `barn.enable(widget, flag)` | Enable or disable |
| `barn.focus(widget)` | Give it keyboard focus |
| `barn.title(window, text)` | Set the window's title |

`barn.text` returns what the control holds, not what you last set: the control
owns its own contents while the person is typing into it.

When you set a text area's text from a handler, compare first:

```baa
if barn.text(editor) != doc.text {
    barn.set_text(editor, doc.text)
}
```

Writing it back unconditionally on every keystroke moves the caret to the start
on every keystroke, which makes an editor unusable while every function in it
still looks correct.

## Windows, dialogs and the loop

| Function | Effect |
| --- | --- |
| `barn.show(window)` | Realise the window and put it on screen |
| `barn.run()` | Run the event loop until every window has closed |
| `barn.close(window)` | Close one window |
| `barn.quit()` | Close all of them, ending the loop |
| `barn.alert(window, title, text)` | A message box |
| `barn.confirm(window, title, text)` | A yes/no question; returns `true` for yes |
| `barn.open_file(window, filter)` | Ask for a file to open. A path, or `nil` if cancelled |
| `barn.save_file(window, filter)` | Ask where to save. A path, or `nil` if cancelled |
| `barn.clipboard()` | The clipboard's text, or `nil` |
| `barn.set_clipboard(text)` | Put text on the clipboard |

A dialog filter is a `|`-separated list of pairs:

```baa
const FILTER = "Text files|*.txt;*.md|All files|*.*"
```

`barn.run()` returns when the last window closes, and the program continues
after it, so anything that has to happen on the way out goes there.

---

## Timers

Something has to happen while nobody is clicking: a clock ticking, a countdown
running down, a progress bar moving. That is what timers are for.

| Function | Effect |
| --- | --- |
| `barn.every(millis, handler)` | Call `handler` every `millis`. Returns a timer id. |
| `barn.after(millis, handler)` | Call `handler` once, `millis` from now. Returns a timer id. |
| `barn.cancel(id)` | Stop a timer. `true` when there was one to stop. |

The handler is called with the timer's id, so a timer can stop itself:

```baa
barn.every(1000, fn(id) {
    remaining = remaining - 1
    barn.set_text(label, remaining + "...")
    if remaining == 0 {
        barn.cancel(id)
        barn.set_text(label, "Done")
    }
})
```

Ticks arrive on the event loop, in the same single thread as every other
handler, and only while `barn.run()` is running. Nothing runs in parallel with
your code and nothing interrupts it half way: a handler that takes 200ms delays
the next tick rather than overlapping it. There is no second concurrency model
to reason about, which is the whole point of putting timers on the loop instead
of on a thread.

Two consequences worth knowing:

- **Intervals are a floor, not a promise.** A tick that cannot be delivered on
  time is delivered late, and Windows will not schedule faster than about 10ms
  whatever you ask for. Anything that needs to know how much time has really
  passed should ask `meadow.now()` rather than counting ticks.
- **`barn.after` cancels itself** once its handler has run, so its id is dead
  afterwards. Cancelling it again is harmless and returns `false`.

A timer can be set before `barn.show`, and it does not keep the loop alive: the
program still ends when the last window closes.

`examples/native/clock` is a stopwatch built on this — a display driven by
`barn.every` and counted by a module with no window in it.

---

## Platforms

The window model in `rust/crates/baa-native/src/gui/mod.rs` contains no Win32
and is unit-tested without a screen. The backend behind it is a trait with one
implementation, for Windows.

On any other platform `barn.show` reports that there is no backend, naming the
platform. It does not silently do nothing, and the rest of the runtime works:
`baa app build --console` on Linux produces a working command-line program.

Adding a second backend means implementing `Backend` — create a window, sync
changed widgets, pump one event, plus dialogs and clipboard. It does not mean
touching the layout, the API or anything in `src/`.
