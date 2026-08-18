//! `shepherd`: the world outside the program. A port of
//! `src/stdlib/shepherd.ts`.
//!
//! Security note, carried over unchanged: `shepherd.run` never uses a shell.
//! It takes a program name and an explicit array of arguments and hands them
//! to the operating system, so there is no string that could be re-read as
//! shell syntax and nothing to quote-escape. A program that wants a shell has
//! to ask for one by name, which puts the decision in the source and in
//! review. See SECURITY.md.
//!
//! `write` goes to the same stream `baa` writes to, not to `print!`. In a
//! windowed application that stream is a sink, so a program that prints has no
//! console window flashing behind it and no hidden file nobody reads.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::rc::Rc;

use crate::ast::Span;
use crate::interp::{Flow, Interpreter, Res};
use crate::value::{display, BaaMap, MapKey, Module, Native, Value};

use super::{map_value, module_of, need_array, need_string, option_str};

const FUNCTIONS: &[(&str, usize, usize)] = &[
    ("args", 0, 0),
    ("env", 1, 2),
    ("env_all", 0, 0),
    ("write", 1, usize::MAX),
    ("write_error", 1, usize::MAX),
    ("input", 0, 1),
    ("read_all", 0, 0),
    ("run", 1, 3),
    ("exit", 0, 1),
];

/// The names Node reports, because the reference implementation reports Node's
/// and a program that branches on the platform has to see the same word from
/// both runtimes.
const PLATFORM: &str = if cfg!(target_os = "windows") {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    std::env::consts::OS
};

const ARCH: &str = if cfg!(target_arch = "x86_64") {
    "x64"
} else if cfg!(target_arch = "aarch64") {
    "arm64"
} else if cfg!(target_arch = "x86") {
    "ia32"
} else {
    std::env::consts::ARCH
};

pub fn module() -> Rc<Module> {
    let mut exports: Vec<(&str, Value)> =
        vec![("PLATFORM", Value::str(PLATFORM)), ("ARCH", Value::str(ARCH))];
    for (name, min, max) in FUNCTIONS {
        exports.push((
            name,
            Value::Native(Rc::new(Native {
                name: format!("shepherd.{name}"),
                method: name,
                min_args: *min,
                max_args: *max,
                call,
                receiver: None,
            })),
        ));
    }
    module_of("shepherd", exports)
}

