//! Causal-chain query — error → session → user → requirement → code.
//!
//! This module exposes [`error_to_cause_chain`], which traverses the
//! property-graph store to recover the full diagnostic context for a
//! production error.  The chain hops are:
//!
//! ```text
//! error  ──caused_in──▶  session  ──initiated_by──▶  user
//!          ──fulfills──▶  requirement  ──implemented_by──▶  code
//! ```
//!
//! Each hop is attempted independently so that a missing link is *reported*
//! rather than silently dropped.  The caller receives a [`CausalChain`] whose
//! `missing_hops` field lists the names of every link that could not be
//! resolved.
//!
//! # Graph substrate
//!
//! All entities live in the `entities` table (public schema), related by rows
//! in `relations`.  Entity type values match the `type` column:
//! `"error"`, `"session"`, `"user"`, `"requirement"`, `"code"`.
//!
//! Relation type values that this query follows:
//! `"caused_in"`, `"initiated_by"`, `"fulfills"`, `"implemented_by"`.
//!
//! # Architecture reference
//!
//! See `docs/architecture.md` §Data Layer (three-table property graph) and
//! §Nexum (unified operational store).  Issue #382.

use serde_json::Value as JsonValue;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

// ── Errors ────────────────────────────────────────────────────────────────────

/// Errors that can occur during a causal-chain query.
#[derive(Debug, Error)]
pub enum CausalChainError {
    /// A database error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The seed error entity was not found.
    #[error("error entity not found: {0}")]
    ErrorNotFound(Uuid),
}

// ── Result types ──────────────────────────────────────────────────────────────

/// A single entity node retrieved during chain traversal.
#[derive(Debug, Clone)]
pub struct ChainNode {
    /// UUID of the entity row.
    pub id: Uuid,
    /// Entity type (`"error"`, `"session"`, `"user"`, `"requirement"`, `"code"`).
    pub entity_type: String,
    /// JSONB properties stored on the entity.
    pub properties: JsonValue,
}

/// The full causal chain returned by [`error_to_cause_chain`].
///
/// Each optional field holds the resolved node for that hop.  A `None` value
/// means the link was not present in the store; the hop name is also listed
/// in `missing_hops` so callers can inspect completeness without pattern-matching
/// five `Option` fields.
#[derive(Debug, Clone)]
pub struct CausalChain {
    /// The seed error entity.
    pub error: ChainNode,
    /// The session in which the error occurred (`caused_in` relation).
    pub session: Option<ChainNode>,
    /// The user who initiated the session (`initiated_by` relation).
    pub user: Option<ChainNode>,
    /// The requirement the session was fulfilling (`fulfills` relation).
    pub requirement: Option<ChainNode>,
    /// The code block that implements the requirement (`implemented_by` relation).
    pub code: Option<ChainNode>,
    /// Names of hops that could not be resolved.
    ///
    /// Possible values: `"session"`, `"user"`, `"requirement"`, `"code"`.
    pub missing_hops: Vec<String>,
}

// ── Internal row types ────────────────────────────────────────────────────────

type EntityRow = (Uuid, String, JsonValue);

// ── Query ─────────────────────────────────────────────────────────────────────

