//! Turning a pattern into a tree, and refusing what is not in the subset.

/// Why a pattern could not be compiled. Carries the text of a diagnostic, so
/// the caller adds a span and nothing else.
#[derive(Debug, Clone)]
pub struct RegexError {
    pub message: String,
    /// What to try instead, when there is something.
    pub help: Option<String>,
}

impl RegexError {
    fn new(message: impl Into<String>) -> RegexError {
        RegexError { message: message.into(), help: None }
    }

    fn with_help(message: impl Into<String>, help: impl Into<String>) -> RegexError {
        RegexError { message: message.into(), help: Some(help.into()) }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Flags {
    /// `i`: case-insensitive.
    pub ignore_case: bool,
    /// `m`: `^` and `$` also match at line breaks.
    pub multiline: bool,
    /// `s`: `.` also matches a line break.
    pub dot_all: bool,
}

impl Flags {
    pub fn parse(flags: &str) -> Result<Flags, RegexError> {
        let mut out = Flags::default();
        for flag in flags.chars() {
            match flag {
                'i' => out.ignore_case = true,
                'm' => out.multiline = true,
                's' => out.dot_all = true,
                // `u` is always on in the reference and means nothing here:
                // this engine works in characters, never in code units.
                'u' | 'g' => {}
                other => {
                    return Err(RegexError::with_help(
                        format!("`{other}` is not a flag Baa knows"),
                        "`i` ignores case, `m` matches `^` and `$` at line breaks, `s` lets `.` match a newline.",
                    ))
                }
            }
        }
        Ok(out)
    }
}

/// One entry in a character class.
#[derive(Clone, Debug)]
pub enum ClassItem {
    Char(char),
    Range(char, char),
    /// `\d`, `\w`, `\s` and their negations.
    Named { kind: NamedClass, negated: bool },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NamedClass {
    Digit,
    Word,
    Space,
}

#[derive(Clone, Debug)]
pub enum Node {
    Empty,
    Char(char),
    /// `.`
    Any,
    Class { negated: bool, items: Vec<ClassItem> },
    Start,
    End,
    /// `\b`, or `\B` when false.
    WordBoundary(bool),
    Group { index: Option<usize>, node: Box<Node> },
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Repeat { node: Box<Node>, min: u32, max: Option<u32>, greedy: bool },
}

pub struct Pattern {
    pub node: Node,
    /// Including group 0, the whole match.
    pub groups: usize,
    pub names: Vec<(usize, String)>,
}

/// The largest `{n,m}` this engine will expand.
///
/// Repetition is compiled by repeating instructions, so a bound of a million
/// would be a million instructions. Refusing is better than allocating for
/// several seconds and then matching.
const MAX_REPEAT: u32 = 1000;

pub fn parse(source: &str, flags: Flags) -> Result<Pattern, RegexError> {
    // Flags change what the *matcher* does, not what the parser accepts, so
    // they are checked here and carried no further.
    let _ = flags;
    let mut parser = Parser { chars: source.chars().collect(), at: 0, groups: 1, names: Vec::new() };
    let node = parser.alternation()?;
    if parser.at < parser.chars.len() {
        // The only way to get here is a `)` with no `(`.
        return Err(RegexError::new(format!(
            "there is a `{}` here with nothing to close",
            parser.chars[parser.at]
        )));
    }
    Ok(Pattern { node, groups: parser.groups, names: parser.names })
}

struct Parser {
    chars: Vec<char>,
    at: usize,
    groups: usize,
    names: Vec<(usize, String)>,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn next(&mut self) -> Option<char> {
        let glyph = self.peek();
        if glyph.is_some() {
            self.at += 1;
        }
        glyph
    }

    fn eat(&mut self, glyph: char) -> bool {
        if self.peek() == Some(glyph) {
            self.at += 1;
            return true;
        }
        false
    }

    fn alternation(&mut self) -> Result<Node, RegexError> {
        let mut branches = vec![self.sequence()?];
        while self.eat('|') {
            branches.push(self.sequence()?);
        }
        Ok(if branches.len() == 1 { branches.pop().unwrap() } else { Node::Alt(branches) })
    }

    fn sequence(&mut self) -> Result<Node, RegexError> {
        let mut items: Vec<Node> = Vec::new();
        while let Some(glyph) = self.peek() {
            if glyph == '|' || glyph == ')' {
                break;
            }
            let atom = self.atom()?;
            items.push(self.quantifier(atom)?);
        }
        Ok(match items.len() {
            0 => Node::Empty,
            1 => items.pop().unwrap(),
            _ => Node::Concat(items),
        })
    }

    fn quantifier(&mut self, atom: Node) -> Result<Node, RegexError> {
        let (min, max) = match self.peek() {
            Some('*') => {
                self.at += 1;
                (0, None)
            }
            Some('+') => {
                self.at += 1;
                (1, None)
            }
            Some('?') => {
                self.at += 1;
                (0, Some(1))
            }
            Some('{') => match self.braces()? {
                Some(bounds) => bounds,
                // `{` that is not a counted repetition is a literal `{`, which
                // is what JavaScript does with `a{x`.
                None => return Ok(atom),
            },
            _ => return Ok(atom),
        };
        if let Some(max) = max {
            if max < min {
                return Err(RegexError::new(format!(
                    "the repetition `{{{min},{max}}}` counts down rather than up"
                )));
            }
        }
        let greedy = !self.eat('?');
        Ok(Node::Repeat { node: Box::new(atom), min, max, greedy })
    }

    /// `{n}`, `{n,}` or `{n,m}`. `None` when this `{` is a literal.
    fn braces(&mut self) -> Result<Option<(u32, Option<u32>)>, RegexError> {
        let start = self.at;
        self.at += 1; // `{`
        let Some(min) = self.number() else {
            self.at = start;
            return Ok(None);
        };
        let max = if self.eat(',') {
            if self.peek() == Some('}') {
                None
            } else {
                match self.number() {
                    Some(value) => Some(value),
                    None => {
                        self.at = start;
                        return Ok(None);
                    }
                }
            }
        } else {
            Some(min)
        };
        if !self.eat('}') {
            self.at = start;
            return Ok(None);
        }
        let bound = max.unwrap_or(min);
        if bound > MAX_REPEAT {
            return Err(RegexError::with_help(
                format!("the repetition `{{{min},{bound}}}` is larger than Baa will expand"),
                format!("The limit is {MAX_REPEAT}. A quantifier that large is usually a `+` in disguise."),
            ));
        }
        Ok(Some((min, max)))
    }

    fn number(&mut self) -> Option<u32> {
        let start = self.at;
        while matches!(self.peek(), Some(glyph) if glyph.is_ascii_digit()) {
            self.at += 1;
        }
        if self.at == start {
            return None;
        }
        self.chars[start..self.at].iter().collect::<String>().parse().ok()
    }

    fn atom(&mut self) -> Result<Node, RegexError> {
        match self.next() {
            None => Ok(Node::Empty),
            Some('.') => Ok(Node::Any),
            Some('^') => Ok(Node::Start),
            Some('$') => Ok(Node::End),
            Some('[') => self.class(),
            Some('(') => self.group(),
            Some('*') | Some('+') | Some('?') => Err(RegexError::with_help(
                "there is a quantifier here with nothing to repeat",
                "Put it after the thing it repeats, or escape it with a backslash.",
            )),
            Some('\\') => self.escape(false),
            Some(glyph) => Ok(Node::Char(glyph)),
        }
    }

    fn group(&mut self) -> Result<Node, RegexError> {
        let mut index = None;
        if self.eat('?') {
            match self.peek() {
                Some(':') => {
                    self.at += 1;
                }
                Some('<') if matches!(self.chars.get(self.at + 1), Some('=') | Some('!')) => {
                    return Err(unsupported("lookbehind", "(?<=...)` and `(?<!...)"))
                }
                Some('<') => {
                    self.at += 1;
                    let name = self.group_name()?;
                    index = Some(self.groups);
                    self.names.push((self.groups, name));
                    self.groups += 1;
                }
                Some('=') | Some('!') => return Err(unsupported("lookahead", "(?=...)` and `(?!...)")),
                _ => {
                    return Err(RegexError::new(
                        "this `(?` opens a group of a kind Baa does not know",
                    ))
                }
            }
        } else {
            index = Some(self.groups);
            self.groups += 1;
        }
        let node = self.alternation()?;
        if !self.eat(')') {
            return Err(RegexError::new("there is a `(` here that is never closed"));
        }
        Ok(Node::Group { index, node: Box::new(node) })
    }

    fn group_name(&mut self) -> Result<String, RegexError> {
        let mut name = String::new();
        loop {
            match self.next() {
                Some('>') => break,
                Some(glyph) if glyph.is_alphanumeric() || glyph == '_' || glyph == '$' => {
                    name.push(glyph)
                }
                Some(other) => {
                    return Err(RegexError::new(format!("`{other}` is not allowed in a group name")))
                }
                None => return Err(RegexError::new("a group name is never closed with `>`")),
            }
        }
        if name.is_empty() {
            return Err(RegexError::new("a named group needs a name"));
        }
        Ok(name)
    }

    fn class(&mut self) -> Result<Node, RegexError> {
        let negated = self.eat('^');
        let mut items: Vec<ClassItem> = Vec::new();
        loop {
            let glyph = match self.next() {
                None => return Err(RegexError::new("there is a `[` here that is never closed")),
                Some(']') => break,
                Some(glyph) => glyph,
            };
            let low = if glyph == '\\' {
                match self.escape(true)? {
                    Node::Char(value) => ClassItem::Char(value),
                    Node::Class { negated, items: mut inner } if inner.len() == 1 => {
                        match inner.pop().unwrap() {
                            ClassItem::Named { kind, .. } => ClassItem::Named { kind, negated },
                            other => other,
                        }
                    }
                    _ => return Err(RegexError::new("that escape means nothing inside `[...]`")),
                }
            } else {
                ClassItem::Char(glyph)
            };

            // A `-` between two single characters is a range; anywhere else it
            // is a literal `-`, which is what JavaScript does.
            if let ClassItem::Char(start) = low {
                if self.peek() == Some('-')
                    && !matches!(self.chars.get(self.at + 1), Some(']') | None)
                {
                    self.at += 1;
                    let end = match self.next() {
                        Some('\\') => match self.escape(true)? {
                            Node::Char(value) => value,
                            _ => {
                                return Err(RegexError::new(
                                    "a range in `[...]` needs single characters on both sides",
                                ))
                            }
                        },
                        Some(value) => value,
                        None => return Err(RegexError::new("there is a `[` here that is never closed")),
                    };
                    if end < start {
                        return Err(RegexError::new(format!(
                            "the range `{start}-{end}` runs backwards"
                        )));
                    }
                    items.push(ClassItem::Range(start, end));
                    continue;
                }
            }
            items.push(low);
        }
        Ok(Node::Class { negated, items })
    }

    /// What follows a backslash. `in_class` is true inside `[...]`, where the
    /// boundary assertions are ordinary characters.
    fn escape(&mut self, in_class: bool) -> Result<Node, RegexError> {
        let Some(glyph) = self.next() else {
            return Err(RegexError::new("the pattern ends with a backslash"));
        };
        let named = |kind: NamedClass, negated: bool| Node::Class {
            negated,
            items: vec![ClassItem::Named { kind, negated: false }],
        };
        Ok(match glyph {
            'd' => named(NamedClass::Digit, false),
            'D' => named(NamedClass::Digit, true),
            'w' => named(NamedClass::Word, false),
            'W' => named(NamedClass::Word, true),
            's' => named(NamedClass::Space, false),
            'S' => named(NamedClass::Space, true),
            'b' if in_class => Node::Char('\u{8}'),
            'b' => Node::WordBoundary(true),
            'B' if in_class => return Err(RegexError::new("`\\B` means nothing inside `[...]`")),
            'B' => Node::WordBoundary(false),
            'n' => Node::Char('\n'),
            'r' => Node::Char('\r'),
            't' => Node::Char('\t'),
            'f' => Node::Char('\u{c}'),
            'v' => Node::Char('\u{b}'),
            '0' => Node::Char('\0'),
            'x' => Node::Char(self.hex(2)?),
            'u' => {
                if self.eat('{') {
                    let mut digits = String::new();
                    while let Some(glyph) = self.peek() {
                        if glyph == '}' {
                            break;
                        }
                        digits.push(glyph);
                        self.at += 1;
                    }
                    if !self.eat('}') {
                        return Err(RegexError::new("a `\\u{...}` escape is never closed"));
                    }
                    let value = u32::from_str_radix(&digits, 16)
                        .ok()
                        .and_then(char::from_u32)
                        .ok_or_else(|| RegexError::new(format!("`\\u{{{digits}}}` is not a character")))?;
                    Node::Char(value)
                } else {
                    Node::Char(self.hex(4)?)
                }
            }
            'p' | 'P' => {
                return Err(unsupported("Unicode property escapes", "\\p{...}` and `\\P{...}"))
            }
            'k' => return Err(unsupported("named backreferences", "\\k<name>")),
            glyph if glyph.is_ascii_digit() => {
                return Err(unsupported("backreferences", "\\1"))
            }
            // A backslash before anything else is that thing, literally, which
            // is how `\.` and `\\` work.
            other => Node::Char(other),
        })
    }

    fn hex(&mut self, count: usize) -> Result<char, RegexError> {
        let mut digits = String::new();
        for _ in 0..count {
            match self.next() {
                Some(glyph) if glyph.is_ascii_hexdigit() => digits.push(glyph),
                _ => return Err(RegexError::new("a `\\x` or `\\u` escape needs hex digits")),
            }
        }
        u32::from_str_radix(&digits, 16)
            .ok()
            .and_then(char::from_u32)
            .ok_or_else(|| RegexError::new(format!("`\\x{digits}` is not a character")))
    }
}

fn unsupported(what: &str, syntax: &str) -> RegexError {
    RegexError::with_help(
        format!("this pattern uses {what}, which Baa's regular expressions do not have"),
        format!(
            "`{syntax}` works in the reference implementation, which borrows JavaScript's engine, \
             and would mean something different here. Rewrite the pattern without it, or do that \
             part in Baa."
        ),
    )
}

/// Does this character belong to a named class?
pub fn in_named(kind: NamedClass, glyph: char) -> bool {
    match kind {
        // ASCII, exactly as JavaScript defines them: `\d` is `[0-9]` and `\w`
        // is `[A-Za-z0-9_]`, however many other digits Unicode has.
        NamedClass::Digit => glyph.is_ascii_digit(),
        NamedClass::Word => glyph.is_ascii_alphanumeric() || glyph == '_',
        NamedClass::Space => {
            matches!(
                glyph,
                ' ' | '\t'
                    | '\n'
                    | '\r'
                    | '\u{b}'
                    | '\u{c}'
                    | '\u{a0}'
                    | '\u{1680}'
                    | '\u{2000}'..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
            )
        }
    }
}