fn call(interp: &mut Interpreter, native: &Native, args: Vec<Value>, span: Span) -> Res<Value> {
    let name = native.name.clone();
    Ok(match native.method {
        "args" => Value::array(interp.argv.iter().map(Value::str).collect()),

        "env" => match std::env::var(&*need_string(interp, &name, &args, 0, span)?) {
            Ok(value) => Value::str(value),
            Err(_) => args.get(1).cloned().unwrap_or(Value::Nil),
        },

        "env_all" => {
            let mut map = BaaMap::new();
            for (key, value) in std::env::vars() {
                map.set(MapKey::Str(Rc::from(key.as_str())), Value::str(value));
            }
            Value::map(map)
        }

        "write" => {
            let _ = interp.out.write_all(joined(&args).as_bytes());
            Value::Nil
        }

        "write_error" => {
            let _ = std::io::stderr().write_all(joined(&args).as_bytes());
            Value::Nil
        }

        "input" => {
            if let Some(prompt) = args.first() {
                let text = need_string(interp, &name, &args, 0, span)?;
                let _ = prompt;
                let _ = interp.out.write_all(text.as_bytes());
                let _ = interp.out.flush();
            }
            match read_line() {
                Some(line) => Value::str(line),
                None => Value::Nil,
            }
        }

        "read_all" => {
            // The reference reads line by line and joins with "\n", which
            // drops a trailing newline. Matched deliberately: differing here
            // would show up as one invisible character.
            let mut lines: Vec<String> = Vec::new();
            while let Some(line) = read_line() {
                lines.push(line);
            }
            Value::str(lines.join("\n"))
        }

        "run" => {
            let program = need_string(interp, &name, &args, 0, span)?;
            let mut arguments: Vec<String> = Vec::new();
            if args.len() > 1 {
                for (index, item) in need_array(interp, &name, &args, 1, span)?.iter().enumerate() {
                    match item {
                        Value::Str(text) => arguments.push(text.to_string()),
                        _ => {
                            return Err(Flow::Err(
                                interp
                                    .error(
                                        "BAA311",
                                        vec![
                                            name.to_string(),
                                            "an array of strings".into(),
                                            "2".into(),
                                            format!("a non-string at index {index}"),
                                        ],
                                        span,
                                    )
                                    .with_note("arguments must all be strings"),
                            ))
                        }
                    }
                }
            }
            let options = args.get(2);
            let input = option_str(options, "input");

            let mut command = Command::new(&*program);
            command.args(&arguments);
            if let Some(cwd) = option_str(options, "cwd") {
                command.current_dir(&*cwd);
            }
            command
                .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    return Err(Flow::Err(
                        interp
                            .error(
                                "BAA301",
                                vec![format!("could not run `{program}`: {error}")],
                                span,
                            )
                            .with_note("the program did not start")
                            .with_help("Check that it is installed and on PATH."),
                    ))
                }
            };
            if let (Some(text), Some(mut pipe)) = (input, child.stdin.take()) {
                let _ = pipe.write_all(text.as_bytes());
            }
            match child.wait_with_output() {
                Ok(output) => map_value(vec![
                    ("code", Value::Number(output.status.code().unwrap_or(-1) as f64)),
                    ("out", Value::str(String::from_utf8_lossy(&output.stdout))),
                    ("err", Value::str(String::from_utf8_lossy(&output.stderr))),
                ]),
                Err(error) => {
                    return Err(Flow::Err(
                        interp
                            .error("BAA301", vec![format!("`{program}` failed: {error}")], span)
                            .with_note("the program started but could not be waited for"),
                    ))
                }
            }
        }

        "exit" => {
            let code = match args.first() {
                None | Some(Value::Nil) => 0.0,
                Some(Value::Number(value)) if value.fract() == 0.0 => *value,
                Some(other) => {
                    return Err(Flow::Err(interp.error(
                        "BAA311",
                        vec![name.to_string(), "a whole number".into(), "1".into(), other.describe()],
                        span,
                    )))
                }
            };
            return Err(Flow::Exit(code as i32));
        }

        _ => Value::Nil,
    })
}

/// `write` and `write_error` take any number of values and concatenate them,
/// with strings used as they are and everything else displayed.
fn joined(args: &[Value]) -> String {
    args.iter()
        .map(|value| match value {
            Value::Str(text) => text.to_string(),
            other => display(other),
        })
        .collect()
}

/// One line from standard input, without its terminator, or `None` at the end
/// of input. Blocking by design: the interpreter is synchronous.
fn read_line() -> Option<String> {
    let mut line = String::new();
    let mut byte = [0u8; 1];
    let mut stdin = std::io::stdin();
    loop {
        match stdin.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    if line.ends_with('\r') {
                        line.pop();
                    }
                    return Some(line);
                }
                line.push(byte[0] as char);
            }
            Err(_) => break,
        }
    }
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_reports_the_platform_names_node_reports() {
        // A program that branches on `shepherd.PLATFORM` has to see the same
        // word from both runtimes, and Node's words are not Rust's.
        assert!(["win32", "darwin", "linux"].contains(&PLATFORM), "{PLATFORM}");
        assert!(["x64", "arm64", "ia32"].contains(&ARCH), "{ARCH}");
    }

    #[test]
    fn joining_uses_strings_as_they_are() {
        assert_eq!(joined(&[Value::str("a"), Value::Number(1.0), Value::Nil]), "a1nil");
    }
}
