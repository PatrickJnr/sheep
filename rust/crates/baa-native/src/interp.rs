//! The native tree-walking interpreter.
//!
//! A port of `src/runtime/interpreter.ts`, kept deliberately close to it. Where
//! the two could reasonably differ, this one does what the reference does, and
//! the conformance suite is the arbiter: `cargo test` runs the same programs
//! and compares the same output, byte for byte.
//!
//! Rust and JavaScript disagree about how control flow leaves a nested call.
//! The reference throws `ReturnSignal`, `BreakSignal` and `ContinueSignal`;
//! here they are variants of `Flow` travelling in the error half of a `Result`.
//! Both are the same shape, and the Rust version is the tidier of the two: the
//! type says which statements can produce which signals.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::ast::{
    Binding, BinaryOp, Block, Else, Expr, Image, ImportTarget, LogicalOp, MatchArm, Param, Pattern,
    Span, Stmt, StringPart, UnaryOp,
};
use crate::diag::{BaaError, Frame};
use crate::number;
use crate::stdlib;
use crate::value::{display, equal, inspect, BaaMap, Function, MapKey, Module, Native, Range, Value};

/// Everything that can interrupt evaluation.
pub enum Flow {
    Err(BaaError),
    Return(Value),
    Break,
    Continue,
    /// A value thrown by `throw`, with the span that threw it.
    Throw(Value, Span),
    Exit(i32),
}

pub type Res<T> = Result<T, Flow>;

impl From<BaaError> for Flow {
    fn from(error: BaaError) -> Flow {
        Flow::Err(error)
    }
}

// -------------------------------------------------------------- environments

pub struct Environment {
    values: RefCell<HashMap<Rc<str>, (Value, bool)>>,
    parent: Option<Rc<Environment>>,
}

impl Environment {
    pub fn root() -> Rc<Environment> {
        Rc::new(Environment { values: RefCell::new(HashMap::new()), parent: None })
    }

    pub fn child(parent: &Rc<Environment>) -> Rc<Environment> {
        Rc::new(Environment {
            values: RefCell::new(HashMap::new()),
            parent: Some(parent.clone()),
        })
    }

    pub fn define(&self, name: Rc<str>, value: Value, mutable: bool) {
        self.values.borrow_mut().insert(name, (value, mutable));
    }

    pub fn has_own(&self, name: &str) -> bool {
        self.values.borrow().contains_key(name)
    }

    pub fn get(&self, name: &str) -> Option<Value> {
        if let Some((value, _)) = self.values.borrow().get(name) {
            return Some(value.clone());
        }
        self.parent.as_ref().and_then(|parent| parent.get(name))
    }

    /// `Ok(true)` when assigned, `Ok(false)` when the name is a constant, and
    /// `None` when it is not declared anywhere up the chain.
    pub fn assign(&self, name: &str, value: Value) -> Option<bool> {
        if let Some(slot) = self.values.borrow_mut().get_mut(name) {
            if !slot.1 {
                return Some(false);
            }
            slot.0 = value;
            return Some(true);
        }
        self.parent.as_ref().and_then(|parent| parent.assign(name, value))
    }

    /// Every name visible from here, innermost first, for "did you mean".
    pub fn names(&self) -> Vec<String> {
        let mut out: Vec<String> = self.values.borrow().keys().map(|key| key.to_string()).collect();
        if let Some(parent) = &self.parent {
            out.extend(parent.names());
        }
        out
    }
}

// ------------------------------------------------------------- the intepreter

pub struct Interpreter {
    pub image: Rc<Image>,
    pub globals: Rc<Environment>,
    /// Where `baa` writes. A windowed application has no console, so this is
    /// not always standard output.
    pub out: Box<dyn std::io::Write>,
    pub max_depth: usize,
    /// The module being executed, for spans in diagnostics.
    pub module: usize,
    modules: HashMap<usize, Rc<Module>>,
    std_modules: HashMap<String, Rc<Module>>,
    loading: HashSet<usize>,
    stack: Vec<Frame>,
    depth: usize,
    /// Collected `test` blocks, in declaration order.
    pub tests: Vec<(Rc<str>, Rc<Block>, Rc<Environment>, usize)>,
    /// The window tree, empty until the program imports `barn`.
    pub ui: crate::gui::Ui,
    /// `(widget, event, handler)`, in the order they were registered. A widget
    /// may have more than one handler for the same event; all of them run.
    pub handlers: Vec<(usize, crate::gui::EventKind, Value)>,
    /// The platform backend, `None` on a platform without one, and taken out
    /// of here while the event loop is borrowing it.
    pub backend: Option<Box<dyn crate::gui::Backend>>,
}

pub const DEFAULT_MAX_DEPTH: usize = 512;

impl Interpreter {
    pub fn new(image: Rc<Image>, out: Box<dyn std::io::Write>) -> Interpreter {
        let globals = Environment::root();
        let mut interpreter = Interpreter {
            image,
            globals,
            out,
            max_depth: DEFAULT_MAX_DEPTH,
            module: 0,
            modules: HashMap::new(),
            std_modules: HashMap::new(),
            loading: HashSet::new(),
            stack: Vec::new(),
            depth: 0,
            tests: Vec::new(),
            ui: crate::gui::Ui::new(),
            handlers: Vec::new(),
            backend: default_backend(),
        };
        stdlib::install_prelude(&interpreter.globals);
        interpreter
    }

    pub fn error(&self, code: &'static str, args: Vec<String>, span: Span) -> BaaError {
        BaaError::new(code, args, span, self.module)
    }

    pub fn fail<T>(&self, code: &'static str, args: Vec<String>, span: Span) -> Res<T> {
        Err(Flow::Err(self.error(code, args, span)))
    }

