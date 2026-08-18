//! `lamb`: JSON. A port of `src/stdlib/lamb.ts`.
//!
//! Written by hand rather than pulled in from a crate, for the same reason the
//! Win32 calls are: this runtime has no dependencies, and JSON is small enough
//! that a parser for it is shorter than the argument about which crate to use.
//!
//! The decoder is strict, as the reference's is: no trailing commas, no
//! comments, no single quotes. The encoder refuses what JSON cannot hold
//! rather than inventing a representation for it, so a function or a cycle is
//! an error naming the problem instead of `null` appearing in an output file.

use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Flow, Interpreter, Res};
use crate::number;
use crate::value::{BaaMap, MapKey, Module, Native, Value};

use super::{module_of, need_number, need_string};

const FUNCTIONS: &[(&str, usize, usize)] =
    &[("encode", 1, 2), ("decode", 1, 1), ("try_decode", 1, 2), ("is_valid", 1, 1)];

pub fn module() -> Rc<Module> {
    let exports = FUNCTIONS
        .iter()
        .map(|(name, min, max)| {
            (
                *name,
                Value::Native(Rc::new(Native {
                    name: format!("lamb.{name}"),
                    method: name,
                    min_args: *min,
                    max_args: *max,
                    call,
                    receiver: None,
                })),
            )
        })
        .collect();
    module_of("lamb", exports)
}

fn call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let name = native.name.clone();
    Ok(match native.method {
        "encode" => {
            let indent = if args.len() > 1 {
                need_number(interp, &name, &args, 1, span)?
            } else {
                0.0
            };
            if !(0.0..=10.0).contains(&indent) || indent.fract() != 0.0 {
                return interp.fail(
                    "BAA311",
                    vec![name, "an indent of 0 to 10".into(), "2".into(), number::format(indent)],
                    span,
                );
            }
            let mut out = String::new();
            let mut seen = Vec::new();
            encode(interp, &args[0], indent as usize, 0, &mut seen, &mut out, span)?;
            Value::str(out)
        }
        "decode" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            match parse(&text) {
                Ok(value) => value,
                Err(reason) => {
                    return Err(Flow::Err(
                        interp
                            .error("BAA301", vec![format!("lamb.decode: {reason}")], span)
                            .with_note("this is not valid JSON")
                            .with_help("Use `lamb.try_decode(text, fallback)` when the text comes from outside."),
                    ))
                }
            }
        }
        // Returns the value or the fallback. Not a map with an `ok` field:
        // this is the shape the reference has, and code written against one
        // has to work against the other.
        "try_decode" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            let fallback = args.get(1).cloned().unwrap_or(Value::Nil);
            parse(&text).unwrap_or(fallback)
        }
        "is_valid" => match args.first() {
            Some(Value::Str(text)) => Value::Bool(parse(text).is_ok()),
            _ => Value::Bool(false),
        },
        _ => Value::Nil,
    })
}

// ------------------------------------------------------------------ encoding

fn encode(
    interp: &Interpreter,
    value: &Value,
    indent: usize,
    depth: usize,
    seen: &mut Vec<usize>,
    out: &mut String,
    span: Span,
) -> Res<()> {
    match value {
        Value::Nil => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            if !number.is_finite() {
                return Err(Flow::Err(
                    interp
                        .error(
                            "BAA301",
                            vec![format!("lamb.encode: JSON has no way to write {}", number::format(*number))],
                            span,
                        )
                        .with_note("not a finite number"),
                ));
            }
            out.push_str(&number::format(*number));
        }
        Value::Str(text) => encode_string(text, out),
        Value::Array(items) => {
            let address = Rc::as_ptr(items) as usize;
            if seen.contains(&address) {
                return Err(cycle(interp, span));
            }
            seen.push(address);
            let items = items.borrow().clone();
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                encode(interp, item, indent, depth + 1, seen, out, span)?;
            }
            if !items.is_empty() {
                newline(out, indent, depth);
            }
            out.push(']');
            seen.pop();
        }
        Value::Map(map) => {
            let address = Rc::as_ptr(map) as usize;
            if seen.contains(&address) {
                return Err(cycle(interp, span));
            }
            seen.push(address);
            let entries: Vec<(MapKey, Value)> = map.borrow().iter().cloned().collect();
            out.push('{');
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                // JSON keys are always strings, so a numeric or boolean key is
                // written as its text form rather than refused: that is what
                // the reference does, and it round-trips through `decode` as a
                // string, which the documentation says.
                encode_string(&key_text(key), out);
                out.push(':');
                if indent > 0 {
                    out.push(' ');
                }
                encode(interp, item, indent, depth + 1, seen, out, span)?;
            }
            if !entries.is_empty() {
                newline(out, indent, depth);
            }
            out.push('}');
            seen.pop();
        }
        other => {
            return Err(Flow::Err(
                interp
                    .error(
                        "BAA301",
                        vec![format!("lamb.encode: JSON cannot hold {}", other.describe())],
                        span,
                    )
                    .with_note("not encodable")
                    .with_help("JSON holds nil, booleans, numbers, strings, arrays and maps."),
            ))
        }
    }
    Ok(())
}

