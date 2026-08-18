//! The Baa value model, as `src/runtime/values.ts` defines it.
//!
//! Two decisions carry over from the reference and are load-bearing rather
//! than stylistic:
//!
//!  - **Arrays and maps are references.** Passing one to a function passes the
//!    same object, and `clone()` is what makes a copy. `Rc<RefCell<..>>` is
//!    the direct equivalent.
//!  - **Maps keep insertion order.** Iteration order is observable, printed by
//!    `inspect`, and asserted by the conformance suite. A hash map alone would
//!    pass most tests and fail those.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::ast::{Block, Param, Span};
use crate::number;

/// A native function's implementation.
///
/// It receives the `Native` it was reached through, so one function can serve a
/// whole table of methods by matching on `method`. That keeps ninety small
/// methods from becoming ninety top-level functions, without the allocation a
/// boxed closure per lookup would cost.
pub type NativeImpl =
    fn(&mut crate::interp::Interpreter, &Native, Vec<Value>, Span) -> crate::interp::Res<Value>;

#[derive(Clone)]
pub enum Value {
    Nil,
    Bool(bool),
    Number(f64),
    Str(Rc<str>),
    Array(Rc<RefCell<Vec<Value>>>),
    Map(Rc<RefCell<BaaMap>>),
    Range(Rc<Range>),
    Function(Rc<Function>),
    Native(Rc<Native>),
    Module(Rc<Module>),
}

pub struct Range {
    pub start: f64,
    pub end: f64,
    pub inclusive: bool,
}

pub struct Function {
    pub name: Rc<str>,
    pub params: Rc<[Param]>,
    pub body: Rc<Block>,
    pub closure: Rc<crate::interp::Environment>,
    pub declared_at: Span,
    pub module: usize,
}

pub struct Native {
    /// Label used in diagnostics: `array.map`, or `len` for a prelude function.
    pub name: String,
    /// Bare method name, for the dispatcher. Empty for a free function.
    pub method: &'static str,
    pub min_args: usize,
    pub max_args: usize,
    pub call: NativeImpl,
    /// A value bound to the call, so `array.map` knows which array it came
    /// from without a separate method object per array.
    pub receiver: Option<Box<Value>>,
}

impl Native {
    pub fn function(name: &str, min_args: usize, max_args: usize, call: NativeImpl) -> Value {
        Value::Native(std::rc::Rc::new(Native {
            name: name.to_string(),
            method: "",
            min_args,
            max_args,
            call,
            receiver: None,
        }))
    }

    pub fn bound(
        label: String,
        method: &'static str,
        min_args: usize,
        max_args: usize,
        call: NativeImpl,
        receiver: Value,
    ) -> Value {
        Value::Native(std::rc::Rc::new(Native {
            name: label,
            method,
            min_args,
            max_args,
            call,
            receiver: Some(Box::new(receiver)),
        }))
    }
}

pub struct Module {
    pub name: Rc<str>,
    pub exports: RefCell<Vec<(Rc<str>, Value)>>,
}

impl Module {
    pub fn get(&self, name: &str) -> Option<Value> {
        self.exports
            .borrow()
            .iter()
            .find(|(key, _)| &**key == name)
            .map(|(_, value)| value.clone())
    }

    pub fn names(&self) -> Vec<String> {
        self.exports.borrow().iter().map(|(key, _)| key.to_string()).collect()
    }
}

// --------------------------------------------------------------------- keys

/// What a map accepts as a key: everything except the composite types.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum MapKey {
    Nil,
    Bool(bool),
    /// Stored as bits so it can be hashed. Normalised on the way in, because
    /// JavaScript's `Map` treats `0` and `-0` as one key and `NaN` as equal to
    /// itself, and the reference implementation is a JavaScript `Map`.
    Number(u64),
    Str(Rc<str>),
}

impl MapKey {
    pub fn number(value: f64) -> MapKey {
        if value == 0.0 {
            return MapKey::Number(0f64.to_bits());
        }
        if value.is_nan() {
            return MapKey::Number(f64::NAN.to_bits());
        }
        MapKey::Number(value.to_bits())
    }

    pub fn from_value(value: &Value) -> Option<MapKey> {
        Some(match value {
            Value::Nil => MapKey::Nil,
            Value::Bool(flag) => MapKey::Bool(*flag),
            Value::Number(number) => MapKey::number(*number),
            Value::Str(text) => MapKey::Str(text.clone()),
            _ => return None,
        })
    }

    pub fn to_value(&self) -> Value {
        match self {
            MapKey::Nil => Value::Nil,
            MapKey::Bool(flag) => Value::Bool(*flag),
            MapKey::Number(bits) => Value::Number(f64::from_bits(*bits)),
            MapKey::Str(text) => Value::Str(text.clone()),
        }
    }
}

