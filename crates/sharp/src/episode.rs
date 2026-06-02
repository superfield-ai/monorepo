//! Sharp agent-episode operations — open, append, finish, and query.
//!
//! An episode represents one agent editing session against a Sharp repo.
//! Episodes live in the `sharp` schema alongside the VCS core tables.
//!
//! See `docs/architecture.md` §Schema namespace assignment and agent-warning:
//!   "Sharp's episode schema goes in the `sharp` schema on the shared instance."

use crate::error::SharpError;
use chrono::{DateTime, Utc};
use serde_json::Value as Json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// An episode record from `sharp.episodes`.
#[derive(Debug, Clone)]
pub struct Episode {
    pub id: Uuid,
    pub repo_id: Uuid,
    pub title: String,
    pub state: String,
    pub opened_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub metadata: Json,
}

/// An episode event record from `sharp.episode_events`.
#[derive(Debug, Clone)]
pub struct EpisodeEvent {
    pub id: Uuid,
    pub episode_id: Uuid,
    pub seq: i64,
    pub event_type: String,
    pub payload: Json,
    pub recorded_at: DateTime<Utc>,
}

/// Map a sqlx Row to an [`Episode`].
fn row_to_episode(r: &sqlx::postgres::PgRow) -> Result<Episode, sqlx::Error> {
    Ok(Episode {
        id: r.try_get("id")?,
        repo_id: r.try_get("repo_id")?,
        title: r.try_get("title")?,
        state: r.try_get("state")?,
        opened_at: r.try_get("opened_at")?,
        finished_at: r.try_get("finished_at")?,
        metadata: r.try_get("metadata")?,
    })
}

/// Map a sqlx Row to an [`EpisodeEvent`].
fn row_to_event(r: &sqlx::postgres::PgRow) -> Result<EpisodeEvent, sqlx::Error> {
    Ok(EpisodeEvent {
        id: r.try_get("id")?,
        episode_id: r.try_get("episode_id")?,
        seq: r.try_get("seq")?,
        event_type: r.try_get("event_type")?,
        payload: r.try_get("payload")?,
        recorded_at: r.try_get("recorded_at")?,
    })
}

/// Open a new episode against `repo_id` with the given `title`.
///
/// Returns the newly created [`Episode`].
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn open(pool: &PgPool, repo_id: Uuid, title: &str) -> Result<Episode, SharpError> {
    let row = sqlx::query(
        r#"
        INSERT INTO sharp.episodes (repo_id, title)
        VALUES ($1, $2)
        RETURNING id, repo_id, title, state, opened_at, finished_at, metadata
        "#,
    )
    .bind(repo_id)
    .bind(title)
    .fetch_one(pool)
    .await?;

    Ok(row_to_episode(&row)?)
}

/// Append an event to an open episode.
///
/// The sequence number is assigned atomically by querying `MAX(seq)` for the
/// episode.
///
/// # Errors
///
/// Returns [`SharpError::EpisodeNotOpen`] when the episode is not in the
/// `'open'` state.  Returns [`SharpError::Db`] on any other database error.
pub async fn append(
    pool: &PgPool,
    episode_id: Uuid,
    event_type: &str,
    payload: Json,
) -> Result<EpisodeEvent, SharpError> {
    // Guard: episode must be open.
    let episode = find(pool, episode_id).await?;
    if episode.state != "open" {
        return Err(SharpError::EpisodeNotOpen(episode_id, episode.state));
    }

    // Determine the next seq.
    let seq_row = sqlx::query(
        "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM sharp.episode_events WHERE episode_id = $1",
    )
    .bind(episode_id)
    .fetch_one(pool)
    .await?;
    let seq: i64 = seq_row.try_get("next_seq")?;

    let row = sqlx::query(
        r#"
        INSERT INTO sharp.episode_events (episode_id, seq, event_type, payload)
        VALUES ($1, $2, $3, $4)
        RETURNING id, episode_id, seq, event_type, payload, recorded_at
        "#,
    )
    .bind(episode_id)
    .bind(seq)
    .bind(event_type)
    .bind(&payload)
    .fetch_one(pool)
    .await?;

    Ok(row_to_event(&row)?)
}

/// Mark an episode as finished.
///
/// # Errors
///
/// Returns [`SharpError::EpisodeNotOpen`] when the episode is not open.
pub async fn finish(pool: &PgPool, episode_id: Uuid) -> Result<Episode, SharpError> {
    let row = sqlx::query(
        r#"
        UPDATE sharp.episodes
        SET state = 'finished', finished_at = now()
        WHERE id = $1 AND state = 'open'
        RETURNING id, repo_id, title, state, opened_at, finished_at, metadata
        "#,
    )
    .bind(episode_id)
    .fetch_optional(pool)
    .await?;

    match row {
        Some(r) => Ok(row_to_episode(&r)?),
        None => {
            // Either not found or already not open — distinguish:
            let ep = find(pool, episode_id).await?;
            Err(SharpError::EpisodeNotOpen(episode_id, ep.state))
        }
    }
}

/// Look up a single episode by id.
///
/// # Errors
///
/// Returns [`SharpError::EpisodeNotFound`] when no episode with that id exists.
pub async fn find(pool: &PgPool, episode_id: Uuid) -> Result<Episode, SharpError> {
    let row = sqlx::query(
        r#"
        SELECT id, repo_id, title, state, opened_at, finished_at, metadata
        FROM   sharp.episodes
        WHERE  id = $1
        "#,
    )
    .bind(episode_id)
    .fetch_optional(pool)
    .await?
    .ok_or(SharpError::EpisodeNotFound(episode_id))?;

    Ok(row_to_episode(&row)?)
}

/// Return all events for an episode in order.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn events(pool: &PgPool, episode_id: Uuid) -> Result<Vec<EpisodeEvent>, SharpError> {
    let rows = sqlx::query(
        r#"
        SELECT id, episode_id, seq, event_type, payload, recorded_at
        FROM   sharp.episode_events
        WHERE  episode_id = $1
        ORDER  BY seq ASC
        "#,
    )
    .bind(episode_id)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(row_to_event)
        .collect::<Result<Vec<_>, _>>()
        .map_err(SharpError::Db)
}

/// Return all open episodes for a repo.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn list_open(pool: &PgPool, repo_id: Uuid) -> Result<Vec<Episode>, SharpError> {
    let rows = sqlx::query(
        r#"
        SELECT id, repo_id, title, state, opened_at, finished_at, metadata
        FROM   sharp.episodes
        WHERE  repo_id = $1 AND state = 'open'
        ORDER  BY opened_at DESC
        "#,
    )
    .bind(repo_id)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(row_to_episode)
        .collect::<Result<Vec<_>, _>>()
        .map_err(SharpError::Db)
}

/// Return all episodes for a repo (any state), most recently opened first.
///
/// Used by `sf-cli`'s `episode list` command.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn list_for_repo(pool: &PgPool, repo_id: Uuid) -> Result<Vec<Episode>, SharpError> {
    let rows = sqlx::query(
        r#"
        SELECT id, repo_id, title, state, opened_at, finished_at, metadata
        FROM   sharp.episodes
        WHERE  repo_id = $1
        ORDER  BY opened_at DESC
        "#,
    )
    .bind(repo_id)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(row_to_episode)
        .collect::<Result<Vec<_>, _>>()
        .map_err(SharpError::Db)
}
