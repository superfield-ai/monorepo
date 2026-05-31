//! Agent CLI commands.
//!
//! Agent commands manage the lifecycle of Sharp *episodes* — the recorded
//! history of an agent editing session.  Each episode belongs to a Sharp repo
//! and carries a sequence of typed events (tool calls, patches, validation
//! outcomes, judge results).
//!
//! Commands:
//! - **`episode open`** — open a new episode against a repo.
//! - **`episode append`** — append a typed event to an episode.
//! - **`episode finish`** — close an episode.
//! - **`episode list`** — list episodes for a repo.
//!
//! All output is written to stdout as line-delimited text.
//!
//! # Architecture
//!
//! Episodes are the observability primitive for the self-improving loop
//! (PRD §5 "Deploying and learning"; architecture §2 Observability row).  See
//! `docs/architecture.md` §sharp schema for the episode table layout.

use sharp::episode;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

/// Errors from agent commands.
#[derive(Debug, Error)]
pub enum AgentError {
    /// A Sharp error (repo not found, episode not found, DB error, etc.).
    #[error("sharp error: {0}")]
    Sharp(#[from] sharp::SharpError),

    /// A raw database error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// Open a new episode against `repo_id` with the given `title`.
///
/// Delegates to [`sharp::episode::open`].
///
/// # Output
///
/// Prints the new episode ID (UUID) to stdout.
pub async fn episode_open(pool: &PgPool, repo_id: Uuid, title: &str) -> Result<(), AgentError> {
    let ep = episode::open(pool, repo_id, title).await?;
    println!("{}", ep.id);
    Ok(())
}

/// Append a typed event to an existing episode.
///
/// Delegates to [`sharp::episode::append`].
///
/// # Output
///
/// Prints the new event ID (UUID) and its sequence number to stdout.
pub async fn episode_append(
    pool: &PgPool,
    episode_id: Uuid,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<(), AgentError> {
    let ev = episode::append(pool, episode_id, event_type, payload).await?;
    println!("{}  seq={}", ev.id, ev.seq);
    Ok(())
}

/// Finish (close) an episode.
///
/// Delegates to [`sharp::episode::finish`].
///
/// # Output
///
/// Prints `finished <episode-id>` to stdout.
pub async fn episode_finish(pool: &PgPool, episode_id: Uuid) -> Result<(), AgentError> {
    episode::finish(pool, episode_id).await?;
    println!("finished {}", episode_id);
    Ok(())
}

/// List episodes for a repo, most recently opened first.
///
/// Delegates to [`sharp::episode::list_for_repo`].
///
/// # Output
///
/// Prints one `episode.id  state  title` line per episode to stdout.
pub async fn episode_list(pool: &PgPool, repo_id: Uuid) -> Result<(), AgentError> {
    let episodes = episode::list_for_repo(pool, repo_id).await?;
    if episodes.is_empty() {
        println!("(no episodes)");
    } else {
        for ep in &episodes {
            println!("{}  {}  {}", ep.id, ep.state, ep.title);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Integration tests that require a live Postgres instance are gated behind
    // `DATABASE_URL` so they are skipped in offline CI.
    //
    // Run them with:
    //   DATABASE_URL=postgres://… cargo test -p sf-cli -- --include-ignored integration

    /// A representative agent command sequence: open → append → finish.
    ///
    /// This test documents the happy path; it requires a live Postgres
    /// instance with the Sharp schema migrated.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and sharp migrations"]
    async fn episode_lifecycle_open_append_finish() {
        use sf_db::{connect, DbConfig};

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");

        // Create a test repo to hang episodes off.
        let repo = sharp::repo::init(&pool, "cli-agent-test-repo")
            .await
            .expect("repo init failed");

        // Open an episode.
        let ep = sharp::episode::open(&pool, repo.id, "test-episode")
            .await
            .expect("episode open failed");
        assert_eq!(ep.state, "open");

        // Append an event.
        let ev = sharp::episode::append(
            &pool,
            ep.id,
            "tool_call",
            serde_json::json!({"tool": "read_file", "path": "src/main.rs"}),
        )
        .await
        .expect("episode append failed");
        assert_eq!(ev.seq, 1);

        // Finish the episode.
        let finished = sharp::episode::finish(&pool, ep.id)
            .await
            .expect("episode finish failed");
        assert_eq!(finished.state, "finished");

        // List should include the finished episode.
        let list = sharp::episode::list_for_repo(&pool, repo.id)
            .await
            .expect("episode list failed");
        assert!(list.iter().any(|e| e.id == ep.id && e.state == "finished"));
    }
}
