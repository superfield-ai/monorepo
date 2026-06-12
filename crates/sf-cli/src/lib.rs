//! Superfield CLI — operator and agent commands.
//!
//! This crate exposes the core CLI commands for both operators (humans managing
//! the shared store) and agents (automated sessions writing episodes into Sharp).
//! All commands talk to the shared Postgres instance through the `sf-db` pool
//! and the `sf-auth` and `sharp` crates.
//!
//! # Command groups
//!
//! - **[`operator`]** — repo management (`repo init`, `repo list`) and session
//!   management (`session issue`).  Operator commands set up the workspace
//!   entities that agents operate against.
//! - **[`agent`]** — agent-episode lifecycle (`episode open`, `episode append`,
//!   `episode finish`, `episode list`).  Agent commands record the full history
//!   of an agent editing session in Sharp's episode schema.
//! - **[`deploy_ops`]** — deploy-operator commands (`deploy-env`, `rollback-env`,
//!   `doctor`).  These are backed by [`sf_deploy`] without requiring any
//!   TypeScript/Node runtime, GCP SDK, or GitHub client.
//! - **[`page`]** — knowledge-base page commands (`page <name>`).  Projects
//!   over the Nexum graph to render named pages as markdown.  Includes the
//!   no-spawn daemon guard (issue #492).
//!
//! # Architecture
//!
//! See `docs/architecture.md` §5 (CLI, deploy tooling, and serving backend in
//! Rust) and the agent-warning: "the CLI wraps sf-db, sf-auth, and Sharp".
//!
//! The binary entrypoint (`crates/superfield/src/main.rs`) builds the shared
//! `PgPool` once, then dispatches the parsed [`Cmd`] here via [`run`].

pub mod agent;
pub mod deploy_ops;
pub mod error;
pub mod operator;
pub mod page;

use sf_db::DbConfig;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

