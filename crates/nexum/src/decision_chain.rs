//! Decision-to-requirement causal chain — the auditor traceability query.
//!
//! Where [`crate::causal_chain::error_to_cause_chain`] answers an *agent's*
//! question ("which error caused this, and what requirement/code does it touch?"),
//! this module answers an *auditor's* question (PRD US16): given any decision or
//! change, recover the full causal chain back to the requirement that justified
//! it, and forward to the code that implemented it.
//!
//! The chain hops are:
//!
//! ```text
//! decision ──motivated_by──▶ error ──caused_in──▶ session
//!            ──fulfills──▶ requirement ──implemented_by──▶ code
//! ```
//!
//! The first hop (`decision ──motivated_by──▶ error`) is resolved here; the
//! remaining hops are delegated to [`error_to_cause_chain`] so the auditor and
//! agent surfaces share exactly one graph-traversal implementation. This keeps
//! the read-only auditor route a thin projection over the existing causal-chain
//! query (issue #719).
//!
//! # Graph substrate
//!
//! Identical to [`crate::causal_chain`]: entities live in `nexum.entities`,
//! related by rows in `nexum.relations`. The seed entity for this query is of
//! type `"decision"` (a recorded policy-engine decision, #716) or `"change"`
//! (a recorded Change-lifecycle row, #707). The motivating-error edge is the
//! relation type `"motivated_by"`.
//!
//! # Sparse data
//!
//! Populating the causal edges is explicitly out of scope for #719 (that is
//! deliverable A3). When the motivating-error edge is absent the query returns
//! an **empty-but-valid** chain: the decision node plus a `missing_hops` list
//! naming every hop that could not be resolved. Callers therefore always get a
//! well-formed envelope, never an error, when data is merely sparse.
//!
//! See `docs/architecture.md` §Nexum (unified operational store) and §Data
//! Layer (three-table property graph).

use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::causal_chain::{error_to_cause_chain, CausalChain, CausalChainError, ChainNode};

// ── Errors ────────────────────────────────────────────────────────────────────

/// Errors that can occur during a decision-to-requirement chain query.
#[derive(Debug, Error)]
pub enum DecisionChainError {
    /// A database error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The seed decision/change entity was not found.
    #[error("decision entity not found: {0}")]
    DecisionNotFound(Uuid),
}

impl From<CausalChainError> for DecisionChainError {
    fn from(e: CausalChainError) -> Self {
        match e {
            CausalChainError::Database(db) => DecisionChainError::Database(db),
            // A missing seed error inside the delegated query is *not* an error
            // for the auditor: the decision simply has no motivating error yet.
            // We never construct that path (we only delegate with a resolved
            // error id), so map defensively to a database-shaped variant.
            CausalChainError::ErrorNotFound(id) => DecisionChainError::DecisionNotFound(id),
        }
    }
}

// ── Result types ────────────────────────────────────────────────────────────────

/// The full decision-to-requirement chain returned by
/// [`decision_to_requirement_chain`].
///
/// The `decision` node is always present (the query errors with
/// [`DecisionChainError::DecisionNotFound`] otherwise). The `causal` field holds
/// the delegated [`CausalChain`] when the motivating-error edge resolved; when
/// it did not, `causal` is `None` and `"error"` (plus every downstream hop) is
/// recorded in `missing_hops`.
#[derive(Debug, Clone)]
pub struct DecisionChain {
    /// The seed decision/change entity.
    pub decision: ChainNode,
    /// The motivating error and everything it traces to, when resolvable.
    pub causal: Option<CausalChain>,
    /// Names of hops that could not be resolved, e.g. `"error"`, `"session"`,
    /// `"user"`, `"requirement"`, `"code"`.
    pub missing_hops: Vec<String>,
}

type EntityRow = (Uuid, String, serde_json::Value);

/// All downstream hop names, recorded as missing when the seed has no
/// motivating error edge.
const DOWNSTREAM_HOPS: [&str; 5] = ["error", "session", "user", "requirement", "code"];

// ── Query ─────────────────────────────────────────────────────────────────────

