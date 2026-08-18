//! `barn`: windows, controls and events.
//!
//! The module a native application uses to put something on the screen. It has
//! no counterpart in the reference implementation, because there is nothing to
//! draw on when a program is a web page: `gate` is its opposite number, and a
//! program imports one or the other, never both.
//!
//! The shape of the API is deliberate. A widget is a number, not an object,
//! because Baa has no classes and a map of methods pretending to be one would
//! be a worse lie than a handle. Everything that changes the screen is a call
//! rather than a field assignment, so there is one place where the tree and
//! the operating system are made to agree.
//!
//! ```baa
//! import barn
//!
//! const window = barn.window({ title: "Hello", width: 320, height: 140 })
//! const column = barn.column(window, { weight: 1 })
//! const label = barn.label(column, { text: "Baa", align: "center", size: 20 })
//! const button = barn.button(column, { text: "Again" })
//!
//! barn.on(button, "click", fn() { barn.set_text(label, "Baa baa") })
//!
//! barn.show(window)
//! barn.run()
//! ```

use std::rc::Rc;

use crate::ast::Span;
use crate::gui::{Align, EventKind, Kind};
use crate::interp::{Flow, Interpreter, Res};
use crate::value::{display, Module, Native, Value};

use super::{module_of, need_number, need_string, option_number, option_str, option_value};

const FUNCTIONS: &[(&str, usize, usize)] = &[
    ("window", 0, 1),
    ("row", 1, 2),
    ("column", 1, 2),
    ("label", 1, 2),
    ("button", 1, 2),
    ("input", 1, 2),
    ("text_area", 1, 2),
    ("list", 1, 2),
    ("checkbox", 1, 2),
    ("spacer", 1, 2),
    ("menu", 2, 2),
    ("item", 2, 3),
    ("separator", 1, 1),
    ("on", 3, 3),
    ("text", 1, 1),
    ("set_text", 2, 2),
    ("items", 1, 1),
    ("set_items", 2, 2),
    ("selected", 1, 1),
    ("select", 2, 2),
    ("checked", 1, 1),
    ("set_checked", 2, 2),
    ("enable", 2, 2),
    ("focus", 1, 1),
    ("title", 2, 2),
    ("show", 1, 1),
    ("run", 0, 0),
    ("close", 1, 1),
    ("quit", 0, 0),
    ("alert", 2, 3),
    ("confirm", 2, 3),
    ("open_file", 0, 2),
    ("save_file", 0, 2),
    ("clipboard", 0, 0),
    ("set_clipboard", 1, 1),
];

pub fn module() -> Rc<Module> {
    let exports = FUNCTIONS
        .iter()
        .map(|(name, min, max)| {
            (
                *name,
                Value::Native(Rc::new(Native {
                    name: format!("barn.{name}"),
                    method: name,
                    min_args: *min,
                    max_args: *max,
                    call,
                    receiver: None,
                })),
            )
        })
        .collect();
    module_of("barn", exports)
}