    /// Runs the entry module. Returns the exit code the program asked for.
    pub fn run(&mut self) -> Result<i32, BaaError> {
        let entry = self.image.entry;
        match self.load_module(entry, Span::ZERO) {
            Ok(_) => Ok(0),
            Err(Flow::Exit(code)) => Ok(code),
            Err(flow) => Err(self.to_error(flow)),
        }
    }

    /// Turns any escaping signal into the error a person should see.
    pub fn to_error(&self, flow: Flow) -> BaaError {
        match flow {
            Flow::Err(error) => error,
            Flow::Throw(value, span) => {
                BaaError::new("BAA308", vec![display(&value)], span, self.module)
                    .with_note("thrown here")
            }
            Flow::Return(_) => BaaError::new("BAA301", vec!["`return` outside a function".into()], Span::ZERO, self.module),
            Flow::Break | Flow::Continue => {
                BaaError::new("BAA301", vec!["a loop signal escaped its loop".into()], Span::ZERO, self.module)
            }
            Flow::Exit(code) => {
                BaaError::new("BAA301", vec![format!("exit({code})")], Span::ZERO, self.module)
            }
        }
    }

    // ------------------------------------------------------------- statements

    pub fn execute_body(&mut self, body: &Block, env: &Rc<Environment>) -> Res<Value> {
        // Function declarations are hoisted so mutually recursive functions
        // work regardless of the order they are written in.
        for statement in body {
            if let Stmt::Fn(declaration) = statement {
                env.define(
                    declaration.name.clone(),
                    Value::Function(Rc::new(Function {
                        name: declaration.name.clone(),
                        params: declaration.params.clone(),
                        body: declaration.body.clone(),
                        closure: env.clone(),
                        declared_at: declaration.span,
                        module: self.module,
                    })),
                    false,
                );
            }
        }
        let mut last = Value::Nil;
        for statement in body {
            last = self.execute(statement, env)?;
        }
        Ok(last)
    }

    pub fn execute(&mut self, statement: &Stmt, env: &Rc<Environment>) -> Res<Value> {
        match statement {
            Stmt::Let { mutable, binding, value, .. } => {
                let value = self.evaluate(value, env)?;
                self.bind(binding, value, env, *mutable)?;
                Ok(Value::Nil)
            }
            Stmt::Fn(declaration) => {
                if !env.has_own(&declaration.name) {
                    env.define(
                        declaration.name.clone(),
                        Value::Function(Rc::new(Function {
                            name: declaration.name.clone(),
                            params: declaration.params.clone(),
                            body: declaration.body.clone(),
                            closure: env.clone(),
                            declared_at: declaration.span,
                            module: self.module,
                        })),
                        false,
                    );
                }
                Ok(Value::Nil)
            }
            Stmt::Expr { expr, .. } => self.evaluate(expr, env),
            Stmt::Baa { values, .. } => {
                let mut parts = Vec::with_capacity(values.len());
                for value in values {
                    parts.push(display(&self.evaluate(value, env)?));
                }
                let line = format!("{}\n", parts.join(" "));
                let _ = self.out.write_all(line.as_bytes());
                Ok(Value::Nil)
            }
            Stmt::Return { value, .. } => {
                let value = match value {
                    Some(expression) => self.evaluate(expression, env)?,
                    None => Value::Nil,
                };
                Err(Flow::Return(value))
            }
            Stmt::If { condition, consequent, alternate, .. } => {
                if self.evaluate(condition, env)?.truthy() {
                    let scope = Environment::child(env);
                    return self.execute_body(consequent, &scope);
                }
                match alternate.as_deref() {
                    None => Ok(Value::Nil),
                    Some(Else::Block(block)) => {
                        let scope = Environment::child(env);
                        self.execute_body(block, &scope)
                    }
                    Some(Else::If(statement)) => self.execute(statement, env),
                }
            }
            Stmt::While { condition, body, .. } => {
                while self.evaluate(condition, env)?.truthy() {
                    let scope = Environment::child(env);
                    match self.execute_body(body, &scope) {
                        Ok(_) | Err(Flow::Continue) => continue,
                        Err(Flow::Break) => break,
                        Err(other) => return Err(other),
                    }
                }
                Ok(Value::Nil)
            }
            Stmt::For { name, value_name, iterable, body, .. } => {
                let subject = self.evaluate(iterable, env)?;
                // An array is read live rather than snapshotted, because the
                // reference implementation iterates it with an index and a
                // length check: a loop that appends to what it is looping over
                // sees what it appended. Every other iterable is finite the
                // moment the loop starts.
                if let Value::Array(items) = &subject {
                    let mut index = 0usize;
                    while index < items.borrow().len() {
                        let item = items.borrow()[index].clone();
                        let scope = Environment::child(env);
                        match value_name {
                            None => scope.define(name.clone(), item, true),
                            Some(second_name) => {
                                scope.define(name.clone(), Value::Number(index as f64), true);
                                scope.define(second_name.clone(), item, true);
                            }
                        }
                        index += 1;
                        match self.execute_body(body, &scope) {
                            Ok(_) | Err(Flow::Continue) => continue,
                            Err(Flow::Break) => break,
                            Err(other) => return Err(other),
                        }
                    }
                    return Ok(Value::Nil);
                }
                let pairs = self.iteration_pairs(&subject, iterable.span())?;
                for (first, second) in pairs {
                    let scope = Environment::child(env);
                    match value_name {
                        None => scope.define(name.clone(), second, true),
                        Some(second_name) => {
                            scope.define(name.clone(), first, true);
                            scope.define(second_name.clone(), second, true);
                        }
                    }
                    match self.execute_body(body, &scope) {
                        Ok(_) | Err(Flow::Continue) => continue,
                        Err(Flow::Break) => break,
                        Err(other) => return Err(other),
                    }
                }
                Ok(Value::Nil)
            }
            Stmt::Break { .. } => Err(Flow::Break),
            Stmt::Continue { .. } => Err(Flow::Continue),
            Stmt::Import { target, alias, source_span, named, .. } => {
                let module = match target {
                    ImportTarget::Module(index) => self.load_module(*index, *source_span)?,
                    ImportTarget::Std(name) => self.load_std(name, *source_span)?,
                };
                if named.is_empty() {
                    env.define(alias.clone(), Value::Module(module), false);
                    return Ok(Value::Nil);
                }
                for specifier in named {
                    match module.get(&specifier.name) {
                        Some(value) => env.define(specifier.alias.clone(), value, false),
                        None => {
                            let mut error = self.error(
                                "BAA403",
                                vec![module.name.to_string(), specifier.name.to_string()],
                                specifier.span,
                            );
                            error = error.with_note("not exported");
                            if let Some(hint) = suggest(&specifier.name, &module.names()) {
                                error = error.with_help(format!("Did you mean `{hint}`?"));
                            }
                            return Err(Flow::Err(error));
                        }
                    }
                }
                Ok(Value::Nil)
            }
            Stmt::Throw { value, span } => {
                let value = self.evaluate(value, env)?;
                Err(Flow::Throw(value, *span))
            }
            Stmt::Try { block, handler, finalizer, .. } => {
                let scope = Environment::child(env);
                let mut outcome = self.execute_body(block, &scope).map(|_| ());

                if let Err(flow) = outcome {
                    // With no `catch`, whatever went wrong keeps going: only
                    // the `finally` below runs on the way past.
                    outcome = match handler {
                        None => Err(flow),
                        Some((name, body)) => match self.catchable(flow) {
                            Err(flow) => Err(flow),
                            Ok(caught) => {
                                let scope = Environment::child(env);
                                if let Some(name) = name {
                                    scope.define(name.clone(), caught, true);
                                }
                                self.execute_body(body, &scope).map(|_| ())
                            }
                        },
                    };
                }

                // `finally` runs whichever way the block left, and its own
                // signals win, which is what lets a `return` in `finally`
                // replace the one being carried out.
                if let Some(finalizer) = finalizer {
                    let scope = Environment::child(env);
                    self.execute_body(finalizer, &scope)?;
                }
                outcome.map(|_| Value::Nil)
            }
            Stmt::Test { name, body, .. } => {
                self.tests.push((name.clone(), body.clone(), env.clone(), self.module));
                Ok(Value::Nil)
            }
        }
    }