/// Top-level CLI error.
#[derive(Debug, Error)]
pub enum CliError {
    /// A database configuration error (e.g. missing `DATABASE_URL`).
    #[error("config error: {0}")]
    Config(#[from] sf_db::config::ConfigError),

    /// A database pool error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    /// An operator-command error.
    #[error("operator error: {0}")]
    Operator(#[from] operator::OperatorError),

    /// An agent-command error.
    #[error("agent error: {0}")]
    Agent(#[from] agent::AgentError),

    /// A deploy-operator command error.
    #[error("deploy-ops error: {0}")]
    DeployOps(#[from] deploy_ops::DeployOpsError),

    /// A page-command error (unknown page, daemon not running, etc.).
    #[error("page error: {0}")]
    Page(#[from] page::PageError),

    /// A UUID parse error.
    #[error("invalid UUID: {0}")]
    Uuid(#[from] uuid::Error),

    /// JSON parse / serialise error.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// An unrecognised command or bad arguments.
    #[error("{0}")]
    Usage(String),
}

/// All commands the CLI understands.
///
/// Parse the process arguments and build a [`Cmd`] to pass to [`run`].
#[derive(Debug)]
pub enum Cmd {
    // --- Operator commands ---
    /// Create or get a Sharp repo by name.
    RepoInit { name: String },
    /// List all Sharp repos.
    RepoList,
    /// Issue a session token for a workspace/user/role triple.
    SessionIssue {
        workspace_id: Uuid,
        user_id: Uuid,
        role: sf_auth::Role,
    },

    // --- Agent commands ---
    /// Open a new agent episode against a repo.
    EpisodeOpen { repo_id: Uuid, title: String },
    /// Append an event to an existing episode.
    EpisodeAppend {
        episode_id: Uuid,
        event_type: String,
        payload: serde_json::Value,
    },
    /// Finish (close) an episode.
    EpisodeFinish { episode_id: Uuid },
    /// List episodes for a repo.
    EpisodeList { repo_id: Uuid },

    // --- Deploy-operator commands ---
    /// Deploy an artifact to a target environment (backed by sf-deploy).
    ///
    /// Equivalent to the TypeScript `deploy-env` command.  Args are a target
    /// config JSON and the path to the artifact.
    DeployEnv {
        config_json: String,
        artifact_path: String,
    },
    /// Roll back a target to its prior version (backed by sf-deploy).
    ///
    /// Equivalent to the TypeScript `rollback-env` command.  The arg is a
    /// serialised [`sf_deploy::DeploymentRecord`] JSON produced by a previous
    /// `deploy-env` call.
    RollbackEnv { record_json: String },
    /// Run preflight validation on a target config (backed by sf-deploy).
    ///
    /// Equivalent to the TypeScript `doctor` command's config-validation pass.
    /// Does not perform any network I/O.
    Doctor { config_json: String },

    // --- Page commands ---
    /// Print a named knowledge-base page as markdown.
    ///
    /// Exits non-zero if the daemon is not running or the name is unknown.
    /// Recognised names: `prd`, `architecture`, `plan`, `strategy`, `project`.
    Page { name: String },
}

/// Parse `args` (the slice after the binary name) into a [`Cmd`].
///
/// Returns a [`CliError::Usage`] with a help string if the arguments are
/// unrecognised or malformed.
pub fn parse(args: &[String]) -> Result<Cmd, CliError> {
    match args {
        // repo init <name>
        [a, b, name] if a == "repo" && b == "init" => Ok(Cmd::RepoInit { name: name.clone() }),

        // repo list
        [a, b] if a == "repo" && b == "list" => Ok(Cmd::RepoList),

        // session issue <workspace-id> <user-id> <role>
        [a, b, ws, uid, role_str] if a == "session" && b == "issue" => {
            let workspace_id = ws.parse::<Uuid>()?;
            let user_id = uid.parse::<Uuid>()?;
            let role = match role_str.as_str() {
                "admin" => sf_auth::Role::Admin,
                "member" => sf_auth::Role::Member,
                "viewer" => sf_auth::Role::Viewer,
                other => {
                    return Err(CliError::Usage(format!(
                        "unknown role '{}'; expected admin|member|viewer",
                        other
                    )))
                }
            };
            Ok(Cmd::SessionIssue {
                workspace_id,
                user_id,
                role,
            })
        }

        // episode open <repo-id> <title>
        [a, b, repo, title] if a == "episode" && b == "open" => Ok(Cmd::EpisodeOpen {
            repo_id: repo.parse::<Uuid>()?,
            title: title.clone(),
        }),

        // episode append <episode-id> <event-type> <payload-json>
        [a, b, eid, ev_type, payload_json] if a == "episode" && b == "append" => {
            Ok(Cmd::EpisodeAppend {
                episode_id: eid.parse::<Uuid>()?,
                event_type: ev_type.clone(),
                payload: serde_json::from_str(payload_json)?,
            })
        }

        // episode finish <episode-id>
        [a, b, eid] if a == "episode" && b == "finish" => Ok(Cmd::EpisodeFinish {
            episode_id: eid.parse::<Uuid>()?,
        }),

        // episode list <repo-id>
        [a, b, repo] if a == "episode" && b == "list" => Ok(Cmd::EpisodeList {
            repo_id: repo.parse::<Uuid>()?,
        }),

        // deploy-env <config-json> <artifact-path>
        [a, config_json, artifact_path] if a == "deploy-env" => Ok(Cmd::DeployEnv {
            config_json: config_json.clone(),
            artifact_path: artifact_path.clone(),
        }),

        // rollback-env <record-json>
        [a, record_json] if a == "rollback-env" => Ok(Cmd::RollbackEnv {
            record_json: record_json.clone(),
        }),

        // doctor <config-json>
        [a, config_json] if a == "doctor" => Ok(Cmd::Doctor {
            config_json: config_json.clone(),
        }),

        // page <name>
        [a, name] if a == "page" => Ok(Cmd::Page { name: name.clone() }),

        _ => Err(CliError::Usage(USAGE.to_string())),
    }
}

/// Run a parsed [`Cmd`] against the shared pool.
///
/// Builds (or accepts) a [`PgPool`] and delegates to the appropriate operator
/// or agent handler.  All output is written to stdout as line-delimited text.
pub async fn run(pool: &PgPool, cmd: Cmd) -> Result<(), CliError> {
    match cmd {
        Cmd::RepoInit { name } => operator::repo_init(pool, &name).await?,
        Cmd::RepoList => operator::repo_list(pool).await?,
        Cmd::SessionIssue {
            workspace_id,
            user_id,
            role,
        } => operator::session_issue(pool, workspace_id, user_id, role).await?,
        Cmd::EpisodeOpen { repo_id, title } => agent::episode_open(pool, repo_id, &title).await?,
        Cmd::EpisodeAppend {
            episode_id,
            event_type,
            payload,
        } => agent::episode_append(pool, episode_id, &event_type, payload).await?,
        Cmd::EpisodeFinish { episode_id } => agent::episode_finish(pool, episode_id).await?,
        Cmd::EpisodeList { repo_id } => agent::episode_list(pool, repo_id).await?,

        // Deploy-operator commands are synchronous; the pool is not used but
        // the signature stays uniform so `run` remains the single dispatch point.
        Cmd::DeployEnv {
            config_json,
            artifact_path,
        } => deploy_ops::deploy_env(&config_json, &artifact_path)?,
        Cmd::RollbackEnv { record_json } => deploy_ops::rollback_env(&record_json)?,
        Cmd::Doctor { config_json } => deploy_ops::doctor(&config_json)?,

        // Page commands.
        Cmd::Page { name } => page::page_show(pool, &name).await?,
    }
    Ok(())
}

/// Connect to Postgres using environment config and run `cmd`.
///
/// Convenience wrapper used by the binary entrypoint when no pool has been
/// constructed yet.
pub async fn connect_and_run(cmd: Cmd) -> Result<(), CliError> {
    let cfg = DbConfig::from_env()?;
    let pool = sf_db::connect(&cfg).await?;
    run(&pool, cmd).await
}

/// CLI usage string printed on unrecognised commands.
pub const USAGE: &str = "\
superfield — Rust CLI over the shared store

Operator commands:
  repo init <name>                    Create or get a Sharp repo
  repo list                           List all repos
  session issue <ws-id> <uid> <role>  Issue a session token
                                      role: admin|member|viewer

Agent commands:
  episode open <repo-id> <title>      Open a new episode
  episode append <ep-id> <type> <json>  Append an event to an episode
  episode finish <ep-id>              Finish an episode
  episode list <repo-id>              List episodes for a repo

Deploy-operator commands (backed by sf-deploy):
  deploy-env <config-json> <artifact-path>
                                      Deploy artifact to a target env
  rollback-env <record-json>          Roll back target to prior version
  doctor <config-json>                Validate target config (no I/O)

Page commands (require running daemon):
  page <name>                         Print a knowledge-base page as markdown
                                      name: prd | architecture | plan | strategy | project
";

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|&x| x.to_string()).collect()
    }

    // --- parse: operator commands ---

    #[test]
    fn parse_repo_init() {
        let cmd = parse(&args(&["repo", "init", "my-repo"])).unwrap();
        assert!(matches!(cmd, Cmd::RepoInit { name } if name == "my-repo"));
    }

    #[test]
    fn parse_repo_list() {
        let cmd = parse(&args(&["repo", "list"])).unwrap();
        assert!(matches!(cmd, Cmd::RepoList));
    }

    #[test]
    fn parse_session_issue_admin() {
        let ws = "00000000-0000-0000-0000-000000000001";
        let uid = "00000000-0000-0000-0000-000000000002";
        let cmd = parse(&args(&["session", "issue", ws, uid, "admin"])).unwrap();
        match cmd {
            Cmd::SessionIssue {
                workspace_id,
                user_id,
                role,
            } => {
                assert_eq!(workspace_id.to_string(), ws);
                assert_eq!(user_id.to_string(), uid);
                assert_eq!(role, sf_auth::Role::Admin);
            }
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn parse_session_issue_unknown_role() {
        let ws = "00000000-0000-0000-0000-000000000001";
        let uid = "00000000-0000-0000-0000-000000000002";
        let err = parse(&args(&["session", "issue", ws, uid, "superuser"])).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    // --- parse: agent commands ---

    #[test]
    fn parse_episode_open() {
        let repo = "00000000-0000-0000-0000-000000000003";
        let cmd = parse(&args(&["episode", "open", repo, "my-episode"])).unwrap();
        assert!(matches!(cmd, Cmd::EpisodeOpen { title, .. } if title == "my-episode"));
    }

    #[test]
    fn parse_episode_append() {
        let eid = "00000000-0000-0000-0000-000000000004";
        let payload = r#"{"tool":"read_file"}"#;
        let cmd = parse(&args(&["episode", "append", eid, "tool_call", payload])).unwrap();
        match cmd {
            Cmd::EpisodeAppend {
                event_type,
                payload,
                ..
            } => {
                assert_eq!(event_type, "tool_call");
                assert_eq!(payload["tool"], "read_file");
            }
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn parse_episode_append_invalid_json() {
        let eid = "00000000-0000-0000-0000-000000000004";
        let err = parse(&args(&["episode", "append", eid, "tool_call", "not-json"])).unwrap_err();
        assert!(matches!(err, CliError::Json(_)));
    }

    #[test]
    fn parse_episode_finish() {
        let eid = "00000000-0000-0000-0000-000000000005";
        let cmd = parse(&args(&["episode", "finish", eid])).unwrap();
        assert!(matches!(cmd, Cmd::EpisodeFinish { episode_id } if episode_id.to_string() == eid));
    }

    #[test]
    fn parse_episode_list() {
        let repo = "00000000-0000-0000-0000-000000000006";
        let cmd = parse(&args(&["episode", "list", repo])).unwrap();
        assert!(matches!(cmd, Cmd::EpisodeList { repo_id } if repo_id.to_string() == repo));
    }

    #[test]
    fn parse_unknown_command_returns_usage() {
        let err = parse(&args(&["deploy", "everything"])).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn parse_empty_returns_usage() {
        let err = parse(&[]).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }
}
