//! `pasture`: files and paths. A port of `src/stdlib/pasture.ts`.
//!
//! # What this can reach
//!
//! Everything the person running the application can reach. A native
//! application is an ordinary process with the user's permissions; there is no
//! sandbox here, and pretending otherwise would be worse than saying so. A
//! program that opens a file the user chose in a dialog and a program that
//! reads their whole home directory look the same to the operating system.
//!
//! What the runtime does guarantee is narrower and worth stating exactly:
//!
//!  - **No shell.** Nothing here builds a command line, so there is no command
//!    injection to have. `shepherd`, which does run programs, is not in the
//!    native runtime at all.
//!  - **No path is interpreted.** A path is passed to the operating system as
//!    given. `..` is not blocked, because a text editor legitimately needs it,
//!    and a block that can be walked around is a false comfort.
//!  - **Every failure is a diagnostic**, never a panic and never a silent
//!    empty string.
//!
//! See docs/native-applications.md for the trust boundary in full.

use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Flow, Interpreter, Res};
use crate::value::{BaaMap, Module, Native, Value};

use super::{module_of, need_array, need_string};

const FUNCTIONS: &[(&str, usize, usize)] = &[
    ("read", 1, 1),
    ("read_lines", 1, 1),
    ("write", 2, 2),
    ("append", 2, 2),
    ("write_lines", 2, 2),
    ("exists", 1, 1),
    ("list", 1, 1),
    ("make_dir", 1, 1),
    ("info", 1, 1),
    ("join", 1, usize::MAX),
    ("resolve", 1, usize::MAX),
    ("dir_name", 1, 1),
    ("base_name", 1, 2),
    ("extension", 1, 1),
    ("normalise", 1, 1),
    ("relative_to", 2, 2),
    ("is_absolute", 1, 1),
    ("cwd", 0, 0),
];

pub fn module() -> Rc<Module> {
    let exports = FUNCTIONS
        .iter()
        .map(|(name, min, max)| {
            (
                *name,
                Value::Native(Rc::new(Native {
                    name: format!("pasture.{name}"),
                    method: name,
                    min_args: *min,
                    max_args: *max,
                    call,
                    receiver: None,
                })),
            )
        })
        .collect();
    module_of("pasture", exports)
}

/// A file error the person can act on: what was attempted, to what, and why.
fn file_error(interp: &Interpreter, path: &str, error: std::io::Error, note: &str, span: Span) -> Flow {
    Flow::Err(
        interp
            .error("BAA404", vec![format!("{path}: {}", describe(error))], span)
            .with_note(note.to_string()),
    )
}

fn describe(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "no such file or directory".to_string(),
        std::io::ErrorKind::PermissionDenied => "permission denied".to_string(),
        std::io::ErrorKind::AlreadyExists => "already exists".to_string(),
        _ => error.to_string(),
    }
}

fn call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let name = native.name.clone();
    Ok(match native.method {
        "read" | "read_lines" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            let text = std::fs::read_to_string(&*path)
                .map_err(|error| file_error(interp, &path, error, "could not read this file", span))?;
            if native.method == "read" {
                Value::str(text)
            } else {
                // Line endings are normalised, so a file written on Windows
                // and a file written on Linux produce the same array.
                let text = text.replace("\r\n", "\n");
                let mut lines: Vec<&str> = text.split('\n').collect();
                if lines.last() == Some(&"") {
                    lines.pop();
                }
                Value::array(lines.into_iter().map(Value::str).collect())
            }
        }
        "write" | "append" | "write_lines" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            let body = if native.method == "write_lines" {
                let lines = need_array(interp, &name, &args, 1, span)?;
                let mut out = String::new();
                for line in &lines {
                    out.push_str(&crate::value::display(line));
                    out.push('\n');
                }
                out
            } else {
                crate::value::display(&args[1])
            };
            let outcome = if native.method == "append" {
                use std::io::Write;
                std::fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open(&*path)
                    .and_then(|mut file| file.write_all(body.as_bytes()))
            } else {
                std::fs::write(&*path, body.as_bytes())
            };
            outcome.map_err(|error| file_error(interp, &path, error, "could not write this file", span))?;
            Value::Nil
        }
        "exists" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            Value::Bool(std::path::Path::new(&*path).exists())
        }
        "list" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            let entries = std::fs::read_dir(&*path)
                .map_err(|error| file_error(interp, &path, error, "could not list this directory", span))?;
            let mut names: Vec<String> = Vec::new();
            for entry in entries {
                let entry =
                    entry.map_err(|error| file_error(interp, &path, error, "could not list this directory", span))?;
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
            names.sort();
            Value::array(names.into_iter().map(Value::str).collect())
        }
        "make_dir" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            std::fs::create_dir_all(&*path)
                .map_err(|error| file_error(interp, &path, error, "could not create this directory", span))?;
            Value::Nil
        }
        "info" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            match std::fs::metadata(&*path) {
                Err(_) => Value::Nil,
                Ok(meta) => {
                    let modified = meta
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|since| since.as_millis() as f64)
                        .unwrap_or(0.0);
                    let mut map = BaaMap::new();
                    map.set_str("path", Value::Str(path.clone()));
                    map.set_str("size", Value::Number(meta.len() as f64));
                    map.set_str("is_directory", Value::Bool(meta.is_dir()));
                    map.set_str("modified", Value::Number(modified));
                    Value::map(map)
                }
            }
        }
        "join" | "resolve" => {
            let mut segments = Vec::with_capacity(args.len());
            for index in 0..args.len() {
                segments.push(need_string(interp, &name, &args, index, span)?.to_string());
            }
            let joined = join_segments(&segments);
            if native.method == "join" {
                Value::str(joined)
            } else {
                let path = std::path::Path::new(&joined);
                let absolute = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    std::env::current_dir().unwrap_or_default().join(path)
                };
                Value::str(normalise(&absolute.to_string_lossy()))
            }
        }
        "dir_name" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            Value::str(dir_name(&path))
        }
        "base_name" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            let base = base_name(&path);
            if args.len() > 1 {
                let suffix = need_string(interp, &name, &args, 1, span)?;
                if base.ends_with(&*suffix) && base.len() > suffix.len() {
                    return Ok(Value::str(&base[..base.len() - suffix.len()]));
                }
            }
            Value::str(base)
        }
        "extension" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            let base = base_name(&path);
            match base.rfind('.') {
                // A leading dot is the whole name of a hidden file, not an
                // extension: `.gitignore` has none.
                Some(0) | None => Value::str(""),
                Some(at) => Value::str(&base[at..]),
            }
        }
        "normalise" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            Value::str(normalise(&path))
        }
        "relative_to" => {
            let from = need_string(interp, &name, &args, 0, span)?;
            let to = need_string(interp, &name, &args, 1, span)?;
            Value::str(relative_to(&from, &to))
        }
        "is_absolute" => {
            let path = need_string(interp, &name, &args, 0, span)?;
            Value::Bool(std::path::Path::new(&*path).is_absolute())
        }
        "cwd" => Value::str(std::env::current_dir().unwrap_or_default().to_string_lossy()),
        _ => Value::Nil,
    })
}