    /// A `catch` sees thrown values and runtime errors. It does not see
    /// `break`, `return` or `exit`, which are not failures.
    fn catchable(&self, flow: Flow) -> Result<Value, Flow> {
        match flow {
            Flow::Throw(value, _) => Ok(value),
            Flow::Err(error) => {
                let mut map = BaaMap::new();
                map.set_str("code", Value::str(error.code));
                map.set_str("message", Value::str(error.message()));
                let module = self.image.modules.get(error.module);
                map.set_str(
                    "file",
                    module.map(|m| Value::str(&*m.path)).unwrap_or(Value::Nil),
                );
                match module {
                    Some(module) => {
                        let (line, column) = crate::diag::position(&module.source, error.span.start);
                        map.set_str("line", Value::Number(line as f64));
                        map.set_str("column", Value::Number(column as f64));
                    }
                    None => {
                        map.set_str("line", Value::Nil);
                        map.set_str("column", Value::Nil);
                    }
                }
                Ok(Value::map(map))
            }
            other => Err(other),
        }
    }

    fn bind(&mut self, binding: &Binding, value: Value, env: &Rc<Environment>, mutable: bool) -> Res<()> {
        match binding {
            Binding::Name { name, .. } => {
                env.define(name.clone(), value, mutable);
                Ok(())
            }
            Binding::Array { span, elements } => {
                let Value::Array(items) = &value else {
                    return Err(Flow::Err(
                        self.error(
                            "BAA311",
                            vec!["this binding".into(), "an array".into(), "1".into(), value.describe()],
                            *span,
                        )
                        .with_note("cannot be taken apart as an array")
                        .with_help(format!("`[...]` on the left needs an array on the right, not {}.", value.describe())),
                    ));
                };
                let source: Vec<Value> = items.borrow().clone();
                for (index, (rest, inner)) in elements.iter().enumerate() {
                    let item = if *rest {
                        Value::array(source.get(index..).map(<[Value]>::to_vec).unwrap_or_default())
                    } else {
                        source.get(index).cloned().unwrap_or(Value::Nil)
                    };
                    self.bind(inner, item, env, mutable)?;
                }
                Ok(())
            }
            Binding::Map { span, entries } => {
                let Value::Map(map) = &value else {
                    return Err(Flow::Err(
                        self.error(
                            "BAA311",
                            vec!["this binding".into(), "a map".into(), "1".into(), value.describe()],
                            *span,
                        )
                        .with_note("cannot be taken apart as a map")
                        .with_help(format!("`{{...}}` on the left needs a map on the right, not {}.", value.describe())),
                    ));
                };
                for (key, inner) in entries {
                    let item = map.borrow().get(&MapKey::Str(key.clone())).cloned().unwrap_or(Value::Nil);
                    self.bind(inner, item, env, mutable)?;
                }
                Ok(())
            }
        }
    }

    /// Iteration yields `(key, value)`: index and item for arrays, strings and
    /// ranges, key and value for maps.
    fn iteration_pairs(&mut self, value: &Value, span: Span) -> Res<Vec<(Value, Value)>> {
        match value {
            Value::Array(items) => Ok(items
                .borrow()
                .iter()
                .enumerate()
                .map(|(index, item)| (Value::Number(index as f64), item.clone()))
                .collect()),
            Value::Range(range) => Ok(range
                .values()
                .into_iter()
                .enumerate()
                .map(|(index, item)| (Value::Number(index as f64), Value::Number(item)))
                .collect()),
            Value::Str(text) => Ok(text
                .chars()
                .enumerate()
                .map(|(index, ch)| (Value::Number(index as f64), Value::str(ch.to_string())))
                .collect()),
            Value::Map(map) => Ok(map
                .borrow()
                .iter()
                .map(|(key, item)| (key.to_value(), item.clone()))
                .collect()),
            other => Err(Flow::Err(
                self.error("BAA309", vec![other.describe()], span)
                    .with_note("cannot be looped over")
                    .with_help("Loop over an array, map, string or range."),
            )),
        }
    }