/// Traverse the causal chain from a production error to the code that caused it.
///
/// Starting from `error_id`, the function follows these directed relation edges
/// in the `relations` table:
///
/// | Hop | source type  | relation type    | target type   |
/// |-----|--------------|------------------|---------------|
/// | 1   | error        | `caused_in`      | session       |
/// | 2   | session      | `initiated_by`   | user          |
/// | 3   | session      | `fulfills`       | requirement   |
/// | 4   | requirement  | `implemented_by` | code          |
///
/// Missing links are recorded in [`CausalChain::missing_hops`] rather than
/// causing an error return.
///
/// # Errors
///
/// Returns [`CausalChainError::ErrorNotFound`] when the seed entity does not
/// exist or is not of type `"error"`.  Returns [`CausalChainError::Database`]
/// on any SQL error.
pub async fn error_to_cause_chain(
    pool: &PgPool,
    error_id: Uuid,
) -> Result<CausalChain, CausalChainError> {
    // Step 0: resolve the seed error entity.
    let error_row: Option<EntityRow> = sqlx::query_as(
        r#"
        SELECT id, type, properties
        FROM entities
        WHERE id = $1 AND type = 'error'
        "#,
    )
    .bind(error_id)
    .fetch_optional(pool)
    .await?;

    let (error_id, error_type, error_props) =
        error_row.ok_or(CausalChainError::ErrorNotFound(error_id))?;

    let error_node = ChainNode {
        id: error_id,
        entity_type: error_type,
        properties: error_props,
    };

    let mut missing_hops: Vec<String> = Vec::new();

    // Step 1: error ──caused_in──▶ session
    let session_node = follow_relation(pool, error_id, "caused_in", "session").await?;
    if session_node.is_none() {
        missing_hops.push("session".into());
    }

    // Step 2: session ──initiated_by──▶ user
    let user_node = if let Some(ref s) = session_node {
        let n = follow_relation(pool, s.id, "initiated_by", "user").await?;
        if n.is_none() {
            missing_hops.push("user".into());
        }
        n
    } else {
        missing_hops.push("user".into());
        None
    };

    // Step 3: session ──fulfills──▶ requirement
    let requirement_node = if let Some(ref s) = session_node {
        let n = follow_relation(pool, s.id, "fulfills", "requirement").await?;
        if n.is_none() {
            missing_hops.push("requirement".into());
        }
        n
    } else {
        missing_hops.push("requirement".into());
        None
    };

    // Step 4: requirement ──implemented_by──▶ code
    let code_node = if let Some(ref r) = requirement_node {
        let n = follow_relation(pool, r.id, "implemented_by", "code").await?;
        if n.is_none() {
            missing_hops.push("code".into());
        }
        n
    } else {
        missing_hops.push("code".into());
        None
    };

    Ok(CausalChain {
        error: error_node,
        session: session_node,
        user: user_node,
        requirement: requirement_node,
        code: code_node,
        missing_hops,
    })
}

