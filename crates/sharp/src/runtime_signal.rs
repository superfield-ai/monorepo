//! Runtime signal capture — production errors and behavioral signals.
//!
//! Production runtime errors (pod crashes, health failures, unhandled
//! exceptions) and behavioral signals are recorded as
//! `sharp.runtime_signals`, each linked to a Sharp episode and optionally to
//! the deployment that originated the signal.
//!
//! This module satisfies issue #381 and resolves scout gap #8:
//! "No runtime-error-to-episode ingestion seam."
//!
//! # Usage
//!
//! ```rust,ignore
//! use sharp::runtime_signal::{record, query_by_deployment, SignalKind, RuntimeSignal};
//! use serde_json::json;
//!
//! // Record a production crash linked to a deployment.
//! let sig = record(
//!     &pool,
//!     episode_id,
//!     Some("deploy-abc123"),
//!     SignalKind::Crash,
//!     "pod/api-server",
//!     "OOMKilled: container exceeded memory limit",
//!     json!({ "namespace": "prod", "pod": "api-server-xyz" }),
//! ).await?;
//!
//! // Query all signals for a deployment.
//! let signals = query_by_deployment(&pool, "deploy-abc123").await?;
//! ```
//!
//! See `docs/architecture.md §Daemon Lifecycle` and
//! migration `0004_sharp_runtime_signal.sql`.

use crate::error::SharpError;
use chrono::{DateTime, Utc};
use serde_json::Value as Json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

// ── Types ─────────────────────────────────────────────────────────────────────

/// The kind of runtime signal captured from the deployed application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalKind {
    /// An unhandled application error (exception, panic, HTTP 5xx spike).
    Error,
    /// A container or process crash (OOMKilled, CrashLoopBackOff, segfault).
    Crash,
    /// A health-probe failure (`/healthz` returned non-200 or timed out).
    HealthFailure,
    /// A behavioral anomaly that is not strictly an error (latency spike,
    /// unexpected output, degraded throughput).
    Behavior,
}

impl SignalKind {
    /// Canonical string representation stored in the database.
    pub fn as_str(&self) -> &'static str {
        match self {
            SignalKind::Error => "error",
            SignalKind::Crash => "crash",
            SignalKind::HealthFailure => "health_failure",
            SignalKind::Behavior => "behavior",
        }
    }

    /// Parse from the stored string representation.
    ///
    /// Returns `None` for unrecognised values (schema addition may pre-date
    /// binary upgrade).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "error" => Some(SignalKind::Error),
            "crash" => Some(SignalKind::Crash),
            "health_failure" => Some(SignalKind::HealthFailure),
            "behavior" => Some(SignalKind::Behavior),
            _ => None,
        }
    }
}