    // ---------------------------------------------------------------- modules

    pub fn load_module(&mut self, index: usize, span: Span) -> Res<Rc<Module>> {
        if let Some(module) = self.modules.get(&index) {
            return Ok(module.clone());
        }
        if self.loading.contains(&index) {
            let path = self.image.modules[index].path.clone();
            return Err(Flow::Err(
                self.error("BAA402", vec![format!("{path} imports itself")], span)
                    .with_note("already being loaded")
                    .with_help("Move the shared code into a third module that both can import."),
            ));
        }

        self.loading.insert(index);
        let previous = self.module;
        self.module = index;
        let scope = Environment::child(&self.globals);
        let body = self.image.modules[index].body.clone();
        let outcome = self.execute_body(&body, &scope);
        self.module = previous;
        self.loading.remove(&index);
        outcome?;

        let mut exports: Vec<(Rc<str>, Value)> = Vec::new();
        for statement in body.iter() {
            match statement {
                Stmt::Fn(declaration) if declaration.exported => {
                    if let Some(value) = scope.get(&declaration.name) {
                        exports.push((declaration.name.clone(), value));
                    }
                }
                Stmt::Let { exported: true, binding, .. } => {
                    let mut names = Vec::new();
                    binding.names(&mut names);
                    for name in names {
                        if let Some(value) = scope.get(&name) {
                            exports.push((name, value));
                        }
                    }
                }
                _ => {}
            }
        }

        let module = Rc::new(Module {
            name: self.image.modules[index].name.clone(),
            exports: RefCell::new(exports),
        });
        self.modules.insert(index, module.clone());
        Ok(module)
    }

    fn load_std(&mut self, name: &str, span: Span) -> Res<Rc<Module>> {
        if let Some(module) = self.std_modules.get(name) {
            return Ok(module.clone());
        }
        match stdlib::load(name) {
            Some(module) => {
                self.std_modules.insert(name.to_string(), module.clone());
                Ok(module)
            }
            None => {
                let known = stdlib::MODULES.join(", ");
                let mut error = self
                    .error("BAA401", vec![name.to_string()], span)
                    .with_note("unknown module");
                error = match suggest(name, &stdlib::MODULES.iter().map(|m| m.to_string()).collect::<Vec<_>>()) {
                    Some(hint) => error.with_help(format!("Did you mean `{hint}`?")),
                    None => error.with_help(format!(
                        "A native application has: {known}. Web-only modules such as `gate` are not in this runtime."
                    )),
                };
                Err(Flow::Err(error))
            }
        }
    }

    // ------------------------------------------------------------ expressions

    pub fn evaluate(&mut self, expression: &Expr, env: &Rc<Environment>) -> Res<Value> {
        match expression {
            Expr::Number { value, .. } => Ok(Value::Number(*value)),
            Expr::Bool { value, .. } => Ok(Value::Bool(*value)),
            Expr::Nil { .. } => Ok(Value::Nil),
            Expr::Str { parts, .. } => {
                if let [StringPart::Text(text)] = &parts[..] {
                    return Ok(Value::Str(text.clone()));
                }
                let mut out = String::new();
                for part in parts {
                    match part {
                        StringPart::Text(text) => out.push_str(text),
                        StringPart::Expr(expression) => {
                            out.push_str(&display(&self.evaluate(expression, env)?))
                        }
                    }
                }
                Ok(Value::str(out))
            }
            Expr::Ident { name, span } => match env.get(name) {
                Some(value) => Ok(value),
                None => {
                    let mut error = self.error("BAA102", vec![name.to_string()], *span);
                    error = error.with_note("not found in this scope");
                    if let Some(hint) = suggest(name, &env.names()) {
                        error = error.with_help(format!("Did you mean `{hint}`?"));
                    }
                    Err(Flow::Err(error))
                }
            },
            Expr::Array { elements, .. } => {
                let mut items = Vec::with_capacity(elements.len());
                for element in elements {
                    items.push(self.evaluate(element, env)?);
                }
                Ok(Value::array(items))
            }
            Expr::Map { entries, .. } => {
                let mut map = BaaMap::new();
                for (key, value) in entries {
                    let key_value = self.evaluate(key, env)?;
                    let Some(map_key) = MapKey::from_value(&key_value) else {
                        return self.fail(
                            "BAA311",
                            vec![
                                "map key".into(),
                                "a string, number, bool or nil".into(),
                                "1".into(),
                                key_value.describe(),
                            ],
                            key.span(),
                        );
                    };
                    let value = self.evaluate(value, env)?;
                    map.set(map_key, value);
                }
                Ok(Value::map(map))
            }
            Expr::Fn { name, params, body, span } => Ok(Value::Function(Rc::new(Function {
                name: name.clone(),
                params: params.clone(),
                body: body.clone(),
                closure: env.clone(),
                declared_at: *span,
                module: self.module,
            }))),
            Expr::Unary { op, operand, span } => {
                let value = self.evaluate(operand, env)?;
                match op {
                    UnaryOp::Not => Ok(Value::Bool(!value.truthy())),
                    UnaryOp::Neg => match value {
                        Value::Number(number) => Ok(Value::Number(-number)),
                        other => Err(Flow::Err(
                            self.error(
                                "BAA302",
                                vec!["negate".into(), other.describe(), "nothing".into()],
                                *span,
                            )
                            .with_note("only numbers can be negated"),
                        )),
                    },
                }
            }
            Expr::Binary { op, op_span, left, right, .. } => {
                let left = self.evaluate(left, env)?;
                let right = self.evaluate(right, env)?;
                self.binary(*op, left, right, *op_span)
            }
            Expr::Logical { op, left, right, .. } => {
                let left = self.evaluate(left, env)?;
                match op {
                    LogicalOp::And => {
                        if left.truthy() {
                            self.evaluate(right, env)
                        } else {
                            Ok(left)
                        }
                    }
                    LogicalOp::Or => {
                        if left.truthy() {
                            Ok(left)
                        } else {
                            self.evaluate(right, env)
                        }
                    }
                    LogicalOp::Coalesce => match left {
                        Value::Nil => self.evaluate(right, env),
                        other => Ok(other),
                    },
                }
            }
            Expr::Range { inclusive, start, end, span } => {
                let start_value = self.evaluate(start, env)?;
                let end_value = self.evaluate(end, env)?;
                match (start_value.as_number(), end_value.as_number()) {
                    (Some(start), Some(end)) => {
                        Ok(Value::Range(Rc::new(Range { start, end, inclusive: *inclusive })))
                    }
                    _ => Err(Flow::Err(
                        self.error(
                            "BAA302",
                            vec![
                                "build a range from".into(),
                                start_value.describe(),
                                end_value.describe(),
                            ],
                            *span,
                        )
                        .with_note("ranges need numbers on both sides"),
                    )),
                }
            }
            Expr::Assign { op, target, value, span } => self.assign(*op, target, value, *span, env),
            Expr::Member { object, property, property_span, .. } => {
                let object = self.evaluate(object, env)?;
                self.read_member(&object, property, *property_span)
            }
            Expr::Index { object, index, span } => {
                let object = self.evaluate(object, env)?;
                let index = self.evaluate(index, env)?;
                self.read_index(&object, &index, *span)
            }
            Expr::Call { callee, args, args_span, .. } => {
                let function = self.evaluate(callee, env)?;
                let mut values = Vec::with_capacity(args.len());
                for argument in args {
                    values.push(self.evaluate(argument, env)?);
                }
                let name = callee.callee_name();
                self.call_value(function, values, *args_span, &name)
            }
            Expr::Match { subject, arms, span } => {
                let subject = self.evaluate(subject, env)?;
                for arm in arms {
                    if let Some(scope) = self.match_arm(arm, &subject, env)? {
                        return self.evaluate(&arm.body, &scope);
                    }
                }
                Err(Flow::Err(
                    self.error(
                        "BAA301",
                        vec![format!("no match arm accepted {}", inspect(&subject))],
                        *span,
                    )
                    .with_note("nothing matched")
                    .with_help("Add a `_ => ...` arm to cover the remaining cases."),
                ))
            }
        }
    }

