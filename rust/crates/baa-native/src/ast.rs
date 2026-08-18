//! The tree the runtime walks.
//!
//! This mirrors `src/ast/ast.ts`, minus everything only the formatter needs:
//! comments, blank-line counts and the original spelling of a literal are not
//! in the image, because nothing at runtime can observe them. Spans are, since
//! an error has to point at the line it happened on.

use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

impl Span {
    pub const ZERO: Span = Span { start: 0, end: 0 };
}

pub type Block = Vec<Stmt>;

#[derive(Debug)]
pub struct Param {
    pub name: Rc<str>,
    pub rest: bool,
    pub default: Option<Expr>,
}

#[derive(Debug)]
pub struct FnDecl {
    pub name: Rc<str>,
    pub exported: bool,
    pub params: Rc<[Param]>,
    pub body: Rc<Block>,
    pub span: Span,
}

#[derive(Debug)]
pub enum Binding {
    Name { span: Span, name: Rc<str> },
    Array { span: Span, elements: Vec<(bool, Binding)> },
    Map { span: Span, entries: Vec<(Rc<str>, Binding)> },
}

impl Binding {
    pub fn span(&self) -> Span {
        match self {
            Binding::Name { span, .. } | Binding::Array { span, .. } | Binding::Map { span, .. } => *span,
        }
    }

    /// Every name this binding introduces, in source order. Used to build a
    /// module's export table.
    pub fn names(&self, out: &mut Vec<Rc<str>>) {
        match self {
            Binding::Name { name, .. } => out.push(name.clone()),
            Binding::Array { elements, .. } => {
                for (_, binding) in elements {
                    binding.names(out);
                }
            }
            Binding::Map { entries, .. } => {
                for (_, binding) in entries {
                    binding.names(out);
                }
            }
        }
    }
}

#[derive(Debug)]
pub enum ImportTarget {
    /// A standard-library module, by name.
    Std(Rc<str>),
    /// Another module in this image, by index. Resolved at build time.
    Module(usize),
}

#[derive(Debug)]
pub struct ImportSpec {
    pub name: Rc<str>,
    pub alias: Rc<str>,
    pub span: Span,
}

#[derive(Debug)]
pub enum Stmt {
    Let {
        span: Span,
        mutable: bool,
        exported: bool,
        binding: Binding,
        value: Expr,
    },
    Fn(Rc<FnDecl>),
    Expr {
        span: Span,
        expr: Expr,
    },
    Baa {
        span: Span,
        values: Vec<Expr>,
    },
    Return {
        span: Span,
        value: Option<Expr>,
    },
    If {
        span: Span,
        condition: Expr,
        consequent: Rc<Block>,
        alternate: Option<Box<Else>>,
    },
    While {
        span: Span,
        condition: Expr,
        body: Rc<Block>,
    },
    For {
        span: Span,
        name: Rc<str>,
        value_name: Option<Rc<str>>,
        iterable: Expr,
        body: Rc<Block>,
    },
    Break {
        span: Span,
    },
    Continue {
        span: Span,
    },
    Import {
        span: Span,
        target: ImportTarget,
        alias: Rc<str>,
        source_span: Span,
        named: Vec<ImportSpec>,
    },
    Throw {
        span: Span,
        value: Expr,
    },
    Try {
        span: Span,
        block: Rc<Block>,
        handler: Option<(Option<Rc<str>>, Rc<Block>)>,
        finalizer: Option<Rc<Block>>,
    },
    Test {
        span: Span,
        name: Rc<str>,
        body: Rc<Block>,
    },
}

#[derive(Debug)]
pub enum Else {
    Block(Rc<Block>),
    If(Stmt),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Pow,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    In,
}

impl BinaryOp {
    pub fn from_tag(tag: u8) -> Option<BinaryOp> {
        Some(match tag {
            0 => BinaryOp::Add,
            1 => BinaryOp::Sub,
            2 => BinaryOp::Mul,
            3 => BinaryOp::Div,
            4 => BinaryOp::Rem,
            5 => BinaryOp::Pow,
            6 => BinaryOp::Eq,
            7 => BinaryOp::Ne,
            8 => BinaryOp::Lt,
            9 => BinaryOp::Le,
            10 => BinaryOp::Gt,
            11 => BinaryOp::Ge,
            12 => BinaryOp::In,
            _ => return None,
        })
    }

