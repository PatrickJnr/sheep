//! The regular-expression engine, for the five `wool` functions that need one.
//!
//! The reference implementation hands its patterns to JavaScript, which brings
//! a whole engine with it. There is nothing to hand them to here, so this is
//! that engine — deliberately a *subset*, deliberately written down, and
//! deliberately loud about the parts it does not have.
//!
//! That last point is the design. A near-miss reimplementation is worse than an
//! absence: a pattern that quietly means something different in one runtime
//! than in the other is a bug that survives review, passes tests, and shows up
//! as a wrong answer in front of a user. So anything outside the subset is
//! refused by name (`BAA314`) rather than approximated.
//!
//! What is here, and matches JavaScript exactly:
//!
//!   - literal characters, and `.` (any character but a line break, unless `s`)
//!   - classes: `[abc]`, `[a-z]`, `[^...]`, with escapes inside them
//!   - escapes: `\d \D \w \W \s \S \b \B \n \r \t \f \v \0 \xNN \uNNNN`, and a
//!     backslash before any punctuation character
//!   - anchors `^` and `$`, which under `m` also match at line breaks
//!   - groups `( )`, `(?: )` and `(?<name> )`
//!   - alternation `|`
//!   - quantifiers `* + ? {n} {n,} {n,m}`, greedy or lazy with a trailing `?`
//!   - flags `i`, `m`, `s`
//!
//! What is refused, by name: lookahead and lookbehind, backreferences,
//! `\p{...}` property escapes, and anything else the parser does not recognise.
//!
//! The matcher is a backtracking virtual machine, which is what gives
//! JavaScript's *leftmost-first* semantics: `a|ab` matches `a` in `abc`, and a
//! greedy quantifier gives characters back one at a time until the rest of the
//! pattern fits. A Thompson simulation would be immune to blow-up and would
//! also answer a different question.
//!
//! Blow-up is bounded instead: every run has a step budget, and a pattern that
//! exhausts it fails with a diagnostic rather than hanging. JavaScript would
//! hang; saying so is better than either hanging or lying.

mod parse;
mod vm;

pub use parse::{parse, Flags, Pattern, RegexError};
pub use vm::{Captures, Match};

/// A compiled pattern, ready to match.
pub struct Regex {
    program: vm::Program,
    /// Capture group count, including group 0 (the whole match).
    pub groups: usize,
    /// `(index, name)` for every named group, in source order.
    pub names: Vec<(usize, String)>,
}

impl Regex {
    /// Compile a pattern, or say what about it is not supported.
    pub fn new(source: &str, flags: &str) -> Result<Regex, RegexError> {
        let flags = Flags::parse(flags)?;
        let pattern = parse(source, flags)?;
        let program = vm::compile(&pattern, flags);
        Ok(Regex { program, groups: pattern.groups, names: pattern.names })
    }

    /// The first match at or after `from`, counted in characters.
    pub fn find_at(&self, haystack: &[char], from: usize) -> Result<Option<Match>, RegexError> {
        vm::search(&self.program, haystack, from, self.groups)
    }
}

#[cfg(test)]
mod tests {
    use super::Regex;

    /// Match, and report what was captured, as a compact string for comparing.
    fn find(pattern: &str, flags: &str, text: &str) -> Option<String> {
        let regex = Regex::new(pattern, flags).expect("the pattern should compile");
        let chars: Vec<char> = text.chars().collect();
        let found = regex.find_at(&chars, 0).expect("the match should not run away")?;
        let mut out: String = chars[found.start..found.end].iter().collect();
        for index in 1..regex.groups {
            out.push('|');
            match (found.slots[index * 2], found.slots[index * 2 + 1]) {
                (Some(start), Some(end)) => out.extend(&chars[start..end]),
                _ => out.push_str("<none>"),
            }
        }
        Some(out)
    }

    #[test]
    fn matches_literals_classes_and_quantifiers() {
        assert_eq!(find("baa", "", "a baa here"), Some("baa".into()));
        assert_eq!(find("b(a+)", "", "baaa"), Some("baaa|aaa".into()));
        assert_eq!(find("[a-c]+", "", "xxabcxx"), Some("abc".into()));
        assert_eq!(find("[^a-c]+", "", "abxyc"), Some("xy".into()));
        assert_eq!(find(r"\d+", "", "sheep 42"), Some("42".into()));
        assert_eq!(find(r"\w+", "", " a_1 "), Some("a_1".into()));
        assert_eq!(find("a{2,3}", "", "aaaa"), Some("aaa".into()));
        assert_eq!(find("a{2}", "", "aaaa"), Some("aa".into()));
        assert_eq!(find("colou?r", "", "color"), Some("color".into()));
    }

