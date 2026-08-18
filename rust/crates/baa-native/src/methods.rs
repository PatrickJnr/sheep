//! Methods on values: `text.upper()`, `items.map(f)`, `map.keys()`.
//!
//! A port of `src/runtime/methods.ts`. Every method here exists there, with the
//! same name, the same arity and the same behaviour at the edges, which is
//! where the two would otherwise part company: negative indexes, what `slice`
//! does when the bounds cross, whether `sort` is stable.
//!
//! One dispatcher per receiver type, matching on the method name, rather than
//! one function per method. The lookup builds a bound `Native` that remembers
//! which value it came from.

use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Flow, Interpreter, Res, MAX_SIZE};
use crate::number;
use crate::value::{display, equal, inspect, BaaMap, MapKey, Native, Range, Value};

/// `(name, min args, max args)` for each method, by receiver type.
const UNIVERSAL: &[(&str, usize, usize)] =
    &[("to_string", 0, 0), ("inspect", 0, 0), ("type_of", 0, 0)];

const STRING: &[(&str, usize, usize)] = &[
    ("length", 0, 0),
    ("is_empty", 0, 0),
    ("upper", 0, 0),
    ("lower", 0, 0),
    ("trim", 0, 0),
    ("trim_start", 0, 0),
    ("trim_end", 0, 0),
    ("contains", 1, 1),
    ("starts_with", 1, 1),
    ("ends_with", 1, 1),
    ("index_of", 1, 1),
    ("split", 0, 1),
    ("lines", 0, 0),
    ("chars", 0, 0),
    ("replace", 2, 2),
    ("replace_all", 2, 2),
    ("slice", 1, 2),
    ("repeat", 1, 1),
    ("pad_start", 1, 2),
    ("pad_end", 1, 2),
    ("reverse", 0, 0),
    ("to_number", 0, 0),
];

const ARRAY: &[(&str, usize, usize)] = &[
    ("length", 0, 0),
    ("is_empty", 0, 0),
    ("push", 1, usize::MAX),
    ("pop", 0, 0),
    ("shift", 0, 0),
    ("unshift", 1, usize::MAX),
    ("insert", 2, 2),
    ("remove", 1, 1),
    ("clear", 0, 0),
    ("contains", 1, 1),
    ("index_of", 1, 1),
    ("first", 0, 0),
    ("last", 0, 0),
    ("slice", 1, 2),
    ("concat", 1, 1),
    ("join", 0, 1),
    ("reverse", 0, 0),
    ("map", 1, 1),
    ("filter", 1, 1),
    ("reduce", 2, 2),
    ("for_each", 1, 1),
    ("find", 1, 1),
    ("any", 1, 1),
    ("all", 1, 1),
    ("count", 0, 1),
    ("sort", 0, 1),
    ("unique", 0, 0),
    ("flatten", 0, 0),
    ("sum", 0, 0),
];

const MAP: &[(&str, usize, usize)] = &[
    ("length", 0, 0),
    ("is_empty", 0, 0),
    ("get", 1, 2),
    ("expect", 1, 1),
    ("set", 2, 2),
    ("has", 1, 1),
    ("remove", 1, 1),
    ("clear", 0, 0),
    ("keys", 0, 0),
    ("values", 0, 0),
    ("entries", 0, 0),
    ("merge", 1, 1),
    ("for_each", 1, 1),
];

const RANGE: &[(&str, usize, usize)] = &[
    ("length", 0, 0),
    ("start", 0, 0),
    ("end", 0, 0),
    ("is_empty", 0, 0),
    ("contains", 1, 1),
    ("to_array", 0, 0),
];

const NUMBER: &[(&str, usize, usize)] = &[
    ("abs", 0, 0),
    ("floor", 0, 0),
    ("ceil", 0, 0),
    ("round", 0, 0),
    ("is_whole", 0, 0),
    ("to_fixed", 1, 1),
    ("clamp", 2, 2),
];

const FUNCTION: &[(&str, usize, usize)] = &[("name", 0, 0)];

fn table_for(value: &Value) -> Option<&'static [(&'static str, usize, usize)]> {
    Some(match value {
        Value::Str(_) => STRING,
        Value::Number(_) => NUMBER,
        Value::Array(_) => ARRAY,
        Value::Map(_) => MAP,
        Value::Range(_) => RANGE,
        Value::Function(_) | Value::Native(_) => FUNCTION,
        _ => return None,
    })
}