    fn match_arm(
        &mut self,
        arm: &MatchArm,
        subject: &Value,
        env: &Rc<Environment>,
    ) -> Res<Option<Rc<Environment>>> {
        for pattern in &arm.patterns {
            let scope = Environment::child(env);
            let matched = match pattern {
                Pattern::Wildcard { .. } => true,
                Pattern::Binding { name, .. } => {
                    scope.define(name.clone(), subject.clone(), false);
                    true
                }
                Pattern::Literal { value, .. } => {
                    let candidate = self.evaluate(value, env)?;
                    equal(&candidate, subject)
                }
            };
            if !matched {
                continue;
            }
            if let Some(guard) = &arm.guard {
                if !self.evaluate(guard, &scope)?.truthy() {
                    continue;
                }
            }
            return Ok(Some(scope));
        }
        Ok(None)
    }

    pub fn binary(&mut self, op: BinaryOp, left: Value, right: Value, span: Span) -> Res<Value> {
        match op {
            BinaryOp::Eq => return Ok(Value::Bool(equal(&left, &right))),
            BinaryOp::Ne => return Ok(Value::Bool(!equal(&left, &right))),
            BinaryOp::In => return self.contains(&right, &left, span),
            _ => {}
        }

        if op == BinaryOp::Add {
            return match (&left, &right) {
                (Value::Number(a), Value::Number(b)) => Ok(Value::Number(a + b)),
                (Value::Array(a), Value::Array(b)) => {
                    let mut items = a.borrow().clone();
                    items.extend(b.borrow().iter().cloned());
                    Ok(Value::array(items))
                }
                _ => {
                    // Concatenation wins when either side is text, which is
                    // what `"Baa, " + name` needs. Everything else is numeric.
                    let textual = matches!(left, Value::Str(_)) || matches!(right, Value::Str(_));
                    if textual && concatenable(&left) && concatenable(&right) {
                        Ok(Value::str(format!("{}{}", display(&left), display(&right))))
                    } else {
                        Err(Flow::Err(self.operand_error("add", &left, &right, span)))
                    }
                }
            };
        }

        if matches!(op, BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge) {
            return match (&left, &right) {
                (Value::Number(a), Value::Number(b)) => Ok(Value::Bool(match op {
                    BinaryOp::Lt => a < b,
                    BinaryOp::Le => a <= b,
                    BinaryOp::Gt => a > b,
                    _ => a >= b,
                })),
                (Value::Str(a), Value::Str(b)) => Ok(Value::Bool(match op {
                    // JavaScript compares strings by UTF-16 code unit and Rust
                    // by byte; both orderings agree for every string that is
                    // not a lone surrogate, which Baa strings cannot hold.
                    BinaryOp::Lt => a < b,
                    BinaryOp::Le => a <= b,
                    BinaryOp::Gt => a > b,
                    _ => a >= b,
                })),
                _ => Err(Flow::Err(self.operand_error("compare", &left, &right, span))),
            };
        }

        let (Value::Number(a), Value::Number(b)) = (&left, &right) else {
            if op == BinaryOp::Mul {
                if let (Value::Str(text), Value::Number(count)) = (&left, &right) {
                    let count = count.floor().max(0.0);
                    let total = count * text.chars().count() as f64;
                    if total > MAX_SIZE as f64 {
                        return self.fail("BAA310", vec!["*".into(), number::format(total)], span);
                    }
                    return Ok(Value::str(text.repeat(count as usize)));
                }
            }
            return Err(Flow::Err(self.operand_error(op.verb(), &left, &right, span)));
        };

        Ok(Value::Number(match op {
            BinaryOp::Sub => a - b,
            BinaryOp::Mul => a * b,
            BinaryOp::Pow => a.powf(*b),
            BinaryOp::Div => {
                if *b == 0.0 {
                    return Err(Flow::Err(
                        self.error("BAA306", vec![], span).with_note("divisor is zero"),
                    ));
                }
                a / b
            }
            BinaryOp::Rem => {
                if *b == 0.0 {
                    return Err(Flow::Err(
                        self.error("BAA306", vec![], span).with_note("divisor is zero"),
                    ));
                }
                a % b
            }
            _ => unreachable!("handled above"),
        }))
    }