/// A widget handle: the index into the tree, as a Baa number.
fn widget_of(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<usize> {
    let value = need_number(interp, name, args, index, span)?;
    let id = value as usize;
    if value < 0.0 || value.fract() != 0.0 || interp.ui.get(id).is_none() {
        return Err(Flow::Err(
            interp
                .error(
                    "BAA311",
                    // The value itself, not its type: "expected a widget,
                    // but got a number" is true and unhelpful when the thing
                    // it got is 999.
                    vec![
                        name.to_string(),
                        "a widget".into(),
                        (index + 1).to_string(),
                        crate::value::display(&args[index]),
                    ],
                    span,
                )
                .with_note("not a widget this program created")
                .with_help("Pass the value a `barn.window` or `barn.button` call returned."),
        ));
    }
    Ok(id)
}

fn align_of(text: Option<Rc<str>>) -> Align {
    match text.as_deref() {
        Some("center") => Align::Center,
        Some("right") | Some("end") => Align::End,
        _ => Align::Start,
    }
}

/// Applies the options every widget accepts.
fn configure(interp: &mut Interpreter, id: usize, options: Option<&Value>) {
    // A window's caption is `title`; every other widget calls its text `text`.
    // Reading both means neither spelling is silently ignored.
    let text = option_str(options, "text").or_else(|| option_str(options, "title"));
    let align = option_str(options, "align");
    let items = option_value(options, "items");
    let weight = option_number(options, "weight");
    let width = option_number(options, "width");
    let height = option_number(options, "height");
    let padding = option_number(options, "padding");
    let spacing = option_number(options, "spacing");
    let size = option_number(options, "size");
    let selected = option_number(options, "selected");
    let enabled = option_value(options, "enabled");
    let checked = option_value(options, "checked");

    let Some(widget) = interp.ui.get_mut(id) else { return };
    if let Some(text) = text {
        widget.text = text.to_string();
    }
    widget.align = align_of(align);
    if let Some(weight) = weight {
        widget.weight = weight.max(0.0);
    }
    widget.width = width;
    widget.height = height;
    if let Some(padding) = padding {
        widget.padding = padding.max(0.0);
    }
    if let Some(spacing) = spacing {
        widget.spacing = spacing.max(0.0);
    }
    if let Some(size) = size {
        widget.font_size = size.max(0.0);
    }
    if let Some(selected) = selected {
        widget.selected = selected as i64;
    }
    if let Some(enabled) = enabled {
        widget.enabled = enabled.truthy();
    }
    if let Some(checked) = checked {
        widget.checked = checked.truthy();
    }
    if let Some(Value::Array(list)) = items {
        widget.items = list.borrow().iter().map(display).collect();
    }
}

fn call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let name = &native.name;

    // Creating a widget: every constructor but `window` takes its parent
    // first, and an optional map of options second.
    let kind = match native.method {
        "window" => Some(Kind::Window),
        "row" => Some(Kind::Row),
        "column" => Some(Kind::Column),
        "label" => Some(Kind::Label),
        "button" => Some(Kind::Button),
        "input" => Some(Kind::Edit),
        "text_area" => Some(Kind::TextArea),
        "list" => Some(Kind::List),
        "checkbox" => Some(Kind::Checkbox),
        "spacer" => Some(Kind::Spacer),
        "menu" => Some(Kind::Menu),
        "item" => Some(Kind::MenuItem),
        "separator" => Some(Kind::Separator),
        _ => None,
    };
    if let Some(kind) = kind {
        let (parent, options) = if kind == Kind::Window {
            (None, args.first())
        } else {
            (Some(widget_of(interp, name, &args, 0, span)?), args.get(1))
        };
        // A menu or an item takes its label directly, because a label is all
        // it has: `barn.item(file, "Open…")` rather than a map holding one key.
        let label = if matches!(kind, Kind::Menu | Kind::MenuItem) {
            match args.get(1) {
                Some(Value::Str(text)) => Some(text.clone()),
                _ => None,
            }
        } else {
            None
        };
        if let Some(parent) = parent {
            if interp.ui.widgets[parent].handle != 0 {
                return Err(Flow::Err(
                    interp
                        .error("BAA301", vec![format!("{name} was called after the window was shown")], span)
                        .with_note("the window already exists")
                        .with_help("Build the whole tree, then call `barn.show`."),
                ));
            }
        }
        let id = interp.ui.add(kind, parent);
        let options = options.cloned();
        if let Some(label) = label {
            interp.ui.widgets[id].text = label.to_string();
        } else {
            configure(interp, id, options.as_ref());
        }
        if kind == Kind::Window {
            let widget = interp.ui.get_mut(id).expect("just created");
            if widget.text.is_empty() {
                widget.text = "Baa".to_string();
            }
            widget.width = widget.width.or(Some(480.0));
            widget.height = widget.height.or(Some(360.0));
        }
        return Ok(Value::Number(id as f64));
    }

    Ok(match native.method {
        "on" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            let event = need_string(interp, name, &args, 1, span)?;
            let handler = args[2].clone();
            if !handler.callable() {
                return Err(Flow::Err(
                    interp
                        .error("BAA303", vec!["the handler".into()], span)
                        .with_note(format!("this is {}", handler.describe()))
                        .with_help("Pass a function: `barn.on(button, \"click\", fn() { ... })`."),
                ));
            }
            let kind = match &*event {
                "click" => EventKind::Click,
                "change" => EventKind::Changed,
                "select" => EventKind::Select,
                "toggle" => EventKind::Toggle,
                "close" => EventKind::Close,
                other => {
                    return Err(Flow::Err(
                        interp
                            .error(
                                "BAA311",
                                vec![
                                    name.clone(),
                                    "\"click\", \"change\", \"select\", \"toggle\" or \"close\"".into(),
                                    "2".into(),
                                    format!("\"{other}\""),
                                ],
                                span,
                            )
                            .with_note("no such event"),
                    ))
                }
            };
            interp.handlers.push((widget, kind, handler));
            Value::Nil
        }
        "text" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            Value::str(interp.ui.widgets[widget].text.clone())
        }
        "set_text" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            let text = display(&args[1]);
            let target = &mut interp.ui.widgets[widget];
            target.text = text;
            target.dirty = true;
            Value::Nil
        }
        "items" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            Value::array(interp.ui.widgets[widget].items.iter().map(Value::str).collect())
        }
        "set_items" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            let Value::Array(list) = &args[1] else {
                return interp.fail(
                    "BAA311",
                    vec![name.clone(), "an array".into(), "2".into(), args[1].describe()],
                    span,
                );
            };
            let items: Vec<String> = list.borrow().iter().map(display).collect();
            let target = &mut interp.ui.widgets[widget];
            target.items = items;
            // A list whose contents changed has no meaningful old selection.
            target.selected = -1;
            target.dirty = true;
            Value::Nil
        }
        "selected" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            Value::Number(interp.ui.widgets[widget].selected as f64)
        }
        "select" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            let index = need_number(interp, name, &args, 1, span)?;
            let target = &mut interp.ui.widgets[widget];
            target.selected = index as i64;
            target.dirty = true;
            Value::Nil
        }
        "checked" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            Value::Bool(interp.ui.widgets[widget].checked)
        }
        "set_checked" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            let checked = args[1].truthy();
            let target = &mut interp.ui.widgets[widget];
            target.checked = checked;
            target.dirty = true;
            Value::Nil
        }
        "enable" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            let enabled = args[1].truthy();
            let target = &mut interp.ui.widgets[widget];
            target.enabled = enabled;
            target.dirty = true;
            Value::Nil
        }
        "focus" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            #[cfg(windows)]
            crate::gui::win32::focus(&interp.ui, widget);
            #[cfg(not(windows))]
            let _ = widget;
            Value::Nil
        }
        "title" => {
            let widget = widget_of(interp, name, &args, 0, span)?;
            let text = display(&args[1]);
            let target = &mut interp.ui.widgets[widget];
            target.text = text;
            target.dirty = true;
            Value::Nil
        }
        "show" => {
            let window = widget_of(interp, name, &args, 0, span)?;
            if interp.ui.widgets[window].kind != Kind::Window {
                return interp.fail(
                    "BAA311",
                    vec![name.clone(), "a window".into(), "1".into(), "another widget".into()],
                    span,
                );
            }
            let mut backend = match interp.backend.take() {
                Some(backend) => backend,
                None => return Err(Flow::Err(no_backend(interp, span))),
            };
            let outcome = backend.create_window(&mut interp.ui, window);
            interp.backend = Some(backend);
            if let Err(reason) = outcome {
                return Err(Flow::Err(
                    interp.error("BAA301", vec![reason], span).with_note("the window did not open"),
                ));
            }
            Value::Nil
        }
        "run" => {
            run_event_loop(interp, span)?;
            Value::Nil
        }
        "close" => {
            let window = widget_of(interp, name, &args, 0, span)?;
            let mut backend = match interp.backend.take() {
                Some(backend) => backend,
                None => return Err(Flow::Err(no_backend(interp, span))),
            };
            backend.close(&mut interp.ui, window);
            interp.backend = Some(backend);
            Value::Nil
        }
        "quit" => {
            let windows = interp.ui.windows.clone();
            let mut backend = match interp.backend.take() {
                Some(backend) => backend,
                None => return Err(Flow::Err(no_backend(interp, span))),
            };
            for window in windows {
                if interp.ui.widgets[window].handle != 0 {
                    backend.close(&mut interp.ui, window);
                }
            }
            interp.backend = Some(backend);
            Value::Nil
        }
        "alert" | "confirm" => {
            let window = widget_of(interp, name, &args, 0, span)?;
            let title = display(&args[1]);
            let text = if args.len() > 2 { display(&args[2]) } else { String::new() };
            let (title, text) = if text.is_empty() { (String::from("Baa"), title) } else { (title, text) };
            let mut backend = match interp.backend.take() {
                Some(backend) => backend,
                None => return Err(Flow::Err(no_backend(interp, span))),
            };
            let answer = backend.message(
                &interp.ui,
                window,
                &title,
                &text,
                if native.method == "confirm" { "ask" } else { "info" },
            );
            interp.backend = Some(backend);
            if native.method == "confirm" {
                Value::Bool(answer)
            } else {
                Value::Nil
            }
        }
        "open_file" | "save_file" => {
            let window = if args.is_empty() {
                interp.ui.windows.first().copied().unwrap_or(0)
            } else {
                widget_of(interp, name, &args, 0, span)?
            };
            let filter = if args.len() > 1 {
                need_string(interp, name, &args, 1, span)?
            } else {
                Rc::from("All files|*.*")
            };
            let mut backend = match interp.backend.take() {
                Some(backend) => backend,
                None => return Err(Flow::Err(no_backend(interp, span))),
            };
            let chosen = backend.file_dialog(&interp.ui, window, native.method == "save_file", &filter);
            interp.backend = Some(backend);
            match chosen {
                Some(path) => Value::str(path),
                None => Value::Nil,
            }
        }
        "clipboard" => {
            let mut backend = match interp.backend.take() {
                Some(backend) => backend,
                None => return Err(Flow::Err(no_backend(interp, span))),
            };
            let text = backend.clipboard_get();
            interp.backend = Some(backend);
            match text {
                Some(text) => Value::str(text),
                None => Value::Nil,
            }
        }
        "set_clipboard" => {
            let text = display(&args[0]);
            let mut backend = match interp.backend.take() {
                Some(backend) => backend,
                None => return Err(Flow::Err(no_backend(interp, span))),
            };
            let ok = backend.clipboard_set(&text);
            interp.backend = Some(backend);
            Value::Bool(ok)
        }
        _ => Value::Nil,
    })
}

