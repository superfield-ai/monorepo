//! Sharp agent-episode operations — open, append, finish, and query.
//!
//! An episode represents one agent editing session against a Sharp repo.
//! Episodes live in the `sharp` schema alongside the VCS core tables.
//!
//! Canonical doc: `crates/sharp/docs/episodes.md`.
//!
//! See `docs/architecture.md §Single-Instance Database Schema Layout § Schema namespace assignment` and agent-warning:
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

// ─────────────────────────────────────────────────────────────────────────────
// Complete episode model (rust-reorg decision #4, ADDITIVE).
//
// Ported from sharp/apps/server/src/episodes.ts.  This is the typed-artifact +
// provenance model that coexists with the generic open/append/finish/list
// surface above (which sf-cli and superfield depend on).  See migration 0006.
// ─────────────────────────────────────────────────────────────────────────────

use crate::object::{self, ObjectType};

/// The kind of a typed episode artifact (`sharp.episode_typed_artifacts.kind`).
///
/// Mirrors the TS `ArtifactKind` union in `episodes.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactKind {
    Prompt,
    Context,
    ToolCall,
    ToolResult,
    IntermediatePatch,
    Validation,
    Judge,
}

impl ArtifactKind {
    /// The wire/SQL string for this kind.
    pub fn as_str(&self) -> &'static str {
        match self {
            ArtifactKind::Prompt => "prompt",
            ArtifactKind::Context => "context",
            ArtifactKind::ToolCall => "tool_call",
            ArtifactKind::ToolResult => "tool_result",
            ArtifactKind::IntermediatePatch => "intermediate_patch",
            ArtifactKind::Validation => "validation",
            ArtifactKind::Judge => "judge",
        }
    }

    /// Parse a SQL/wire string into an [`ArtifactKind`].
    ///
    /// # Errors
    ///
    /// Returns [`SharpError::InvalidArtifact`] for an unknown kind string.
    pub fn parse(s: &str) -> Result<Self, SharpError> {
        Ok(match s {
            "prompt" => ArtifactKind::Prompt,
            "context" => ArtifactKind::Context,
            "tool_call" => ArtifactKind::ToolCall,
            "tool_result" => ArtifactKind::ToolResult,
            "intermediate_patch" => ArtifactKind::IntermediatePatch,
            "validation" => ArtifactKind::Validation,
            "judge" => ArtifactKind::Judge,
            other => {
                return Err(SharpError::InvalidArtifact(format!(
                    "unknown artifact kind: {other}"
                )))
            }
        })
    }
}

/// The lifecycle status of a complete-model episode
/// (`sharp.episodes.status`).  Distinct from the generic `state` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpisodeStatus {
    Started,
    Completed,
    Failed,
    Abandoned,
}

impl EpisodeStatus {
    /// The SQL string for this status.
    pub fn as_str(&self) -> &'static str {
        match self {
            EpisodeStatus::Started => "started",
            EpisodeStatus::Completed => "completed",
            EpisodeStatus::Failed => "failed",
            EpisodeStatus::Abandoned => "abandoned",
        }
    }
}

/// A relation between two complete-model episodes
/// (`sharp.episode_relations.relation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRelation {
    Sibling,
    RetryOf,
    ReplayOf,
    SupersededBy,
}

impl LinkRelation {
    /// The SQL string for this relation.
    pub fn as_str(&self) -> &'static str {
        match self {
            LinkRelation::Sibling => "sibling",
            LinkRelation::RetryOf => "retry_of",
            LinkRelation::ReplayOf => "replay_of",
            LinkRelation::SupersededBy => "superseded_by",
        }
    }
}

/// Provenance for opening a complete-model episode.
///
/// Mirrors the TS `OpenEpisodeInput`.
#[derive(Debug, Clone)]
pub struct OpenEpisodeInput {
    pub repo_id: Uuid,
    pub title: String,
    /// Hex sha of the parent commit.
    pub parent_commit: String,
    pub agent_identity: String,
    pub model_id: String,
    pub harness_version: String,
    pub tool_versions: Json,
    pub decoding_params: Json,
}

