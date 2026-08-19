//! `wool`: text. A port of `src/stdlib/wool.ts`, minus its pattern functions.
//!
//! The five functions built on regular expressions — `matches`, `find`,
//! `find_all`, `substitute` and `split_on` — are not here. The reference gets
//! them from JavaScript's `RegExp`, and reproducing that engine's exact
//! behaviour in Rust is a project of its own: a near-miss would be worse than
//! an absence, because it would differ only on the inputs nobody tested.
//!
//! They are still present as names, and calling one reports which function it
//! was and what to do instead. A program that never uses a pattern gets the
//! whole of `wool`; a program that does finds out at the call, in a sentence,
//! rather than by `import wool` failing and taking the other twenty functions
//! with it.

use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Flow, Interpreter, Res, MAX_SIZE};
use crate::number;
use crate::value::{display, inspect, BaaMap, MapKey, Module, Native, Value};

use super::{map_value, module_of, need_array, need_number, need_string};
use crate::regex::{Match, Regex, RegexError};

const FUNCTIONS: &[(&str, usize, usize)] = &[
    ("join", 1, 2),
    ("concat", 0, usize::MAX),
    ("format", 1, usize::MAX),
    ("repeat", 2, 2),
    ("title_case", 1, 1),
    ("snake_case", 1, 1),
    ("camel_case", 1, 1),
    ("kebab_case", 1, 1),
    ("wrap", 2, 2),
    ("center", 2, 3),
    ("escape_html", 1, 1),
    ("safe_url", 1, 1),
    ("percent_encode", 1, 1),
    ("percent_decode", 1, 1),
    ("matches", 2, 3),
    ("find", 2, 3),
    ("find_all", 2, 3),
    ("substitute", 3, 4),
    ("split_on", 2, 3),
    ("is_blank", 1, 1),
    ("to_bytes", 1, 1),
    ("from_bytes", 1, 1),
    ("inspect", 1, 1),
];

/// The functions that use the regular-expression engine.
pub const PATTERN_FUNCTIONS: &[&str] = &["matches", "find", "find_all", "substitute", "split_on"];

/// The longest pattern the engine will take, matching the reference.
const MAX_PATTERN: usize = 4096;

pub fn module() -> Rc<Module> {
    let exports = FUNCTIONS
        .iter()
        .map(|(name, min, max)| {
            (
                *name,
                Value::Native(Rc::new(Native {
                    name: format!("wool.{name}"),
                    method: name,
                    min_args: *min,
                    max_args: *max,
                    call,
                    receiver: None,
                })),
            )
        })
        .collect();
    module_of("wool", exports)
}

/// Schemes a link may use. Everything else, known or not, is refused: a
/// `javascript:` URL survives HTML escaping untouched and still runs.
const SAFE_SCHEMES: &[&str] = &["http", "https", "mailto", "tel", "ftp"];

