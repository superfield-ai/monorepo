//! Runtime-signal projection — feed production errors and health signals into
//! the brain's property graph (issue #708).
//!
//! A deployed app's errors and health signals are written to
//! `sharp.runtime_signals` by the runtime-signal producer
//! (`sharp::runtime_signal::record`). This module is the *feeder*: it reads
//! one of those signals and projects it into the `nexum.entities` /
//! `nexum.relations` property graph so an agent can join the signal to its
//! deployment — and from there, via the existing causal-chain query
//! ([`crate::causal_chain`]), to the requirement and the code that produced it.
//!
//! # Projected shape
//!
//! ```text
//! runtime_signal ──observed_on──▶ deployment
//! ```
//!
//! * a `runtime_signal` entity carries the signal's id, kind, source, message,
//!   and originating `deployment_id` in its `properties`;
//! * a `deployment` entity is keyed by `deployment_id` (one per deployment per
//!   workspace, reused across signals);
//! * an `observed_on` relation joins the signal to its deployment.
//!
//! Both entities and the relation carry the signal's `workspace_id`, so a
//! cross-workspace read does not surface another tenant's signals (issue #708
//! acceptance criterion).
//!
//! # Why nexum reads sharp directly
//!
//! `sharp.runtime_signals` and `nexum.entities` live in the same single
//! Postgres instance (see `docs/architecture.md §Single-Instance Database
//! Schema Layout`), so the projection reads the signal row with a
//! fully-qualified `sharp.runtime_signals` SELECT rather than taking a build
//! dependency on the `sharp` crate.
//!
//! See `docs/architecture.md` §Nexum and §Data Layer (three-table property
//! graph), and `docs/prd.md` §5 (deploy-and-learn) / US14 / US15.

use serde_json::json;
use sqlx::{PgPool, Row};
use thiserror::Error;
use uuid::Uuid;

/// Entity `type` written for a projected runtime signal.
pub const SIGNAL_ENTITY_TYPE: &str = "runtime_signal";
/// Entity `type` written for the deployment a signal was observed on.
pub const DEPLOYMENT_ENTITY_TYPE: &str = "deployment";
/// Relation `type` joining a signal entity to its deployment entity.
pub const OBSERVED_ON_RELATION: &str = "observed_on";

// ── Errors ──────────────────────────────────────────────────────────────────────

/// Errors that can occur while projecting a runtime signal into the graph.
#[derive(Debug, Error)]
pub enum ProjectionError {
    /// A database error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The runtime signal to project was not found in `sharp.runtime_signals`.
    #[error("runtime signal not found: {0}")]
    SignalNotFound(Uuid),

    /// The runtime signal has no `deployment_id`, so it cannot be joined to a
    /// deployment. Signals of unknown origin are not projected.
    #[error("runtime signal {0} has no deployment_id; cannot project")]
    NoDeployment(Uuid),
}

// ── Result ──────────────────────────────────────────────────────────────────────

/// The graph nodes/edge created (or reused) for a projected signal.
#[derive(Debug, Clone)]
pub struct ProjectedSignal {
    /// The `runtime_signal` entity id in `nexum.entities`.
    pub signal_entity_id: Uuid,
    /// The `deployment` entity id the signal was joined to.
    pub deployment_entity_id: Uuid,
    /// The workspace the projection is scoped to.
    pub workspace_id: Uuid,
    /// The opaque deployment identifier the signal was observed on.
    pub deployment_id: String,
}

// ── Projection ──────────────────────────────────────────────────────────────────

