//! `ram`: arithmetic. A port of `src/stdlib/ram.ts`.
//!
//! Every function here exists there with the same name, arity and edge-case
//! behaviour, including the ones that are easy to get subtly different:
//! `modulo` takes the sign of its divisor while `%` takes the sign of its
//! left operand, `idiv` rounds towards negative infinity rather than zero, and
//! `sqrt` of a negative number is an error rather than a quiet `nan`.

use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Flow, Interpreter, Res};
use crate::number;
use crate::value::{Module, Native, Value};

use super::{module_of, need_array, need_number, need_string};

const FUNCTIONS: &[(&str, usize, usize)] = &[
    ("abs", 1, 1),
    ("sign", 1, 1),
    ("floor", 1, 1),
    ("ceil", 1, 1),
    ("trunc", 1, 1),
    ("round", 1, 2),
    ("sqrt", 1, 1),
    ("pow", 2, 2),
    ("exp", 1, 1),
    ("log", 1, 2),
    ("sin", 1, 1),
    ("cos", 1, 1),
    ("tan", 1, 1),
    ("atan2", 2, 2),
    ("hypot", 2, 2),
    ("min", 1, usize::MAX),
    ("max", 1, usize::MAX),
    ("clamp", 3, 3),
    ("lerp", 3, 3),
    ("idiv", 2, 2),
    ("modulo", 2, 2),
    ("gcd", 2, 2),
    ("is_nan", 1, 1),
    ("is_finite", 1, 1),
    ("is_whole", 1, 1),
    ("sum", 1, 1),
    ("mean", 1, 1),
    ("median", 1, 1),
    ("to_binary", 1, 1),
    ("to_hex", 1, 1),
    ("parse", 1, 2),
];

pub fn module() -> Rc<Module> {
    let mut exports: Vec<(&str, Value)> = vec![
        ("PI", Value::Number(std::f64::consts::PI)),
        ("E", Value::Number(std::f64::consts::E)),
        ("TAU", Value::Number(std::f64::consts::PI * 2.0)),
        ("INF", Value::Number(f64::INFINITY)),
        ("NAN", Value::Number(f64::NAN)),
        ("EPSILON", Value::Number(f64::EPSILON)),
        ("MAX_SAFE_WHOLE", Value::Number(9_007_199_254_740_991.0)),
    ];
    for (name, min, max) in FUNCTIONS {
        exports.push((
            name,
            Value::Native(Rc::new(Native {
                name: format!("ram.{name}"),
                method: name,
                min_args: *min,
                max_args: *max,
                call,
                receiver: None,
            })),
        ));
    }
    module_of("ram", exports)
}