/// An insertion-ordered map: the order entries were added is the order they
/// iterate and print in.
#[derive(Default)]
pub struct BaaMap {
    entries: Vec<(MapKey, Value)>,
    index: HashMap<MapKey, usize>,
}

impl BaaMap {
    pub fn new() -> BaaMap {
        BaaMap::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &MapKey) -> Option<&Value> {
        self.index.get(key).map(|at| &self.entries[*at].1)
    }

    pub fn has(&self, key: &MapKey) -> bool {
        self.index.contains_key(key)
    }

    pub fn set(&mut self, key: MapKey, value: Value) {
        match self.index.get(&key) {
            // Replacing a value keeps the key where it was, which is what
            // JavaScript's `Map` does and what makes an update non-reordering.
            Some(at) => self.entries[*at].1 = value,
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    pub fn remove(&mut self, key: &MapKey) -> Option<Value> {
        let at = self.index.remove(key)?;
        let (_, value) = self.entries.remove(at);
        // Everything after the hole moved down one.
        for slot in self.index.values_mut() {
            if *slot > at {
                *slot -= 1;
            }
        }
        Some(value)
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.index.clear();
    }

    pub fn iter(&self) -> impl Iterator<Item = &(MapKey, Value)> {
        self.entries.iter()
    }

    pub fn keys(&self) -> Vec<MapKey> {
        self.entries.iter().map(|(key, _)| key.clone()).collect()
    }

    pub fn get_str(&self, key: &str) -> Option<Value> {
        self.get(&MapKey::Str(Rc::from(key))).cloned()
    }

    pub fn set_str(&mut self, key: &str, value: Value) {
        self.set(MapKey::Str(Rc::from(key)), value);
    }

    pub fn from_pairs(pairs: Vec<(&str, Value)>) -> BaaMap {
        let mut map = BaaMap::new();
        for (key, value) in pairs {
            map.set_str(key, value);
        }
        map
    }
}

// -------------------------------------------------------------- constructors

impl Value {
    pub fn str(text: impl AsRef<str>) -> Value {
        Value::Str(Rc::from(text.as_ref()))
    }

    pub fn array(items: Vec<Value>) -> Value {
        Value::Array(Rc::new(RefCell::new(items)))
    }

    pub fn map(map: BaaMap) -> Value {
        Value::Map(Rc::new(RefCell::new(map)))
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Nil => "nil",
            Value::Bool(_) => "bool",
            Value::Number(_) => "number",
            Value::Str(_) => "string",
            Value::Array(_) => "array",
            Value::Map(_) => "map",
            Value::Range(_) => "range",
            Value::Function(_) | Value::Native(_) => "function",
            Value::Module(_) => "module",
        }
    }

    /// Type name with its article, for diagnostics: "an array", "a string".
    /// Templates never write the article themselves, for the reason set out in
    /// `describeType` in the reference implementation.
    pub fn describe(&self) -> String {
        match self.type_name() {
            "array" => "an array".to_string(),
            name => format!("a {name}"),
        }
    }

    /// Only `nil` and `false` are falsy. Zero and the empty string are true.
    pub fn truthy(&self) -> bool {
        !matches!(self, Value::Nil | Value::Bool(false))
    }

    pub fn callable(&self) -> bool {
        matches!(self, Value::Function(_) | Value::Native(_))
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<Rc<str>> {
        match self {
            Value::Str(text) => Some(text.clone()),
            _ => None,
        }
    }
}

impl Range {
    /// How many values iteration yields. A descending range counts the same
    /// distance, so `5..0` yields five values just as `0..5` does.
    pub fn length(&self) -> f64 {
        let distance = (self.end - self.start).abs();
        if distance.is_nan() {
            return 0.0;
        }
        if distance.is_infinite() {
            return f64::INFINITY;
        }
        if self.inclusive {
            distance.floor() + 1.0
        } else {
            distance.ceil()
        }
    }

    pub fn contains(&self, value: f64) -> bool {
        let low = self.start.min(self.end);
        let high = self.start.max(self.end);
        if self.inclusive {
            return value >= low && value <= high;
        }
        if self.start <= self.end {
            value >= self.start && value < self.end
        } else {
            value <= self.start && value > self.end
        }
    }

    pub fn values(&self) -> Vec<f64> {
        let mut out = Vec::new();
        if self.start <= self.end {
            let mut at = self.start;
            while if self.inclusive { at <= self.end } else { at < self.end } {
                out.push(at);
                at += 1.0;
            }
        } else {
            let mut at = self.start;
            while if self.inclusive { at >= self.end } else { at > self.end } {
                out.push(at);
                at -= 1.0;
            }
        }
        out
    }
}

// ------------------------------------------------------------------ equality

/// Structural for arrays and maps, identity for functions and modules, and
/// `NaN != NaN` as everywhere else.
pub fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Nil, Value::Nil) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => {
            if Rc::ptr_eq(x, y) {
                return true;
            }
            let (x, y) = (x.borrow(), y.borrow());
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(a, b)| equal(a, b))
        }
        (Value::Map(x), Value::Map(y)) => {
            if Rc::ptr_eq(x, y) {
                return true;
            }
            let (x, y) = (x.borrow(), y.borrow());
            if x.len() != y.len() {
                return false;
            }
            let same = x.iter().all(|(key, value)| match y.get(key) {
                Some(other) => equal(value, other),
                None => false,
            });
            same
        }
        (Value::Range(x), Value::Range(y)) => {
            x.start == y.start && x.end == y.end && x.inclusive == y.inclusive
        }
        (Value::Function(x), Value::Function(y)) => Rc::ptr_eq(x, y),
        (Value::Native(x), Value::Native(y)) => Rc::ptr_eq(x, y),
        (Value::Module(x), Value::Module(y)) => Rc::ptr_eq(x, y),
        _ => false,
    }
}