/// Project a single `sharp.runtime_signals` row into the property graph.
///
/// Reads the signal by `signal_id`, then writes (idempotently for the
/// deployment node) a `runtime_signal` entity, a `deployment` entity, and an
/// `observed_on` relation joining them — all scoped to the signal's
/// `workspace_id`.
///
/// The whole projection runs in one transaction so a partial graph is never
/// left behind.
///
/// # Errors
///
/// * [`ProjectionError::SignalNotFound`] when `signal_id` is not in
///   `sharp.runtime_signals`.
/// * [`ProjectionError::NoDeployment`] when the signal has no `deployment_id`
///   (an unknown-origin signal cannot be joined to a deployment).
/// * [`ProjectionError::Database`] on any SQL error.
pub async fn project_runtime_signal(
    pool: &PgPool,
    signal_id: Uuid,
) -> Result<ProjectedSignal, ProjectionError> {
    // 1. Read the source signal from the sharp schema.
    let row = sqlx::query(
        r#"
        SELECT workspace_id, deployment_id, signal_kind, source, message, payload
        FROM   sharp.runtime_signals
        WHERE  id = $1
        "#,
    )
    .bind(signal_id)
    .fetch_optional(pool)
    .await?
    .ok_or(ProjectionError::SignalNotFound(signal_id))?;

    let workspace_id: Uuid = row.try_get("workspace_id")?;
    let deployment_id: Option<String> = row.try_get("deployment_id")?;
    let signal_kind: String = row.try_get("signal_kind")?;
    let source: String = row.try_get("source")?;
    let message: String = row.try_get("message")?;
    let payload: serde_json::Value = row.try_get("payload")?;

    let deployment_id = deployment_id.ok_or(ProjectionError::NoDeployment(signal_id))?;

    let mut tx = pool.begin().await?;

    // 2. Upsert the deployment entity (one per deployment_id per workspace).
    //    A deployment node is reused across many signals, so we look it up
    //    first and only create it when absent.
    let existing_deploy: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM   nexum.entities
        WHERE  workspace_id = $1
          AND  type = $2
          AND  properties ->> 'deployment_id' = $3
        LIMIT 1
        "#,
    )
    .bind(workspace_id)
    .bind(DEPLOYMENT_ENTITY_TYPE)
    .bind(&deployment_id)
    .fetch_optional(&mut *tx)
    .await?;

    let deployment_entity_id = match existing_deploy {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                r#"
                INSERT INTO nexum.entities (workspace_id, type, properties)
                VALUES ($1, $2, $3)
                RETURNING id
                "#,
            )
            .bind(workspace_id)
            .bind(DEPLOYMENT_ENTITY_TYPE)
            .bind(json!({ "deployment_id": deployment_id }))
            .fetch_one(&mut *tx)
            .await?
        }
    };

    // 3. Insert the runtime_signal entity, carrying the signal's identity and
    //    its deployment_id so the node is joinable to the deployment by value.
    let signal_entity_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO nexum.entities (workspace_id, type, properties)
        VALUES ($1, $2, $3)
        RETURNING id
        "#,
    )
    .bind(workspace_id)
    .bind(SIGNAL_ENTITY_TYPE)
    .bind(json!({
        "signal_id":     signal_id.to_string(),
        "deployment_id": deployment_id,
        "signal_kind":   signal_kind,
        "source":        source,
        "message":       message,
        "payload":       payload,
    }))
    .fetch_one(&mut *tx)
    .await?;

    // 4. Join the signal to its deployment.
    sqlx::query(
        r#"
        INSERT INTO nexum.relations (workspace_id, source_id, target_id, type)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(workspace_id)
    .bind(signal_entity_id)
    .bind(deployment_entity_id)
    .bind(OBSERVED_ON_RELATION)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(ProjectedSignal {
        signal_entity_id,
        deployment_entity_id,
        workspace_id,
        deployment_id,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Unit tests (no database required) ────────────────────────────────────

    #[test]
    fn projection_constants_are_stable() {
        // These strings are part of the graph contract that the causal-chain
        // and agent join queries depend on; pin them so a rename is loud.
        assert_eq!(SIGNAL_ENTITY_TYPE, "runtime_signal");
        assert_eq!(DEPLOYMENT_ENTITY_TYPE, "deployment");
        assert_eq!(OBSERVED_ON_RELATION, "observed_on");
    }

    #[test]
    fn no_deployment_error_carries_signal_id() {
        let id = Uuid::new_v4();
        let err = ProjectionError::NoDeployment(id);
        assert!(err.to_string().contains(&id.to_string()));
    }

    // ── Integration test (requires DATABASE_URL + applied migrations) ────────

    /// An ingested runtime signal becomes a nexum entity joinable to its
    /// deployment id, scoped to its workspace.
    ///
    /// Acceptance criteria (issue #708):
    /// * an ingested runtime signal becomes a nexum entity joinable to its
    ///   deployment id;
    /// * signals carry workspace_id so a cross-workspace read does not surface
    ///   them.
    ///
    /// Skipped unless `DATABASE_URL` is set and the sharp + nexum migrations
    /// (including `0008_sharp_runtime_signal_workspace.sql`) are applied.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and applied sharp+nexum migrations"]
    async fn signal_projects_to_entity_joinable_to_deployment() {
        use sf_db::config::DbConfig;
        use sf_db::pool::connect;

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");

        // Two workspaces: the signal belongs to ws_a only.
        let ws_a = insert_workspace(&pool).await;
        let ws_b = insert_workspace(&pool).await;

        let deployment_id = format!("deploy-{}", Uuid::new_v4().as_simple());
        let signal_id = insert_runtime_signal(&pool, ws_a, &deployment_id).await;

        let projected = project_runtime_signal(&pool, signal_id)
            .await
            .expect("projection should succeed");

        assert_eq!(projected.workspace_id, ws_a);
        assert_eq!(projected.deployment_id, deployment_id);

        // The signal entity is joinable to its deployment via observed_on, and
        // the deployment node is keyed by the deployment_id.
        let joined_deploy_id: Option<String> = sqlx::query_scalar(
            r#"
            SELECT d.properties ->> 'deployment_id'
            FROM   nexum.entities  s
            JOIN   nexum.relations r ON r.source_id = s.id AND r.type = 'observed_on'
            JOIN   nexum.entities  d ON d.id = r.target_id AND d.type = 'deployment'
            WHERE  s.id = $1 AND s.type = 'runtime_signal'
            "#,
        )
        .bind(projected.signal_entity_id)
        .fetch_optional(&pool)
        .await
        .expect("join query failed");

        assert_eq!(
            joined_deploy_id.as_deref(),
            Some(deployment_id.as_str()),
            "signal entity must join to its deployment id"
        );

        // Cross-workspace isolation: reading ws_b's signals must NOT surface
        // this signal even though the deployment_id matches.
        let cross: i64 = sqlx::query_scalar(
            r#"
            SELECT count(*)
            FROM   nexum.entities
            WHERE  workspace_id = $1
              AND  type = 'runtime_signal'
              AND  properties ->> 'deployment_id' = $2
            "#,
        )
        .bind(ws_b)
        .bind(&deployment_id)
        .fetch_one(&pool)
        .await
        .expect("cross-workspace count failed");

        assert_eq!(cross, 0, "ws_b must not see ws_a's projected signal");

        // Re-projecting reuses the same deployment node (no duplicate).
        let signal_id2 = insert_runtime_signal(&pool, ws_a, &deployment_id).await;
        let projected2 = project_runtime_signal(&pool, signal_id2)
            .await
            .expect("second projection should succeed");
        assert_eq!(
            projected2.deployment_entity_id, projected.deployment_entity_id,
            "the deployment entity must be reused across signals"
        );
    }

    // ── Integration helpers ──────────────────────────────────────────────────

    #[allow(dead_code)]
    async fn insert_workspace(pool: &PgPool) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO public.workspaces (slug, display_name) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("rts-proj-ws-{}", Uuid::new_v4().as_simple()))
        .bind("Runtime Signal Projection Test Workspace")
        .fetch_one(pool)
        .await
        .expect("workspace insert failed")
    }

    /// Insert a `sharp.runtime_signals` row directly (no episode link needed
    /// for the projection path, which only reads the signal columns it
    /// projects). Requires the sharp episode schema + 0008 to be applied.
    #[allow(dead_code)]
    async fn insert_runtime_signal(pool: &PgPool, workspace_id: Uuid, deployment_id: &str) -> Uuid {
        // A runtime_signals row needs an episode (FK). Create a minimal repo +
        // episode for the workspace.
        let repo_id: Uuid = sqlx::query_scalar(
            "INSERT INTO sharp.repos (workspace_id, name) VALUES ($1, $2) RETURNING id",
        )
        .bind(workspace_id)
        .bind(format!("rts-repo-{}", Uuid::new_v4().as_simple()))
        .fetch_one(pool)
        .await
        .expect("repo insert failed");

        let episode_id: Uuid = sqlx::query_scalar(
            "INSERT INTO sharp.episodes (workspace_id, repo_id, title) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(workspace_id)
        .bind(repo_id)
        .bind("projection test episode")
        .fetch_one(pool)
        .await
        .expect("episode insert failed");

        sqlx::query_scalar(
            r#"
            INSERT INTO sharp.runtime_signals
                (workspace_id, episode_id, deployment_id, signal_kind, source, message, payload)
            VALUES ($1, $2, $3, 'crash', 'pod/api-server', 'OOMKilled', '{}'::jsonb)
            RETURNING id
            "#,
        )
        .bind(workspace_id)
        .bind(episode_id)
        .bind(deployment_id)
        .fetch_one(pool)
        .await
        .expect("runtime signal insert failed")
    }
}