fn call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let name = &native.name;
    let one = |interp: &Interpreter| need_number(interp, name, &args, 0, span);

    Ok(match native.method {
        "abs" => Value::Number(one(interp)?.abs()),
        // `Math.sign` returns the value itself for NaN and preserves -0, which
        // `f64::signum` does not: signum(-0.0) is -1.0 and signum(NaN) is NaN
        // with a sign. Written out rather than borrowed.
        "sign" => {
            let value = one(interp)?;
            Value::Number(if value.is_nan() {
                f64::NAN
            } else if value > 0.0 {
                1.0
            } else if value < 0.0 {
                -1.0
            } else {
                value
            })
        }
        "floor" => Value::Number(one(interp)?.floor()),
        "ceil" => Value::Number(one(interp)?.ceil()),
        "trunc" => Value::Number(one(interp)?.trunc()),
        "round" => {
            let value = one(interp)?;
            if args.len() == 1 {
                // JavaScript rounds halves towards positive infinity.
                Value::Number((value + 0.5).floor())
            } else {
                let digits = need_number(interp, name, &args, 1, span)?;
                let factor = 10f64.powf(digits);
                Value::Number((value * factor + 0.5).floor() / factor)
            }
        }
        "sqrt" => {
            let value = one(interp)?;
            if value < 0.0 {
                return Err(Flow::Err(
                    interp
                        .error(
                            "BAA301",
                            vec!["ram.sqrt of a negative number is not a real number".into()],
                            span,
                        )
                        .with_note("negative input")
                        .with_help("Check the sign first, or use `ram.abs(x)`."),
                ));
            }
            Value::Number(value.sqrt())
        }
        "pow" => Value::Number(
            need_number(interp, name, &args, 0, span)?.powf(need_number(interp, name, &args, 1, span)?),
        ),
        "exp" => Value::Number(one(interp)?.exp()),
        "log" => {
            let value = one(interp)?;
            if args.len() == 1 {
                Value::Number(value.ln())
            } else {
                let base = need_number(interp, name, &args, 1, span)?;
                Value::Number(value.ln() / base.ln())
            }
        }
        "sin" => Value::Number(one(interp)?.sin()),
        "cos" => Value::Number(one(interp)?.cos()),
        "tan" => Value::Number(one(interp)?.tan()),
        "atan2" => Value::Number(
            need_number(interp, name, &args, 0, span)?.atan2(need_number(interp, name, &args, 1, span)?),
        ),
        "hypot" => Value::Number(
            need_number(interp, name, &args, 0, span)?.hypot(need_number(interp, name, &args, 1, span)?),
        ),
        "min" | "max" => {
            let mut best = need_number(interp, name, &args, 0, span)?;
            for index in 1..args.len() {
                let value = need_number(interp, name, &args, index, span)?;
                // NaN wins, as `Math.min`/`Math.max` do: `f64::min` ignores it.
                if value.is_nan() || best.is_nan() {
                    best = f64::NAN;
                } else if (native.method == "min") == (value < best) && value != best {
                    best = value;
                }
            }
            Value::Number(best)
        }
        "clamp" => {
            let value = need_number(interp, name, &args, 0, span)?;
            let low = need_number(interp, name, &args, 1, span)?;
            let high = need_number(interp, name, &args, 2, span)?;
            if low > high {
                return interp.fail(
                    "BAA311",
                    vec![
                        "ram.clamp".into(),
                        "low <= high".into(),
                        "2".into(),
                        "a low bound above the high bound".into(),
                    ],
                    span,
                );
            }
            Value::Number(value.max(low).min(high))
        }
        "lerp" => {
            let a = need_number(interp, name, &args, 0, span)?;
            let b = need_number(interp, name, &args, 1, span)?;
            let t = need_number(interp, name, &args, 2, span)?;
            Value::Number(a + (b - a) * t)
        }
        "idiv" | "modulo" => {
            let a = need_number(interp, name, &args, 0, span)?;
            let b = need_number(interp, name, &args, 1, span)?;
            if b == 0.0 {
                return Err(Flow::Err(
                    interp.error("BAA306", vec![], span).with_note("divisor is zero"),
                ));
            }
            Value::Number(if native.method == "idiv" {
                (a / b).floor()
            } else {
                ((a % b) + b) % b
            })
        }
        "gcd" => {
            let mut a = need_number(interp, name, &args, 0, span)?.abs();
            let mut b = need_number(interp, name, &args, 1, span)?.abs();
            while b > 0.0 {
                let next = a % b;
                a = b;
                b = next;
            }
            Value::Number(a)
        }
        "is_nan" => Value::Bool(match args.first() {
            Some(Value::Number(value)) => value.is_nan(),
            // Anything that is not a number "is not a number".
            _ => true,
        }),
        "is_finite" => Value::Bool(matches!(args.first(), Some(Value::Number(value)) if value.is_finite())),
        "is_whole" => Value::Bool(
            matches!(args.first(), Some(Value::Number(value)) if value.is_finite() && value.fract() == 0.0),
        ),
        "sum" | "mean" | "median" => {
            let items = need_array(interp, name, &args, 0, span)?;
            let mut numbers = Vec::with_capacity(items.len());
            for item in &items {
                match item {
                    Value::Number(value) => numbers.push(*value),
                    other => {
                        return Err(Flow::Err(
                            interp
                                .error(
                                    "BAA311",
                                    vec![name.clone(), "an array of numbers".into(), "1".into(), other.describe()],
                                    span,
                                )
                                .with_note("every item must be a number"),
                        ))
                    }
                }
            }
            match native.method {
                "sum" => Value::Number(numbers.iter().sum()),
                "mean" => {
                    if numbers.is_empty() {
                        Value::Nil
                    } else {
                        Value::Number(numbers.iter().sum::<f64>() / numbers.len() as f64)
                    }
                }
                _ => {
                    if numbers.is_empty() {
                        Value::Nil
                    } else {
                        numbers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                        let middle = numbers.len() / 2;
                        Value::Number(if numbers.len() % 2 == 1 {
                            numbers[middle]
                        } else {
                            (numbers[middle - 1] + numbers[middle]) / 2.0
                        })
                    }
                }
            }
        }
        "to_binary" | "to_hex" => {
            let value = one(interp)?;
            if !value.is_finite() || value.fract() != 0.0 {
                return interp.fail(
                    "BAA311",
                    vec![name.clone(), "a whole number".into(), "1".into(), "a fraction".into()],
                    span,
                );
            }
            let magnitude = value.abs() as u64;
            let digits = if native.method == "to_binary" {
                format!("{magnitude:b}")
            } else {
                format!("{magnitude:x}")
            };
            Value::str(if value < 0.0 { format!("-{digits}") } else { digits })
        }
        "parse" => {
            let text = need_string(interp, name, &args, 0, span)?;
            let base = if args.len() > 1 {
                need_number(interp, name, &args, 1, span)?
            } else {
                10.0
            };
            if base == 10.0 {
                match number::parse(&text) {
                    Some(value) => Value::Number(value),
                    None => Value::Nil,
                }
            } else {
                // `parseInt` reads as many valid digits as it can and ignores
                // the rest, which is what this reproduces.
                let trimmed = text.trim();
                let (sign, body) = match trimmed.strip_prefix('-') {
                    Some(rest) => (-1.0, rest),
                    None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
                };
                let radix = base as u32;
                if !(2..=36).contains(&radix) {
                    return Ok(Value::Nil);
                }
                let mut total: f64 = 0.0;
                let mut any = false;
                for ch in body.chars() {
                    match ch.to_digit(radix) {
                        Some(digit) => {
                            total = total * base + digit as f64;
                            any = true;
                        }
                        None => break,
                    }
                }
                if any {
                    Value::Number(sign * total)
                } else {
                    Value::Nil
                }
            }
        }
        _ => Value::Nil,
    })
}