fn cycle(interp: &Interpreter, span: Span) -> Flow {
    Flow::Err(
        interp
            .error("BAA301", vec!["lamb.encode: this value contains itself".into()], span)
            .with_note("a cycle")
            .with_help("JSON is a tree. Break the loop before encoding."),
    )
}

fn key_text(key: &MapKey) -> String {
    match key {
        MapKey::Str(text) => text.to_string(),
        MapKey::Nil => "nil".to_string(),
        MapKey::Bool(true) => "true".to_string(),
        MapKey::Bool(false) => "false".to_string(),
        MapKey::Number(bits) => number::format(f64::from_bits(*bits)),
    }
}

fn newline(out: &mut String, indent: usize, depth: usize) {
    if indent == 0 {
        return;
    }
    out.push('\n');
    for _ in 0..indent * depth {
        out.push(' ');
    }
}

fn encode_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            // Control characters have to be escaped; everything else is
            // written as itself, because the output is UTF-8 and JSON allows
            // it. Escaping the whole non-ASCII range would only make the text
            // longer and harder to read.
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// ------------------------------------------------------------------ decoding

struct Parser<'a> {
    chars: Vec<char>,
    at: usize,
    text: &'a str,
}

pub fn parse(text: &str) -> std::result::Result<Value, String> {
    let mut parser = Parser { chars: text.chars().collect(), at: 0, text };
    parser.space();
    let value = parser.value(0)?;
    parser.space();
    if parser.at < parser.chars.len() {
        return Err(format!("unexpected `{}` after the value", parser.chars[parser.at]));
    }
    Ok(value)
}

/// JSON nests, and so does this parser. The limit stops a crafted document
/// from turning depth into a stack overflow, which is the one thing a decoder
/// reading untrusted text must not do.
const MAX_DEPTH: usize = 200;

