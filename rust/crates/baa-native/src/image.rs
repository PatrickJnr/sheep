//! Reading a `.fleece` image.
//!
//! The writer lives in `src/native/image.ts`. The two are one format described
//! twice, which is a real risk, so three things keep them honest: the magic
//! and version are checked before anything is decoded, every read is bounds
//! checked and returns an error rather than panicking, and the test suite
//! builds an image from the TypeScript side and runs it through this reader on
//! every commit.
//!
//! A malformed image is refused, not guessed at. This code runs on whatever
//! bytes are appended to the executable, so it treats them as untrusted.

use std::rc::Rc;

use crate::ast::{
    Binding, BinaryOp, Block, Else, Expr, FnDecl, Image, ImportSpec, ImportTarget, LogicalOp,
    MatchArm, Module, Param, Pattern, Span, Stmt, StringPart, UnaryOp,
};

pub const MAGIC: &[u8] = b"FLEECE\n";
pub const VERSION: u8 = 1;

pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    strings: Vec<Rc<str>>,
}

pub type Result<T> = std::result::Result<T, String>;

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8> {
        let byte = *self.bytes.get(self.at).ok_or("image ends in the middle of a value")?;
        self.at += 1;
        Ok(byte)
    }

    fn u32(&mut self) -> Result<u32> {
        let end = self.at + 4;
        let slice = self.bytes.get(self.at..end).ok_or("image ends in the middle of a number")?;
        self.at = end;
        Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }

    fn f64(&mut self) -> Result<f64> {
        let end = self.at + 8;
        let slice = self.bytes.get(self.at..end).ok_or("image ends in the middle of a number")?;
        self.at = end;
        let mut buffer = [0u8; 8];
        buffer.copy_from_slice(slice);
        Ok(f64::from_le_bytes(buffer))
    }

    fn bool(&mut self) -> Result<bool> {
        Ok(self.u8()? != 0)
    }

    fn str(&mut self) -> Result<Rc<str>> {
        let index = self.u32()? as usize;
        self.strings
            .get(index)
            .cloned()
            .ok_or_else(|| format!("string {index} is not in the image"))
    }

    fn span(&mut self) -> Result<Span> {
        Ok(Span { start: self.u32()?, end: self.u32()? })
    }

    fn count(&mut self) -> Result<usize> {
        let count = self.u32()? as usize;
        // A length is four bytes and an element is at least one, so a count
        // larger than what remains is corruption rather than a big program.
        // Without this a bad length asks for a several-gigabyte allocation.
        if count > self.bytes.len() - self.at.min(self.bytes.len()) + 1 {
            return Err(format!("image claims {count} items, which cannot fit in it"));
        }
        Ok(count)
    }

    fn list<T>(&mut self, mut read: impl FnMut(&mut Self) -> Result<T>) -> Result<Vec<T>> {
        let count = self.count()?;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            out.push(read(self)?);
        }
        Ok(out)
    }

    fn params(&mut self) -> Result<Rc<[Param]>> {
        let list = self.list(|r| {
            let name = r.str()?;
            let rest = r.bool()?;
            let default = if r.u8()? == 0 { None } else { Some(r.expr()?) };
            Ok(Param { name, rest, default })
        })?;
        Ok(Rc::from(list))
    }

    fn block(&mut self) -> Result<Rc<Block>> {
        Ok(Rc::new(self.list(|r| r.stmt())?))
    }

    fn binding(&mut self) -> Result<Binding> {
        let span = self.span()?;
        match self.u8()? {
            1 => Ok(Binding::Name { span, name: self.str()? }),
            2 => {
                let elements = self.list(|r| {
                    let rest = r.bool()?;
                    Ok((rest, r.binding()?))
                })?;
                Ok(Binding::Array { span, elements })
            }
            3 => {
                let entries = self.list(|r| {
                    let key = r.str()?;
                    Ok((key, r.binding()?))
                })?;
                Ok(Binding::Map { span, entries })
            }
            other => Err(format!("unknown binding tag {other}")),
        }
    }

    fn pattern(&mut self) -> Result<Pattern> {
        let span = self.span()?;
        match self.u8()? {
            1 => Ok(Pattern::Wildcard { span }),
            2 => Ok(Pattern::Binding { span, name: self.str()? }),
            3 => Ok(Pattern::Literal { span, value: self.expr()? }),
            other => Err(format!("unknown pattern tag {other}")),
        }
    }

    fn expr(&mut self) -> Result<Expr> {
        let span = self.span()?;
        Ok(match self.u8()? {
            1 => Expr::Number { span, value: self.f64()? },
            2 => Expr::Str {
                span,
                parts: self.list(|r| {
                    Ok(if r.u8()? == 0 {
                        StringPart::Text(r.str()?)
                    } else {
                        StringPart::Expr(r.expr()?)
                    })
                })?,
            },
            3 => Expr::Bool { span, value: self.bool()? },
            4 => Expr::Nil { span },
            5 => Expr::Ident { span, name: self.str()? },
            6 => Expr::Array { span, elements: self.list(|r| r.expr())? },
            7 => Expr::Map {
                span,
                entries: self.list(|r| {
                    let key = r.expr()?;
                    Ok((key, r.expr()?))
                })?,
            },
            8 => {
                let name = self.str()?;
                let params = self.params()?;
                Expr::Fn { span, name, params, body: self.block()? }
            }
            9 => {
                let op = match self.u8()? {
                    0 => UnaryOp::Neg,
                    1 => UnaryOp::Not,
                    other => return Err(format!("unknown unary operator {other}")),
                };
                Expr::Unary { span, op, operand: Box::new(self.expr()?) }
            }
            10 => {
                let tag = self.u8()?;
                let op = BinaryOp::from_tag(tag).ok_or_else(|| format!("unknown binary operator {tag}"))?;
                let op_span = self.span()?;
                let left = Box::new(self.expr()?);
                Expr::Binary { span, op, op_span, left, right: Box::new(self.expr()?) }
            }
            11 => {
                let op = match self.u8()? {
                    0 => LogicalOp::And,
                    1 => LogicalOp::Or,
                    2 => LogicalOp::Coalesce,
                    other => return Err(format!("unknown logical operator {other}")),
                };
                let left = Box::new(self.expr()?);
                Expr::Logical { span, op, left, right: Box::new(self.expr()?) }
            }
            12 => {
                let op = match self.u8()? {
                    0 => None,
                    1 => Some(BinaryOp::Add),
                    2 => Some(BinaryOp::Sub),
                    3 => Some(BinaryOp::Mul),
                    4 => Some(BinaryOp::Div),
                    5 => Some(BinaryOp::Rem),
                    other => return Err(format!("unknown assignment operator {other}")),
                };
                let target = Box::new(self.expr()?);
                Expr::Assign { span, op, target, value: Box::new(self.expr()?) }
            }
            13 => {
                let args_span = self.span()?;
                let callee = Box::new(self.expr()?);
                Expr::Call { span, args_span, callee, args: self.list(|r| r.expr())? }
            }
            14 => {
                let property = self.str()?;
                let property_span = self.span()?;
                Expr::Member { span, property, property_span, object: Box::new(self.expr()?) }
            }
            15 => {
                let object = Box::new(self.expr()?);
                Expr::Index { span, object, index: Box::new(self.expr()?) }
            }
            16 => {
                let inclusive = self.bool()?;
                let start = Box::new(self.expr()?);
                Expr::Range { span, inclusive, start, end: Box::new(self.expr()?) }
            }
            17 => {
                let subject = Box::new(self.expr()?);
                let arms = self.list(|r| {
                    let span = r.span()?;
                    let patterns = r.list(|p| p.pattern())?;
                    let guard = if r.u8()? == 0 { None } else { Some(r.expr()?) };
                    Ok(MatchArm { span, patterns, guard, body: r.expr()? })
                })?;
                Expr::Match { span, subject, arms }
            }
            other => return Err(format!("unknown expression tag {other}")),
        })
    }

    fn stmt(&mut self) -> Result<Stmt> {
        let span = self.span()?;
        Ok(match self.u8()? {
            1 => {
                let mutable = self.bool()?;
                let exported = self.bool()?;
                let binding = self.binding()?;
                Stmt::Let { span, mutable, exported, binding, value: self.expr()? }
            }
            2 => {
                let name = self.str()?;
                let exported = self.bool()?;
                let params = self.params()?;
                let body = self.block()?;
                Stmt::Fn(Rc::new(FnDecl { name, exported, params, body, span }))
            }
            3 => Stmt::Expr { span, expr: self.expr()? },
            4 => Stmt::Baa { span, values: self.list(|r| r.expr())? },
            5 => {
                let value = if self.u8()? == 0 { None } else { Some(self.expr()?) };
                Stmt::Return { span, value }
            }
            6 => {
                let condition = self.expr()?;
                let consequent = self.block()?;
                let alternate = match self.u8()? {
                    0 => None,
                    1 => Some(Box::new(Else::Block(self.block()?))),
                    2 => Some(Box::new(Else::If(self.stmt()?))),
                    other => return Err(format!("unknown else tag {other}")),
                };
                Stmt::If { span, condition, consequent, alternate }
            }
            7 => {
                let condition = self.expr()?;
                Stmt::While { span, condition, body: self.block()? }
            }
            8 => {
                let name = self.str()?;
                let value_name = if self.u8()? == 0 { None } else { Some(self.str()?) };
                let iterable = self.expr()?;
                Stmt::For { span, name, value_name, iterable, body: self.block()? }
            }
            9 => Stmt::Break { span },
            10 => Stmt::Continue { span },
            11 => {
                let target = if self.u8()? == 1 {
                    ImportTarget::Module(self.u32()? as usize)
                } else {
                    ImportTarget::Std(self.str()?)
                };
                let alias = self.str()?;
                let source_span = self.span()?;
                let named = self.list(|r| {
                    let name = r.str()?;
                    let alias = r.str()?;
                    Ok(ImportSpec { name, alias, span: r.span()? })
                })?;
                Stmt::Import { span, target, alias, source_span, named }
            }
            12 => Stmt::Throw { span, value: self.expr()? },
            13 => {
                let block = self.block()?;
                let handler = if self.u8()? == 0 {
                    None
                } else {
                    let name = if self.u8()? == 0 { None } else { Some(self.str()?) };
                    Some((name, self.block()?))
                };
                let finalizer = if self.u8()? == 0 { None } else { Some(self.block()?) };
                Stmt::Try { span, block, handler, finalizer }
            }
            14 => {
                let name = self.str()?;
                Stmt::Test { span, name, body: self.block()? }
            }
            other => return Err(format!("unknown statement tag {other}")),
        })
    }
}