/// Every method name a value has, for "did you mean".
pub fn names(value: &Value) -> Vec<String> {
    let mut out: Vec<String> = UNIVERSAL.iter().map(|(name, _, _)| name.to_string()).collect();
    if let Some(table) = table_for(value) {
        out.extend(table.iter().map(|(name, _, _)| name.to_string()));
    }
    out
}

/// The method, bound to its receiver, or `None` when the type has no such
/// method: the caller turns that into a `BAA305` with a suggestion.
pub fn lookup(value: &Value, name: &str) -> Option<Value> {
    let table = table_for(value);
    let found = table
        .and_then(|table| table.iter().find(|(method, _, _)| *method == name))
        .or_else(|| UNIVERSAL.iter().find(|(method, _, _)| *method == name))?;

    // The static name is taken from the table so it outlives the lookup.
    let (method, min, max) = *found;
    let label = format!("{}.{}", value.type_name(), method);
    Some(Native::bound(label, method, min, max, dispatch, value.clone()))
}

// ------------------------------------------------------------------- helpers

fn arg(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Nil)
}

fn need_string(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<Rc<str>> {
    match args.get(index) {
        Some(Value::Str(text)) => Ok(text.clone()),
        other => Err(Flow::Err(
            interp
                .error(
                    "BAA311",
                    vec![
                        name.to_string(),
                        "a string".into(),
                        index.to_string(),
                        other.cloned().unwrap_or(Value::Nil).describe(),
                    ],
                    span,
                )
                .with_note("wrong type here"),
        )),
    }
}

fn need_number(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<f64> {
    match args.get(index) {
        Some(Value::Number(number)) => Ok(*number),
        other => Err(Flow::Err(
            interp
                .error(
                    "BAA311",
                    vec![
                        name.to_string(),
                        "a number".into(),
                        index.to_string(),
                        other.cloned().unwrap_or(Value::Nil).describe(),
                    ],
                    span,
                )
                .with_note("wrong type here"),
        )),
    }
}

fn need_index(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<f64> {
    let value = need_number(interp, name, args, index, span)?;
    if value.fract() != 0.0 || !value.is_finite() {
        return Err(Flow::Err(interp.error(
            "BAA311",
            vec![
                name.to_string(),
                "a whole number".into(),
                index.to_string(),
                "a number".into(),
            ],
            span,
        )));
    }
    Ok(value)
}

fn need_array(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<Vec<Value>> {
    match args.get(index) {
        Some(Value::Array(items)) => Ok(items.borrow().clone()),
        other => Err(Flow::Err(interp.error(
            "BAA311",
            vec![
                name.to_string(),
                "an array".into(),
                index.to_string(),
                other.cloned().unwrap_or(Value::Nil).describe(),
            ],
            span,
        ))),
    }
}

fn need_key(interp: &Interpreter, name: &str, args: &[Value], index: usize, span: Span) -> Res<MapKey> {
    let value = arg(args, index);
    MapKey::from_value(&value).ok_or_else(|| {
        Flow::Err(interp.error(
            "BAA311",
            vec![
                name.to_string(),
                "a string, number, bool or nil".into(),
                index.to_string(),
                value.describe(),
            ],
            span,
        ))
    })
}

/// A count the program supplied, refused before it becomes an allocation
/// failure. Mirrors `checkSize` in the reference implementation.
fn check_size(interp: &Interpreter, name: &str, count: f64, span: Span) -> Res<usize> {
    if !count.is_finite() || count > MAX_SIZE as f64 {
        return Err(Flow::Err(
            interp
                .error(
                    "BAA312",
                    vec![name.to_string(), number::format(count), number::format(MAX_SIZE as f64)],
                    span,
                )
                .with_note("too many at once")
                .with_help("Build it in smaller pieces, or check the count for a mistake."),
        ));
    }
    Ok(count.max(0.0) as usize)
}

/// Negative indexes count from the end. Unlike an element read, a `slice`
/// bound is clamped rather than refused.
fn normalise(index: f64, length: usize) -> f64 {
    if index < 0.0 {
        length as f64 + index
    } else {
        index
    }
}

fn compare_values(interp: &Interpreter, a: &Value, b: &Value, span: Span) -> Res<std::cmp::Ordering> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            Ok(x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal))
        }
        (Value::Str(x), Value::Str(y)) => Ok(x.cmp(y)),
        _ => Err(Flow::Err(
            interp
                .error("BAA302", vec!["compare".into(), a.describe(), b.describe()], span)
                .with_note("sorting needs values of the same comparable type")
                .with_help("Pass a comparison function: `items.sort(fn(a, b) { return a.age - b.age })`."),
        )),
    }
}