fn call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let name = native.name.clone();

    if PATTERN_FUNCTIONS.contains(&native.method) {
        return pattern_call(interp, native, &name, args, span);
    }

    Ok(match native.method {
        "join" => {
            let items = need_array(interp, &name, &args, 0, span)?;
            let separator = if args.len() > 1 {
                need_string(interp, &name, &args, 1, span)?
            } else {
                Rc::from("")
            };
            let parts: Vec<String> = items.iter().map(display).collect();
            Value::str(parts.join(&separator))
        }
        "concat" => Value::str(args.iter().map(display).collect::<Vec<_>>().join("")),
        "format" => {
            let template = need_string(interp, &name, &args, 0, span)?;
            let rest = &args[1..];
            let mut out = String::with_capacity(template.len());
            let letters: Vec<char> = template.chars().collect();
            let mut index = 0usize;
            let mut used = 0usize;
            let mut missing = false;
            while index < letters.len() {
                if letters[index] == '%' && index + 1 < letters.len() {
                    match letters[index + 1] {
                        '%' => {
                            out.push('%');
                            index += 2;
                            continue;
                        }
                        's' => {
                            match rest.get(used) {
                                Some(value) => out.push_str(&display(value)),
                                None => {
                                    missing = true;
                                    out.push_str("%s");
                                }
                            }
                            used += 1;
                            index += 2;
                            continue;
                        }
                        _ => {}
                    }
                }
                out.push(letters[index]);
                index += 1;
            }
            if missing {
                return Err(Flow::Err(
                    interp
                        .error(
                            "BAA301",
                            vec![format!(
                                "wool.format: the template has more `%s` placeholders than values ({} given)",
                                rest.len()
                            )],
                            span,
                        )
                        .with_note("not enough values"),
                ));
            }
            Value::str(out)
        }
        "repeat" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            let count = need_number(interp, &name, &args, 1, span)?;
            if count < 0.0 || count.fract() != 0.0 {
                return interp.fail(
                    "BAA311",
                    vec![name, "a count of 0 or more".into(), "2".into(), number::format(count)],
                    span,
                );
            }
            let total = count * text.chars().count() as f64;
            if total > MAX_SIZE as f64 {
                return interp.fail(
                    "BAA312",
                    vec![name, number::format(total), number::format(MAX_SIZE as f64)],
                    span,
                );
            }
            Value::str(text.repeat(count as usize))
        }
        "title_case" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            Value::str(
                text.split(' ')
                    .map(|word| match word.chars().next() {
                        None => String::new(),
                        Some(first) => {
                            first.to_uppercase().collect::<String>() + &word[first.len_utf8()..]
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        }
        "snake_case" | "kebab_case" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            let joiner = if native.method == "snake_case" { "_" } else { "-" };
            Value::str(
                split_words(&text)
                    .iter()
                    .map(|word| word.to_lowercase())
                    .collect::<Vec<_>>()
                    .join(joiner),
            )
        }
        "camel_case" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            let words = split_words(&text);
            let mut out = String::new();
            for (index, word) in words.iter().enumerate() {
                if index == 0 {
                    out.push_str(&word.to_lowercase());
                    continue;
                }
                let mut chars = word.chars();
                if let Some(first) = chars.next() {
                    out.extend(first.to_uppercase());
                    out.push_str(&chars.as_str().to_lowercase());
                }
            }
            Value::str(out)
        }
        "wrap" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            let width = need_number(interp, &name, &args, 1, span)?;
            if width < 1.0 || width.fract() != 0.0 {
                return interp.fail(
                    "BAA311",
                    vec![name, "a width of 1 or more".into(), "2".into(), number::format(width)],
                    span,
                );
            }
            let width = width as usize;
            let mut lines: Vec<String> = Vec::new();
            for paragraph in text.split('\n') {
                let mut current = String::new();
                for word in paragraph.split(' ') {
                    if current.is_empty() {
                        current = word.to_string();
                    } else if current.chars().count() + 1 + word.chars().count() <= width {
                        current.push(' ');
                        current.push_str(word);
                    } else {
                        lines.push(std::mem::take(&mut current));
                        current = word.to_string();
                    }
                }
                lines.push(current);
            }
            Value::str(lines.join("\n"))
        }
        "center" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            let width = need_number(interp, &name, &args, 1, span)?;
            let filler = if args.len() > 2 {
                need_string(interp, &name, &args, 2, span)?
            } else {
                Rc::from(" ")
            };
            let length = text.chars().count() as f64;
            if filler.is_empty() || length >= width {
                return Ok(Value::Str(text));
            }
            if width > MAX_SIZE as f64 {
                return interp.fail(
                    "BAA312",
                    vec![name, number::format(width), number::format(MAX_SIZE as f64)],
                    span,
                );
            }
            let total = (width - length) as usize;
            let left = total / 2;
            let right = total - left;
            Value::str(format!("{}{}{}", pad(&filler, left), text, pad(&filler, right)))
        }
        "escape_html" => Value::str(escape_html(&display(&args[0]))),
        "safe_url" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            // Control characters are stripped before the scheme is read,
            // because `java\nscript:` is a scheme a browser will accept and a
            // naive check will not.
            let stripped: String = text.chars().filter(|c| *c > '\u{20}' && *c != '\u{7f}').collect();
            match scheme_of(&stripped) {
                None => Value::Str(text),
                Some(scheme) if SAFE_SCHEMES.contains(&scheme.to_lowercase().as_str()) => Value::Str(text),
                Some(_) => Value::Nil,
            }
        }
        "percent_encode" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            let mut out = String::new();
            for byte in text.as_bytes() {
                let ch = *byte as char;
                // The unreserved set `encodeURIComponent` leaves alone.
                if ch.is_ascii_alphanumeric() || "-_.!~*'()".contains(ch) {
                    out.push(ch);
                } else {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
            Value::str(out)
        }
        "percent_decode" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            match percent_decode(&text) {
                Some(decoded) => Value::str(decoded),
                None => Value::Nil,
            }
        }
        "is_blank" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            Value::Bool(text.trim().is_empty())
        }
        "to_bytes" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            Value::array(text.as_bytes().iter().map(|b| Value::Number(*b as f64)).collect())
        }
        "from_bytes" => {
            let items = need_array(interp, &name, &args, 0, span)?;
            let mut bytes = Vec::with_capacity(items.len());
            for item in &items {
                match item {
                    Value::Number(value) if value.fract() == 0.0 && (0.0..=255.0).contains(value) => {
                        bytes.push(*value as u8)
                    }
                    other => {
                        return interp.fail(
                            "BAA311",
                            vec![name, "byte values 0-255".into(), "1".into(), inspect(other)],
                            span,
                        )
                    }
                }
            }
            // Lossy, matching `TextDecoder`, which substitutes U+FFFD rather
            // than failing on bytes that are not valid UTF-8.
            Value::str(String::from_utf8_lossy(&bytes))
        }
        "inspect" => Value::str(inspect(&args[0])),
        _ => Value::Nil,
    })
}

