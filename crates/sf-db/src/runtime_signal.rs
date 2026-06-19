//! Runtime-signal read projection — behavioral traces for the gardening loop.
//!
//! Production runtime errors and behavioral signals are captured into
//! `sharp.runtime_signals` by the Sharp crate (issue #381). This module is the
//! read seam through which the gardening loop's intent-to-spec inference step
//! (issue #709) consumes those signals **without** depending on the `sharp`
//! crate directly — it queries the `sharp.runtime_signals` table over the same
//! shared [`sqlx::PgPool`] that every component crate already uses.
//!
//! The loop never writes runtime signals; it only reads a recency-ordered
//! summary to compare *actual usage* against the *stated specification* and
//! propose a spec delta for a human to confirm.
//!
//! # Why a read-only summary
//!
//! The inference step does not need the full episode/deployment graph — it
//! needs a compact, recency-ordered view of *what the deployed software is
//! actually doing* (crashes, errors, health failures, behavioral anomalies).
//! [`RuntimeSignalSummary`] is that compact view.
//!
//! # Schema
//!
//! `sharp.runtime_signals` is created by
//! `crates/sharp/migrations/0004_sharp_runtime_signal.sql`. When that migration
//! has not been applied, [`fetch_recent_runtime_signals`] returns an empty
//! vector rather than an error, so the loop step cleanly no-ops on a substrate
//! that predates the signals schema.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle — runtime-signal ingestion.
//! - `docs/prd.md` US6 — Steerer intent inferred from real usage.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// Error type for runtime-signal read operations.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeSignalError {
    /// A database error from sqlx (other than a missing table).
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

/// A compact, read-only view of one `sharp.runtime_signals` row.
///
/// This is intentionally a subset of `sharp::runtime_signal::RuntimeSignal` —
/// it carries only the fields the inference step renders into its agent prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSignalSummary {
    /// Primary key of the signal row.
    pub id: Uuid,
    /// Category of signal (`error`, `crash`, `health_failure`, `behavior`).
    pub signal_kind: String,
    /// Where the signal came from (e.g. `"pod/api-server"`, `"healthz"`).
    pub source: String,
    /// Raw error message, log line, or behavioral description.
    pub message: String,
    /// Wall-clock time the signal was recorded.
    pub recorded_at: DateTime<Utc>,
}

/// Fetch the most recent runtime signals across all deployments and episodes.
///
/// Returns up to `limit` rows ordered by `recorded_at` **descending** (newest
/// first) — the natural order for "what has the software been doing lately?".
///
/// # Graceful degradation
///
/// If `sharp.runtime_signals` does not exist yet (the Sharp signals migration
/// has not been applied), this returns `Ok(vec![])` instead of an error. The
/// loop step treats an empty result as "no signals → no-op", so a substrate
/// without the signals schema simply advances the cursor without proposing a
/// spec delta.
///
/// # Arguments
///
/// * `pool`  — the shared [`sqlx::PgPool`] from `sf-db`.
/// * `limit` — maximum number of signals to return (most recent first).
///
/// # Errors
///
/// Returns [`RuntimeSignalError::Database`] on any Postgres error other than a
/// missing `runtime_signals` table.
pub async fn fetch_recent_runtime_signals(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<RuntimeSignalSummary>, RuntimeSignalError> {
    let result = sqlx::query_as::<_, (Uuid, String, String, String, DateTime<Utc>)>(
        "SELECT id, signal_kind, source, message, recorded_at \
         FROM sharp.runtime_signals \
         ORDER BY recorded_at DESC \
         LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await;

    match result {
        Ok(rows) => Ok(rows
            .into_iter()
            .map(
                |(id, signal_kind, source, message, recorded_at)| RuntimeSignalSummary {
                    id,
                    signal_kind,
                    source,
                    message,
                    recorded_at,
                },
            )
            .collect()),
        Err(e) => {
            // Treat "table/schema does not exist" as "no signals yet" so the
            // loop step can no-op on a substrate that predates the signals
            // migration. Any other database error propagates.
            let msg = e.to_string();
            if msg.contains("runtime_signals") && msg.contains("does not exist") {
                Ok(Vec::new())
            } else {
                Err(RuntimeSignalError::Database(e))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Integration: seeded signals read back newest-first; empty table yields [].
    ///
    /// Requires `DATABASE_URL` with the sharp schema (episodes + runtime_signals)
    /// migrated. Skipped otherwise.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with sharp migrations applied"]
    async fn fetch_recent_runtime_signals_orders_newest_first() {
        let url = match std::env::var("DATABASE_URL") {
            Ok(u) => u,
            Err(_) => return,
        };
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect");

        // Seed an episode + two signals (older, then newer).
        let episode_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO sharp.episodes (id, status) VALUES ($1, 'open') \
             ON CONFLICT DO NOTHING",
        )
        .bind(episode_id)
        .execute(&pool)
        .await
        .ok();

        sqlx::query(
            "INSERT INTO sharp.runtime_signals \
             (episode_id, signal_kind, source, message, recorded_at) \
             VALUES ($1, 'error', 'pod/api', 'older', now() - interval '1 minute')",
        )
        .bind(episode_id)
        .execute(&pool)
        .await
        .expect("seed older");

        sqlx::query(
            "INSERT INTO sharp.runtime_signals \
             (episode_id, signal_kind, source, message, recorded_at) \
             VALUES ($1, 'behavior', 'healthz', 'newer', now())",
        )
        .bind(episode_id)
        .execute(&pool)
        .await
        .expect("seed newer");

        let signals = fetch_recent_runtime_signals(&pool, 10)
            .await
            .expect("fetch must succeed");

        assert!(signals.len() >= 2, "expected at least the two seeded rows");
        // Newest first: the first of our two seeded rows is 'newer'.
        let ours: Vec<&str> = signals
            .iter()
            .filter(|s| s.message == "older" || s.message == "newer")
            .map(|s| s.message.as_str())
            .collect();
        assert_eq!(ours, vec!["newer", "older"], "must be newest-first");

        // Cleanup.
        sqlx::query("DELETE FROM sharp.runtime_signals WHERE episode_id = $1")
            .bind(episode_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM sharp.episodes WHERE id = $1")
            .bind(episode_id)
            .execute(&pool)
            .await
            .ok();
    }
}