    /// The verb a type error uses: "You can't multiply a string and nil."
    pub fn verb(self) -> &'static str {
        match self {
            BinaryOp::Add => "add",
            BinaryOp::Sub => "subtract",
            BinaryOp::Mul => "multiply",
            BinaryOp::Div => "divide",
            BinaryOp::Rem => "take the remainder of",
            BinaryOp::Pow => "raise",
            _ => "compare",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogicalOp {
    And,
    Or,
    Coalesce,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnaryOp {
    Neg,
    Not,
}

#[derive(Debug)]
pub enum StringPart {
    Text(Rc<str>),
    Expr(Expr),
}

#[derive(Debug)]
pub enum Pattern {
    Wildcard { span: Span },
    Binding { span: Span, name: Rc<str> },
    Literal { span: Span, value: Expr },
}

#[derive(Debug)]
pub struct MatchArm {
    pub span: Span,
    pub patterns: Vec<Pattern>,
    pub guard: Option<Expr>,
    pub body: Expr,
}

#[derive(Debug)]
pub enum Expr {
    Number {
        span: Span,
        value: f64,
    },
    Str {
        span: Span,
        parts: Vec<StringPart>,
    },
    Bool {
        span: Span,
        value: bool,
    },
    Nil {
        span: Span,
    },
    Ident {
        span: Span,
        name: Rc<str>,
    },
    Array {
        span: Span,
        elements: Vec<Expr>,
    },
    Map {
        span: Span,
        entries: Vec<(Expr, Expr)>,
    },
    Fn {
        span: Span,
        name: Rc<str>,
        params: Rc<[Param]>,
        body: Rc<Block>,
    },
    Unary {
        span: Span,
        op: UnaryOp,
        operand: Box<Expr>,
    },
    Binary {
        span: Span,
        op: BinaryOp,
        op_span: Span,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Logical {
        span: Span,
        op: LogicalOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Assign {
        span: Span,
        /// `None` for plain `=`, otherwise the operator `+=` applies.
        op: Option<BinaryOp>,
        target: Box<Expr>,
        value: Box<Expr>,
    },
    Call {
        span: Span,
        args_span: Span,
        callee: Box<Expr>,
        args: Vec<Expr>,
    },
    Member {
        span: Span,
        property: Rc<str>,
        property_span: Span,
        object: Box<Expr>,
    },
    Index {
        span: Span,
        object: Box<Expr>,
        index: Box<Expr>,
    },
    Range {
        span: Span,
        inclusive: bool,
        start: Box<Expr>,
        end: Box<Expr>,
    },
    Match {
        span: Span,
        subject: Box<Expr>,
        arms: Vec<MatchArm>,
    },
}

impl Expr {
    pub fn span(&self) -> Span {
        match self {
            Expr::Number { span, .. }
            | Expr::Str { span, .. }
            | Expr::Bool { span, .. }
            | Expr::Nil { span }
            | Expr::Ident { span, .. }
            | Expr::Array { span, .. }
            | Expr::Map { span, .. }
            | Expr::Fn { span, .. }
            | Expr::Unary { span, .. }
            | Expr::Binary { span, .. }
            | Expr::Logical { span, .. }
            | Expr::Assign { span, .. }
            | Expr::Call { span, .. }
            | Expr::Member { span, .. }
            | Expr::Index { span, .. }
            | Expr::Range { span, .. }
            | Expr::Match { span, .. } => *span,
        }
    }

    /// The name a diagnostic uses for whatever is being called.
    pub fn callee_name(&self) -> Rc<str> {
        match self {
            Expr::Ident { name, .. } => name.clone(),
            Expr::Member { property, .. } => property.clone(),
            _ => Rc::from("this value"),
        }
    }
}

/// One `.baa` file in the image.
pub struct Module {
    pub name: Rc<str>,
    /// Path relative to the project root, for stack traces.
    pub path: Rc<str>,
    pub source: Rc<str>,
    pub body: Rc<Block>,
}

/// A whole application: every module it needs, and where to start.
pub struct Image {
    pub modules: Vec<Module>,
    pub entry: usize,
    /// `[app]` metadata from `baa.toml`: name, version, window size.
    pub app: Vec<(Rc<str>, Rc<str>)>,
}

impl Image {
    pub fn app_value(&self, key: &str) -> Option<&str> {
        self.app
            .iter()
            .find(|(name, _)| &**name == key)
            .map(|(_, value)| &**value)
    }
}