fn pad(filler: &str, width: usize) -> String {
    let mut out = String::new();
    while out.chars().count() < width {
        out.push_str(filler);
    }
    out.chars().take(width).collect()
}

/// Splits on whitespace, underscores and hyphens, and at a lower-to-upper
/// boundary, so `parseHTML_now` becomes `parse`, `HTML`, `now`.
fn split_words(text: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(text.len() + 8);
    let letters: Vec<char> = text.chars().collect();
    for (index, ch) in letters.iter().enumerate() {
        if index > 0 && ch.is_uppercase() {
            let previous = letters[index - 1];
            if previous.is_lowercase() || previous.is_numeric() {
                spaced.push(' ');
            }
        }
        spaced.push(*ch);
    }
    spaced
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Five characters, not three: `<` and `&` cover text between tags, but a
/// value dropped into an attribute escapes its quoting with `"` or `'`.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

fn scheme_of(text: &str) -> Option<String> {
    let colon = text.find(':')?;
    let scheme = &text[..colon];
    if scheme.is_empty() {
        return None;
    }
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
        return None;
    }
    Some(scheme.to_string())
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    // Malformed UTF-8 is nil rather than replacement characters: a caller
    // reading untrusted input should be able to tell the difference.
    String::from_utf8(out).ok()
}


// --------------------------------------------------------------------------
// The five functions that take a pattern
// --------------------------------------------------------------------------

/// Compile the pattern these arguments carry.
///
/// The flags are the third argument for every one of these functions except
/// `substitute`, where the replacement takes that place. A pattern that this
/// engine does not support is `BAA314` naming the feature, never a match that
/// quietly means something else than it would in the reference.
fn compile(
    interp: &Interpreter,
    name: &str,
    args: &[Value],
    flag_index: usize,
    span: Span,
) -> Res<Regex> {
    let source = need_string(interp, name, args, 1, span)?;
    if source.chars().count() > MAX_PATTERN {
        return Err(Flow::Err(
            interp
                .error(
                    "BAA312",
                    vec![
                        name.to_string(),
                        source.chars().count().to_string(),
                        MAX_PATTERN.to_string(),
                    ],
                    span,
                )
                .with_note("pattern too long"),
        ));
    }
    let flags = if args.len() > flag_index {
        need_string(interp, name, args, flag_index, span)?
    } else {
        Rc::from("")
    };
    Regex::new(&source, &flags).map_err(|error| {
        let mut diagnostic = interp
            .error("BAA314", vec![name.to_string(), error.message.clone()], span)
            .with_note("this pattern cannot be used here");
        if let Some(help) = error.help {
            diagnostic = diagnostic.with_help(help);
        }
        Flow::Err(diagnostic)
    })
}

