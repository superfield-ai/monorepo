//! Superfield single-binary entrypoint.
//!
//! All component crates (Sharp, Nexum, sf-cli, sf-serve, sf-deploy) are linked
//! into this binary.  The CLI commands (operator + agent) are dispatched here
//! via `sf_cli::parse` and `sf_cli::connect_and_run`.
//!
//! # Architecture
//!
//! See `docs/architecture.md` §5 (CLI, deploy tooling, and serving backend in
//! Rust) and the agent-warning: "The single binary entrypoint is
//! `crates/superfield/src/main.rs`".
//!
//! The pool is built once here from `DATABASE_URL` (via [`sf_db::DbConfig`]);
//! component crates receive it rather than opening their own connections.

use std::process;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // No-op command: exit cleanly without spinning up any component.
    if args.first().map(String::as_str) == Some("noop") {
        eprintln!("superfield: ok");
        process::exit(0);
    }

    // Help / no args.
    if args.is_empty()
        || args.first().map(String::as_str) == Some("--help")
        || args.first().map(String::as_str) == Some("-h")
    {
        print!("{}", sf_cli::USAGE);
        process::exit(0);
    }

    // Parse and run a CLI command.
    let cmd = match sf_cli::parse(&args) {
        Ok(c) => c,
        Err(sf_cli::CliError::Usage(msg)) => {
            eprintln!("{}\n{}", msg, sf_cli::USAGE);
            process::exit(1);
        }
        Err(e) => {
            eprintln!("superfield: {}", e);
            process::exit(1);
        }
    };

    if let Err(e) = sf_cli::connect_and_run(cmd).await {
        eprintln!("superfield: {}", e);
        process::exit(1);
    }
}
