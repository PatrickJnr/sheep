//! The glob subset Baa understands. A port of `src/stdlib/glob.ts`.
//!
//!   `?`   one character, never a separator
//!   `*`   any run of characters, never crossing a separator
//!   `**`  any run of characters, separators included
//!
//! Nothing else is special. The rules are written down in the reference
//! implementation and in `docs/stdlib.md`; this file exists to give the same
//! answers, not to have opinions of its own.

/// Split a pattern or path on either separator.
fn segments(text: &str) -> Vec<&str> {
    let parts: Vec<&str> = text.split(['/', '\\']).collect();
    let last = parts.len().saturating_sub(1);
    parts
        .into_iter()
        .enumerate()
        .filter(|(index, part)| !part.is_empty() || *index == last)
        .map(|(_, part)| part)
        .collect()
}

/// Match one path segment against one pattern segment, with `?` and `*`.
///
/// Iterative backtracking rather than recursion, so a pattern like
/// `a*a*a*a*b` against a long name cannot exhaust the stack.
fn match_segment(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let mut pattern_at = 0;
    let mut text_at = 0;
    let mut star_at: Option<usize> = None;
    let mut match_at = 0;

    while text_at < text.len() {
        let glyph = pattern.get(pattern_at).copied();
        if glyph == Some('?') || (glyph.is_some() && glyph != Some('*') && glyph == Some(text[text_at]))
        {
            pattern_at += 1;
            text_at += 1;
        } else if glyph == Some('*') {
            star_at = Some(pattern_at);
            match_at = text_at;
            pattern_at += 1;
        } else if let Some(star) = star_at {
            pattern_at = star + 1;
            match_at += 1;
            text_at = match_at;
        } else {
            return false;
        }
    }
    while pattern.get(pattern_at) == Some(&'*') {
        pattern_at += 1;
    }
    pattern_at == pattern.len()
}

/// True when `path` matches `pattern`.
///
/// A table filled from the end, which turns `**` from a recursive search that
/// can blow up on `**/**/**/x` into a lookup.
pub fn matches(path: &str, pattern: &str) -> bool {
    let parts = segments(path);
    let globs = segments(pattern);

    let mut table = vec![vec![false; parts.len() + 1]; globs.len() + 1];
    table[globs.len()][parts.len()] = true;

    for i in (0..globs.len()).rev() {
        let glob = globs[i];
        for j in (0..=parts.len()).rev() {
            table[i][j] = if glob == "**" {
                table[i + 1][j] || (j < parts.len() && table[i][j + 1])
            } else {
                j < parts.len() && match_segment(glob, parts[j]) && table[i + 1][j + 1]
            };
        }
    }
    table[0][0]
}

#[cfg(test)]
mod tests {
    use super::matches;

    #[test]
    fn matches_the_documented_subset() {
        assert!(matches("main.baa", "*.baa"));
        assert!(!matches("src/main.baa", "*.baa"));
        assert!(matches("src/main.baa", "**/*.baa"));
        assert!(matches("src/deep/main.baa", "**/*.baa"));
        assert!(matches("src/main.baa", "src/*.baa"));
        assert!(matches("a.baa", "?.baa"));
        assert!(!matches("ab.baa", "?.baa"));
        assert!(matches("src\\main.baa", "src/*.baa"));
        assert!(matches("anything/at/all", "**"));
    }
}