/// Turn an engine failure at match time into a diagnostic. Only the step
/// budget gets here; everything else is refused at compile time.
fn matching_failed(interp: &Interpreter, name: &str, error: RegexError, span: Span) -> Flow {
    let mut diagnostic = interp
        .error("BAA314", vec![name.to_string(), error.message], span)
        .with_note("the match was abandoned");
    if let Some(help) = error.help {
        diagnostic = diagnostic.with_help(help);
    }
    Flow::Err(diagnostic)
}

/// `{ match, start, end, groups, named }`, the same shape the reference builds.
fn match_map(regex: &Regex, haystack: &[char], found: &Match) -> Value {
    let text: String = haystack[found.start..found.end].iter().collect();
    let mut groups: Vec<Value> = Vec::new();
    for index in 1..regex.groups {
        let start = found.slots.get(index * 2).copied().flatten();
        let end = found.slots.get(index * 2 + 1).copied().flatten();
        groups.push(match (start, end) {
            (Some(start), Some(end)) if start <= end => {
                Value::str(haystack[start..end].iter().collect::<String>())
            }
            _ => Value::Nil,
        });
    }
    let mut named = BaaMap::new();
    for (index, name) in &regex.names {
        let start = found.slots.get(index * 2).copied().flatten();
        let end = found.slots.get(index * 2 + 1).copied().flatten();
        let value = match (start, end) {
            (Some(start), Some(end)) if start <= end => {
                Value::str(haystack[start..end].iter().collect::<String>())
            }
            _ => Value::Nil,
        };
        named.set(MapKey::Str(Rc::from(name.as_str())), value);
    }
    map_value(vec![
        ("match", Value::str(text)),
        // Character offsets, not code units, exactly as the reference reports.
        ("start", Value::Number(found.start as f64)),
        ("end", Value::Number(found.end as f64)),
        ("groups", Value::array(groups)),
        ("named", Value::map(named)),
    ])
}

/// Every non-overlapping match, the way `String.matchAll` walks them: after an
/// empty match the search moves on by one, or it would never end.
fn all_matches(
    interp: &Interpreter,
    name: &str,
    regex: &Regex,
    haystack: &[char],
    span: Span,
) -> Res<Vec<Match>> {
    let mut out = Vec::new();
    let mut at = 0;
    loop {
        let found = regex
            .find_at(haystack, at)
            .map_err(|error| matching_failed(interp, name, error, span))?;
        let Some(found) = found else { break };
        at = if found.end == found.start { found.end + 1 } else { found.end };
        out.push(found);
        if at > haystack.len() {
            break;
        }
    }
    Ok(out)
}

fn pattern_call(
    interp: &mut Interpreter,
    native: &Native,
    name: &str,
    args: Vec<Value>,
    span: Span,
) -> Res<Value> {
    let haystack: Vec<char> = need_string(interp, name, &args, 0, span)?.chars().collect();
    let flag_index = if native.method == "substitute" { 3 } else { 2 };
    let regex = compile(interp, name, &args, flag_index, span)?;

    Ok(match native.method {
        "matches" => Value::Bool(
            regex
                .find_at(&haystack, 0)
                .map_err(|error| matching_failed(interp, name, error, span))?
                .is_some(),
        ),
        "find" => match regex
            .find_at(&haystack, 0)
            .map_err(|error| matching_failed(interp, name, error, span))?
        {
            Some(found) => match_map(&regex, &haystack, &found),
            None => Value::Nil,
        },
        "find_all" => {
            let found = all_matches(interp, name, &regex, &haystack, span)?;
            Value::array(found.iter().map(|item| match_map(&regex, &haystack, item)).collect())
        }
        "substitute" => {
            let replacement = need_string(interp, name, &args, 2, span)?;
            let found = all_matches(interp, name, &regex, &haystack, span)?;
            let mut out = String::new();
            let mut at = 0;
            for item in &found {
                if item.start >= at {
                    out.extend(&haystack[at..item.start]);
                }
                out.push_str(&expand(&replacement, &regex, &haystack, item));
                at = item.end.max(item.start);
            }
            if at <= haystack.len() {
                out.extend(&haystack[at..]);
            }
            Value::str(out)
        }
        "split_on" => {
            let found = all_matches(interp, name, &regex, &haystack, span)?;
            let mut parts: Vec<Value> = Vec::new();
            let mut at = 0;
            for item in &found {
                // `String.split` ignores a match at the very start or end of
                // an empty-width run the same way; matching JavaScript here
                // matters more than any tidier rule.
                if item.start == item.end && (item.start == 0 || item.start == haystack.len()) {
                    continue;
                }
                parts.push(Value::str(haystack[at..item.start].iter().collect::<String>()));
                at = item.end;
            }
            parts.push(Value::str(haystack[at.min(haystack.len())..].iter().collect::<String>()));
            Value::array(parts)
        }
        _ => Value::Nil,
    })
}