    #[test]
    fn prefers_the_leftmost_first_alternative_as_javascript_does() {
        // Not the longest: `a` wins because it comes first.
        assert_eq!(find("a|ab", "", "abc"), Some("a".into()));
        assert_eq!(find("ab|a", "", "abc"), Some("ab".into()));
    }

    #[test]
    fn gives_characters_back_until_the_rest_of_the_pattern_fits() {
        assert_eq!(find("<(.+)>", "", "<a><b>"), Some("<a><b>|a><b".into()));
        assert_eq!(find("<(.+?)>", "", "<a><b>"), Some("<a>|a".into()));
    }

    #[test]
    fn honours_the_flags() {
        assert_eq!(find("sheep", "", "SHEEP"), None);
        assert_eq!(find("sheep", "i", "SHEEP"), Some("SHEEP".into()));
        assert_eq!(find("[a-z]+", "i", "ABC"), Some("ABC".into()));
        assert_eq!(find("^two", "", "one\ntwo"), None);
        assert_eq!(find("^two", "m", "one\ntwo"), Some("two".into()));
        assert_eq!(find("a.b", "", "a\nb"), None);
        assert_eq!(find("a.b", "s", "a\nb"), Some("a\nb".into()));
    }

    #[test]
    fn anchors_and_boundaries() {
        assert_eq!(find("^baa$", "", "baa"), Some("baa".into()));
        assert_eq!(find("^baa$", "", "a baa"), None);
        assert_eq!(find(r"\bsheep\b", "", "a sheep here"), Some("sheep".into()));
        assert_eq!(find(r"\bsheep\b", "", "sheepdog"), None);
        assert_eq!(find(r"\Bee", "", "sheep"), Some("ee".into()));
    }

    #[test]
    fn groups_that_did_not_take_part_are_absent_rather_than_empty() {
        assert_eq!(find("(a)|(b)", "", "b"), Some("b|<none>|b".into()));
    }

    #[test]
    fn names_the_groups_it_was_given() {
        let regex = Regex::new(r"(?<who>\w+) the (?<what>\w+)", "").unwrap();
        assert_eq!(regex.names, vec![(1, "who".to_string()), (2, "what".to_string())]);
        assert_eq!(regex.groups, 3);
    }

    #[test]
    fn refuses_what_it_does_not_have_by_name() {
        for (pattern, expected) in [
            ("(?=a)", "lookahead"),
            ("(?!a)", "lookahead"),
            ("(?<=a)b", "lookbehind"),
            ("(?<!a)b", "lookbehind"),
            (r"(a)\1", "backreferences"),
            (r"\p{L}", "Unicode property escapes"),
            (r"\k<name>", "named backreferences"),
        ] {
            let error = match Regex::new(pattern, "") {
                Err(error) => error,
                Ok(_) => panic!("`{pattern}` should have been refused"),
            };
            assert!(
                error.message.contains(expected),
                "`{pattern}` should be refused as {expected}, said: {}",
                error.message
            );
        }
    }

    #[test]
    fn refuses_a_pattern_that_does_not_make_sense() {
        for pattern in ["(", "[a", "*a", "a{3,2}", "a{2000}", r"\"] {
            assert!(Regex::new(pattern, "").is_err(), "`{pattern}` should be refused");
        }
        assert!(Regex::new("a", "y").is_err(), "an unknown flag should be refused");
    }

    #[test]
    fn gives_up_rather_than_hanging_on_a_pattern_that_explodes() {
        // JavaScript hangs on this. Refusing is the only one of the three
        // possible behaviours that is not silent.
        let regex = Regex::new("(a+)+b", "").unwrap();
        let text: Vec<char> = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".chars().collect();
        let outcome = regex.find_at(&text, 0);
        assert!(outcome.is_err(), "it should give up rather than run for ever");
        assert!(outcome.unwrap_err().message.contains("too long"));
    }

    #[test]
    fn counts_in_characters_rather_than_in_bytes() {
        // `é` is two bytes in UTF-8 and one character. The reference reports
        // character offsets, so this one must too.
        let regex = Regex::new("sheep", "").unwrap();
        let text: Vec<char> = "ééé sheep".chars().collect();
        let found = regex.find_at(&text, 0).unwrap().unwrap();
        assert_eq!(found.start, 4);
        assert_eq!(found.end, 9);
    }
}
