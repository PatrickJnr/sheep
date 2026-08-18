//! Runtime errors, and how they reach a person.
//!
//! The catalogue in `codes.rs` is generated from the reference implementation,
//! so the sentence a native application prints for `BAA302` is the sentence
//! `baa run` prints. What differs is the frame around it: there is no colour
//! here and no `--no-baa` flag on a windowed application, so the plain wording
//! is selected by the same environment variables the CLI honours.

use crate::ast::{Image, Span};
use crate::codes;

#[derive(Clone)]
pub struct Frame {
    pub name: String,
    pub span: Span,
    pub module: usize,
}

pub struct BaaError {
    pub code: &'static str,
    pub args: Vec<String>,
    pub span: Span,
    pub module: usize,
    pub note: Option<String>,
    pub help: Option<String>,
    pub trace: Vec<Frame>,
}

impl BaaError {
    pub fn new(code: &'static str, args: Vec<String>, span: Span, module: usize) -> BaaError {
        BaaError { code, args, span, module, note: None, help: None, trace: Vec::new() }
    }

    pub fn with_note(mut self, note: impl Into<String>) -> BaaError {
        self.note = Some(note.into());
        self
    }

    pub fn with_help(mut self, help: impl Into<String>) -> BaaError {
        self.help = Some(help.into());
        self
    }

    pub fn with_trace(mut self, trace: Vec<Frame>) -> BaaError {
        self.trace = trace;
        self
    }

    pub fn message(&self) -> String {
        match codes::lookup(self.code) {
            Some((woolly, plain)) => codes::render(if plain_wording() { plain } else { woolly }, &self.args),
            // A code with no entry would be a generator bug rather than a
            // program's fault, and saying so beats printing an empty sentence.
            None => format!("{} (no message for this code)", self.code),
        }
    }

    /// The full report: message, the line it happened on, and the call stack.
    pub fn render(&self, image: &Image) -> String {
        let mut out = format!("error[{}]: {}\n", self.code, self.message());

        if let Some(module) = image.modules.get(self.module) {
            let (line, column) = position(&module.source, self.span.start);
            out.push_str(&format!("  --> {}:{}:{}\n", module.path, line, column));
            if let Some(text) = module.source.lines().nth(line.saturating_sub(1)) {
                let gutter = line.to_string();
                let width = gutter.len();
                out.push_str(&format!("{:width$} |\n", "", width = width));
                out.push_str(&format!("{gutter} | {}\n", text.replace('\t', "    ")));
                let caret_column = caret_offset(text, column);
                let length = (self.span.end.saturating_sub(self.span.start)).max(1) as usize;
                out.push_str(&format!(
                    "{:width$} | {}{}",
                    "",
                    " ".repeat(caret_column),
                    "^".repeat(length.min(text.chars().count().saturating_sub(caret_column).max(1))),
                    width = width
                ));
                match &self.note {
                    Some(note) => out.push_str(&format!(" {note}\n")),
                    None => out.push('\n'),
                }
            }
        }

        if let Some(help) = &self.help {
            out.push_str(&format!("  help: {help}\n"));
        }
        if !self.trace.is_empty() {
            out.push_str("  call stack:\n");
            for frame in &self.trace {
                let path = image
                    .modules
                    .get(frame.module)
                    .map(|module| {
                        let (line, column) = position(&module.source, frame.span.start);
                        format!("{}:{}:{}", module.path, line, column)
                    })
                    .unwrap_or_else(|| "<unknown>".to_string());
                out.push_str(&format!("    {} at {}\n", frame.name, path));
            }
        }
        out
    }
}

/// Whether to use the neutral wording, by the same rules as the CLI: `CI` is
/// included because a log a build system captures should read like a compiler.
fn plain_wording() -> bool {
    for name in ["BAA_NO_BAA", "CI"] {
        if std::env::var_os(name).is_some_and(|value| !value.is_empty()) {
            return true;
        }
    }
    false
}

/// One-based line and column for a byte offset, counting columns in characters
/// so a line containing non-ASCII text still underlines the right place.
pub fn position(source: &str, offset: u32) -> (usize, usize) {
    let offset = (offset as usize).min(source.len());
    let mut line = 1;
    let mut column = 1;
    for (at, ch) in source.char_indices() {
        if at >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

/// Columns are counted in characters, and a tab was expanded to four spaces in
/// the line above, so the caret has to be moved by the same amount.
fn caret_offset(line: &str, column: usize) -> usize {
    line.chars()
        .take(column.saturating_sub(1))
        .map(|ch| if ch == '\t' { 4 } else { 1 })
        .sum()
}