/// `$1`, `$<name>`, `$&` and `$$` in a replacement, as `String.replace` reads
/// them. A `$` before anything else stays a `$`.
fn expand(replacement: &str, regex: &Regex, haystack: &[char], found: &Match) -> String {
    let chars: Vec<char> = replacement.chars().collect();
    let mut out = String::new();
    let mut at = 0;
    let slice = |start: Option<usize>, end: Option<usize>| -> String {
        match (start, end) {
            (Some(start), Some(end)) if start <= end => haystack[start..end].iter().collect(),
            _ => String::new(),
        }
    };
    while at < chars.len() {
        if chars[at] != '$' || at + 1 >= chars.len() {
            out.push(chars[at]);
            at += 1;
            continue;
        }
        match chars[at + 1] {
            '$' => {
                out.push('$');
                at += 2;
            }
            '&' => {
                out.push_str(&slice(Some(found.start), Some(found.end)));
                at += 2;
            }
            '<' => {
                let mut name = String::new();
                let mut cursor = at + 2;
                while cursor < chars.len() && chars[cursor] != '>' {
                    name.push(chars[cursor]);
                    cursor += 1;
                }
                if cursor >= chars.len() {
                    out.push(chars[at]);
                    at += 1;
                    continue;
                }
                if let Some((index, _)) = regex.names.iter().find(|(_, known)| *known == name) {
                    out.push_str(&slice(
                        found.slots.get(index * 2).copied().flatten(),
                        found.slots.get(index * 2 + 1).copied().flatten(),
                    ));
                }
                at = cursor + 1;
            }
            glyph if glyph.is_ascii_digit() => {
                // Two digits when that names a group, one otherwise, which is
                // what JavaScript does with `$12` in a pattern with two groups.
                let mut digits = String::new();
                digits.push(glyph);
                let mut cursor = at + 2;
                if cursor < chars.len() && chars[cursor].is_ascii_digit() {
                    let both: usize = format!("{digits}{}", chars[cursor]).parse().unwrap_or(0);
                    if both > 0 && both < regex.groups {
                        digits.push(chars[cursor]);
                        cursor += 1;
                    }
                }
                let index: usize = digits.parse().unwrap_or(0);
                if index > 0 && index < regex.groups {
                    out.push_str(&slice(
                        found.slots.get(index * 2).copied().flatten(),
                        found.slots.get(index * 2 + 1).copied().flatten(),
                    ));
                } else {
                    out.push('$');
                    out.push_str(&digits);
                }
                at = cursor;
            }
            _ => {
                out.push(chars[at]);
                at += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_words_the_way_the_reference_does() {
        assert_eq!(split_words("hello world"), vec!["hello", "world"]);
        assert_eq!(split_words("parseHTML_now"), vec!["parse", "HTML", "now"]);
        assert_eq!(split_words("kebab-case-text"), vec!["kebab", "case", "text"]);
        assert_eq!(split_words("count2Sheep"), vec!["count2", "Sheep"]);
    }

    #[test]
    fn escapes_the_five_characters_that_matter() {
        assert_eq!(escape_html(r#"<a href="x">&'"#), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    }

    #[test]
    fn refuses_a_scheme_that_executes() {
        assert_eq!(scheme_of("javascript:alert(1)").as_deref(), Some("javascript"));
        assert_eq!(scheme_of("/relative/path"), None);
        assert_eq!(scheme_of("https://example.com").as_deref(), Some("https"));
    }

    #[test]
    fn decodes_percent_escapes_and_refuses_broken_ones() {
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode("%F0%9F%90%91").as_deref(), Some("🐑"));
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("%FF"), None);
    }
}