    fn operand_error(&self, verb: &str, left: &Value, right: &Value, span: Span) -> BaaError {
        let numeric = matches!(left, Value::Number(_)) || matches!(right, Value::Number(_));
        self.error(
            "BAA302",
            vec![verb.to_string(), left.describe(), right.describe()],
            span,
        )
        .with_note("these types don't mix")
        .with_help(if numeric {
            "Convert the other value first, for example with `to_number(x)`."
        } else {
            "Check the types with `type_of(x)`."
        })
    }

    fn contains(&mut self, container: &Value, needle: &Value, span: Span) -> Res<Value> {
        match container {
            Value::Array(items) => Ok(Value::Bool(items.borrow().iter().any(|item| equal(item, needle)))),
            Value::Map(map) => Ok(Value::Bool(match MapKey::from_value(needle) {
                Some(key) => map.borrow().has(&key),
                None => false,
            })),
            Value::Range(range) => Ok(Value::Bool(match needle {
                Value::Number(number) => range.contains(*number),
                _ => false,
            })),
            Value::Str(text) => match needle {
                Value::Str(part) => Ok(Value::Bool(text.contains(&**part))),
                _ => Err(Flow::Err(
                    self.error(
                        "BAA302",
                        vec!["look inside".into(), needle.describe(), container.describe()],
                        span,
                    )
                    .with_note("`in` works on arrays, maps, ranges and strings"),
                )),
            },
            _ => Err(Flow::Err(
                self.error(
                    "BAA302",
                    vec!["look inside".into(), needle.describe(), container.describe()],
                    span,
                )
                .with_note("`in` works on arrays, maps, ranges and strings"),
            )),
        }
    }

    // ------------------------------------------------------------ member access

    pub fn read_member(&mut self, object: &Value, property: &str, span: Span) -> Res<Value> {
        if let Value::Module(module) = object {
            return match module.get(property) {
                Some(value) => Ok(value),
                None => {
                    let mut error = self
                        .error("BAA403", vec![module.name.to_string(), property.to_string()], span)
                        .with_note("not exported");
                    if let Some(hint) = suggest(property, &module.names()) {
                        error = error.with_help(format!("Did you mean `{hint}`?"));
                    }
                    Err(Flow::Err(error))
                }
            };
        }
        if let Value::Map(map) = object {
            // Data wins over methods, so adding a method never breaks a
            // program that already stores a key by that name.
            let key = MapKey::Str(Rc::from(property));
            if let Some(value) = map.borrow().get(&key) {
                return Ok(value.clone());
            }
        }
        if let Some(method) = crate::methods::lookup(object, property) {
            return Ok(method);
        }
        if matches!(object, Value::Map(_)) {
            return Ok(Value::Nil);
        }
        if matches!(object, Value::Nil) {
            return Err(Flow::Err(
                self.error("BAA305", vec!["nil".into(), property.to_string()], span)
                    .with_note("nil has no fields")
                    .with_help("Check the value before reading from it, or use `value ?? fallback`."),
            ));
        }
        let mut error = self
            .error("BAA305", vec![object.describe(), property.to_string()], span)
            .with_note("no such field or method");
        if let Some(hint) = suggest(property, &crate::methods::names(object)) {
            error = error.with_help(format!("Did you mean `{hint}`?"));
        }
        Err(Flow::Err(error))
    }

    pub fn read_index(&mut self, object: &Value, index: &Value, span: Span) -> Res<Value> {
        match object {
            Value::Array(items) => {
                let length = items.borrow().len();
                let at = self.normalise_index(index, length, span, "array")?;
                Ok(items.borrow()[at].clone())
            }
            Value::Str(text) => {
                let chars: Vec<char> = text.chars().collect();
                let at = self.normalise_index(index, chars.len(), span, "string")?;
                Ok(Value::str(chars[at].to_string()))
            }
            Value::Map(map) => {
                let Some(key) = MapKey::from_value(index) else {
                    return self.fail(
                        "BAA311",
                        vec![
                            "index".into(),
                            "a string, number, bool or nil".into(),
                            "1".into(),
                            index.describe(),
                        ],
                        span,
                    );
                };
                Ok(map.borrow().get(&key).cloned().unwrap_or(Value::Nil))
            }
            Value::Range(range) => {
                // Computed rather than materialised: indexing `0..10_000_000`
                // should not allocate ten million numbers to return one.
                let length = range.length();
                let at = self.normalise_index(index, length as usize, span, "range")?;
                let step = if range.start <= range.end { 1.0 } else { -1.0 };
                Ok(Value::Number(range.start + at as f64 * step))
            }
            other => Err(Flow::Err(
                self.error("BAA305", vec![other.describe(), display(index)], span)
                    .with_note("this value cannot be indexed")
                    .with_help("Indexing works on arrays, maps, strings and ranges."),
            )),
        }
    }

