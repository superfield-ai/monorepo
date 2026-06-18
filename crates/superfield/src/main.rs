//! Superfield single-binary entrypoint.
//!
//! All component crates (Sharp, Nexum, sf-cli, sf-serve, sf-deploy) are linked
//! into this binary.  The CLI commands (operator + agent) are dispatched here
//! via `sf_cli::parse` and `sf_cli::connect_and_run`.  The HTTP serving layer
//! is started via `sf_serve::serve` when the `serve` subcommand is given.
//!
//! # Architecture
//!
//! See `docs/architecture.md` §CLI — Command Surface and the agent-warning:
//! "The single binary entrypoint is
//! `crates/superfield/src/main.rs`".
//!
//! The pool is built once here from `DATABASE_URL` (via [`sf_db::DbConfig`]);
//! component crates receive it rather than opening their own connections.
//!
//! # Daemon auto-spawn
//!
//! When `SF_START_DAEMON=1` is set in the environment, the binary enters
//! daemon mode: it starts the serving layer (after the Postgres health gate
//! passes) and notifies the spawning CLI via the startup-notify socket
//! (`SF_STARTUP_NOTIFY`).
//!
//! `SF_NO_DAEMON=1` suppresses the daemonize() call and runs the server in
//! the calling process — used in containers and CI.
//!
//! # Subcommands
//!
//! | Subcommand       | Handler                     | Description                                   |
//! |------------------|-----------------------------|-----------------------------------------------|
//! | `serve`          | [`sf_serve::serve`]         | Start the HTTP server                         |
//! | `daemon stop`    | sf_cli daemon               | Graceful daemon shutdown                      |
//! | `status`         | sf_cli daemon               | Show daemon status (no-spawn guard)           |
//! | `logs`           | sf_cli daemon               | Show daemon log tail (no-spawn guard)         |
//! | `page`           | `sf_cli` page commands      | Print a knowledge-base page (requires daemon) |
//! | `garden`         | `sf_cli` garden commands    | Ingest seed documents into the knowledge graph|
//! | `repo`           | `sf_cli` operator commands  | Manage Sharp repos                            |
//! | `session`        | `sf_cli` operator commands  | Manage auth sessions                          |
//! | `episode`        | `sf_cli` agent commands     | Manage agent episodes                         |
//! | `deploy`         | [`sf_deploy`]               | Deploy a build to a target                    |
//! | `noop`           | (built-in)                  | Smoke-test — exits cleanly                    |

use std::process;

use sf_cli::daemon as sf_daemon;

mod boot;
mod daemon_runtime;

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
  deploy rollback <record-json>       Roll back the target to the prior version (stub)

Deploy-operator commands (backed by sf-deploy):
  deploy-env <config-json> <artifact-path>
                                      Deploy artifact to a target env
  rollback-env <record-json>          Roll back target to prior version
  doctor <config-json>                Validate target config (no I/O)

Page commands (require running daemon):
  page <name>                         Print a knowledge-base page as markdown
                                      name: prd | architecture | plan | strategy | project