// ---------------------------------------------------------------- formatting

/// `baa x` output: strings print bare, everything else as source-ish text.
pub fn display(value: &Value) -> String {
    match value {
        Value::Str(text) => text.to_string(),
        other => inspect(other),
    }
}

/// Developer-facing text, with quoted strings.
pub fn inspect(value: &Value) -> String {
    let mut seen = Vec::new();
    inspect_inner(value, &mut seen)
}

fn inspect_inner(value: &Value, seen: &mut Vec<usize>) -> String {
    match value {
        Value::Nil => "nil".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(number) => number::format(*number),
        Value::Str(text) => quote(text),
        Value::Range(range) => format!(
            "{}{}{}",
            number::format(range.start),
            if range.inclusive { "..=" } else { ".." },
            number::format(range.end)
        ),
        Value::Function(function) => format!("<fn {}/{}>", function.name, function.params.len()),
        Value::Native(native) => format!("<native fn {}>", native.name),
        Value::Module(module) => format!("<module {}>", module.name),
        Value::Array(items) => {
            let address = Rc::as_ptr(items) as usize;
            if seen.contains(&address) {
                return "[...]".to_string();
            }
            seen.push(address);
            let parts: Vec<String> = items.borrow().iter().map(|item| inspect_inner(item, seen)).collect();
            seen.pop();
            format!("[{}]", parts.join(", "))
        }
        Value::Map(map) => {
            let address = Rc::as_ptr(map) as usize;
            if seen.contains(&address) {
                return "{...}".to_string();
            }
            seen.push(address);
            let parts: Vec<String> = map
                .borrow()
                .iter()
                .map(|(key, value)| format!("{}: {}", format_key(key), inspect_inner(value, seen)))
                .collect();
            seen.pop();
            if parts.is_empty() {
                "{}".to_string()
            } else {
                format!("{{ {} }}", parts.join(", "))
            }
        }
    }
}

fn format_key(key: &MapKey) -> String {
    match key {
        MapKey::Str(text) => {
            let identifier = !text.is_empty()
                && text.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if identifier {
                text.to_string()
            } else {
                quote(text)
            }
        }
        MapKey::Nil => "nil".to_string(),
        MapKey::Bool(true) => "true".to_string(),
        MapKey::Bool(false) => "false".to_string(),
        MapKey::Number(bits) => number::format(f64::from_bits(*bits)),
    }
}

pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Deep copy of an array or map; everything else is already a value.
pub fn deep_clone(value: &Value) -> Value {
    fn inner(value: &Value, seen: &mut Vec<(usize, Value)>) -> Value {
        match value {
            Value::Array(items) => {
                let address = Rc::as_ptr(items) as usize;
                if let Some((_, existing)) = seen.iter().find(|(at, _)| *at == address) {
                    return existing.clone();
                }
                let copy = Rc::new(RefCell::new(Vec::new()));
                seen.push((address, Value::Array(copy.clone())));
                let source: Vec<Value> = items.borrow().clone();
                for item in &source {
                    let cloned = inner(item, seen);
                    copy.borrow_mut().push(cloned);
                }
                Value::Array(copy)
            }
            Value::Map(map) => {
                let address = Rc::as_ptr(map) as usize;
                if let Some((_, existing)) = seen.iter().find(|(at, _)| *at == address) {
                    return existing.clone();
                }
                let copy = Rc::new(RefCell::new(BaaMap::new()));
                seen.push((address, Value::Map(copy.clone())));
                let source: Vec<(MapKey, Value)> = map.borrow().iter().cloned().collect();
                for (key, entry) in source {
                    let cloned = inner(&entry, seen);
                    copy.borrow_mut().set(key, cloned);
                }
                Value::Map(copy)
            }
            other => other.clone(),
        }
    }
    inner(value, &mut Vec::new())
}