    fn normalise_index(&self, index: &Value, length: usize, span: Span, what: &str) -> Res<usize> {
        let Value::Number(number) = index else {
            return self.fail(
                "BAA311",
                vec!["index".into(), "a whole number".into(), "1".into(), index.describe()],
                span,
            );
        };
        if number.fract() != 0.0 || !number.is_finite() {
            return self.fail(
                "BAA311",
                vec!["index".into(), "a whole number".into(), "1".into(), index.describe()],
                span,
            );
        }
        let at = if *number < 0.0 { length as f64 + number } else { *number };
        if at < 0.0 || at >= length as f64 {
            return Err(Flow::Err(
                self.error(
                    "BAA304",
                    vec![number::format(*number), what.to_string(), length.to_string()],
                    span,
                )
                .with_note("index out of range")
                .with_help(if length == 0 {
                    "This value is empty.".to_string()
                } else {
                    format!(
                        "Valid indexes are 0 to {} (or -1 to -{length} counting from the end).",
                        length - 1
                    )
                }),
            ));
        }
        Ok(at as usize)
    }

    fn assign(
        &mut self,
        op: Option<BinaryOp>,
        target: &Expr,
        value: &Expr,
        span: Span,
        env: &Rc<Environment>,
    ) -> Res<Value> {
        match target {
            Expr::Ident { name, span: name_span } => {
                let computed = match op {
                    None => self.evaluate(value, env)?,
                    Some(op) => {
                        let Some(current) = env.get(name) else {
                            return self.fail("BAA102", vec![name.to_string()], *name_span);
                        };
                        let right = self.evaluate(value, env)?;
                        self.binary(op, current, right, span)?
                    }
                };
                match env.assign(name, computed.clone()) {
                    Some(true) => Ok(computed),
                    Some(false) => Err(Flow::Err(
                        self.error("BAA104", vec![name.to_string()], *name_span)
                            .with_note("declared with `const`")
                            .with_help("Use `let` if this needs to change."),
                    )),
                    None => {
                        let mut error = self
                            .error("BAA102", vec![name.to_string()], *name_span)
                            .with_note("not found in this scope");
                        if let Some(hint) = suggest(name, &env.names()) {
                            error = error.with_help(format!("Did you mean `{hint}`?"));
                        }
                        Err(Flow::Err(error))
                    }
                }
            }
            Expr::Member { object, property, property_span, .. } => {
                let target_value = self.evaluate(object, env)?;
                let Value::Map(map) = &target_value else {
                    return Err(Flow::Err(
                        self.error(
                            "BAA305",
                            vec![target_value.describe(), property.to_string()],
                            *property_span,
                        )
                        .with_note("cannot assign to this")
                        .with_help("Only map fields and array elements can be assigned."),
                    ));
                };
                let key = MapKey::Str(Rc::from(&**property));
                let computed = match op {
                    None => self.evaluate(value, env)?,
                    Some(op) => {
                        let current = map.borrow().get(&key).cloned().unwrap_or(Value::Nil);
                        let right = self.evaluate(value, env)?;
                        self.binary(op, current, right, span)?
                    }
                };
                map.borrow_mut().set(key, computed.clone());
                Ok(computed)
            }
            Expr::Index { object, index, span: target_span } => {
                let target_value = self.evaluate(object, env)?;
                let index_value = self.evaluate(index, env)?;
                match &target_value {
                    Value::Array(items) => {
                        let length = items.borrow().len();
                        let at = self.normalise_index(&index_value, length, *target_span, "array")?;
                        let computed = match op {
                            None => self.evaluate(value, env)?,
                            Some(op) => {
                                let current = items.borrow()[at].clone();
                                let right = self.evaluate(value, env)?;
                                self.binary(op, current, right, span)?
                            }
                        };
                        items.borrow_mut()[at] = computed.clone();
                        Ok(computed)
                    }
                    Value::Map(map) => {
                        let Some(key) = MapKey::from_value(&index_value) else {
                            return self.fail(
                                "BAA311",
                                vec![
                                    "index".into(),
                                    "a string, number, bool or nil".into(),
                                    "1".into(),
                                    index_value.describe(),
                                ],
                                *target_span,
                            );
                        };
                        let computed = match op {
                            None => self.evaluate(value, env)?,
                            Some(op) => {
                                let current = map.borrow().get(&key).cloned().unwrap_or(Value::Nil);
                                let right = self.evaluate(value, env)?;
                                self.binary(op, current, right, span)?
                            }
                        };
                        map.borrow_mut().set(key, computed.clone());
                        Ok(computed)
                    }
                    other => Err(Flow::Err(
                        self.error("BAA305", vec![other.describe(), display(&index_value)], *target_span)
                            .with_note("cannot assign into this value")
                            .with_help("Only arrays and maps support indexed assignment."),
                    )),
                }
            }
            other => Err(Flow::Err(
                self.error("BAA103", vec!["this expression".into()], other.span())
                    .with_note("cannot be assigned to"),
            )),
        }
    }

    // ---------------------------------------------------------------- calling

    pub fn call_value(&mut self, callee: Value, args: Vec<Value>, span: Span, name: &str) -> Res<Value> {
        match callee {
            Value::Native(native) => self.call_native(&native, args, span),
            Value::Function(function) => self.call_function(&function, args, span),
            other => Err(Flow::Err(
                self.error("BAA303", vec![name.to_string()], span)
                    .with_note(format!("this is {}", other.describe()))
                    .with_help("Only functions can be called."),
            )),
        }
    }

    /// Calls a Baa function from library code, dropping arguments the callback
    /// did not ask for. `map` offers `(item, index)` and most callbacks want
    /// one of them; only this path is lenient, and only in that direction.
    pub fn call_callback(&mut self, callee: &Value, mut args: Vec<Value>, span: Span) -> Res<Value> {
        if let Value::Function(function) = callee {
            let takes_rest = function.params.iter().any(|param| param.rest);
            if !takes_rest && args.len() > function.params.len() {
                args.truncate(function.params.len());
            }
        }
        self.call_value(callee.clone(), args, span, "this value")
    }