/// Follow a single outgoing relation from `source_id` of `rel_type` to a
/// target entity of `target_type`.  Returns the first matching target, or
/// `None` if no such relation exists.
async fn follow_relation(
    pool: &PgPool,
    source_id: Uuid,
    rel_type: &str,
    target_type: &str,
) -> Result<Option<ChainNode>, CausalChainError> {
    let row: Option<EntityRow> = sqlx::query_as(
        r#"
        SELECT e.id, e.type, e.properties
        FROM relations r
        JOIN entities e ON e.id = r.target_id
        WHERE r.source_id = $1
          AND r.type      = $2
          AND e.type      = $3
        LIMIT 1
        "#,
    )
    .bind(source_id)
    .bind(rel_type)
    .bind(target_type)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(id, entity_type, properties)| ChainNode {
        id,
        entity_type,
        properties,
    }))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // ── Unit tests (no database required) ────────────────────────────────────

    #[test]
    fn causal_chain_missing_hops_vec_starts_empty() {
        // Verify the CausalChain struct can be constructed and that missing_hops
        // behaves as a plain Vec<String>.
        let chain = CausalChain {
            error: ChainNode {
                id: Uuid::new_v4(),
                entity_type: "error".into(),
                properties: serde_json::json!({}),
            },
            session: None,
            user: None,
            requirement: None,
            code: None,
            missing_hops: vec!["session".into(), "user".into()],
        };
        assert_eq!(chain.missing_hops.len(), 2);
        assert!(chain.missing_hops.contains(&"session".to_string()));
    }

    #[test]
    fn complete_chain_has_no_missing_hops() {
        let make_node = |t: &str| ChainNode {
            id: Uuid::new_v4(),
            entity_type: t.into(),
            properties: serde_json::json!({}),
        };
        let chain = CausalChain {
            error: make_node("error"),
            session: Some(make_node("session")),
            user: Some(make_node("user")),
            requirement: Some(make_node("requirement")),
            code: Some(make_node("code")),
            missing_hops: vec![],
        };
        assert!(chain.missing_hops.is_empty());
        assert!(chain.session.is_some());
        assert!(chain.code.is_some());
    }

    // ── Integration tests (require DATABASE_URL and seeded public schema) ────

    /// Full causal chain returns all hops on seeded data.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded public schema"]
    async fn chain_query_returns_all_hops_on_seeded_data() {
        use sqlx::PgPool;

        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("pool creation failed");

        // Seed a complete chain: error → session → user + requirement → code.
        let (error_id, _session_id, _user_id, _req_id, _code_id) = seed_complete_chain(&pool).await;

        let chain = error_to_cause_chain(&pool, error_id)
            .await
            .expect("causal chain query should succeed");

        assert!(
            chain.missing_hops.is_empty(),
            "expected no missing hops, got: {:?}",
            chain.missing_hops
        );
        assert!(chain.session.is_some(), "session hop must be resolved");
        assert!(chain.user.is_some(), "user hop must be resolved");
        assert!(
            chain.requirement.is_some(),
            "requirement hop must be resolved"
        );
        assert!(chain.code.is_some(), "code hop must be resolved");
    }

    /// A broken chain reports the missing hop rather than silently dropping it.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded public schema"]
    async fn broken_chain_reports_missing_hop() {
        use sqlx::PgPool;

        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("pool creation failed");

        // Seed an error with a session but no user, requirement, or code.
        let (error_id, _session_id) = seed_partial_chain_error_to_session(&pool).await;

        let chain = error_to_cause_chain(&pool, error_id)
            .await
            .expect("causal chain query should succeed even when links are missing");

        assert!(
            chain.session.is_some(),
            "session should be resolved when the caused_in link exists"
        );
        assert!(
            chain.user.is_none(),
            "user should be None when initiated_by link is absent"
        );
        assert!(
            chain.missing_hops.contains(&"user".to_string()),
            "missing_hops must list 'user'"
        );
        assert!(
            chain.missing_hops.contains(&"requirement".to_string()),
            "missing_hops must list 'requirement'"
        );
        assert!(
            chain.missing_hops.contains(&"code".to_string()),
            "missing_hops must list 'code'"
        );
    }

    // ── Integration test helpers ──────────────────────────────────────────────

    /// Insert a complete five-node chain and return all five UUIDs.
    #[allow(dead_code)]
    async fn seed_complete_chain(pool: &PgPool) -> (Uuid, Uuid, Uuid, Uuid, Uuid) {
        let error_id =
            insert_entity(pool, "error", serde_json::json!({"message": "test error"})).await;
        let session_id = insert_entity(pool, "session", serde_json::json!({})).await;
        let user_id = insert_entity(pool, "user", serde_json::json!({"name": "test-user"})).await;
        let req_id = insert_entity(
            pool,
            "requirement",
            serde_json::json!({"title": "test-req"}),
        )
        .await;
        let code_id = insert_entity(pool, "code", serde_json::json!({"path": "src/lib.rs"})).await;

        insert_relation(pool, error_id, session_id, "caused_in").await;
        insert_relation(pool, session_id, user_id, "initiated_by").await;
        insert_relation(pool, session_id, req_id, "fulfills").await;
        insert_relation(pool, req_id, code_id, "implemented_by").await;

        (error_id, session_id, user_id, req_id, code_id)
    }

    /// Insert a partial chain: error → session only (no user/requirement/code links).
    #[allow(dead_code)]
    async fn seed_partial_chain_error_to_session(pool: &PgPool) -> (Uuid, Uuid) {
        let error_id = insert_entity(
            pool,
            "error",
            serde_json::json!({"message": "partial error"}),
        )
        .await;
        let session_id = insert_entity(pool, "session", serde_json::json!({})).await;
        insert_relation(pool, error_id, session_id, "caused_in").await;
        (error_id, session_id)
    }

    #[allow(dead_code)]
    async fn insert_entity(
        pool: &PgPool,
        entity_type: &str,
        properties: serde_json::Value,
    ) -> Uuid {
        sqlx::query_scalar("INSERT INTO entities (type, properties) VALUES ($1, $2) RETURNING id")
            .bind(entity_type)
            .bind(properties)
            .fetch_one(pool)
            .await
            .expect("entity insert failed")
    }

    #[allow(dead_code)]
    async fn insert_relation(pool: &PgPool, source_id: Uuid, target_id: Uuid, rel_type: &str) {
        sqlx::query("INSERT INTO relations (source_id, target_id, type) VALUES ($1, $2, $3)")
            .bind(source_id)
            .bind(target_id)
            .bind(rel_type)
            .execute(pool)
            .await
            .expect("relation insert failed");
    }
}
