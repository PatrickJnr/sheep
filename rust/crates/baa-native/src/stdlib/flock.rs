//! `flock`: collections. A port of `src/stdlib/flock.ts`.
//!
//! Every function takes a collection and returns a new one; nothing here
//! mutates its argument. That is the same contract the reference has, and it
//! is what makes `flock.sort_by(sheep, age)` safe to call on something another
//! part of the program is still holding.

use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Flow, Interpreter, Res, MAX_SIZE};
use crate::number;
use crate::value::{BaaMap, MapKey, Module, Native, Value};

use super::{module_of, need_array, need_int};

const FUNCTIONS: &[(&str, usize, usize)] = &[
    ("of", 0, usize::MAX),
    ("repeat", 2, 2),
    ("zip", 2, 2),
    ("chunk", 2, 2),
    ("group_by", 2, 2),
    ("partition", 2, 2),
    ("sort_by", 2, 2),
    ("min_by", 2, 2),
    ("max_by", 2, 2),
    ("to_map", 1, 1),
    ("from_keys", 2, 2),
    ("invert", 1, 1),
    ("range", 1, 3),
    ("to_array", 1, 1),
];

pub fn module() -> Rc<Module> {
    let exports = FUNCTIONS
        .iter()
        .map(|(name, min, max)| {
            (
                *name,
                Value::Native(Rc::new(Native {
                    name: format!("flock.{name}"),
                    method: name,
                    min_args: *min,
                    max_args: *max,
                    call,
                    receiver: None,
                })),
            )
        })
        .collect();
    module_of("flock", exports)
}

fn check_size(interp: &Interpreter, name: &str, count: f64, span: Span) -> Res<()> {
    if !count.is_finite() || count > MAX_SIZE as f64 {
        return Err(Flow::Err(
            interp
                .error(
                    "BAA312",
                    vec![name.to_string(), number::format(count), number::format(MAX_SIZE as f64)],
                    span,
                )
                .with_note("too many at once"),
        ));
    }
    Ok(())
}

/// Compares two sort keys, which must be all numbers or all strings.
fn compare_keys(interp: &Interpreter, a: &Value, b: &Value, span: Span) -> Res<std::cmp::Ordering> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => Ok(x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal)),
        (Value::Str(x), Value::Str(y)) => Ok(x.cmp(y)),
        _ => Err(Flow::Err(
            interp
                .error("BAA302", vec!["compare".into(), a.describe(), b.describe()], span)
                .with_note("sort keys must be all numbers or all strings"),
        )),
    }
}