impl Parser<'_> {
    fn space(&mut self) {
        while self.at < self.chars.len() && matches!(self.chars[self.at], ' ' | '\t' | '\n' | '\r') {
            self.at += 1;
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn eat(&mut self, word: &str) -> bool {
        let letters: Vec<char> = word.chars().collect();
        if self.chars.len() < self.at + letters.len() {
            return false;
        }
        if self.chars[self.at..self.at + letters.len()] == letters[..] {
            self.at += letters.len();
            return true;
        }
        false
    }

    fn value(&mut self, depth: usize) -> std::result::Result<Value, String> {
        if depth > MAX_DEPTH {
            return Err(format!("nested more than {MAX_DEPTH} deep"));
        }
        self.space();
        match self.peek() {
            None => Err("the text ends before a value".to_string()),
            Some('n') if self.eat("null") => Ok(Value::Nil),
            Some('t') if self.eat("true") => Ok(Value::Bool(true)),
            Some('f') if self.eat("false") => Ok(Value::Bool(false)),
            Some('"') => self.string().map(Value::str),
            Some('[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.peek() == Some(']') {
                    self.at += 1;
                    return Ok(Value::array(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.space();
                    match self.peek() {
                        Some(',') => self.at += 1,
                        Some(']') => {
                            self.at += 1;
                            return Ok(Value::array(items));
                        }
                        _ => return Err("expected `,` or `]` in an array".to_string()),
                    }
                }
            }
            Some('{') => {
                self.at += 1;
                let mut map = BaaMap::new();
                self.space();
                if self.peek() == Some('}') {
                    self.at += 1;
                    return Ok(Value::map(map));
                }
                loop {
                    self.space();
                    let key = self.string()?;
                    self.space();
                    if self.peek() != Some(':') {
                        return Err("expected `:` after a key".to_string());
                    }
                    self.at += 1;
                    let value = self.value(depth + 1)?;
                    map.set(MapKey::Str(Rc::from(key.as_str())), value);
                    self.space();
                    match self.peek() {
                        Some(',') => self.at += 1,
                        Some('}') => {
                            self.at += 1;
                            return Ok(Value::map(map));
                        }
                        _ => return Err("expected `,` or `}` in an object".to_string()),
                    }
                }
            }
            Some(c) if c == '-' || c.is_ascii_digit() => self.number(),
            Some(c) => Err(format!("unexpected `{c}`")),
        }
    }

    fn string(&mut self) -> std::result::Result<String, String> {
        if self.peek() != Some('"') {
            return Err("expected a string".to_string());
        }
        self.at += 1;
        let mut out = String::new();
        loop {
            let Some(ch) = self.peek() else {
                return Err("the text ends inside a string".to_string());
            };
            self.at += 1;
            match ch {
                '"' => return Ok(out),
                '\\' => {
                    let Some(escape) = self.peek() else {
                        return Err("the text ends inside an escape".to_string());
                    };
                    self.at += 1;
                    match escape {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{08}'),
                        'f' => out.push('\u{0c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => out.push(self.unicode()?),
                        other => return Err(format!("`\\{other}` is not an escape JSON has")),
                    }
                }
                c if (c as u32) < 0x20 => return Err("a control character in a string".to_string()),
                c => out.push(c),
            }
        }
    }

    /// `\uXXXX`, including the surrogate pair a character outside the basic
    /// plane is written as. Getting this wrong turns an emoji into two
    /// replacement characters, silently.
    fn unicode(&mut self) -> std::result::Result<char, String> {
        let first = self.hex4()?;
        if (0xD800..0xDC00).contains(&first) {
            if !self.eat("\\u") {
                return Err("a high surrogate with nothing after it".to_string());
            }
            let second = self.hex4()?;
            if !(0xDC00..0xE000).contains(&second) {
                return Err("a high surrogate followed by something else".to_string());
            }
            let combined = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
            return char::from_u32(combined).ok_or_else(|| "an escape that is not a character".to_string());
        }
        char::from_u32(first).ok_or_else(|| "an escape that is not a character".to_string())
    }

    fn hex4(&mut self) -> std::result::Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let Some(ch) = self.peek() else {
                return Err("the text ends inside an escape".to_string());
            };
            let digit = ch.to_digit(16).ok_or_else(|| format!("`{ch}` is not a hex digit"))?;
            value = value * 16 + digit;
            self.at += 1;
        }
        Ok(value)
    }

    fn number(&mut self) -> std::result::Result<Value, String> {
        let start = self.at;
        if self.peek() == Some('-') {
            self.at += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.at += 1;
        }
        if self.peek() == Some('.') {
            self.at += 1;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.at += 1;
            }
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            self.at += 1;
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.at += 1;
            }
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.at += 1;
            }
        }
        let text: String = self.chars[start..self.at].iter().collect();
        let _ = self.text;
        text.parse::<f64>()
            .map(Value::Number)
            .map_err(|_| format!("`{text}` is not a number"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{display, inspect};

    #[test]
    fn round_trips() {
        let value = parse(r#"{"a":[1,2,{"b":null}],"c":"x\ny","d":true}"#).expect("valid");
        assert_eq!(inspect(&value), r#"{ a: [1, 2, { b: nil }], c: "x\ny", d: true }"#);
    }

    #[test]
    fn reads_escapes_and_surrogate_pairs() {
        let value = parse(r#""A🐑""#).expect("valid");
        assert_eq!(display(&value), "A\u{1f411}");
    }

    #[test]
    fn refuses_what_json_does_not_allow() {
        for bad in [
            "{'a':1}",
            "[1,]",
            "{\"a\":1,}",
            "nul",
            "",
            "[1 2]",
            "\"unterminated",
        ] {
            assert!(parse(bad).is_err(), "should have refused: {bad}");
        }
    }

    /// A document nested past the limit is refused rather than crashing.
    #[test]
    fn refuses_absurd_nesting() {
        let deep = "[".repeat(5000) + &"]".repeat(5000);
        assert!(parse(&deep).is_err());
    }
}