fn separator() -> char {
    std::path::MAIN_SEPARATOR
}

fn join_segments(segments: &[String]) -> String {
    let mut path = std::path::PathBuf::new();
    for segment in segments {
        path.push(segment);
    }
    normalise(&path.to_string_lossy())
}

/// Collapses `.` and `..` without touching the filesystem, so it works on a
/// path that does not exist yet.
fn normalise(path: &str) -> String {
    let windows = cfg!(windows);
    let text = if windows { path.replace('/', "\\") } else { path.to_string() };
    let sep = if windows { '\\' } else { '/' };

    let absolute = text.starts_with(sep);
    let prefix: String = if windows && text.len() > 1 && text.as_bytes()[1] == b':' {
        text[..2].to_string()
    } else {
        String::new()
    };
    let body = &text[prefix.len()..];

    let mut parts: Vec<&str> = Vec::new();
    for part in body.split(sep) {
        match part {
            "" | "." => continue,
            ".." => {
                if matches!(parts.last(), Some(&last) if last != "..") {
                    parts.pop();
                } else if !absolute && prefix.is_empty() {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join(&sep.to_string());
    let leading = if body.starts_with(sep) { sep.to_string() } else { String::new() };
    let out = format!("{prefix}{leading}{joined}");
    if out.is_empty() {
        ".".to_string()
    } else {
        out
    }
}

fn dir_name(path: &str) -> String {
    let normalised = normalise(path);
    match normalised.rfind(separator()) {
        None => ".".to_string(),
        Some(0) => separator().to_string(),
        Some(at) => normalised[..at].to_string(),
    }
}

fn base_name(path: &str) -> String {
    let normalised = normalise(path);
    match normalised.rfind(separator()) {
        None => normalised,
        Some(at) => normalised[at + 1..].to_string(),
    }
}

fn relative_to(from: &str, to: &str) -> String {
    let sep = separator().to_string();
    let from_parts: Vec<String> = normalise(from).split(&sep).map(str::to_string).collect();
    let to_parts: Vec<String> = normalise(to).split(&sep).map(str::to_string).collect();
    let shared = from_parts
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts: Vec<String> = vec!["..".to_string(); from_parts.len() - shared];
    parts.extend(to_parts[shared..].iter().cloned());
    if parts.is_empty() {
        String::new()
    } else {
        parts.join(&sep)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_dot_segments() {
        let sep = separator();
        assert_eq!(normalise(&format!("a{sep}.{sep}b")), format!("a{sep}b"));
        assert_eq!(normalise(&format!("a{sep}b{sep}..{sep}c")), format!("a{sep}c"));
        assert_eq!(normalise("."), ".");
    }

    #[test]
    fn takes_a_path_apart() {
        let sep = separator();
        let path = format!("one{sep}two{sep}three.baa");
        assert_eq!(base_name(&path), "three.baa");
        assert_eq!(dir_name(&path), format!("one{sep}two"));
    }

    /// A dotfile has no extension: the dot is the start of its name.
    #[test]
    fn a_dotfile_has_no_extension() {
        assert_eq!(base_name(".gitignore"), ".gitignore");
        assert_eq!(base_name(".gitignore").rfind('.'), Some(0));
    }
}
