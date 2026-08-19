//! Compiling a pattern to instructions, and running them.
//!
//! A backtracking virtual machine, because that is what gives JavaScript's
//! answers. Alternation is leftmost-first — `a|ab` matches `a` in `abc`, not
//! the longer `ab` — and a greedy quantifier takes everything it can and then
//! gives characters back one at a time until the rest of the pattern fits.
//! Those are properties of *backtracking*, not of regular languages, and an
//! engine that simulated all threads at once would return different matches.
//!
//! The price is that a pattern like `(a+)+b` against a long run of `a`s takes
//! exponential time. JavaScript has the same problem and hangs. Here every run
//! has a step budget and exhausting it is a diagnostic, which is the only one
//! of the three possible behaviours — right answer, wrong answer, honest
//! refusal — that is not silent.

use super::parse::{in_named, ClassItem, Flags, Node, Pattern};
use super::RegexError;

/// How many instructions one search may execute.
///
/// Ten million is far past any pattern a program means to run and reached in
/// well under a second, so a runaway is caught while a real match is not.
const STEP_BUDGET: u64 = 10_000_000;

#[derive(Clone, Debug)]
pub enum Inst {
    Char(char),
    Any,
    Class { negated: bool, items: Vec<ClassItem> },
    /// Try `first`; on failure, try `second`.
    Split { first: usize, second: usize },
    Jump(usize),
    /// Record the current position in capture slot `slot`.
    Save(usize),
    AssertStart,
    AssertEnd,
    AssertWord(bool),
    Match,
}

pub struct Program {
    insts: Vec<Inst>,
    flags: Flags,
    slots: usize,
}

pub type Captures = Vec<Option<usize>>;

#[derive(Clone, Debug)]
pub struct Match {
    pub start: usize,
    pub end: usize,
    /// Two slots per group: start and end, `None` when the group did not take part.
    pub slots: Captures,
}

pub fn compile(pattern: &Pattern, flags: Flags) -> Program {
    let mut insts = Vec::new();
    insts.push(Inst::Save(0));
    emit(&pattern.node, &mut insts);
    insts.push(Inst::Save(1));
    insts.push(Inst::Match);
    Program { insts, flags, slots: pattern.groups * 2 }
}

fn emit(node: &Node, out: &mut Vec<Inst>) {
    match node {
        Node::Empty => {}
        Node::Char(glyph) => out.push(Inst::Char(*glyph)),
        Node::Any => out.push(Inst::Any),
        Node::Class { negated, items } => {
            out.push(Inst::Class { negated: *negated, items: items.clone() })
        }
        Node::Start => out.push(Inst::AssertStart),
        Node::End => out.push(Inst::AssertEnd),
        Node::WordBoundary(inside) => out.push(Inst::AssertWord(*inside)),
        Node::Group { index, node } => {
            if let Some(index) = index {
                out.push(Inst::Save(index * 2));
                emit(node, out);
                out.push(Inst::Save(index * 2 + 1));
            } else {
                emit(node, out);
            }
        }
        Node::Concat(items) => {
            for item in items {
                emit(item, out);
            }
        }
        Node::Alt(branches) => {
            // Each branch: split to it, run it, jump to the end.
            let mut jumps = Vec::new();
            for (at, branch) in branches.iter().enumerate() {
                if at + 1 == branches.len() {
                    emit(branch, out);
                    break;
                }
                let split = out.len();
                out.push(Inst::Jump(0)); // placeholder for Split
                emit(branch, out);
                jumps.push(out.len());
                out.push(Inst::Jump(0)); // placeholder to the end
                let next = out.len();
                out[split] = Inst::Split { first: split + 1, second: next };
            }
            let end = out.len();
            for jump in jumps {
                out[jump] = Inst::Jump(end);
            }
        }
        Node::Repeat { node, min, max, greedy } => emit_repeat(node, *min, *max, *greedy, out),
    }
}

fn emit_repeat(node: &Node, min: u32, max: Option<u32>, greedy: bool, out: &mut Vec<Inst>) {
    // The required part, written out.
    for _ in 0..min {
        emit(node, out);
    }
    match max {
        None => {
            // `x*`: split, body, jump back.
            let split = out.len();
            out.push(Inst::Jump(0));
            emit(node, out);
            out.push(Inst::Jump(split));
            let end = out.len();
            out[split] = if greedy {
                Inst::Split { first: split + 1, second: end }
            } else {
                Inst::Split { first: end, second: split + 1 }
            };
        }
        Some(max) => {
            // `x{n,m}`: (m - n) optional copies.
            let mut splits = Vec::new();
            for _ in min..max {
                let split = out.len();
                out.push(Inst::Jump(0));
                splits.push(split);
                emit(node, out);
            }
            let end = out.len();
            for split in splits {
                out[split] = if greedy {
                    Inst::Split { first: split + 1, second: end }
                } else {
                    Inst::Split { first: end, second: split + 1 }
                };
            }
        }
    }
}

