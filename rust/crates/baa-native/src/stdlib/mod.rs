//! The standard library available to a native application.
//!
//! Not all of it. `gate` serves web pages over CGI and has no meaning in a
//! window. The list below is the promise: `src/native/bundle.ts` refuses an
//! import that is not on it at build time, and `tests/native.test.ts` asserts
//! the two lists match, so a module added to one and forgotten in the other
//! fails a test rather than a user.
//!
//! One module is not whole. `wool`'s five pattern functions need a
//! regular-expression engine and report that they are missing when called;
//! everything else in `wool` works. That is recorded here, in the module's own
//! documentation, in docs/native-applications.md and in ROADMAP.md, because a
//! gap nobody wrote down is indistinguishable from a bug.

pub mod barn;
pub mod flock;
pub mod glob;
pub mod lamb;
pub mod meadow;
pub mod pasture;
pub mod ram;
pub mod shepherd;
pub mod wool;

use std::cell::RefCell;
use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Environment, Flow, Interpreter, Res};
use crate::value::{deep_clone, display, equal, inspect, BaaMap, MapKey, Module, Native, Value};

/// Every standard module a native application can import.
pub const MODULES: &[&str] =
    &["barn", "flock", "lamb", "meadow", "pasture", "ram", "shepherd", "wool"];

pub fn load(name: &str) -> Option<Rc<Module>> {
    match name {
        "ram" => Some(ram::module()),
        "wool" => Some(wool::module()),
        "flock" => Some(flock::module()),
        "lamb" => Some(lamb::module()),
        "pasture" => Some(pasture::module()),
        "barn" => Some(barn::module()),
        "meadow" => Some(meadow::module()),
        "shepherd" => Some(shepherd::module()),
        _ => None,
    }
}

pub fn module_of(name: &str, exports: Vec<(&str, Value)>) -> Rc<Module> {
    Rc::new(Module {
        name: Rc::from(name),
        exports: RefCell::new(exports.into_iter().map(|(key, value)| (Rc::from(key), value)).collect()),
    })
}

/// Names available without an import. Kept short on purpose: a small prelude
/// is fewer names a program can shadow by accident.
pub fn install_prelude(globals: &Rc<Environment>) {
    let entries: &[(&'static str, usize, usize)] = &[
        ("len", 1, 1),
        ("type_of", 1, 1),
        ("to_string", 1, 1),
        ("inspect", 1, 1),
        ("to_number", 1, 1),
        ("clone", 1, 1),
        ("assert", 1, 2),
        ("assert_eq", 2, 3),
        ("panic", 1, 1),
        ("exit", 0, 1),
    ];
    for (name, min, max) in entries {
        globals.define(
            Rc::from(*name),
            Value::Native(Rc::new(Native {
                name: name.to_string(),
                method: name,
                min_args: *min,
                max_args: *max,
                call: prelude_call,
                receiver: None,
            })),
            false,
        );
    }
}

fn prelude_call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let first = args.first().cloned().unwrap_or(Value::Nil);
    Ok(match native.method {
        "len" => Value::Number(match &first {
            Value::Str(text) => text.chars().count() as f64,
            Value::Array(items) => items.borrow().len() as f64,
            Value::Map(map) => map.borrow().len() as f64,
            Value::Range(range) => range.length(),
            other => {
                return Err(Flow::Err(
                    interp
                        .error(
                            "BAA311",
                            vec![
                                "len".into(),
                                "a string, array, map or range".into(),
                                "1".into(),
                                other.describe(),
                            ],
                            span,
                        )
                        .with_note("has no length"),
                ))
            }
        }),
        "type_of" => Value::str(first.type_name()),
        "to_string" => Value::str(display(&first)),
        "inspect" => Value::str(inspect(&first)),
        "to_number" => match &first {
            Value::Number(value) => Value::Number(*value),
            Value::Bool(flag) => Value::Number(if *flag { 1.0 } else { 0.0 }),
            Value::Str(text) => match crate::number::parse(text) {
                Some(value) => Value::Number(value),
                None => Value::Nil,
            },
            _ => Value::Nil,
        },
        "clone" => deep_clone(&first),
        "assert" => {
            if first.truthy() {
                return Ok(Value::Nil);
            }
            let message = match args.get(1) {
                Some(value) => display(value),
                None => "assertion failed".to_string(),
            };
            return Err(Flow::Err(
                interp
                    .error("BAA301", vec![message], span)
                    .with_note("this assertion did not hold"),
            ));
        }
        "assert_eq" => {
            let left = first;
            let right = args.get(1).cloned().unwrap_or(Value::Nil);
            if equal(&left, &right) {
                return Ok(Value::Nil);
            }
            let label = match args.get(2) {
                Some(value) => format!("{}: ", display(value)),
                None => String::new(),
            };
            return Err(Flow::Err(
                interp
                    .error(
                        "BAA301",
                        vec![format!("{label}expected {}, got {}", inspect(&right), inspect(&left))],
                        span,
                    )
                    .with_note("these values differ"),
            ));
        }
        "panic" => return Err(Flow::Throw(first, span)),
        "exit" => {
            let code = match &first {
                Value::Nil => 0.0,
                Value::Number(value) if value.fract() == 0.0 => *value,
                other => {
                    return Err(Flow::Err(interp.error(
                        "BAA311",
                        vec!["exit".into(), "a whole number".into(), "1".into(), other.describe()],
                        span,
                    )))
                }
            };
            return Err(Flow::Exit(code as i32));
        }
        _ => Value::Nil,
    })
}

