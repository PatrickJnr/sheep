//! The windowed build: identical, minus the console.
//!
//! Two binaries rather than one because the subsystem is a flag in the
//! executable header, chosen when the runtime is linked and not when an
//! application is built from it. A console application built on the windowed
//! runtime would have nowhere to print; a windowed application built on the
//! console runtime flashes up a black window behind itself. `baa app build`
//! picks between them, the way python.exe and pythonw.exe are picked between.
#![windows_subsystem = "windows"]

fn main() {
    std::process::exit(baa_native::run(std::env::args().collect(), true));
}