fn no_backend(interp: &Interpreter, span: Span) -> crate::diag::BaaError {
    interp
        .error(
            "BAA301",
            vec![format!(
                "`barn` has no window backend on {}",
                std::env::consts::OS
            )],
            span,
        )
        .with_note("no backend for this platform")
        .with_help("Windows is the only platform with a `barn` backend today. See docs/gui.md.")
}

/// The event loop.
///
/// One turn is: let the operating system deliver a message, then run whatever
/// handlers that message produced, then push any changes those handlers made
/// back to the screen. Handlers run here rather than inside the window
/// procedure, so a handler can do anything a Baa function can do, including
/// opening another window or failing with a diagnostic.
fn run_event_loop(interp: &mut Interpreter, span: Span) -> Res<()> {
    if interp.ui.windows.iter().all(|id| interp.ui.widgets[*id].handle == 0) {
        return Err(Flow::Err(
            interp
                .error("BAA301", vec!["`barn.run` was called with no window on screen".into()], span)
                .with_note("nothing to run")
                .with_help("Call `barn.show(window)` first."),
        ));
    }

    loop {
        let mut backend = match interp.backend.take() {
            Some(backend) => backend,
            None => return Err(Flow::Err(no_backend(interp, span))),
        };
        let running = backend.pump(&mut interp.ui);
        interp.backend = Some(backend);
        if !running {
            return Ok(());
        }

        while let Some(event) = interp.ui.events.pop_front() {
            let handlers: Vec<Value> = interp
                .handlers
                .iter()
                .filter(|(widget, kind, _)| *widget == event.widget && *kind == event.kind)
                .map(|(_, _, handler)| handler.clone())
                .collect();
            for handler in handlers {
                interp.call_callback(&handler, vec![Value::Number(event.widget as f64)], span)?;
            }
            // A close with no handler means the obvious thing. With one, the
            // handler decides, which is what makes "save before closing?"
            // possible.
            if event.kind == EventKind::Close
                && !interp
                    .handlers
                    .iter()
                    .any(|(widget, kind, _)| *widget == event.widget && *kind == EventKind::Close)
            {
                // Not an `expect`: a handler runs arbitrary Baa code between
                // the check above and here, and an invariant that holds today
                // should still fail as a diagnostic rather than a panic.
                let Some(mut backend) = interp.backend.take() else {
                    return Err(Flow::Err(no_backend(interp, span)));
                };
                backend.close(&mut interp.ui, event.widget);
                interp.backend = Some(backend);
            }
        }

        let Some(mut backend) = interp.backend.take() else {
            return Err(Flow::Err(no_backend(interp, span)));
        };
        backend.sync(&mut interp.ui);
        interp.backend = Some(backend);
    }
}
