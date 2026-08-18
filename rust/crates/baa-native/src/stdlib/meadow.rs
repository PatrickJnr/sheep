//! `meadow`: time and chance. A port of `src/stdlib/meadow.ts`.
//!
//! The calendar is written out rather than pulled in, because this crate has
//! no dependencies and is not about to grow one for civil-date arithmetic.
//! `days_from_civil` and `civil_from_days` below are the standard proleptic
//! Gregorian conversions; everything else is arithmetic on a day number and a
//! millisecond-of-day.
//!
//! Two behaviours are deliberately matched to JavaScript, because the
//! reference implementation is JavaScript and the two runtimes have to agree:
//!
//! - a timestamp is truncated towards zero before use, the way `new Date(x)`
//!   applies `ToInteger`;
//! - a timestamp outside +/- 8.64e15 milliseconds is not a real date, and the
//!   functions that take one say so rather than inventing a year.
//!
//! One behaviour is deliberately *not* matched, and is an error instead. ECMA
//! -262 reads an ISO date-time with no offset (`2026-08-18T09:30`) as *local*
//! time, which would make `meadow.parse_iso` return a different number on the
//! two runtimes depending on where the machine is. Guessing an offset here
//! would be a near miss, and a near miss is worse than an absence: the native
//! runtime refuses that form and names the fix. Date-only text, and date-time
//! text carrying `Z` or an explicit offset, are unambiguous and are read
//! exactly as the reference reads them.

use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Flow, Interpreter, Res};
use crate::value::{Module, Native, Value};

use super::{map_value, module_of, need_array, need_int, need_number, need_string};

const FUNCTIONS: &[(&str, usize, usize)] = &[
    ("now", 0, 0),
    ("clock", 0, 0),
    ("parts", 0, 1),
    ("format", 1, 2),
    ("iso", 0, 1),
    ("parse_iso", 1, 1),
    ("random", 0, 0),
    ("random_int", 2, 2),
    ("pick", 1, 1),
    ("shuffle", 1, 1),
    ("sample", 2, 2),
];

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// The largest timestamp JavaScript calls a date. Past it, `new Date(millis)`
/// is Invalid Date, and the reference implementation raises BAA301.
const MAX_TIME: f64 = 8.64e15;

const MS_PER_DAY: f64 = 86_400_000.0;

pub fn module() -> Rc<Module> {
    let exports = FUNCTIONS
        .iter()
        .map(|(name, min, max)| {
            (
                *name,
                Value::Native(Rc::new(Native {
                    name: format!("meadow.{name}"),
                    method: name,
                    min_args: *min,
                    max_args: *max,
                    call,
                    receiver: None,
                })),
            )
        })
        .collect();
    module_of("meadow", exports)
}