/// A stable merge sort, because the comparison can fail and `sort_by` has
/// nowhere to put an error. Stability is not incidental: the reference uses
/// JavaScript's sort, which the specification requires to be stable.
fn sort_by<F>(items: &mut Vec<Value>, mut compare: F) -> Res<()>
where
    F: FnMut(&Value, &Value) -> Res<std::cmp::Ordering>,
{
    let length = items.len();
    if length < 2 {
        return Ok(());
    }
    let mut buffer = items.clone();
    let mut width = 1;
    while width < length {
        let mut start = 0;
        while start < length {
            let middle = (start + width).min(length);
            let end = (start + 2 * width).min(length);
            let (mut left, mut right, mut at) = (start, middle, start);
            while left < middle && right < end {
                if compare(&items[left], &items[right])? == std::cmp::Ordering::Greater {
                    buffer[at] = items[right].clone();
                    right += 1;
                } else {
                    buffer[at] = items[left].clone();
                    left += 1;
                }
                at += 1;
            }
            while left < middle {
                buffer[at] = items[left].clone();
                left += 1;
                at += 1;
            }
            while right < end {
                buffer[at] = items[right].clone();
                right += 1;
                at += 1;
            }
            start += 2 * width;
        }
        std::mem::swap(items, &mut buffer);
        width *= 2;
    }
    Ok(())
}

// ---------------------------------------------------------------- dispatch

fn dispatch(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let receiver = args[0].clone();
    let rest = &args[1..];
    let name = native.method;

    // Available on every value, and checked first only for the three names
    // that no type-specific table uses.
    match name {
        "to_string" => return Ok(Value::str(display(&receiver))),
        "inspect" => return Ok(Value::str(inspect(&receiver))),
        "type_of" => return Ok(Value::str(receiver.type_name())),
        _ => {}
    }

    match &receiver {
        Value::Str(text) => string_method(interp, name, text, rest, span),
        Value::Number(number) => number_method(interp, name, *number, rest, span),
        Value::Array(_) => array_method(interp, name, &receiver, rest, span),
        Value::Map(_) => map_method(interp, name, &receiver, rest, span),
        Value::Range(range) => range_method(interp, name, range, rest, span),
        Value::Function(function) => Ok(Value::str(&*function.name)),
        Value::Native(inner) => Ok(Value::str(inner.name.clone())),
        other => interp.fail("BAA305", vec![other.describe(), name.to_string()], span),
    }
}