/// Decodes an image, or explains why the bytes are not one.
pub fn decode(bytes: &[u8]) -> Result<Image> {
    if bytes.len() < MAGIC.len() + 1 || &bytes[..MAGIC.len()] != MAGIC {
        return Err("this is not a Baa image: the header is missing".to_string());
    }
    let version = bytes[MAGIC.len()];
    if version != VERSION {
        return Err(format!(
            "this image is version {version}, and this runtime reads version {VERSION}. \
             Rebuild the application with a matching `baa` release."
        ));
    }

    let mut reader = Reader { bytes, at: MAGIC.len() + 1, strings: Vec::new() };

    let count = reader.count()?;
    let mut strings = Vec::with_capacity(count);
    for _ in 0..count {
        let length = reader.u32()? as usize;
        let end = reader.at + length;
        let slice = reader
            .bytes
            .get(reader.at..end)
            .ok_or("image ends in the middle of a string")?;
        reader.at = end;
        strings.push(Rc::from(
            std::str::from_utf8(slice).map_err(|_| "a string in the image is not valid UTF-8")?,
        ));
    }
    reader.strings = strings;

    let app = reader.list(|r| {
        let key = r.str()?;
        Ok((key, r.str()?))
    })?;
    let entry = reader.u32()? as usize;
    let modules = reader.list(|r| {
        let name = r.str()?;
        let path = r.str()?;
        let source = r.str()?;
        Ok(Module { name, path, source, body: r.block()? })
    })?;

    if entry >= modules.len() {
        return Err(format!(
            "the image names module {entry} as its entry point, but holds {} modules",
            modules.len()
        ));
    }
    for module in &modules {
        check_import_targets(&module.body, modules.len())?;
    }

    Ok(Image { modules, entry, app })
}

