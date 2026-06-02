//! Superfield single-binary entrypoint.
//!
//! All component crates (Sharp, Nexum, sf-cli, sf-serve, sf-deploy) are linked
//! into this binary.  The CLI commands (operator + agent) are dispatched here
//! via `sf_cli::parse` and `sf_cli::connect_and_run`.  The HTTP serving layer
//! is started via `sf_serve::serve` when the `serve` subcommand is given.
//!
//! # Architecture
//!
//! See `docs/architecture.md` §5 (CLI, deploy tooling, and serving backend in
//! Rust) and the agent-warning: "The single binary entrypoint is
//! `crates/superfield/src/main.rs`".
//!
//! The pool is built once here from `DATABASE_URL` (via [`sf_db::DbConfig`]);
//! component crates receive it rather than opening their own connections.
//!
//! # Subcommands
//!
//! | Subcommand | Handler                     | Description                         |
//! |------------|-----------------------------|-------------------------------------|
//! | `serve`    | [`sf_serve::serve`]         | Start the HTTP server               |
//! | `repo`     | `sf_cli` operator commands  | Manage Sharp repos                  |
//! | `session`  | `sf_cli` operator commands  | Manage auth sessions                |
//! | `episode`  | `sf_cli` agent commands     | Manage agent episodes               |
//! | `deploy`   | [`sf_deploy`]               | Deploy a build to a target          |
//! | `noop`     | (built-in)                  | Smoke-test — exits cleanly          |

use std::process;

const USAGE: &str = "\
superfield — unified CLI and HTTP serving backend

Subcommands:
  serve [--bind <addr>] [--session-ttl <secs>]
                        Start the HTTP server (default bind: 0.0.0.0:7000)

Operator commands:
  repo init <name>                    Create or get a Sharp repo
  repo list                           List all repos
  session issue <ws-id> <uid> <role>  Issue a session token
                                      role: admin|member|viewer

Agent commands:
  episode open <repo-id> <title>      Open a new episode
  episode append <ep-id> <type> <json>  Append an event to an episode
  episode finish <episode-id>         Close an episode
  episode list <repo-id>              List episodes for a repo

Deploy commands:
  deploy validate <config-json>       Validate a target config
  deploy ship <config-json> <path>    Ship a build to a target (stub)

Other:
  noop                                Smoke-test — exits with code 0
";

const DEPLOY_USAGE: &str = "\
superfield deploy — Rust deploy tooling

Usage:
  superfield deploy validate <config-json>
      Validate a target config JSON (no I/O).

  superfield deploy ship <config-json> <artifact-path>
      Validate config and ship the artifact to the target (stub transport).

Target config JSON fields:
  name       string   — target name, e.g. \"prod\"
  kind       string   — \"stub\" | \"ssh\" | \"kubernetes\"
  host       string?  — SSH host (required for ssh)
  user       string?  — SSH user (required for ssh)
  dest_dir   string?  — remote path (required for ssh)
  namespace  string?  — k8s namespace (required for kubernetes)
  image      string?  — OCI image ref (required for kubernetes)
";

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
        print!("{}", USAGE);
        process::exit(0);
    }

    // Route deploy subcommand to sf-deploy.
    if args.first().map(String::as_str) == Some("deploy") {
        run_deploy(&args[1..]);
        process::exit(0);
    }

    // `serve` subcommand — start the HTTP serving layer.
    if args.first().map(String::as_str) == Some("serve") {
        run_serve(&args[1..]).await;
        return;
    }

    // All other subcommands are handled by sf-cli (operator + agent).
    let cmd = match sf_cli::parse(&args) {
        Ok(c) => c,
        Err(sf_cli::CliError::Usage(msg)) => {
            eprintln!("{}\n{}", msg, USAGE);
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

/// Parse `serve` subcommand flags and start the HTTP server.
///
/// Recognised flags:
/// - `--bind <addr>` — override the default bind address (`0.0.0.0:7000`).
/// - `--session-ttl <secs>` — override the default session TTL (86 400 s).
async fn run_serve(args: &[String]) {
    let mut bind_addr: std::net::SocketAddr = "0.0.0.0:7000".parse().expect("static addr");
    let mut session_ttl: Option<i64> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--bind" => {
                i += 1;
                if let Some(addr_str) = args.get(i) {
                    match addr_str.parse() {
                        Ok(a) => bind_addr = a,
                        Err(_) => {
                            eprintln!("superfield serve: invalid bind address '{}'", addr_str);
                            process::exit(1);
                        }
                    }
                } else {
                    eprintln!("superfield serve: --bind requires an argument");
                    process::exit(1);
                }
            }
            "--session-ttl" => {
                i += 1;
                if let Some(ttl_str) = args.get(i) {
                    match ttl_str.parse::<i64>() {
                        Ok(t) => session_ttl = Some(t),
                        Err(_) => {
                            eprintln!(
                                "superfield serve: invalid --session-ttl value '{}'",
                                ttl_str
                            );
                            process::exit(1);
                        }
                    }
                } else {
                    eprintln!("superfield serve: --session-ttl requires an argument");
                    process::exit(1);
                }
            }
            other => {
                eprintln!("superfield serve: unknown flag '{}'", other);
                process::exit(1);
            }
        }
        i += 1;
    }

    // Build the shared pool from DATABASE_URL.
    let cfg = match sf_db::DbConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("superfield serve: config error: {}", e);
            process::exit(1);
        }
    };
    let pool = match sf_db::connect(&cfg).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("superfield serve: database error: {}", e);
            process::exit(1);
        }
    };

    let serve_cfg = sf_serve::ServeConfig {
        bind_addr,
        session_ttl_secs: session_ttl,
    };

    eprintln!("superfield serve: listening on {}", bind_addr);

    if let Err(e) = sf_serve::serve(pool, serve_cfg).await {
        eprintln!("superfield serve: {}", e);
        process::exit(1);
    }
}

/// Handle `superfield deploy <subcommand> ...` arguments.
///
/// Subcommands:
///   validate <config-json>  — validate a target config and print OK / error
///   ship <config-json> <artifact-path> — validate config and simulate a ship
///                                        (stub transport; no real I/O)
fn run_deploy(args: &[String]) {
    use sf_deploy::transport::StubTransport;
    use sf_deploy::{deploy, BuildArtifact, TargetConfig};
    use std::path::PathBuf;

    match args {
        // deploy validate <json>
        [sub, json] if sub == "validate" => {
            match serde_json::from_str::<TargetConfig>(json.as_str()) {
                Err(e) => {
                    eprintln!("superfield deploy validate: JSON parse error: {}", e);
                    process::exit(1);
                }
                Ok(cfg) => match cfg.validate() {
                    Ok(()) => println!("config ok: target '{}'", cfg.name),
                    Err(e) => {
                        eprintln!("superfield deploy validate: {}", e);
                        process::exit(1);
                    }
                },
            }
        }

        // deploy ship <json> <artifact-path>
        [sub, json, path] if sub == "ship" => {
            let cfg: TargetConfig = match serde_json::from_str(json.as_str()) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("superfield deploy ship: JSON parse error: {}", e);
                    process::exit(1);
                }
            };
            let artifact = BuildArtifact {
                path: PathBuf::from(path),
                name: "superfield".to_string(),
            };
            let transport = StubTransport::new();
            match deploy(&cfg, &artifact, &transport) {
                Ok(result) => println!("{}", result.summary),
                Err(e) => {
                    eprintln!("superfield deploy ship: {}", e);
                    process::exit(1);
                }
            }
        }

        _ => {
            eprintln!("{}", DEPLOY_USAGE);
            process::exit(1);
        }
    }
}