fn string_method(interp: &mut Interpreter, name: &str, text: &Rc<str>, args: &[Value], span: Span) -> Res<Value> {
    let label = format!("string.{name}");
    Ok(match name {
        "length" => Value::Number(text.chars().count() as f64),
        "is_empty" => Value::Bool(text.is_empty()),
        "upper" => Value::str(text.to_uppercase()),
        "lower" => Value::str(text.to_lowercase()),
        // Baa trims what JavaScript trims: Unicode whitespace, which is what
        // `char::is_whitespace` covers.
        "trim" => Value::str(text.trim()),
        "trim_start" => Value::str(text.trim_start()),
        "trim_end" => Value::str(text.trim_end()),
        "contains" => Value::Bool(text.contains(&*need_string(interp, &label, args, 0, span)?)),
        "starts_with" => Value::Bool(text.starts_with(&*need_string(interp, &label, args, 0, span)?)),
        "ends_with" => Value::Bool(text.ends_with(&*need_string(interp, &label, args, 0, span)?)),
        "index_of" => {
            // Counted in characters, not bytes, so the answer can be handed
            // straight back to `slice` or to `[]`.
            let needle = need_string(interp, &label, args, 0, span)?;
            match text.find(&*needle) {
                None => Value::Number(-1.0),
                Some(0) => Value::Number(0.0),
                Some(at) => Value::Number(text[..at].chars().count() as f64),
            }
        }
        "split" => {
            if args.is_empty() {
                return Ok(Value::array(text.chars().map(|c| Value::str(c.to_string())).collect()));
            }
            let separator = need_string(interp, &label, args, 0, span)?;
            if separator.is_empty() {
                Value::array(text.chars().map(|c| Value::str(c.to_string())).collect())
            } else {
                Value::array(text.split(&*separator).map(Value::str).collect())
            }
        }
        "lines" => Value::array(text.split('\n').map(Value::str).collect()),
        "chars" => Value::array(text.chars().map(|c| Value::str(c.to_string())).collect()),
        "replace" => {
            let from = need_string(interp, &label, args, 0, span)?;
            let to = need_string(interp, &label, args, 1, span)?;
            Value::str(text.replacen(&*from, &to, 1))
        }
        "replace_all" => {
            let from = need_string(interp, &label, args, 0, span)?;
            let to = need_string(interp, &label, args, 1, span)?;
            if from.is_empty() {
                // `"abc".replace_all("", "-")` in JavaScript inserts between
                // every character. Rust's `replace` does the same, so this
                // needs no special case; it is called out because it looks
                // like one.
                Value::str(text.replace(&*from, &to))
            } else {
                Value::str(text.replace(&*from, &to))
            }
        }
        "slice" => {
            let chars: Vec<char> = text.chars().collect();
            let start = normalise(need_index(interp, &label, args, 0, span)?, chars.len()).max(0.0);
            let end = if args.len() > 1 {
                normalise(need_index(interp, &label, args, 1, span)?, chars.len()).max(0.0)
            } else {
                chars.len() as f64
            };
            let start = (start as usize).min(chars.len());
            let end = (end as usize).min(chars.len());
            Value::str(if start >= end { String::new() } else { chars[start..end].iter().collect::<String>() })
        }
        "repeat" => {
            let count = need_index(interp, &label, args, 0, span)?;
            if count < 0.0 {
                return interp.fail(
                    "BAA311",
                    vec![label, "a count of 0 or more".into(), "1".into(), "a negative number".into()],
                    span,
                );
            }
            let total = check_size(interp, &label, count * text.chars().count() as f64, span)?;
            let _ = total;
            Value::str(text.repeat(count as usize))
        }
        "pad_start" | "pad_end" => {
            let width = check_size(interp, &label, need_index(interp, &label, args, 0, span)?, span)?;
            let filler = if args.len() > 1 {
                need_string(interp, &label, args, 1, span)?
            } else {
                Rc::from(" ")
            };
            // JavaScript pads to a width counted in UTF-16 code units, which
            // is what `.padStart` measures; matching it keeps a table of
            // padded text aligned identically in both runtimes.
            let current = text.encode_utf16().count();
            if current >= width || filler.is_empty() {
                Value::Str(text.clone())
            } else {
                let mut pad = String::new();
                while pad.encode_utf16().count() < width - current {
                    pad.push_str(&filler);
                }
                let mut trimmed: String = String::new();
                for ch in pad.chars() {
                    if trimmed.encode_utf16().count() + ch.len_utf16() > width - current {
                        break;
                    }
                    trimmed.push(ch);
                }
                Value::str(if name == "pad_start" {
                    format!("{trimmed}{text}")
                } else {
                    format!("{text}{trimmed}")
                })
            }
        }
        "reverse" => Value::str(text.chars().rev().collect::<String>()),
        "to_number" => match number::parse(text) {
            Some(value) => Value::Number(value),
            None => Value::Nil,
        },
        _ => return interp.fail("BAA305", vec!["a string".into(), name.to_string()], span),
    })
}