/// Every module index in the image points at a module in the image.
///
/// Checked once, here, so the interpreter can index the module list without a
/// bounds test on every import and without a panic if one is wrong.
fn check_import_targets(body: &[Stmt], count: usize) -> Result<()> {
    for statement in body {
        match statement {
            Stmt::Import { target: ImportTarget::Module(index), .. } if *index >= count => {
                return Err(format!("an import points at module {index}, which the image does not hold"));
            }
            Stmt::If { consequent, alternate, .. } => {
                check_import_targets(consequent, count)?;
                match alternate.as_deref() {
                    Some(Else::Block(block)) => check_import_targets(block, count)?,
                    Some(Else::If(statement)) => check_import_targets(std::slice::from_ref(statement), count)?,
                    None => {}
                }
            }
            Stmt::While { body, .. } | Stmt::For { body, .. } | Stmt::Test { body, .. } => {
                check_import_targets(body, count)?;
            }
            Stmt::Try { block, handler, finalizer, .. } => {
                check_import_targets(block, count)?;
                if let Some((_, handler)) = handler {
                    check_import_targets(handler, count)?;
                }
                if let Some(finalizer) = finalizer {
                    check_import_targets(finalizer, count)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// An image appended to this executable, if there is one.
///
/// A built application is the runtime followed by its image and a footer, so
/// one file is both the program and the thing that runs it. Reading our own
/// path rather than looking beside it means an application does not change
/// behaviour based on what is in its directory.
pub fn embedded(exe: &[u8]) -> Option<&[u8]> {
    const FOOTER: &[u8] = b"BAAFLEECE";
    if exe.len() < FOOTER.len() + 8 {
        return None;
    }
    let tail = &exe[exe.len() - FOOTER.len()..];
    if tail != FOOTER {
        return None;
    }
    let length_at = exe.len() - FOOTER.len() - 8;
    let mut buffer = [0u8; 8];
    buffer.copy_from_slice(&exe[length_at..length_at + 8]);
    let length = u64::from_le_bytes(buffer) as usize;
    if length > length_at {
        return None;
    }
    Some(&exe[length_at - length..length_at])
}