fn call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let name = native.name.clone();
    Ok(match native.method {
        "now" => Value::Number(interp.now()),
        "clock" => Value::Number(interp.clock()),

        "parts" => {
            let millis = if args.is_empty() {
                interp.now()
            } else {
                need_number(interp, &name, &args, 0, span)?
            };
            let civil = civil(interp, &name, millis, span)?;
            map_value(vec![
                ("year", Value::Number(civil.year as f64)),
                ("month", Value::Number(civil.month as f64)),
                ("day", Value::Number(civil.day as f64)),
                ("hour", Value::Number(civil.hour as f64)),
                ("minute", Value::Number(civil.minute as f64)),
                ("second", Value::Number(civil.second as f64)),
                ("millisecond", Value::Number(civil.millisecond as f64)),
                ("weekday", Value::str(DAYS[civil.weekday])),
                ("month_name", Value::str(MONTHS[(civil.month - 1) as usize])),
            ])
        }

        "format" => {
            let millis = need_number(interp, &name, &args, 0, span)?;
            let pattern: Rc<str> = if args.len() > 1 {
                need_string(interp, &name, &args, 1, span)?
            } else {
                Rc::from("YYYY-MM-DD")
            };
            let civil = civil(interp, &name, millis, span)?;
            // The reference substitutes in this order with `String.replace`.
            // No replacement introduces a letter, so no later pattern can
            // match text an earlier one produced.
            let text = pattern
                .replace("YYYY", &civil.year.to_string())
                .replace("MM", &pad2(civil.month as i64))
                .replace("DD", &pad2(civil.day as i64))
                .replace("hh", &pad2(civil.hour as i64))
                .replace("mm", &pad2(civil.minute as i64))
                .replace("ss", &pad2(civil.second as i64));
            Value::str(text)
        }

        "iso" => {
            let millis = if args.is_empty() {
                interp.now()
            } else {
                need_number(interp, &name, &args, 0, span)?
            };
            Value::str(civil(interp, &name, millis, span)?.iso())
        }

        "parse_iso" => {
            let text = need_string(interp, &name, &args, 0, span)?;
            match parse_iso(&text) {
                Parsed::Time(millis) => Value::Number(millis),
                Parsed::NotADate => Value::Nil,
                Parsed::NoOffset => {
                    return Err(Flow::Err(
                        interp
                            .error(
                                "BAA301",
                                vec![format!(
                                    "meadow.parse_iso cannot read `{text}`: it has a time but no time zone"
                                )],
                                span,
                            )
                            .with_note("this would mean a different instant on a different machine")
                            .with_help("Add `Z` for UTC, or an offset such as `+01:00`."),
                    ))
                }
            }
        }

        "random" => Value::Number(interp.random()),

        "random_int" => {
            let low = need_int(interp, &name, &args, 0, span)?;
            let high = need_int(interp, &name, &args, 1, span)?;
            if low > high {
                return Err(Flow::Err(interp.error(
                    "BAA311",
                    vec![
                        name.to_string(),
                        "low <= high".into(),
                        "1".into(),
                        "a low bound above the high bound".into(),
                    ],
                    span,
                )));
            }
            Value::Number(low + (interp.random() * (high - low + 1.0)).floor())
        }

        "pick" => {
            let items = match args.first() {
                Some(Value::Range(range)) => {
                    range.values().into_iter().map(Value::Number).collect::<Vec<_>>()
                }
                _ => need_array(interp, &name, &args, 0, span)?,
            };
            if items.is_empty() {
                Value::Nil
            } else {
                let index = (interp.random() * items.len() as f64).floor() as usize;
                items.get(index).cloned().unwrap_or(Value::Nil)
            }
        }

        "shuffle" => {
            let mut items = need_array(interp, &name, &args, 0, span)?;
            // The same Fisher-Yates the reference runs, drawing in the same
            // order, so one seeded sequence produces one permutation.
            let mut i = items.len();
            while i > 1 {
                i -= 1;
                let j = (interp.random() * (i as f64 + 1.0)).floor() as usize;
                items.swap(i, j.min(i));
            }
            Value::array(items)
        }

        "sample" => {
            let mut items = need_array(interp, &name, &args, 0, span)?;
            let count = need_int(interp, &name, &args, 1, span)?;
            if count < 0.0 || count > items.len() as f64 {
                return Err(Flow::Err(
                    interp
                        .error(
                            "BAA311",
                            vec![
                                name.to_string(),
                                format!("0 to {}", items.len()),
                                "2".into(),
                                crate::number::format(count),
                            ],
                            span,
                        )
                        .with_note("cannot take more items than the array holds"),
                ));
            }
            let mut out = Vec::with_capacity(count as usize);
            for _ in 0..count as usize {
                let index = (interp.random() * items.len() as f64).floor() as usize;
                out.push(items.remove(index.min(items.len() - 1)));
            }
            Value::array(out)
        }

        _ => Value::Nil,
    })
}

// ----------------------------------------------------------------- calendar

/// A timestamp broken into UTC calendar fields.
pub struct Civil {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millisecond: i64,
    pub weekday: usize,
}