/// One point the machine can come back to.
struct Thread {
    pc: usize,
    at: usize,
    slots: Captures,
}

/// The first match at or after `from`.
pub fn search(
    program: &Program,
    haystack: &[char],
    from: usize,
    groups: usize,
) -> Result<Option<Match>, RegexError> {
    let mut steps = 0u64;
    let mut start = from;
    loop {
        if start > haystack.len() {
            return Ok(None);
        }
        if let Some(slots) = run(program, haystack, start, &mut steps)? {
            let begin = slots[0].unwrap_or(start);
            let end = slots[1].unwrap_or(start);
            let mut out = slots;
            out.resize(groups * 2, None);
            return Ok(Some(Match { start: begin, end, slots: out }));
        }
        start += 1;
    }
}

/// Try to match with the pattern anchored at `start`.
fn run(
    program: &Program,
    haystack: &[char],
    start: usize,
    steps: &mut u64,
) -> Result<Option<Captures>, RegexError> {
    let mut stack: Vec<Thread> = vec![Thread {
        pc: 0,
        at: start,
        slots: vec![None; program.slots],
    }];

    while let Some(mut thread) = stack.pop() {
        loop {
            *steps += 1;
            if *steps > STEP_BUDGET {
                return Err(RegexError {
                    message: "this pattern took too long to match".into(),
                    help: Some(
                        "A quantifier inside a quantifier, like `(a+)+`, can take exponential time. \
                         Rewriting it usually makes it instant."
                            .into(),
                    ),
                });
            }
            match &program.insts[thread.pc] {
                Inst::Match => return Ok(Some(thread.slots)),
                Inst::Char(glyph) => {
                    let Some(&found) = haystack.get(thread.at) else { break };
                    if !same(*glyph, found, program.flags) {
                        break;
                    }
                    thread.at += 1;
                    thread.pc += 1;
                }
                Inst::Any => {
                    let Some(&found) = haystack.get(thread.at) else { break };
                    if !program.flags.dot_all && is_line_break(found) {
                        break;
                    }
                    thread.at += 1;
                    thread.pc += 1;
                }
                Inst::Class { negated, items } => {
                    let Some(&found) = haystack.get(thread.at) else { break };
                    if in_class(items, found, program.flags) == *negated {
                        break;
                    }
                    thread.at += 1;
                    thread.pc += 1;
                }
                Inst::Split { first, second } => {
                    stack.push(Thread { pc: *second, at: thread.at, slots: thread.slots.clone() });
                    thread.pc = *first;
                }
                Inst::Jump(to) => thread.pc = *to,
                Inst::Save(slot) => {
                    // The old value is restored by backtracking, because every
                    // thread carries its own copy.
                    thread.slots[*slot] = Some(thread.at);
                    thread.pc += 1;
                }
                Inst::AssertStart => {
                    let ok = thread.at == 0
                        || (program.flags.multiline && is_line_break(haystack[thread.at - 1]));
                    if !ok {
                        break;
                    }
                    thread.pc += 1;
                }
                Inst::AssertEnd => {
                    let ok = thread.at == haystack.len()
                        || (program.flags.multiline && is_line_break(haystack[thread.at]));
                    if !ok {
                        break;
                    }
                    thread.pc += 1;
                }
                Inst::AssertWord(inside) => {
                    let before = thread.at > 0 && is_word(haystack[thread.at - 1]);
                    let after = thread.at < haystack.len() && is_word(haystack[thread.at]);
                    if (before != after) != *inside {
                        break;
                    }
                    thread.pc += 1;
                }
            }
        }
    }
    Ok(None)
}

fn same(pattern: char, found: char, flags: Flags) -> bool {
    if pattern == found {
        return true;
    }
    flags.ignore_case && fold(pattern) == fold(found)
}

/// Case folding, the simple kind: JavaScript's `i` without `u` niceties folds
/// each character on its own, which `to_lowercase` does for everything that
/// has a single-character lower case.
fn fold(glyph: char) -> char {
    glyph.to_lowercase().next().unwrap_or(glyph)
}

fn is_line_break(glyph: char) -> bool {
    matches!(glyph, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn is_word(glyph: char) -> bool {
    glyph.is_ascii_alphanumeric() || glyph == '_'
}

fn in_class(items: &[ClassItem], found: char, flags: Flags) -> bool {
    items.iter().any(|item| match item {
        ClassItem::Char(glyph) => same(*glyph, found, flags),
        ClassItem::Range(low, high) => {
            if *low <= found && found <= *high {
                return true;
            }
            if !flags.ignore_case {
                return false;
            }
            // `[a-z]` with `i` also matches `A`: fold the character both ways
            // and see whether either lands in the range.
            let lowered = fold(found);
            let raised = found.to_uppercase().next().unwrap_or(found);
            (*low <= lowered && lowered <= *high) || (*low <= raised && raised <= *high)
        }
        ClassItem::Named { kind, negated } => in_named(*kind, found) != *negated,
    })
}