fn number_method(interp: &mut Interpreter, name: &str, value: f64, args: &[Value], span: Span) -> Res<Value> {
    let label = format!("number.{name}");
    Ok(match name {
        "abs" => Value::Number(value.abs()),
        "floor" => Value::Number(value.floor()),
        "ceil" => Value::Number(value.ceil()),
        // JavaScript's `Math.round` rounds halves towards positive infinity,
        // so -0.5 rounds to 0 rather than to -1 as Rust's `round` would.
        "round" => Value::Number((value + 0.5).floor()),
        "is_whole" => Value::Bool(value.is_finite() && value.fract() == 0.0),
        "to_fixed" => {
            let digits = need_index(interp, &label, args, 0, span)?;
            if !(0.0..=20.0).contains(&digits) {
                return interp.fail(
                    "BAA311",
                    vec![label, "0 to 20".into(), "1".into(), number::format(digits)],
                    span,
                );
            }
            Value::str(format!("{:.*}", digits as usize, value))
        }
        "clamp" => {
            let low = need_number(interp, &label, args, 0, span)?;
            let high = need_number(interp, &label, args, 1, span)?;
            Value::Number(value.max(low).min(high))
        }
        _ => return interp.fail("BAA305", vec!["a number".into(), name.to_string()], span),
    })
}