/// A typed artifact row from `sharp.episode_typed_artifacts`.
#[derive(Debug, Clone)]
pub struct TypedArtifact {
    pub id: Uuid,
    pub episode_id: Uuid,
    pub seq: i64,
    pub kind: ArtifactKind,
    /// CAS pointer (hex sha256) into `sharp.objects`, or `None` if inline.
    pub content_ref: Option<String>,
    /// Inline jsonb payload, or `None` if stored via `content_ref`.
    pub inline: Option<Json>,
    pub created_at: DateTime<Utc>,
}

fn row_to_typed_artifact(r: &sqlx::postgres::PgRow) -> Result<TypedArtifact, sqlx::Error> {
    let kind_str: String = r.try_get("kind")?;
    // Map an unknown kind to a column-decode error so it surfaces through sqlx.
    let kind = ArtifactKind::parse(&kind_str).map_err(|e| sqlx::Error::ColumnDecode {
        index: "kind".to_string(),
        source: Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            e.to_string(),
        )),
    })?;
    Ok(TypedArtifact {
        id: r.try_get("id")?,
        episode_id: r.try_get("episode_id")?,
        seq: r.try_get("seq")?,
        kind,
        content_ref: r.try_get("content_ref")?,
        inline: r.try_get("inline")?,
        created_at: r.try_get("created_at")?,
    })
}

/// Open a complete-model episode with full provenance.
///
/// Inserts into `sharp.episodes` populating both the generic columns (title,
/// state='open') and the provenance columns from 0006, with status='started'.
/// This keeps the row queryable by both the generic and complete surfaces.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn open_with_provenance(
    pool: &PgPool,
    input: &OpenEpisodeInput,
) -> Result<Episode, SharpError> {
    let row = sqlx::query(
        r#"
        INSERT INTO sharp.episodes (
            repo_id, title, parent_commit, agent_identity, model_id,
            harness_version, tool_versions, decoding_params, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'started')
        RETURNING id, repo_id, title, state, opened_at, finished_at, metadata
        "#,
    )
    .bind(input.repo_id)
    .bind(&input.title)
    .bind(&input.parent_commit)
    .bind(&input.agent_identity)
    .bind(&input.model_id)
    .bind(&input.harness_version)
    .bind(&input.tool_versions)
    .bind(&input.decoding_params)
    .fetch_one(pool)
    .await?;

    Ok(row_to_episode(&row)?)
}

/// Finish a complete-model episode, recording its terminal `status` and an
/// optional `promoted_commit` (hex sha).
///
/// Also flips the generic `state` to 'finished' so the generic surface
/// (`list_open`, etc.) stays consistent.
///
/// # Errors
///
/// Returns [`SharpError::InvalidArtifact`] if `status` is `Started` (not a
/// terminal status).  Returns [`SharpError::EpisodeNotFound`] if no such
/// episode exists.  Returns [`SharpError::Db`] on a database error.
pub async fn finish_with_status(
    pool: &PgPool,
    episode_id: Uuid,
    status: EpisodeStatus,
    promoted_commit: Option<&str>,
) -> Result<Episode, SharpError> {
    if status == EpisodeStatus::Started {
        return Err(SharpError::InvalidArtifact(
            "cannot finish an episode with status 'started'".to_string(),
        ));
    }
    let row = sqlx::query(
        r#"
        UPDATE sharp.episodes
        SET status = $2,
            promoted_commit = $3,
            state = 'finished',
            finished_at = now()
        WHERE id = $1
        RETURNING id, repo_id, title, state, opened_at, finished_at, metadata
        "#,
    )
    .bind(episode_id)
    .bind(status.as_str())
    .bind(promoted_commit)
    .fetch_optional(pool)
    .await?
    .ok_or(SharpError::EpisodeNotFound(episode_id))?;

    Ok(row_to_episode(&row)?)
}