impl Civil {
    /// The text `Date.prototype.toISOString` produces, including the expanded
    /// year form for anything outside 0000-9999.
    pub fn iso(&self) -> String {
        let year = if (0..=9999).contains(&self.year) {
            format!("{:04}", self.year)
        } else if self.year > 9999 {
            format!("+{:06}", self.year)
        } else {
            format!("-{:06}", -self.year)
        };
        format!(
            "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            self.month, self.day, self.hour, self.minute, self.second, self.millisecond
        )
    }
}

fn civil(interp: &Interpreter, name: &str, millis: f64, span: Span) -> Res<Civil> {
    match break_up(millis) {
        Some(civil) => Ok(civil),
        None => Err(Flow::Err(interp.error(
            "BAA301",
            vec![format!("{name} got a timestamp that is not a real date")],
            span,
        ))),
    }
}

/// Splits a timestamp into UTC fields, or `None` when JavaScript would call it
/// an Invalid Date.
pub fn break_up(millis: f64) -> Option<Civil> {
    if millis.is_nan() || millis.abs() > MAX_TIME {
        return None;
    }
    let millis = millis.trunc();
    let days = (millis / MS_PER_DAY).floor();
    let rest = (millis - days * MS_PER_DAY) as i64;
    let (year, month, day) = civil_from_days(days as i64);
    Some(Civil {
        year,
        month,
        day,
        hour: rest / 3_600_000,
        minute: rest / 60_000 % 60,
        second: rest / 1_000 % 60,
        millisecond: rest % 1_000,
        // 1970-01-01 was a Thursday, which `getUTCDay` numbers 4.
        weekday: (((days as i64 + 4) % 7 + 7) % 7) as usize,
    })
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The inverse: a date from a day number.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

fn pad2(value: i64) -> String {
    format!("{value:02}")
}

// -------------------------------------------------------------- parse_iso

pub enum Parsed {
    Time(f64),
    /// Not the Date Time String Format at all.
    NotADate,
    /// A time with no zone: unambiguous only if you know where you are.
    NoOffset,
}

/// The ECMA-262 Date Time String Format, and nothing else. Anything outside it
/// is `NotADate`, which the reference also reports as `nil` because
/// `Date.parse` returns `NaN` for it.
pub fn parse_iso(text: &str) -> Parsed {
    let bytes = text.as_bytes();
    let mut at = 0usize;

    let sign = match bytes.first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => 0,
    };
    let year = if sign == 0 {
        match digits(bytes, &mut at, 4) {
            Some(value) => value,
            None => return Parsed::NotADate,
        }
    } else {
        at = 1;
        match digits(bytes, &mut at, 6) {
            // `-000000` is explicitly not a year in the grammar.
            Some(0) if sign == -1 => return Parsed::NotADate,
            Some(value) => value * sign,
            None => return Parsed::NotADate,
        }
    };

    let mut month = 1;
    let mut day = 1;
    if eat(bytes, &mut at, b'-') {
        month = match digits(bytes, &mut at, 2) {
            Some(value) if (1..=12).contains(&value) => value,
            _ => return Parsed::NotADate,
        };
        if eat(bytes, &mut at, b'-') {
            day = match digits(bytes, &mut at, 2) {
                Some(value) if (1..=31).contains(&value) => value,
                _ => return Parsed::NotADate,
            };
        }
    }

    let mut hour = 0;
    let mut minute = 0;
    let mut second = 0;
    let mut milli = 0;
    let mut has_time = false;
    if eat(bytes, &mut at, b'T') {
        has_time = true;
        hour = match digits(bytes, &mut at, 2) {
            Some(value) if value <= 24 => value,
            _ => return Parsed::NotADate,
        };
        if !eat(bytes, &mut at, b':') {
            return Parsed::NotADate;
        }
        minute = match digits(bytes, &mut at, 2) {
            Some(value) if value <= 59 => value,
            _ => return Parsed::NotADate,
        };
        if eat(bytes, &mut at, b':') {
            second = match digits(bytes, &mut at, 2) {
                Some(value) if value <= 59 => value,
                _ => return Parsed::NotADate,
            };
            if eat(bytes, &mut at, b'.') {
                milli = match digits(bytes, &mut at, 3) {
                    Some(value) => value,
                    None => return Parsed::NotADate,
                };
            }
        }
    }

    let mut offset = 0i64;
    let mut zoned = false;
    if eat(bytes, &mut at, b'Z') {
        // The grammar in ECMA-262 attaches a zone only to a time, so
        // `1970-01-01Z` is not in it. V8 reads it anyway, as UTC, and the
        // reference implementation is V8; a bare `Z` on a date is
        // unambiguous, so this follows rather than disagreeing over it. An
        // offset on a date is a different matter: V8 rejects that too.
        zoned = true;
    } else if has_time && at < bytes.len() && (bytes[at] == b'+' || bytes[at] == b'-') {
        let sign = if bytes[at] == b'-' { -1 } else { 1 };
        at += 1;
        let hours = match digits(bytes, &mut at, 2) {
            Some(value) if value <= 23 => value,
            _ => return Parsed::NotADate,
        };
        if !eat(bytes, &mut at, b':') {
            return Parsed::NotADate;
        }
        let minutes = match digits(bytes, &mut at, 2) {
            Some(value) if value <= 59 => value,
            _ => return Parsed::NotADate,
        };
        offset = sign * (hours * 60 + minutes);
        zoned = true;
    }

    if at != bytes.len() {
        return Parsed::NotADate;
    }
    // A date with no time is UTC by the specification; a time with no zone is
    // local, which is the case this runtime refuses rather than guesses.
    if has_time && !zoned {
        return Parsed::NoOffset;
    }

    let millis = days_from_civil(year, month, day) as f64 * MS_PER_DAY
        + (hour * 3_600_000 + minute * 60_000 + second * 1_000 + milli - offset * 60_000) as f64;
    if millis.abs() > MAX_TIME {
        return Parsed::NotADate;
    }
    Parsed::Time(millis)
}