    fn call_native(&mut self, native: &Rc<Native>, args: Vec<Value>, span: Span) -> Res<Value> {
        if args.len() < native.min_args {
            return self.fail(
                "BAA202",
                vec![
                    native.name.to_string(),
                    arity_text(native.min_args, native.max_args),
                    args.len().to_string(),
                ],
                span,
            );
        }
        if args.len() > native.max_args {
            return self.fail(
                "BAA201",
                vec![
                    native.name.to_string(),
                    arity_text(native.min_args, native.max_args),
                    args.len().to_string(),
                ],
                span,
            );
        }
        let mut full = Vec::with_capacity(args.len() + 1);
        if let Some(receiver) = &native.receiver {
            full.push((**receiver).clone());
        }
        full.extend(args);
        (native.call)(self, native, full, span)
    }

    pub fn call_function(&mut self, function: &Rc<Function>, args: Vec<Value>, span: Span) -> Res<Value> {
        let required = function
            .params
            .iter()
            .filter(|param| param.default.is_none() && !param.rest)
            .count();
        let has_rest = function.params.iter().any(|param| param.rest);
        let maximum = if has_rest { usize::MAX } else { function.params.len() };

        if args.len() < required {
            return Err(Flow::Err(
                self.error(
                    "BAA202",
                    vec![
                        function.name.to_string(),
                        arity_text(required, maximum),
                        args.len().to_string(),
                    ],
                    span,
                )
                .with_note("too few arguments"),
            ));
        }
        if args.len() > maximum {
            return Err(Flow::Err(
                self.error(
                    "BAA201",
                    vec![
                        function.name.to_string(),
                        arity_text(required, function.params.len()),
                        args.len().to_string(),
                    ],
                    span,
                )
                .with_note("too many arguments"),
            ));
        }
        if self.depth >= self.max_depth {
            return Err(Flow::Err(
                self.error("BAA307", vec![], span)
                    .with_note("call stack limit reached")
                    .with_help(format!(
                        "The limit is {} nested calls. Rewrite deep recursion as a loop.",
                        self.max_depth
                    ))
                    .with_trace(self.stack.iter().rev().take(8).cloned().collect()),
            ));
        }

        let scope = Environment::child(&function.closure);
        self.bind_params(&function.params, args, &scope)?;

        self.stack.push(Frame { name: function.name.to_string(), span, module: self.module });
        self.depth += 1;
        let previous_module = self.module;
        self.module = function.module;

        let outcome = self.execute_body(&function.body, &scope);

        self.module = previous_module;
        self.depth -= 1;
        let frames: Vec<Frame> = self.stack.iter().rev().cloned().collect();
        self.stack.pop();

        match outcome {
            Ok(_) => Ok(Value::Nil),
            Err(Flow::Return(value)) => Ok(value),
            Err(Flow::Err(error)) if error.trace.is_empty() => Err(Flow::Err(error.with_trace(frames))),
            Err(other) => Err(other),
        }
    }

    fn bind_params(&mut self, params: &[Param], args: Vec<Value>, scope: &Rc<Environment>) -> Res<()> {
        let mut index = 0;
        for param in params {
            if param.rest {
                let rest = args.get(index..).map(<[Value]>::to_vec).unwrap_or_default();
                scope.define(param.name.clone(), Value::array(rest), true);
                index = args.len();
                continue;
            }
            let value = match args.get(index) {
                Some(value) => value.clone(),
                None => match &param.default {
                    // Defaults are evaluated in the call scope, so a later
                    // default can refer to an earlier parameter.
                    Some(expression) => self.evaluate(expression, scope)?,
                    None => Value::Nil,
                },
            };
            scope.define(param.name.clone(), value, true);
            index += 1;
        }
        Ok(())
    }

    pub fn stack_trace(&self) -> Vec<Frame> {
        self.stack.iter().rev().cloned().collect()
    }
}

#[cfg(windows)]
fn default_backend() -> Option<Box<dyn crate::gui::Backend>> {
    Some(Box::new(crate::gui::win32::Win32::new()))
}

/// Every other platform. The window model is portable; no backend implements
/// it yet, and `barn.show` says so rather than failing silently.
#[cfg(not(windows))]
fn default_backend() -> Option<Box<dyn crate::gui::Backend>> {
    None
}

/// The largest array or string the runtime will build, matching `checkSize` in
/// the reference implementation: a limit that fails with a diagnostic beats an
/// allocator that fails with a crash.
pub const MAX_SIZE: usize = 10_000_000;

fn concatenable(value: &Value) -> bool {
    matches!(value, Value::Nil | Value::Str(_) | Value::Number(_) | Value::Bool(_))
}

fn arity_text(min: usize, max: usize) -> String {
    if max == usize::MAX {
        return format!("{min} or more");
    }
    if min == max {
        return min.to_string();
    }
    format!("{min} to {max}")
}

/// "Did you mean" for a misspelled name: the closest candidate within an edit
/// distance that scales with the length of the word, as the reference does.
pub fn suggest(name: &str, candidates: &[String]) -> Option<String> {
    let limit = match name.len() {
        0..=2 => 0,
        3..=5 => 1,
        _ => 2,
    };
    if limit == 0 {
        return None;
    }
    let mut best: Option<(usize, &String)> = None;
    for candidate in candidates {
        let distance = edit_distance(name, candidate);
        if distance > limit {
            continue;
        }
        match best {
            Some((current, _)) if current <= distance => {}
            _ => best = Some((distance, candidate)),
        }
    }
    best.map(|(_, candidate)| candidate.clone())
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        current[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            current[j] = (previous[j] + 1).min(current[j - 1] + 1).min(previous[j - 1] + cost);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}