Garden commands (seed document ingestion):
  garden <file1> [file2...] [--workspace-id <uuid>]
                                      Ingest markdown files into the knowledge graph
                                      workspace-id defaults to WORKSPACE_ID env var

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

  superfield deploy rollback <record-json>
      Roll back the target to its prior version using a deployment record JSON.
      The record is the serialised DeploymentRecord returned by a previous ship.

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

    // ---------------------------------------------------------------------------
    // SF_START_DAEMON dispatch
    //
    // When the CLI re-executes itself with SF_START_DAEMON=1, the binary enters
    // daemon mode.  It starts the Postgres provisioner, runs migrations, starts
    // the HTTP serving layer, and notifies the parent CLI via the startup-notify
    // socket.
    //
    // SF_NO_DAEMON=1 suppresses daemonize() — runs the server in the foreground.
    // ---------------------------------------------------------------------------
    if std::env::var("SF_START_DAEMON").as_deref() == Ok("1") {
        run_as_daemon().await;
        return;
    }

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

    // No-spawn guard: status, logs, page — exit non-zero if daemon not running.
    let subcommand = args.first().map(String::as_str).unwrap_or("");
    if sf_daemon::is_no_spawn_command(subcommand) && !sf_daemon::daemon_is_running() {
        eprintln!("superfield {}: daemon not running", subcommand);
        process::exit(1);
    }

    // `daemon stop` — send graceful shutdown RPC.
    if args.first().map(String::as_str) == Some("daemon") {
        if args.get(1).map(String::as_str) == Some("stop") {
            handle_daemon_stop();
            return;
        }
        eprintln!("superfield daemon: unknown subcommand; try 'stop'");
        process::exit(1);
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

    // Read CONTROL_ASSETS_DIR from the environment — path to pre-built browser
    // UI assets served at the root by the Rust HTTP layer.
    let assets_dir = std::env::var("CONTROL_ASSETS_DIR")
        .ok()
        .map(std::path::PathBuf::from);

    let serve_cfg = sf_serve::ServeConfig {
        bind_addr,
        session_ttl_secs: session_ttl,
        assets_dir,
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
///   rollback <record-json>  — roll back the target to the prior version
///                             using a serialised DeploymentRecord
fn run_deploy(args: &[String]) {
    use sf_deploy::transport::StubTransport;
    use sf_deploy::{deploy, rollback, BuildArtifact, DeploymentRecord, TargetConfig};
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

        // deploy rollback <record-json>
        [sub, json] if sub == "rollback" => {
            let record: DeploymentRecord = match serde_json::from_str(json.as_str()) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("superfield deploy rollback: JSON parse error: {}", e);
                    process::exit(1);
                }
            };
            let target = record.target.clone();
            let transport = StubTransport::new();
            match rollback(record, &transport) {
                Ok(result) => println!("rolled back {} → {}", target, result.restored_version),
                Err(e) => {
                    eprintln!("superfield deploy rollback: {}", e);
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

// ---------------------------------------------------------------------------
// Daemon mode — entered when SF_START_DAEMON=1
// ---------------------------------------------------------------------------

/// Run the binary in daemon mode.
///
/// Called when `SF_START_DAEMON=1` is set in the environment.  The sequence
/// implements the issue #670 health-gated boot — `provision -> wait healthy ->
/// migrate -> serve` — so the appliance stands up its own company brain on
/// first run and never serves against an empty or unmigrated database:
///
/// 1. Acquire the daemon state directory.
/// 2. **Provision + health gate + migrate** ([`boot::health_gate`]):
///    - When `DATABASE_URL` is set externally the appliance honours it and uses
///      a no-op [`sf_db::TestProvisioner`] (no local provisioning).
///    - Otherwise it provisions a local Postgres instance via
///      [`sf_db::LocalPostgresProvisioner`], waits for `pg_isready`, and migrates.
///    - A provisioning failure and a migration failure abort boot with
///      *distinct*, actionable errors; the HTTP server never binds.
/// 3. Write `daemon.json`.
/// 4. Send `StartupResult::Ok` over the startup-notify socket.
/// 5. Start the HTTP serving layer (only now is the brain ready for traffic).
///
/// If any health-gate step fails, send `StartupResult::Err` and exit non-zero
/// without binding the server.
///
/// `SF_NO_DAEMON=1` skips the daemonize() call (runs in-process / foreground).
///
/// # Boot-sequence seam map (dev-scout #676)
///
/// The canonical provision → migrate → serve → loop-start → supervisor ordering
/// and the exact integration points for #670 (provisioner + migration runner)
/// and #671 (loop-start, handle install, supervisor selection) are written down
/// and compile-checked in [`crate::boot`]. Graduating those features must
/// preserve that ordering; the loop handle is installed in `AppState` via
/// [`sf_serve::AppState::with_loop_handle`].
async fn run_as_daemon() {
    use sf_cli::daemon::{
        daemon_log_path, daemon_state_dir, remove_daemon_json, send_startup_result, socket_path,
        write_daemon_json, DaemonJson, StartupResult,
    };
    use sf_db::{LocalPostgresProvisioner, PostgresProvisioner, TestProvisioner};
    use std::time::{SystemTime, UNIX_EPOCH};

    let state_dir = match daemon_state_dir() {
        Ok(d) => d,
        Err(e) => {
            let reason = format!("cannot create daemon state dir: {}", e);
            eprintln!("superfield daemon: {}", reason);
            // Best-effort notification.
            let _ = send_startup_result(&StartupResult::Err {
                reason,
                log_path: String::new(),
            });
            process::exit(1);
        }
    };

    let log_path = daemon_log_path(&state_dir).to_string_lossy().into_owned();

    // Macro to send Err and exit.
    macro_rules! fail {
        ($reason:expr) => {{
            let reason = $reason.to_string();
            eprintln!("superfield daemon startup failed: {}", reason);
            let _ = send_startup_result(&StartupResult::Err {
                reason,
                log_path: log_path.clone(),
            });
            remove_daemon_json(&state_dir);
            process::exit(1);
        }};
    }

    // Decide provisioner from DATABASE_URL: an externally-supplied URL skips
    // local provisioning (use the no-op TestProvisioner); otherwise stand up a
    // local Postgres instance under the daemon state dir.
    let external_url = std::env::var("DATABASE_URL").ok().filter(|u| !u.is_empty());
    let data_dir = state_dir.join("postgres");
    let local_provisioner;
    let test_provisioner;
    let provisioner: &dyn PostgresProvisioner = if external_url.is_some() {
        test_provisioner = TestProvisioner;
        &test_provisioner
    } else {
        local_provisioner = LocalPostgresProvisioner::new(&data_dir);
        &local_provisioner
    };

    // Run the health gate: provision -> wait healthy -> migrate. Provisioning
    // and migration failures are surfaced as distinct, actionable errors and
    // the server is NOT bound on any failure.
    let repo_root = sf_db::repo_root();
    let ready = match boot::health_gate(provisioner, external_url, &repo_root).await {
        Ok(r) => r,
        Err(e @ boot::BootError::Provision(_)) => {
            // Best-effort cleanup of a partially-started instance.
            let _ = provisioner.stop().await;
            fail!(format!("postgres provisioner error: {e}"));
        }
        Err(e @ boot::BootError::Migrate(_)) => {
            let _ = provisioner.stop().await;
            fail!(format!("schema migration error: {e}"));
        }
        Err(e) => {
            let _ = provisioner.stop().await;
            fail!(format!("daemon boot error: {e}"));
        }
    };

    let bind_addr: std::net::SocketAddr = "0.0.0.0:7000".parse().expect("static addr");
    let sock = socket_path(&state_dir).to_string_lossy().into_owned();

    // Write daemon.json before starting the server.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let info = DaemonJson {
        pid: std::process::id(),
        version: sf_cli::daemon::current_version().to_string(),
        started_at: now,
        socket_path: sock.clone(),
    };
    if let Err(e) = write_daemon_json(&state_dir, &info) {
        let _ = provisioner.stop().await;
        fail!(format!("cannot write daemon.json: {}", e));
    }

    // Send startup Ok — health gate passed (provisioned, healthy, migrated).
    if let Err(e) = send_startup_result(&StartupResult::Ok {
        version: info.version.clone(),
        addr: sock,
    }) {
        // Startup-notify socket may not be set in some modes (e.g. direct
        // `superfield serve` call).  Log but do not fail.
        eprintln!("superfield daemon: startup notify skipped: {}", e);
    }

    eprintln!(
        "superfield daemon: brain ready on {} (serving)",
        ready.database_url
    );

    // Start the HTTP serving layer against the migrated pool, plus the
    // autonomous gardening loop and the appliance workload supervisor.
    //
    // In SF_NO_DAEMON=1 mode this runs in the foreground.  In normal daemon
    // mode the process has already been detached by the parent's spawn call.
    //
    // On SIGTERM the server stops gracefully, then `daemon_runtime::shutdown`
    // drains the loop, takes the appliance down, and stops the provisioner — in
    // that strict order (loop drains against the still-live, migrated DB so its
    // cursor commits before Postgres goes down).
    let pool = ready.pool;

    // Start the appliance workload supervisor (app + Postgres). A failure here
    // must not abort the daemon — the HTTP layer and loop can still run — so
    // log and fall through with the no-op supervisor.
    let app_image = std::env::var("SF_APP_IMAGE").unwrap_or_default();
    let pg_image = std::env::var("SF_POSTGRES_IMAGE").unwrap_or_default();
    let manifest = daemon_runtime::appliance_manifest(&app_image, &pg_image);
    let supervisor: Box<dyn fastenv::deployment::ManifestSupervisor> =
        match daemon_runtime::boot_supervisor(&manifest) {
            Ok(s) => Box::new(s),
            Err(e) => {
                eprintln!(
                    "superfield daemon: appliance supervisor failed to start: {}",
                    e
                );
                Box::new(fastenv::deployment::NoopSupervisor)
            }
        };

    // Start the gardening loop and install the REAL loop handle, retiring
    // NoopLoopHandle on the running path.  The loop resumes from its persisted
    // cursor on its first pass.
    let loop_config = sf_loop::LoopConfig::from_env();
    let executor = daemon_runtime::build_executor(&loop_config);
    let loop_handle = daemon_runtime::boot_loop(pool.clone(), loop_config, executor);

    let assets_dir = std::env::var("CONTROL_ASSETS_DIR")
        .ok()
        .map(std::path::PathBuf::from);
    let serve_cfg = sf_serve::ServeConfig {
        bind_addr,
        session_ttl_secs: None,
        assets_dir,
    };

    // Serve until SIGTERM (or SIGINT) requests a graceful shutdown.
    if let Err(e) = sf_serve::serve_with_shutdown(pool, serve_cfg, shutdown_signal()).await {
        eprintln!("superfield daemon: serve error: {}", e);
    }

    // Ordered teardown: drain loop → appliance down → provisioner stop.
    daemon_runtime::shutdown(loop_handle.as_ref(), supervisor.as_ref(), provisioner).await;

    remove_daemon_json(&state_dir);
}

/// Future that resolves when the daemon receives `SIGTERM` or `SIGINT`.
///
/// `daemon stop` delivers `SIGTERM`; an interactive Ctrl-C in foreground mode
/// (`SF_NO_DAEMON=1`) delivers `SIGINT`. Either triggers the graceful shutdown
/// path so the server drains, then the loop/appliance/provisioner stop in order.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("superfield daemon: cannot install SIGTERM handler: {}", e);
                // Fall back to never resolving so the server keeps running.
                std::future::pending::<()>().await;
                return;
            }
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("superfield daemon: cannot install SIGINT handler: {}", e);
                std::future::pending::<()>().await;
                return;
            }
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

// ---------------------------------------------------------------------------
// `daemon stop` — graceful shutdown RPC
// ---------------------------------------------------------------------------

/// Handle `superfield daemon stop`.
///
/// Sends `SIGTERM` to the daemon process (identified via `daemon.json`) and
/// waits for `daemon.json` to be removed (indicating the daemon has exited).
fn handle_daemon_stop() {
    use sf_cli::daemon::{daemon_json_path, daemon_state_dir, read_daemon_json};
    use std::time::Duration;

    let state_dir = match daemon_state_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("superfield daemon stop: {}", e);
            process::exit(1);
        }
    };

    let info = match read_daemon_json(&state_dir) {
        Some(i) => i,
        None => {
            eprintln!("superfield daemon stop: daemon not running");
            process::exit(1);
        }
    };

    // Send SIGTERM to the daemon.
    #[cfg(unix)]
    {
        let ret = unsafe { libc::kill(info.pid as libc::pid_t, libc::SIGTERM) };
        if ret != 0 {
            let err = std::io::Error::last_os_error();
            eprintln!("superfield daemon stop: kill failed: {}", err);
            process::exit(1);
        }
    }

    // Wait for daemon.json to disappear (max 30 s).
    let djson = daemon_json_path(&state_dir);
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        if !djson.exists() {
            eprintln!("superfield daemon stop: daemon exited cleanly");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    eprintln!("superfield daemon stop: timed out waiting for daemon to exit");
    process::exit(1);
}