/// Trace a decision or change back to its requirement (and forward to its code).
///
/// Starting from `decision_id`, the function:
///
/// 1. resolves the seed entity (must be type `"decision"` or `"change"`);
/// 2. follows the `motivated_by` edge to the error that prompted the decision;
/// 3. delegates to [`error_to_cause_chain`] for the rest of the chain.
///
/// A missing motivating-error edge yields an **empty-but-valid** chain rather
/// than an error: `causal` is `None` and `missing_hops` lists every downstream
/// hop. Missing links *within* the delegated chain are surfaced through the
/// nested [`CausalChain::missing_hops`].
///
/// # Errors
///
/// Returns [`DecisionChainError::DecisionNotFound`] when no entity of type
/// `"decision"` or `"change"` has that id. Returns
/// [`DecisionChainError::Database`] on any SQL error.
pub async fn decision_to_requirement_chain(
    pool: &PgPool,
    decision_id: Uuid,
) -> Result<DecisionChain, DecisionChainError> {
    // Step 0: resolve the seed decision/change entity.
    let seed: Option<EntityRow> = sqlx::query_as(
        r#"
        SELECT id, type, properties
        FROM nexum.entities
        WHERE id = $1 AND type IN ('decision', 'change')
        "#,
    )
    .bind(decision_id)
    .fetch_optional(pool)
    .await?;

    let (seed_id, seed_type, seed_props) =
        seed.ok_or(DecisionChainError::DecisionNotFound(decision_id))?;

    let decision_node = ChainNode {
        id: seed_id,
        entity_type: seed_type,
        properties: seed_props,
    };

    // Step 1: decision ──motivated_by──▶ error.
    let error_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT e.id
        FROM nexum.relations r
        JOIN nexum.entities e ON e.id = r.target_id
        WHERE r.source_id = $1
          AND r.type      = 'motivated_by'
          AND e.type      = 'error'
        LIMIT 1
        "#,
    )
    .bind(seed_id)
    .fetch_optional(pool)
    .await?;

    let Some(error_id) = error_id else {
        // Empty-but-valid chain: no motivating error recorded yet (#719 A3).
        return Ok(DecisionChain {
            decision: decision_node,
            causal: None,
            missing_hops: DOWNSTREAM_HOPS.iter().map(|s| s.to_string()).collect(),
        });
    };

    // Steps 2..5: delegate to the shared causal-chain traversal.
    let causal = error_to_cause_chain(pool, error_id).await?;
    let missing_hops = causal.missing_hops.clone();

    Ok(DecisionChain {
        decision: decision_node,
        causal: Some(causal),
        missing_hops,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Unit tests (no database required) ────────────────────────────────────

    #[test]
    fn empty_chain_lists_all_downstream_hops() {
        let chain = DecisionChain {
            decision: ChainNode {
                id: Uuid::new_v4(),
                entity_type: "decision".into(),
                properties: json!({}),
            },
            causal: None,
            missing_hops: DOWNSTREAM_HOPS.iter().map(|s| s.to_string()).collect(),
        };
        assert!(chain.causal.is_none());
        assert_eq!(chain.missing_hops.len(), 5);
        assert!(chain.missing_hops.contains(&"requirement".to_string()));
        assert!(chain.missing_hops.contains(&"error".to_string()));
    }

    #[test]
    fn decision_node_preserved() {
        let id = Uuid::new_v4();
        let chain = DecisionChain {
            decision: ChainNode {
                id,
                entity_type: "change".into(),
                properties: json!({"title": "t"}),
            },
            causal: None,
            missing_hops: vec![],
        };
        assert_eq!(chain.decision.id, id);
        assert_eq!(chain.decision.entity_type, "change");
    }

    // ── Integration tests (require DATABASE_URL and seeded public schema) ────

    /// A decision with a complete motivating chain resolves every hop.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded public schema"]
    async fn decision_chain_resolves_full_chain_on_seeded_data() {
        use sf_db::config::DbConfig;
        use sf_db::pool::connect;

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");

        let decision_id = seed_full_decision_chain(&pool).await;

        let chain = decision_to_requirement_chain(&pool, decision_id)
            .await
            .expect("decision chain query should succeed");

        let causal = chain.causal.expect("motivating-error hop must resolve");
        assert!(
            causal.requirement.is_some(),
            "requirement hop must be resolved on seeded data"
        );
        assert!(chain.missing_hops.is_empty(), "no hops should be missing");
    }

    /// A decision with no motivating error returns an empty-but-valid chain.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded public schema"]
    async fn decision_chain_is_empty_but_valid_when_sparse() {
        use sf_db::config::DbConfig;
        use sf_db::pool::connect;

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");

        let decision_id = seed_bare_decision(&pool).await;

        let chain = decision_to_requirement_chain(&pool, decision_id)
            .await
            .expect("query must succeed even with sparse data");

        assert!(
            chain.causal.is_none(),
            "no motivating error → no causal hop"
        );
        assert_eq!(
            chain.missing_hops.len(),
            5,
            "every downstream hop must be listed as missing"
        );
    }

    /// An unknown id (or an entity of the wrong type) is reported, not silently
    /// returned as empty.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded public schema"]
    async fn unknown_decision_id_is_not_found() {
        use sf_db::config::DbConfig;
        use sf_db::pool::connect;

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");

        let err = decision_to_requirement_chain(&pool, Uuid::new_v4())
            .await
            .expect_err("unknown id must error");
        assert!(matches!(err, DecisionChainError::DecisionNotFound(_)));
    }

    // ── Integration test helpers ──────────────────────────────────────────────

    #[allow(dead_code)]
    async fn seed_full_decision_chain(pool: &PgPool) -> Uuid {
        let ws = insert_workspace(pool).await;
        let decision = insert_entity(pool, ws, "decision", json!({"rule": "r1"})).await;
        let error = insert_entity(pool, ws, "error", json!({"message": "e"})).await;
        let session = insert_entity(pool, ws, "session", json!({})).await;
        let user = insert_entity(pool, ws, "user", json!({"name": "u"})).await;
        let req = insert_entity(pool, ws, "requirement", json!({"title": "US16"})).await;
        let code = insert_entity(pool, ws, "code", json!({"path": "src/x.rs"})).await;

        insert_relation(pool, ws, decision, error, "motivated_by").await;
        insert_relation(pool, ws, error, session, "caused_in").await;
        insert_relation(pool, ws, session, user, "initiated_by").await;
        insert_relation(pool, ws, session, req, "fulfills").await;
        insert_relation(pool, ws, req, code, "implemented_by").await;
        decision
    }

    #[allow(dead_code)]
    async fn seed_bare_decision(pool: &PgPool) -> Uuid {
        let ws = insert_workspace(pool).await;
        insert_entity(pool, ws, "decision", json!({"rule": "lonely"})).await
    }

    #[allow(dead_code)]
    async fn insert_workspace(pool: &PgPool) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO public.workspaces (slug, display_name) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("decision-chain-test-ws-{}", Uuid::new_v4()))
        .bind("Decision Chain Test Workspace")
        .fetch_one(pool)
        .await
        .expect("workspace insert failed")
    }

    #[allow(dead_code)]
    async fn insert_entity(
        pool: &PgPool,
        workspace_id: Uuid,
        entity_type: &str,
        properties: serde_json::Value,
    ) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO nexum.entities (workspace_id, type, properties) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(workspace_id)
        .bind(entity_type)
        .bind(properties)
        .fetch_one(pool)
        .await
        .expect("entity insert failed")
    }

    #[allow(dead_code)]
    async fn insert_relation(
        pool: &PgPool,
        workspace_id: Uuid,
        source_id: Uuid,
        target_id: Uuid,
        rel_type: &str,
    ) {
        sqlx::query(
            "INSERT INTO nexum.relations (workspace_id, source_id, target_id, type) VALUES ($1, $2, $3, $4)",
        )
        .bind(workspace_id)
        .bind(source_id)
        .bind(target_id)
        .bind(rel_type)
        .execute(pool)
        .await
        .expect("relation insert failed");
    }
}