// ------------------------------------------------------- shared argument help

pub fn need_number(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<f64> {
    match args.get(index) {
        Some(Value::Number(value)) => Ok(*value),
        other => Err(Flow::Err(interp.error(
            "BAA311",
            vec![
                name.to_string(),
                "a number".into(),
                (index + 1).to_string(),
                other.cloned().unwrap_or(Value::Nil).describe(),
            ],
            span,
        ))),
    }
}

pub fn need_string(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<Rc<str>> {
    match args.get(index) {
        Some(Value::Str(text)) => Ok(text.clone()),
        other => Err(Flow::Err(interp.error(
            "BAA311",
            vec![
                name.to_string(),
                "a string".into(),
                (index + 1).to_string(),
                other.cloned().unwrap_or(Value::Nil).describe(),
            ],
            span,
        ))),
    }
}

/// Whole-number argument, for counts and bounds.
pub fn need_int(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<f64> {
    let value = need_number(interp, name, args, index, span)?;
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(Flow::Err(interp.error(
            "BAA311",
            vec![name.to_string(), "a whole number".into(), (index + 1).to_string(), "a fraction".into()],
            span,
        )));
    }
    Ok(value)
}

pub fn need_array(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<Vec<Value>> {
    match args.get(index) {
        Some(Value::Array(items)) => Ok(items.borrow().clone()),
        other => Err(Flow::Err(interp.error(
            "BAA311",
            vec![
                name.to_string(),
                "an array".into(),
                (index + 1).to_string(),
                other.cloned().unwrap_or(Value::Nil).describe(),
            ],
            span,
        ))),
    }
}

/// Reads a string field from an options map, for the `barn` API.
pub fn option_str(options: Option<&Value>, key: &str) -> Option<Rc<str>> {
    let Some(Value::Map(map)) = options else { return None };
    match map.borrow().get(&MapKey::Str(Rc::from(key))) {
        Some(Value::Str(text)) => Some(text.clone()),
        _ => None,
    }
}

pub fn option_number(options: Option<&Value>, key: &str) -> Option<f64> {
    let Some(Value::Map(map)) = options else { return None };
    match map.borrow().get(&MapKey::Str(Rc::from(key))) {
        Some(Value::Number(value)) => Some(*value),
        _ => None,
    }
}

pub fn option_value(options: Option<&Value>, key: &str) -> Option<Value> {
    let Some(Value::Map(map)) = options else { return None };
    map.borrow().get(&MapKey::Str(Rc::from(key))).cloned()
}

pub fn map_value(pairs: Vec<(&str, Value)>) -> Value {
    Value::map(BaaMap::from_pairs(pairs))
}
