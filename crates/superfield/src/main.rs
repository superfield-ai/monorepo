//! Superfield single-binary entrypoint.
//!
//! All component crates (Sharp, Nexum, sf-cli, sf-serve, sf-deploy) are linked
//! into this binary. Components are mounted here as they are ported to Rust;
//! the stubs below mark the integration seams.

use std::process;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // No-op command: exit cleanly without spinning up any component.
    if args.get(1).map(String::as_str) == Some("noop") {
        eprintln!("superfield: ok");
        process::exit(0);
    }

    eprintln!("superfield: no command given — nothing to do");
    process::exit(0);
}