/// Append a typed artifact whose payload is stored inline as jsonb.
///
/// The sequence number is assigned as `MAX(seq) + 1` for the episode (starting
/// at 1, matching the TS prototype).
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn add_artifact_inline(
    pool: &PgPool,
    episode_id: Uuid,
    kind: ArtifactKind,
    inline: Json,
) -> Result<TypedArtifact, SharpError> {
    let seq = next_artifact_seq(pool, episode_id).await?;
    let row = sqlx::query(
        r#"
        INSERT INTO sharp.episode_typed_artifacts (episode_id, seq, kind, inline)
        VALUES ($1, $2, $3, $4)
        RETURNING id, episode_id, seq, kind, content_ref, inline, created_at
        "#,
    )
    .bind(episode_id)
    .bind(seq)
    .bind(kind.as_str())
    .bind(&inline)
    .fetch_one(pool)
    .await?;

    Ok(row_to_typed_artifact(&row)?)
}

/// Append a typed artifact, storing `data` in the CAS (`sharp.objects`) and
/// recording the resulting sha256 hex as the artifact's `content_ref`.
///
/// The object is stored as a `blob` under `repo_id`.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn add_artifact(
    pool: &PgPool,
    episode_id: Uuid,
    repo_id: Uuid,
    kind: ArtifactKind,
    data: &[u8],
) -> Result<TypedArtifact, SharpError> {
    // Materialize the payload into the content-addressed store.
    let content_ref = object::store(pool, repo_id, ObjectType::Blob, data).await?;
    let seq = next_artifact_seq(pool, episode_id).await?;
    let row = sqlx::query(
        r#"
        INSERT INTO sharp.episode_typed_artifacts (episode_id, seq, kind, content_ref)
        VALUES ($1, $2, $3, $4)
        RETURNING id, episode_id, seq, kind, content_ref, inline, created_at
        "#,
    )
    .bind(episode_id)
    .bind(seq)
    .bind(kind.as_str())
    .bind(&content_ref)
    .fetch_one(pool)
    .await?;

    Ok(row_to_typed_artifact(&row)?)
}

/// Compute the next artifact seq (`MAX(seq) + 1`, starting at 1) for an episode.
async fn next_artifact_seq(pool: &PgPool, episode_id: Uuid) -> Result<i64, SharpError> {
    let r = sqlx::query(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM sharp.episode_typed_artifacts WHERE episode_id = $1",
    )
    .bind(episode_id)
    .fetch_one(pool)
    .await?;
    Ok(r.try_get("next")?)
}

/// Return all typed artifacts for an episode in seq order.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn list_artifacts(
    pool: &PgPool,
    episode_id: Uuid,
) -> Result<Vec<TypedArtifact>, SharpError> {
    let rows = sqlx::query(
        r#"
        SELECT id, episode_id, seq, kind, content_ref, inline, created_at
        FROM   sharp.episode_typed_artifacts
        WHERE  episode_id = $1
        ORDER  BY seq ASC
        "#,
    )
    .bind(episode_id)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(row_to_typed_artifact)
        .collect::<Result<Vec<_>, _>>()
        .map_err(SharpError::Db)
}

/// Create a relation-typed link between two episodes.  Idempotent
/// (`ON CONFLICT DO NOTHING` on the `(from, to, relation)` unique constraint).
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn link_episodes(
    pool: &PgPool,
    from_episode: Uuid,
    to_episode: Uuid,
    relation: LinkRelation,
) -> Result<(), SharpError> {
    sqlx::query(
        r#"
        INSERT INTO sharp.episode_relations (from_episode, to_episode, relation)
        VALUES ($1, $2, $3)
        ON CONFLICT (from_episode, to_episode, relation) DO NOTHING
        "#,
    )
    .bind(from_episode)
    .bind(to_episode)
    .bind(relation.as_str())
    .execute(pool)
    .await?;
    Ok(())
}