fn call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let name = native.name.clone();
    Ok(match native.method {
        "of" => Value::array(args),
        "repeat" => {
            let count = need_int(interp, &name, &args, 1, span)?;
            check_size(interp, &name, count, span)?;
            let value = args[0].clone();
            Value::array(vec![value; count.max(0.0) as usize])
        }
        "zip" => {
            let left = need_array(interp, &name, &args, 0, span)?;
            let right = need_array(interp, &name, &args, 1, span)?;
            Value::array(
                left.into_iter()
                    .zip(right)
                    .map(|(a, b)| Value::array(vec![a, b]))
                    .collect(),
            )
        }
        "chunk" => {
            let items = need_array(interp, &name, &args, 0, span)?;
            let size = need_int(interp, &name, &args, 1, span)?;
            if size < 1.0 {
                return interp.fail(
                    "BAA311",
                    vec![name, "a size of 1 or more".into(), "2".into(), number::format(size)],
                    span,
                );
            }
            Value::array(
                items
                    .chunks(size as usize)
                    .map(|chunk| Value::array(chunk.to_vec()))
                    .collect(),
            )
        }
        "group_by" => {
            let items = need_array(interp, &name, &args, 0, span)?;
            let key_fn = args[1].clone();
            let mut groups = BaaMap::new();
            for item in items {
                let key_value = interp.call_callback(&key_fn, vec![item.clone()], span)?;
                let Some(key) = MapKey::from_value(&key_value) else {
                    return interp.fail(
                        "BAA311",
                        vec![name, "a key the map accepts".into(), "2".into(), key_value.describe()],
                        span,
                    );
                };
                match groups.get(&key) {
                    Some(Value::Array(existing)) => existing.borrow_mut().push(item),
                    _ => groups.set(key, Value::array(vec![item])),
                }
            }
            Value::map(groups)
        }
        "partition" => {
            let items = need_array(interp, &name, &args, 0, span)?;
            let test = args[1].clone();
            let (mut yes, mut no) = (Vec::new(), Vec::new());
            for item in items {
                if interp.call_callback(&test, vec![item.clone()], span)?.truthy() {
                    yes.push(item);
                } else {
                    no.push(item);
                }
            }
            Value::array(vec![Value::array(yes), Value::array(no)])
        }
        "sort_by" => {
            let items = need_array(interp, &name, &args, 0, span)?;
            let key_fn = args[1].clone();
            // Decorate, sort, undecorate: the key function runs once per item
            // rather than twice per comparison, which matters when it is Baa
            // code rather than a field read.
            let mut decorated = Vec::with_capacity(items.len());
            for item in items {
                let key = interp.call_callback(&key_fn, vec![item.clone()], span)?;
                decorated.push((key, item));
            }
            let mut failure = None;
            decorated.sort_by(|a, b| match compare_keys(interp, &a.0, &b.0, span) {
                Ok(ordering) => ordering,
                Err(flow) => {
                    if failure.is_none() {
                        failure = Some(flow);
                    }
                    std::cmp::Ordering::Equal
                }
            });
            if let Some(flow) = failure {
                return Err(flow);
            }
            Value::array(decorated.into_iter().map(|(_, item)| item).collect())
        }
        "min_by" | "max_by" => {
            let items = need_array(interp, &name, &args, 0, span)?;
            let key_fn = args[1].clone();
            let want_greater = native.method == "max_by";
            let mut best: Option<(Value, Value)> = None;
            for item in items {
                let key = interp.call_callback(&key_fn, vec![item.clone()], span)?;
                match &best {
                    None => best = Some((key, item)),
                    Some((best_key, _)) => {
                        let ordering = compare_keys(interp, &key, best_key, span)?;
                        if (ordering == std::cmp::Ordering::Greater) == want_greater
                            && ordering != std::cmp::Ordering::Equal
                        {
                            best = Some((key, item));
                        }
                    }
                }
            }
            best.map(|(_, item)| item).unwrap_or(Value::Nil)
        }
        "to_map" => {
            let items = need_array(interp, &name, &args, 0, span)?;
            let mut map = BaaMap::new();
            for (index, pair) in items.iter().enumerate() {
                let Value::Array(entry) = pair else {
                    return interp.fail(
                        "BAA311",
                        vec![name, "an array of [key, value] pairs".into(), "1".into(), pair.describe()],
                        span,
                    );
                };
                let entry = entry.borrow();
                let key_value = entry.first().cloned().unwrap_or(Value::Nil);
                let Some(key) = MapKey::from_value(&key_value) else {
                    return interp.fail(
                        "BAA311",
                        vec![
                            name,
                            format!("a key the map accepts at position {index}"),
                            "1".into(),
                            key_value.describe(),
                        ],
                        span,
                    );
                };
                map.set(key, entry.get(1).cloned().unwrap_or(Value::Nil));
            }
            Value::map(map)
        }
        "from_keys" => {
            let keys = need_array(interp, &name, &args, 0, span)?;
            let value_fn = args[1].clone();
            let mut map = BaaMap::new();
            for key_value in keys {
                let Some(key) = MapKey::from_value(&key_value) else {
                    return interp.fail(
                        "BAA311",
                        vec![name, "keys the map accepts".into(), "1".into(), key_value.describe()],
                        span,
                    );
                };
                let value = interp.call_callback(&value_fn, vec![key_value], span)?;
                map.set(key, value);
            }
            Value::map(map)
        }
        "invert" => {
            let Some(Value::Map(source)) = args.first() else {
                return interp.fail(
                    "BAA311",
                    vec![name, "a map".into(), "1".into(), args.first().cloned().unwrap_or(Value::Nil).describe()],
                    span,
                );
            };
            let entries: Vec<(MapKey, Value)> = source.borrow().iter().cloned().collect();
            let mut inverted = BaaMap::new();
            for (key, value) in entries {
                let Some(new_key) = MapKey::from_value(&value) else {
                    return interp.fail(
                        "BAA311",
                        vec![name, "values the map accepts as keys".into(), "1".into(), value.describe()],
                        span,
                    );
                };
                inverted.set(new_key, key.to_value());
            }
            Value::map(inverted)
        }
        "range" => {
            let first = need_int(interp, &name, &args, 0, span)?;
            let (start, end) = if args.len() == 1 {
                (0.0, first)
            } else {
                (first, need_int(interp, &name, &args, 1, span)?)
            };
            let step = if args.len() > 2 { need_int(interp, &name, &args, 2, span)? } else { 1.0 };
            if step == 0.0 {
                return interp.fail(
                    "BAA311",
                    vec![name, "a non-zero step".into(), "3".into(), "zero".into()],
                    span,
                );
            }
            check_size(interp, &name, ((end - start) / step).ceil().max(0.0), span)?;
            let mut out = Vec::new();
            let mut at = start;
            if step > 0.0 {
                while at < end {
                    out.push(Value::Number(at));
                    at += step;
                }
            } else {
                while at > end {
                    out.push(Value::Number(at));
                    at += step;
                }
            }
            Value::array(out)
        }
        "to_array" => match args.first() {
            Some(Value::Array(items)) => Value::array(items.borrow().clone()),
            Some(Value::Range(range)) => {
                check_size(interp, &name, range.length(), span)?;
                Value::array(range.values().into_iter().map(Value::Number).collect())
            }
            Some(Value::Str(text)) => {
                Value::array(text.chars().map(|c| Value::str(c.to_string())).collect())
            }
            Some(Value::Map(map)) => Value::array(
                map.borrow()
                    .iter()
                    .map(|(key, value)| Value::array(vec![key.to_value(), value.clone()]))
                    .collect(),
            ),
            other => {
                return interp.fail(
                    "BAA311",
                    vec![
                        name,
                        "an array, range, string or map".into(),
                        "1".into(),
                        other.cloned().unwrap_or(Value::Nil).describe(),
                    ],
                    span,
                )
            }
        },
        _ => Value::Nil,
    })
}
