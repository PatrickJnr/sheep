//! Printing numbers exactly the way the reference implementation prints them.
//!
//! Baa has one numeric type, an f64, and `baa 0.1 + 0.2` must produce the same
//! twenty characters whether the program is interpreted by Node or run as a
//! native application. The reference implementation gets its text from
//! JavaScript's `String(number)`, so that algorithm is what this reproduces:
//! ECMA-262 §6.1.6.1.20, which is *not* what Rust's `{}` prints. The two agree
//! on ordinary numbers and disagree at both ends, where Rust never switches to
//! exponential notation and JavaScript does:
//!
//! | value    | Rust `{}`                 | JavaScript | Baa    |
//! |----------|---------------------------|------------|--------|
//! | `1e21`   | `1000000000000000000000`  | `1e+21`    | `1e+21`|
//! | `1e-7`   | `0.0000001`               | `1e-7`     | `1e-7` |
//!
//! Shortest-round-trip digits come from Rust's `{:e}`, which uses the same
//! kind of algorithm JavaScript does, so only the *placement* of the point has
//! to be reimplemented here.

/// `String(value)` in JavaScript, and so `to_string(value)` in Baa, except for
/// the three special values Baa spells differently.
pub fn format(value: f64) -> String {
    if value.is_nan() {
        return "nan".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "inf".to_string() } else { "-inf".to_string() };
    }
    if value == 0.0 {
        // Both zeros print as "0": JavaScript's String(-0) is "0" too, and a
        // program that wants to tell them apart has `ram.sign`.
        return "0".to_string();
    }
    if value < 0.0 {
        return format!("-{}", format(-value));
    }

    let (digits, exponent) = shortest(value);
    let k = digits.len() as i32;
    // `n` is the position of the decimal point relative to the digits, as in
    // the specification: the value is 0.<digits> × 10^n.
    let n = exponent + 1;

    if k <= n && n <= 21 {
        let mut out = digits;
        for _ in 0..(n - k) {
            out.push('0');
        }
        return out;
    }
    if 0 < n && n <= 21 {
        let point = n as usize;
        return format!("{}.{}", &digits[..point], &digits[point..]);
    }
    if -6 < n && n <= 0 {
        let mut out = String::from("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
        return out;
    }

    let sign = if n - 1 >= 0 { '+' } else { '-' };
    let magnitude = (n - 1).abs();
    if k == 1 {
        format!("{}e{}{}", digits, sign, magnitude)
    } else {
        format!("{}.{}e{}{}", &digits[..1], &digits[1..], sign, magnitude)
    }
}

/// The shortest digit string that round-trips, with its base-10 exponent, so
/// that `0.<digits> × 10^(exponent+1) == value`.
fn shortest(value: f64) -> (String, i32) {
    // `{:e}` is shortest-round-trip and always has exactly one digit before
    // the point, which makes the exponent directly usable.
    let text = format!("{:e}", value);
    let (mantissa, exponent) = text.split_once('e').expect("`{:e}` always writes an exponent");
    let exponent: i32 = exponent.parse().expect("`{:e}` always writes a decimal exponent");
    let mut digits = String::with_capacity(mantissa.len());
    for ch in mantissa.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        }
    }
    // Trailing zeros are not part of a shortest representation, but a value
    // like 100.0 arrives as "1e2" already, so this only trims what rounding
    // left behind.
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    (digits, exponent)
}

/// The inverse: `to_number(text)`, matching `parseNumber` in the reference.
///
/// Baa parses back exactly what Baa prints, and nothing the lexer would
/// refuse. `Infinity` and `NaN` are JavaScript spellings Baa never produces,
/// so they are rejected here even though Rust's own parser accepts them.
pub fn parse(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    match trimmed {
        "inf" | "+inf" => return Some(f64::INFINITY),
        "-inf" => return Some(f64::NEG_INFINITY),
        "nan" => return Some(f64::NAN),
        _ => {}
    }
    let lowered = trimmed.trim_start_matches(['+', '-']).to_ascii_lowercase();
    if lowered == "infinity" || lowered == "nan" {
        return None;
    }
    // Rust accepts a trailing/leading underscore-free decimal; JavaScript's
    // `Number` also accepts hex, octal and binary literals, which Baa's lexer
    // writes as plain decimals long before this point.
    if let Some(hex) = strip_radix(trimmed, "0x") {
        return u64::from_str_radix(&hex, 16).ok().map(|v| v as f64);
    }
    if let Some(oct) = strip_radix(trimmed, "0o") {
        return u64::from_str_radix(&oct, 8).ok().map(|v| v as f64);
    }
    if let Some(bin) = strip_radix(trimmed, "0b") {
        return u64::from_str_radix(&bin, 2).ok().map(|v| v as f64);
    }
    match trimmed.parse::<f64>() {
        Ok(value) if !value.is_nan() => Some(value),
        _ => None,
    }
}

fn strip_radix(text: &str, prefix: &str) -> Option<String> {
    let lowered = text.to_ascii_lowercase();
    lowered.strip_prefix(prefix).map(|rest| rest.replace('_', ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every expectation here is what `String(x)` prints in JavaScript, which
    /// is what the reference implementation prints.
    #[test]
    fn matches_javascript() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.0, "-1"),
            (1.5, "1.5"),
            (100.0, "100"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1.0 / 3.0, "0.3333333333333333"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (9007199254740991.0, "9007199254740991"),
            (123456789.123, "123456789.123"),
        ];
        for (value, expected) in cases {
            assert_eq!(&format(*value), expected, "formatting {value:?}");
        }
        assert_eq!(format(f64::NAN), "nan");
        assert_eq!(format(f64::INFINITY), "inf");
        assert_eq!(format(f64::NEG_INFINITY), "-inf");
    }

    #[test]
    fn round_trips_what_it_prints() {
        for value in [0.1_f64, 1e21, 1e-7, 12345.6789, f64::MAX, 5e-324] {
            let text = format(value);
            assert_eq!(parse(&text), Some(value), "round trip of {text}");
        }
    }

    #[test]
    fn refuses_spellings_baa_cannot_lex() {
        assert_eq!(parse("Infinity"), None);
        assert_eq!(parse("NaN"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse("twelve"), None);
        assert_eq!(parse("inf"), Some(f64::INFINITY));
        assert_eq!(parse("  42  "), Some(42.0));
        assert_eq!(parse("0xff"), Some(255.0));
    }
}