fn digits(bytes: &[u8], at: &mut usize, count: usize) -> Option<i64> {
    if *at + count > bytes.len() {
        return None;
    }
    let mut value = 0i64;
    for &byte in &bytes[*at..*at + count] {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    *at += count;
    Some(value)
}

fn eat(bytes: &[u8], at: &mut usize, ch: u8) -> bool {
    if bytes.get(*at) == Some(&ch) {
        *at += 1;
        true
    } else {
        false
    }
}

// -------------------------------------------------------------------- chance

/// xoshiro256++. Small, no dependency, and good enough for `pick` and
/// `shuffle`; nothing here is a security boundary, and the module's
/// documentation says so.
pub struct Rng {
    state: [u64; 4],
}

impl Rng {
    pub fn seeded(seed: u64) -> Rng {
        // SplitMix64 to spread one seed across the whole state, so a small
        // seed does not start the generator in a corner.
        let mut z = seed;
        let mut next = || {
            z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        };
        Rng { state: [next(), next(), next(), next()] }
    }

    pub fn next_u64(&mut self) -> u64 {
        let result = self.state[0]
            .wrapping_add(self.state[3])
            .rotate_left(23)
            .wrapping_add(self.state[0]);
        let t = self.state[1] << 17;
        self.state[2] ^= self.state[0];
        self.state[3] ^= self.state[1];
        self.state[1] ^= self.state[2];
        self.state[0] ^= self.state[3];
        self.state[2] ^= t;
        self.state[3] = self.state[3].rotate_left(45);
        result
    }

    /// A number in [0, 1), with 53 bits of mantissa, the way `Math.random`
    /// produces one.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_epoch_is_a_thursday() {
        let civil = break_up(0.0).expect("the epoch is a real date");
        assert_eq!((civil.year, civil.month, civil.day), (1970, 1, 1));
        assert_eq!(DAYS[civil.weekday], "Thursday");
        assert_eq!(civil.iso(), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn negative_timestamps_go_backwards_correctly() {
        // The day before the epoch, one millisecond in. Truncation towards
        // zero and a floored day number disagree here if either is wrong.
        let civil = break_up(-86_400_000.0 + 1.0).expect("a real date");
        assert_eq!((civil.year, civil.month, civil.day), (1969, 12, 31));
        assert_eq!(civil.millisecond, 1);
        assert_eq!(civil.iso(), "1969-12-31T00:00:00.001Z");
    }

    #[test]
    fn a_leap_day_survives_the_round_trip() {
        let days = days_from_civil(2024, 2, 29);
        assert_eq!(civil_from_days(days), (2024, 2, 29));
        let civil = break_up(days as f64 * MS_PER_DAY).expect("a real date");
        assert_eq!(civil.iso(), "2024-02-29T00:00:00.000Z");
        assert_eq!(DAYS[civil.weekday], "Thursday");
    }

    #[test]
    fn every_day_of_a_century_round_trips() {
        for day in -36_524..36_524 {
            let (year, month, date) = civil_from_days(day);
            assert_eq!(days_from_civil(year, month, date), day);
        }
    }

    #[test]
    fn a_timestamp_past_the_edge_is_not_a_date() {
        assert!(break_up(8.64e15).is_some());
        assert!(break_up(8.64e15 + 1.0).is_none());
        assert!(break_up(f64::NAN).is_none());
    }

    #[test]
    fn iso_uses_the_expanded_year_outside_four_digits() {
        let far = break_up(days_from_civil(275_760, 9, 13) as f64 * MS_PER_DAY).expect("a real date");
        assert_eq!(far.iso(), "+275760-09-13T00:00:00.000Z");
        let old = break_up(days_from_civil(-1, 1, 1) as f64 * MS_PER_DAY).expect("a real date");
        assert_eq!(old.iso(), "-000001-01-01T00:00:00.000Z");
    }

    #[test]
    fn parse_iso_reads_what_the_specification_defines() {
        let cases: &[(&str, f64)] = &[
            ("1970-01-01T00:00:00.000Z", 0.0),
            ("1970-01-01", 0.0),
            ("1970-01", 0.0),
            ("1970", 0.0),
            ("2024-02-29T12:30:45.500Z", 1_709_209_845_500.0),
            // An offset moves the instant the other way.
            ("2024-02-29T12:30:45.500+01:00", 1_709_206_245_500.0),
            ("+002024-02-29T00:00:00.000Z", 1_709_164_800_000.0),
            // Not in the grammar, but V8 reads it and it cannot mean anything
            // else. Checked against `Date.parse` rather than assumed.
            ("1970-01-01Z", 0.0),
        ];
        for (text, expected) in cases {
            match parse_iso(text) {
                Parsed::Time(value) => assert_eq!(value, *expected, "{text}"),
                _ => panic!("{text} should have parsed"),
            }
        }
    }

    #[test]
    fn parse_iso_refuses_a_time_with_no_zone_and_rejects_nonsense() {
        assert!(matches!(parse_iso("2026-08-18T09:30"), Parsed::NoOffset));
        // Each of these is `NaN` from `Date.parse`, including the offset on a
        // date with no time, which V8 rejects where it accepts a bare `Z`.
        for text in ["", "today", "2026-13-01", "1970-01-01T25:00Z", "1970-01-01+01:00"] {
            assert!(matches!(parse_iso(text), Parsed::NotADate), "{text}");
        }
    }

    #[test]
    fn the_generator_stays_in_range_and_moves() {
        let mut rng = Rng::seeded(42);
        let first: Vec<f64> = (0..1000).map(|_| rng.next_f64()).collect();
        assert!(first.iter().all(|value| (0.0..1.0).contains(value)));
        assert!(first.windows(2).any(|pair| pair[0] != pair[1]));
        // Same seed, same sequence: a seeded run has to be reproducible.
        let mut again = Rng::seeded(42);
        assert!(first.iter().all(|value| again.next_f64() == *value));
    }
}