/// A runtime signal record from `sharp.runtime_signals`.
#[derive(Debug, Clone)]
pub struct RuntimeSignal {
    /// Primary key.
    pub id: Uuid,
    /// The Sharp episode this signal is linked to.
    pub episode_id: Uuid,
    /// Opaque deployment identifier (e.g. GitHub Deployment ID or image digest).
    /// `None` when the originating deployment is unknown.
    pub deployment_id: Option<String>,
    /// Category of signal.
    pub signal_kind: String,
    /// Source identifier (e.g. `"pod/api-server"`, `"healthz"`,
    /// `"github-actions/deploy-workflow"`).
    pub source: String,
    /// Raw error message, log line, or behavioral description.
    pub message: String,
    /// Structured context (stack traces, labels, k8s metadata).
    pub payload: Json,
    /// Wall-clock time the signal was recorded in the store.
    pub recorded_at: DateTime<Utc>,
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Map a sqlx [`PgRow`] to a [`RuntimeSignal`].
fn row_to_signal(r: &sqlx::postgres::PgRow) -> Result<RuntimeSignal, sqlx::Error> {
    Ok(RuntimeSignal {
        id: r.try_get("id")?,
        episode_id: r.try_get("episode_id")?,
        deployment_id: r.try_get("deployment_id")?,
        signal_kind: r.try_get("signal_kind")?,
        source: r.try_get("source")?,
        message: r.try_get("message")?,
        payload: r.try_get("payload")?,
        recorded_at: r.try_get("recorded_at")?,
    })
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Record a runtime signal as episode signal in the Sharp store.
///
/// The signal is persisted atomically and also appended to the episode event
/// log (as a `"runtime_signal"` event) so it appears in the episode timeline.
///
/// # Arguments
///
/// * `pool`          — database connection pool.
/// * `episode_id`    — the Sharp episode to attach the signal to.
/// * `deployment_id` — opaque deployment identifier; `None` if unknown.
/// * `kind`          — category of signal (error, crash, health failure, behavior).
/// * `source`        — where the signal came from (e.g. `"pod/api-server"`).
/// * `message`       — raw error message or behavioral description.
/// * `payload`       — structured context (stack trace, labels, metadata).
///
/// # Errors
///
/// Returns [`SharpError::EpisodeNotFound`] when `episode_id` does not exist.
/// Returns [`SharpError::Db`] on any other database error.
pub async fn record(
    pool: &PgPool,
    episode_id: Uuid,
    deployment_id: Option<&str>,
    kind: SignalKind,
    source: &str,
    message: &str,
    payload: Json,
) -> Result<RuntimeSignal, SharpError> {
    // Verify the episode exists (raises EpisodeNotFound if not).
    crate::episode::find(pool, episode_id).await?;

    let row = sqlx::query(
        r#"
        INSERT INTO sharp.runtime_signals
            (episode_id, deployment_id, signal_kind, source, message, payload)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, episode_id, deployment_id, signal_kind, source, message, payload, recorded_at
        "#,
    )
    .bind(episode_id)
    .bind(deployment_id)
    .bind(kind.as_str())
    .bind(source)
    .bind(message)
    .bind(&payload)
    .fetch_one(pool)
    .await?;

    let signal = row_to_signal(&row)?;

    // Mirror into the episode event log so the full timeline is queryable from
    // `sharp.episode_events`.
    let event_payload = serde_json::json!({
        "signal_id":     signal.id.to_string(),
        "signal_kind":   signal.signal_kind,
        "deployment_id": signal.deployment_id,
        "source":        signal.source,
        "message":       signal.message,
    });
    // episode::append guards that the episode is open; if it is not, the
    // signal row is already committed — this is intentionally best-effort so
    // finished episodes can still receive post-deploy signals (e.g. a crash
    // discovered after the merge session closed).  We therefore ignore the
    // EpisodeNotOpen error here.
    let _ = crate::episode::append(pool, episode_id, "runtime_signal", event_payload).await;

    Ok(signal)
}

/// Return all runtime signals linked to a specific deployment.
///
/// Results are ordered by `recorded_at` ascending (oldest first), which is the
/// natural order for a post-deploy error timeline.
///
/// # Arguments
///
/// * `pool`          — database connection pool.
/// * `deployment_id` — opaque deployment identifier to query for.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn query_by_deployment(
    pool: &PgPool,
    deployment_id: &str,
) -> Result<Vec<RuntimeSignal>, SharpError> {
    let rows = sqlx::query(
        r#"
        SELECT id, episode_id, deployment_id, signal_kind, source, message, payload, recorded_at
        FROM   sharp.runtime_signals
        WHERE  deployment_id = $1
        ORDER  BY recorded_at ASC
        "#,
    )
    .bind(deployment_id)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(row_to_signal)
        .collect::<Result<Vec<_>, _>>()
        .map_err(SharpError::Db)
}

/// Return all runtime signals for an episode, ordered oldest first.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn query_by_episode(
    pool: &PgPool,
    episode_id: Uuid,
) -> Result<Vec<RuntimeSignal>, SharpError> {
    let rows = sqlx::query(
        r#"
        SELECT id, episode_id, deployment_id, signal_kind, source, message, payload, recorded_at
        FROM   sharp.runtime_signals
        WHERE  episode_id = $1
        ORDER  BY recorded_at ASC
        "#,
    )
    .bind(episode_id)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(row_to_signal)
        .collect::<Result<Vec<_>, _>>()
        .map_err(SharpError::Db)
}

// ── Unit tests (no DB required) ───────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_kind_roundtrip() {
        for (kind, s) in [
            (SignalKind::Error, "error"),
            (SignalKind::Crash, "crash"),
            (SignalKind::HealthFailure, "health_failure"),
            (SignalKind::Behavior, "behavior"),
        ] {
            assert_eq!(kind.as_str(), s);
            assert_eq!(SignalKind::parse(s).as_ref().map(|k| k.as_str()), Some(s));
        }
    }

    #[test]
    fn signal_kind_unknown_returns_none() {
        assert!(SignalKind::parse("unknown_kind").is_none());
    }
}
