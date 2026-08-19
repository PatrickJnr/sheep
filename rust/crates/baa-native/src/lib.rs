//! The Baa native application runtime.
//!
//! A built application is this runtime with a `.fleece` image appended to it.
//! Starting one is: read our own executable, find the image, walk the tree.
//! There is no parser here and no filesystem lookup for modules, so an
//! application does what it was built to do and nothing a file placed beside
//! it can change.
//!
//! The same binary runs an image from a path, which is what `baa app run` uses
//! during development and what the conformance harness uses to check this
//! runtime against the reference implementation.

pub mod ast;
pub mod codes;
pub mod diag;
pub mod gui;
pub mod image;
pub mod interp;
pub mod methods;
pub mod number;
pub mod regex;
pub mod stdlib;
pub mod value;

use std::rc::Rc;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Runs whatever this executable was asked to run. Returns the exit code.
///
/// `windowed` is true for the copy of the runtime built without a console: it
/// has nowhere to write, so a diagnostic goes to a message box instead of into
/// a void.
///
/// The work happens on a thread with a large stack. A tree-walking interpreter
/// uses one machine frame per Baa expression, so the default 1 MB main-thread
/// stack runs out well before the 512-call limit that is supposed to produce
/// `BAA307`. Reaching a diagnostic instead of a crash is the whole point of
/// having a limit, and this is what makes the limit the thing that fires.
pub fn run(args: Vec<String>, windowed: bool) -> i32 {
    // The GUI must stay on the thread that created the windows, and it does:
    // everything runs on this one thread, main simply waits for it.
    let copy = args.clone();
    match std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(move || run_on_this_thread(copy, windowed))
    {
        Ok(handle) => handle.join().unwrap_or(70),
        // If a thread cannot be spawned, running here is better than not
        // running: deep recursion will crash, everything else works.
        Err(_) => run_on_this_thread(args, windowed),
    }
}

fn run_on_this_thread(args: Vec<String>, windowed: bool) -> i32 {
    let mut path: Option<String> = None;
    let mut program_args: Vec<String> = Vec::new();
    let mut tests = false;

    let mut rest = args.into_iter().skip(1);
    while let Some(argument) = rest.next() {
        match argument.as_str() {
            "--version" | "-V" => {
                println!("baa-native {VERSION}");
                return 0;
            }
            "--help" | "-h" => {
                print!("{}", HELP);
                return 0;
            }
            "--test" => tests = true,
            "--image" => match rest.next() {
                Some(value) => path = Some(value),
                None => {
                    eprintln!("--image needs a path");
                    return 2;
                }
            },
            "--" => {
                program_args.extend(rest);
                break;
            }
            other if path.is_none() && other.ends_with(".fleece") => path = Some(other.to_string()),
            other => program_args.push(other.to_string()),
        }
    }
    let bytes = match load_image(path.as_deref()) {
        Ok(bytes) => bytes,
        Err(reason) => return fail(&reason, windowed),
    };
    let image = match image::decode(&bytes) {
        Ok(image) => Rc::new(image),
        Err(reason) => return fail(&reason, windowed),
    };

    let out: Box<dyn std::io::Write> = if windowed {
        // A windowed application has no console. Discarding is the honest
        // behaviour: the alternative is a hidden file nobody reads, or a
        // console window flashing up behind the application.
        Box::new(std::io::sink())
    } else {
        Box::new(std::io::stdout())
    };

    let mut interpreter = interp::Interpreter::new(image.clone(), out);
    interpreter.argv = program_args;
    if tests {
        return run_tests(&mut interpreter, &image);
    }
    match interpreter.run() {
        Ok(code) => code,
        Err(error) => {
            let report = error.render(&image);
            fail(&report, windowed)
        }
    }
}

const HELP: &str = "\
The Baa native application runtime.

  baa-native <image.fleece>   run an image
  baa-native --test <image>   run the image's `test` blocks
  baa-native --version

With no image, runs the one appended to this executable, which is what a built
application is. See docs/native-applications.md.
";

/// The image to run: the one given on the command line, or the one appended to
/// this executable.
fn load_image(path: Option<&str>) -> Result<Vec<u8>, String> {
    if let Some(path) = path {
        return std::fs::read(path).map_err(|error| format!("cannot read {path}: {error}"));
    }
    let exe = std::env::current_exe().map_err(|error| format!("cannot find this executable: {error}"))?;
    let bytes = std::fs::read(&exe).map_err(|error| format!("cannot read {}: {error}", exe.display()))?;
    match image::embedded(&bytes) {
        Some(image) => Ok(image.to_vec()),
        None => Err(
            "This runtime has no application in it.\n\
             Give it an image to run, or build an application with `baa app build`."
                .to_string(),
        ),
    }
}

fn run_tests(interpreter: &mut interp::Interpreter, image: &Rc<ast::Image>) -> i32 {
    // Loading the entry module is what registers the `test` blocks, the same
    // way `baa test` collects them by running the file.
    if let Err(flow) = interpreter.load_module(image.entry, ast::Span::ZERO) {
        let error = interpreter.to_error(flow);
        eprint!("{}", error.render(image));
        return 1;
    }

    let tests = std::mem::take(&mut interpreter.tests);
    let mut failed = 0;
    for (name, body, env, module) in tests {
        let scope = interp::Environment::child(&env);
        let previous = interpreter.module;
        interpreter.module = module;
        let outcome = interpreter.execute_body(&body, &scope);
        interpreter.module = previous;
        match outcome {
            Ok(_) => println!("  ok {name}"),
            Err(flow) => {
                failed += 1;
                let error = interpreter.to_error(flow);
                println!("  FAILED {name}");
                print!("{}", error.render(image));
            }
        }
    }
    if failed == 0 {
        println!("all tests passed");
        0
    } else {
        println!("{failed} failed");
        1
    }
}

/// Reports a failure through whichever channel the build has.
fn fail(message: &str, windowed: bool) -> i32 {
    if windowed {
        #[cfg(windows)]
        {
            let mut backend = gui::win32::Win32::new();
            let ui = gui::Ui::new();
            use gui::Backend;
            backend.message(&ui, usize::MAX, "Baa", message, "info");
            return 1;
        }
    }
    eprint!("{message}");
    if !message.ends_with('\n') {
        eprintln!();
    }
    1
}
