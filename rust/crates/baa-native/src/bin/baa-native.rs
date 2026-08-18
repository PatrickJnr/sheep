//! The console build of the runtime: `baa` output goes to standard output.
//!
//! Used by `baa app run`, by the conformance harness, and by any application
//! that is genuinely a command-line tool.

fn main() {
    std::process::exit(baa_native::run(std::env::args().collect(), false));
}