fn array_method(interp: &mut Interpreter, name: &str, receiver: &Value, args: &[Value], span: Span) -> Res<Value> {
    let Value::Array(cell) = receiver else { unreachable!("dispatched on an array") };
    let label = format!("array.{name}");
    Ok(match name {
        "length" => Value::Number(cell.borrow().len() as f64),
        "is_empty" => Value::Bool(cell.borrow().is_empty()),
        "push" => {
            check_size(interp, &label, (cell.borrow().len() + args.len()) as f64, span)?;
            cell.borrow_mut().extend(args.iter().cloned());
            receiver.clone()
        }
        "pop" => cell.borrow_mut().pop().unwrap_or(Value::Nil),
        "shift" => {
            let mut items = cell.borrow_mut();
            if items.is_empty() {
                Value::Nil
            } else {
                items.remove(0)
            }
        }
        "unshift" => {
            check_size(interp, &label, (cell.borrow().len() + args.len()) as f64, span)?;
            let mut items = cell.borrow_mut();
            for (offset, value) in args.iter().enumerate() {
                items.insert(offset, value.clone());
            }
            drop(items);
            receiver.clone()
        }
        "insert" => {
            let length = cell.borrow().len();
            check_size(interp, &label, length as f64 + 1.0, span)?;
            let at = need_index(interp, &label, args, 0, span)?;
            let at = normalise(at, length);
            if at < 0.0 || at > length as f64 {
                return Err(Flow::Err(
                    interp
                        .error(
                            "BAA304",
                            vec![number::format(at), "array".into(), length.to_string()],
                            span,
                        )
                        .with_note("index out of range"),
                ));
            }
            cell.borrow_mut().insert(at as usize, arg(args, 1));
            receiver.clone()
        }
        "remove" => {
            let length = cell.borrow().len();
            let at = normalise(need_index(interp, &label, args, 0, span)?, length);
            if at < 0.0 || at >= length as f64 {
                return Err(Flow::Err(
                    interp
                        .error(
                            "BAA304",
                            vec![number::format(at), "array".into(), length.to_string()],
                            span,
                        )
                        .with_note("index out of range"),
                ));
            }
            cell.borrow_mut().remove(at as usize)
        }
        "clear" => {
            cell.borrow_mut().clear();
            receiver.clone()
        }
        "contains" => {
            let needle = arg(args, 0);
            Value::Bool(cell.borrow().iter().any(|item| equal(item, &needle)))
        }
        "index_of" => {
            let needle = arg(args, 0);
            Value::Number(
                cell.borrow()
                    .iter()
                    .position(|item| equal(item, &needle))
                    .map(|at| at as f64)
                    .unwrap_or(-1.0),
            )
        }
        "first" => cell.borrow().first().cloned().unwrap_or(Value::Nil),
        "last" => cell.borrow().last().cloned().unwrap_or(Value::Nil),
        "slice" => {
            let items = cell.borrow().clone();
            let start = normalise(need_index(interp, &label, args, 0, span)?, items.len()).max(0.0);
            let end = if args.len() > 1 {
                normalise(need_index(interp, &label, args, 1, span)?, items.len()).max(0.0)
            } else {
                items.len() as f64
            };
            let start = (start as usize).min(items.len());
            let end = (end as usize).min(items.len());
            Value::array(if start >= end { Vec::new() } else { items[start..end].to_vec() })
        }
        "concat" => {
            let other = need_array(interp, &label, args, 0, span)?;
            let mut items = cell.borrow().clone();
            check_size(interp, &label, (items.len() + other.len()) as f64, span)?;
            items.extend(other);
            Value::array(items)
        }
        "join" => {
            let separator = if args.is_empty() {
                Rc::from("")
            } else {
                need_string(interp, &label, args, 0, span)?
            };
            let parts: Vec<String> = cell.borrow().iter().map(display).collect();
            Value::str(parts.join(&separator))
        }
        "reverse" => {
            let mut items = cell.borrow().clone();
            items.reverse();
            Value::array(items)
        }
        "map" | "filter" | "for_each" | "find" | "any" | "all" | "count" => {
            let function = arg(args, 0);
            if name == "count" && args.is_empty() {
                return Ok(Value::Number(cell.borrow().len() as f64));
            }
            let items = cell.borrow().clone();
            let mut mapped = Vec::new();
            let mut matched = 0.0;
            for (index, item) in items.iter().enumerate() {
                let outcome = interp.call_callback(
                    &function,
                    vec![item.clone(), Value::Number(index as f64)],
                    span,
                )?;
                match name {
                    "map" => mapped.push(outcome),
                    "filter" => {
                        if outcome.truthy() {
                            mapped.push(item.clone());
                        }
                    }
                    "count" => {
                        if outcome.truthy() {
                            matched += 1.0;
                        }
                    }
                    "find" => {
                        if outcome.truthy() {
                            return Ok(item.clone());
                        }
                    }
                    "any" => {
                        if outcome.truthy() {
                            return Ok(Value::Bool(true));
                        }
                    }
                    "all"
                        if !outcome.truthy() => {
                            return Ok(Value::Bool(false));
                        }
                    _ => {}
                }
            }
            match name {
                "map" | "filter" => Value::array(mapped),
                "count" => Value::Number(matched),
                "find" => Value::Nil,
                "any" => Value::Bool(false),
                "all" => Value::Bool(true),
                _ => Value::Nil,
            }
        }
        "reduce" => {
            let function = arg(args, 0);
            let mut total = arg(args, 1);
            let items = cell.borrow().clone();
            for (index, item) in items.iter().enumerate() {
                total = interp.call_callback(
                    &function,
                    vec![total, item.clone(), Value::Number(index as f64)],
                    span,
                )?;
            }
            total
        }
        "sort" => {
            let mut items = cell.borrow().clone();
            if args.is_empty() {
                sort_by(&mut items, |a, b| compare_values(interp, a, b, span))?;
            } else {
                let function = arg(args, 0);
                // The comparison runs Baa code, which can fail or throw, and
                // that has to travel out rather than be swallowed by a sort.
                let mut error = None;
                sort_by(&mut items, |a, b| {
                    if error.is_some() {
                        return Ok(std::cmp::Ordering::Equal);
                    }
                    match interp.call_callback(&function, vec![a.clone(), b.clone()], span) {
                        Ok(Value::Number(result)) => Ok(if result < 0.0 {
                            std::cmp::Ordering::Less
                        } else if result > 0.0 {
                            std::cmp::Ordering::Greater
                        } else {
                            std::cmp::Ordering::Equal
                        }),
                        Ok(other) => {
                            error = Some(Flow::Err(
                                interp
                                    .error(
                                        "BAA311",
                                        vec!["sort".into(), "a number".into(), "1".into(), other.describe()],
                                        span,
                                    )
                                    .with_note("the comparison function must return a number")
                                    .with_help("Return a negative number, zero, or a positive number."),
                            ));
                            Ok(std::cmp::Ordering::Equal)
                        }
                        Err(flow) => {
                            error = Some(flow);
                            Ok(std::cmp::Ordering::Equal)
                        }
                    }
                })?;
                if let Some(flow) = error {
                    return Err(flow);
                }
            }
            Value::array(items)
        }
        "unique" => {
            let mut out: Vec<Value> = Vec::new();
            for item in cell.borrow().iter() {
                if !out.iter().any(|existing| equal(existing, item)) {
                    out.push(item.clone());
                }
            }
            Value::array(out)
        }
        "flatten" => {
            let mut out: Vec<Value> = Vec::new();
            for item in cell.borrow().iter() {
                match item {
                    Value::Array(inner) => out.extend(inner.borrow().iter().cloned()),
                    other => out.push(other.clone()),
                }
            }
            Value::array(out)
        }
        "sum" => {
            let mut total = 0.0;
            for item in cell.borrow().iter() {
                match item {
                    Value::Number(number) => total += number,
                    other => {
                        return Err(Flow::Err(
                            interp
                                .error(
                                    "BAA302",
                                    vec!["add".into(), "a number".into(), other.describe()],
                                    span,
                                )
                                .with_note("every item must be a number"),
                        ))
                    }
                }
            }
            Value::Number(total)
        }
        _ => return interp.fail("BAA305", vec!["an array".into(), name.to_string()], span),
    })
}