/// Redact a typed artifact: destroy its stored payload (clear `content_ref`,
/// rewrite `inline` with `redacted`) and record the redaction in
/// `sharp.episode_redactions`.  Performed atomically in a transaction.
///
/// # Errors
///
/// Returns [`SharpError::InvalidRedaction`] if `policy` or `actor` is empty, or
/// if no artifact with that `(episode_id, seq)` exists.  Returns
/// [`SharpError::Db`] on a database error.
pub async fn redact(
    pool: &PgPool,
    episode_id: Uuid,
    seq: i64,
    policy: &str,
    actor: &str,
    redacted: Json,
) -> Result<(), SharpError> {
    if policy.trim().is_empty() {
        return Err(SharpError::InvalidRedaction(
            "policy must not be empty".to_string(),
        ));
    }
    if actor.trim().is_empty() {
        return Err(SharpError::InvalidRedaction(
            "actor must not be empty".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;

    let updated = sqlx::query(
        r#"
        UPDATE sharp.episode_typed_artifacts
        SET content_ref = NULL, inline = $3
        WHERE episode_id = $1 AND seq = $2
        "#,
    )
    .bind(episode_id)
    .bind(seq)
    .bind(&redacted)
    .execute(&mut *tx)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(SharpError::InvalidRedaction(format!(
            "no artifact at episode {episode_id} seq {seq}"
        )));
    }

    sqlx::query(
        r#"
        INSERT INTO sharp.episode_redactions (episode_id, seq, policy, actor)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(episode_id)
    .bind(seq)
    .bind(policy)
    .bind(actor)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Filter for [`list_filtered`] over complete-model episodes.
#[derive(Debug, Clone, Default)]
pub struct EpisodeFilter {
    pub repo_id: Option<Uuid>,
    pub model_id: Option<String>,
    pub status: Option<EpisodeStatus>,
    pub parent_commit: Option<String>,
    pub promoted_commit: Option<String>,
    /// Cap on rows returned (clamped to 1000, default 100).
    pub limit: Option<i64>,
}

/// List complete-model episodes by provenance filters, most recently opened
/// first.  Mirrors the TS `listEpisodes` query.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn list_filtered(
    pool: &PgPool,
    filter: &EpisodeFilter,
) -> Result<Vec<Episode>, SharpError> {
    let limit = filter.limit.unwrap_or(100).clamp(1, 1000);
    // Bind every optional filter once; a NULL bind disables that predicate.
    let rows = sqlx::query(
        r#"
        SELECT id, repo_id, title, state, opened_at, finished_at, metadata
        FROM   sharp.episodes
        WHERE  ($1::uuid  IS NULL OR repo_id         = $1)
          AND  ($2::text  IS NULL OR model_id        = $2)
          AND  ($3::text  IS NULL OR status          = $3)
          AND  ($4::text  IS NULL OR parent_commit   = $4)
          AND  ($5::text  IS NULL OR promoted_commit = $5)
        ORDER  BY opened_at DESC
        LIMIT  $6
        "#,
    )
    .bind(filter.repo_id)
    .bind(filter.model_id.as_deref())
    .bind(filter.status.map(|s| s.as_str()))
    .bind(filter.parent_commit.as_deref())
    .bind(filter.promoted_commit.as_deref())
    .bind(limit)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_kind_roundtrip() {
        for k in [
            ArtifactKind::Prompt,
            ArtifactKind::Context,
            ArtifactKind::ToolCall,
            ArtifactKind::ToolResult,
            ArtifactKind::IntermediatePatch,
            ArtifactKind::Validation,
            ArtifactKind::Judge,
        ] {
            assert_eq!(ArtifactKind::parse(k.as_str()).unwrap(), k);
        }
    }

    #[test]
    fn artifact_kind_unknown_is_invalid() {
        let err = ArtifactKind::parse("nope").unwrap_err();
        assert!(matches!(err, SharpError::InvalidArtifact(_)));
    }

    #[test]
    fn status_and_relation_strings() {
        assert_eq!(EpisodeStatus::Started.as_str(), "started");
        assert_eq!(EpisodeStatus::Completed.as_str(), "completed");
        assert_eq!(EpisodeStatus::Failed.as_str(), "failed");
        assert_eq!(EpisodeStatus::Abandoned.as_str(), "abandoned");
        assert_eq!(LinkRelation::Sibling.as_str(), "sibling");
        assert_eq!(LinkRelation::RetryOf.as_str(), "retry_of");
        assert_eq!(LinkRelation::ReplayOf.as_str(), "replay_of");
        assert_eq!(LinkRelation::SupersededBy.as_str(), "superseded_by");
    }
}