fn map_method(interp: &mut Interpreter, name: &str, receiver: &Value, args: &[Value], span: Span) -> Res<Value> {
    let Value::Map(cell) = receiver else { unreachable!("dispatched on a map") };
    let label = format!("map.{name}");
    Ok(match name {
        "length" => Value::Number(cell.borrow().len() as f64),
        "is_empty" => Value::Bool(cell.borrow().is_empty()),
        "get" => {
            let key = need_key(interp, &label, args, 0, span)?;
            let fallback = if args.len() > 1 { arg(args, 1) } else { Value::Nil };
            cell.borrow().get(&key).cloned().unwrap_or(fallback)
        }
        "expect" => {
            let key = need_key(interp, &label, args, 0, span)?;
            match cell.borrow().get(&key) {
                Some(value) => value.clone(),
                None => {
                    return Err(Flow::Err(
                        interp
                            .error("BAA310", vec![display(&key.to_value())], span)
                            .with_note("no such key")
                            .with_help("Use `get(key, fallback)` when the key may be missing."),
                    ))
                }
            }
        }
        "set" => {
            let key = need_key(interp, &label, args, 0, span)?;
            cell.borrow_mut().set(key, arg(args, 1));
            receiver.clone()
        }
        "has" => {
            let key = need_key(interp, &label, args, 0, span)?;
            let has = cell.borrow().has(&key);
            Value::Bool(has)
        }
        "remove" => {
            let key = need_key(interp, &label, args, 0, span)?;
            let removed = cell.borrow_mut().remove(&key);
            removed.unwrap_or(Value::Nil)
        }
        "clear" => {
            cell.borrow_mut().clear();
            receiver.clone()
        }
        "keys" => Value::array(cell.borrow().iter().map(|(key, _)| key.to_value()).collect()),
        "values" => Value::array(cell.borrow().iter().map(|(_, value)| value.clone()).collect()),
        "entries" => Value::array(
            cell.borrow()
                .iter()
                .map(|(key, value)| Value::array(vec![key.to_value(), value.clone()]))
                .collect(),
        ),
        "merge" => {
            let Some(Value::Map(other)) = args.first() else {
                return interp.fail(
                    "BAA311",
                    vec![label, "a map".into(), "1".into(), arg(args, 0).describe()],
                    span,
                );
            };
            let mut merged = BaaMap::new();
            for (key, value) in cell.borrow().iter() {
                merged.set(key.clone(), value.clone());
            }
            for (key, value) in other.borrow().iter() {
                merged.set(key.clone(), value.clone());
            }
            Value::map(merged)
        }
        "for_each" => {
            let function = arg(args, 0);
            let entries: Vec<(MapKey, Value)> = cell.borrow().iter().cloned().collect();
            for (key, value) in entries {
                interp.call_callback(&function, vec![key.to_value(), value], span)?;
            }
            Value::Nil
        }
        _ => return interp.fail("BAA305", vec!["a map".into(), name.to_string()], span),
    })
}

fn range_method(interp: &mut Interpreter, name: &str, range: &Rc<Range>, args: &[Value], span: Span) -> Res<Value> {
    let label = format!("range.{name}");
    Ok(match name {
        "length" => Value::Number(range.length()),
        "start" => Value::Number(range.start),
        "end" => Value::Number(range.end),
        "is_empty" => Value::Bool(range.length() == 0.0),
        "contains" => Value::Bool(range.contains(need_number(interp, &label, args, 0, span)?)),
        "to_array" => {
            check_size(interp, &label, range.length(), span)?;
            Value::array(range.values().into_iter().map(Value::Number).collect())
        }
        _ => return interp.fail("BAA305", vec!["a range".into(), name.to_string()], span),
    })
}
