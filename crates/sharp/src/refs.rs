//! Refs (branches, tags, HEAD) over `sharp.refs`.
//!
//! Ports `sharp/apps/server/src/refs.ts`.
//!
//! A ref is a discriminated union over a *hash* target — a commit/object SHA
//! stored as hex text — and a *symbolic* target — another ref's name (e.g.
//! `HEAD` → `refs/heads/main`).
//!
//! Updates use a compare-and-swap (CAS) model so concurrent pushes to the same
//! ref deterministically produce one winner; the losers get a typed
//! [`SharpError::RefCasFailed`] and can retry.
//!
//! Per `docs/rust-reorg-decisions.md` §2, ref ids (hash targets) are stored as
//! hex `String`, matching the rest of the crate, rather than `bytea`.
//!
//! See `docs/architecture.md §Sharp — Tier-1 Rust Semantic Merge § Components (crates/sharp)`.

use crate::error::SharpError;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// The target a ref points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefTarget {
    /// A direct pointer to a commit/object, identified by its hex SHA.
    Hash(String),
    /// A symbolic pointer to another ref, identified by name.
    Symbolic(String),
}

/// A named ref together with its target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedRef {
    pub name: String,
    pub target: RefTarget,
}

/// Build a [`RefTarget`] from a row's `(target_kind, target_sha, symbolic_target)`.
fn row_to_target(
    kind: &str,
    target_sha: Option<String>,
    symbolic_target: Option<String>,
) -> Result<RefTarget, SharpError> {
    match kind {
        "hash" => target_sha.map(RefTarget::Hash).ok_or_else(|| {
            SharpError::GitInterop("ref row marked 'hash' has null target_sha".into())
        }),
        "symbolic" => symbolic_target.map(RefTarget::Symbolic).ok_or_else(|| {
            SharpError::GitInterop("ref row marked 'symbolic' has null symbolic_target".into())
        }),
        other => Err(SharpError::GitInterop(format!(
            "ref row has unknown target_kind: {other}"
        ))),
    }
}

/// Look up a single ref by name.
///
/// Returns `None` if no ref with that name exists in the repo.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn get_ref(
    pool: &PgPool,
    repo_id: Uuid,
    name: &str,
) -> Result<Option<RefTarget>, SharpError> {
    let row = sqlx::query(
        r#"
        SELECT target_kind, target_sha, symbolic_target
        FROM   sharp.refs
        WHERE  repo_id = $1 AND ref_name = $2
        "#,
    )
    .bind(repo_id)
    .bind(name)
    .fetch_optional(pool)
    .await?;

    match row {
        None => Ok(None),
        Some(r) => {
            let kind: String = r.try_get("target_kind")?;
            let target_sha: Option<String> = r.try_get("target_sha")?;
            let symbolic_target: Option<String> = r.try_get("symbolic_target")?;
            Ok(Some(row_to_target(&kind, target_sha, symbolic_target)?))
        }
    }
}

/// List refs in a repo, optionally filtered by name prefix, ordered by name.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn list_refs(
    pool: &PgPool,
    repo_id: Uuid,
    prefix: Option<&str>,
) -> Result<Vec<NamedRef>, SharpError> {
    let rows = match prefix {
        Some(p) => {
            sqlx::query(
                r#"
                SELECT ref_name, target_kind, target_sha, symbolic_target
                FROM   sharp.refs
                WHERE  repo_id = $1 AND ref_name LIKE $2
                ORDER  BY ref_name
                "#,
            )
            .bind(repo_id)
            .bind(format!("{p}%"))
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query(
                r#"
                SELECT ref_name, target_kind, target_sha, symbolic_target
                FROM   sharp.refs
                WHERE  repo_id = $1
                ORDER  BY ref_name
                "#,
            )
            .bind(repo_id)
            .fetch_all(pool)
            .await?
        }
    };

    rows.into_iter()
        .map(|r| {
            let name: String = r.try_get("ref_name")?;
            let kind: String = r.try_get("target_kind")?;
            let target_sha: Option<String> = r.try_get("target_sha")?;
            let symbolic_target: Option<String> = r.try_get("symbolic_target")?;
            Ok(NamedRef {
                name,
                target: row_to_target(&kind, target_sha, symbolic_target)?,
            })
        })
        .collect()
}

/// Create a ref. Fails if a ref with the same name already exists.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error (including a unique-violation
/// when the ref already exists).
pub async fn create_ref(
    pool: &PgPool,
    repo_id: Uuid,
    name: &str,
    target: &RefTarget,
) -> Result<(), SharpError> {
    match target {
        RefTarget::Hash(sha) => {
            sqlx::query(
                r#"
                INSERT INTO sharp.refs (repo_id, ref_name, target_sha, target_kind)
                VALUES ($1, $2, $3, 'hash')
                "#,
            )
            .bind(repo_id)
            .bind(name)
            .bind(sha)
            .execute(pool)
            .await?;
        }
        RefTarget::Symbolic(t) => {
            sqlx::query(
                r#"
                INSERT INTO sharp.refs (repo_id, ref_name, symbolic_target, target_kind)
                VALUES ($1, $2, $3, 'symbolic')
                "#,
            )
            .bind(repo_id)
            .bind(name)
            .bind(t)
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

/// Unconditionally set a hash ref, creating it or overwriting whatever it
/// currently points at. This is *not* a CAS; use [`update_ref`] when a
/// concurrent-writer race must be detected.
///
/// Used by the branch-head helpers (`commit`, `create_branch`) whose upsert
/// semantics intentionally overwrite the prior target.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn set_ref(
    pool: &PgPool,
    repo_id: Uuid,
    name: &str,
    sha: &str,
) -> Result<(), SharpError> {
    sqlx::query(
        r#"
        INSERT INTO sharp.refs (repo_id, ref_name, target_sha, target_kind)
        VALUES ($1, $2, $3, 'hash')
        ON CONFLICT (repo_id, ref_name) DO UPDATE
            SET target_sha       = EXCLUDED.target_sha,
                target_kind      = 'hash',
                symbolic_target  = NULL,
                updated_at       = now()
        "#,
    )
    .bind(repo_id)
    .bind(name)
    .bind(sha)
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomic compare-and-swap update of a hash ref.
///
/// If `expected_old` is `None`, the operation creates the ref iff it does not
/// already exist (insert-or-throw). If `expected_old` is `Some(sha)`, the
/// operation updates the ref iff its current hash value matches.
///
/// Only hash → hash CAS is supported; symbolic refs are updated via
/// [`update_symbolic`], which does not race the same way.
///
/// # Errors
///
/// - Returns [`SharpError::RefCasFailed`] when no row matched the CAS condition.
/// - Returns [`SharpError::Db`] on a database error.
pub async fn update_ref(
    pool: &PgPool,
    repo_id: Uuid,
    name: &str,
    expected_old: Option<&str>,
    new_target: &str,
) -> Result<(), SharpError> {
    let Some(expected) = expected_old else {
        // Create-only path.
        return create_ref(
            pool,
            repo_id,
            name,
            &RefTarget::Hash(new_target.to_string()),
        )
        .await;
    };

    let result = sqlx::query(
        r#"
        UPDATE sharp.refs
           SET target_sha = $3,
               updated_at = now()
         WHERE repo_id = $1
           AND ref_name = $2
           AND target_kind = 'hash'
           AND target_sha = $4
        "#,
    )
    .bind(repo_id)
    .bind(name)
    .bind(new_target)
    .bind(expected)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        // Surface the observed value to aid retries; fall back to "<none>".
        let found = match get_ref(pool, repo_id, name).await? {
            Some(RefTarget::Hash(sha)) => sha,
            Some(RefTarget::Symbolic(t)) => format!("symbolic:{t}"),
            None => "<none>".to_string(),
        };
        return Err(SharpError::RefCasFailed {
            ref_name: name.to_string(),
            expected: expected.to_string(),
            found,
        });
    }
    Ok(())
}

/// Replace a symbolic ref's target. Used for HEAD updates after `checkout`.
///
/// If no symbolic ref with that name exists, a new symbolic ref is created.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn update_symbolic(
    pool: &PgPool,
    repo_id: Uuid,
    name: &str,
    new_target: &str,
) -> Result<(), SharpError> {
    let result = sqlx::query(
        r#"
        UPDATE sharp.refs
           SET symbolic_target = $3,
               updated_at = now()
         WHERE repo_id = $1 AND ref_name = $2 AND target_kind = 'symbolic'
        "#,
    )
    .bind(repo_id)
    .bind(name)
    .bind(new_target)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        create_ref(
            pool,
            repo_id,
            name,
            &RefTarget::Symbolic(new_target.to_string()),
        )
        .await?;
    }
    Ok(())
}

/// Delete a ref by name. A no-op if the ref does not exist.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn delete_ref(pool: &PgPool, repo_id: Uuid, name: &str) -> Result<(), SharpError> {
    sqlx::query("DELETE FROM sharp.refs WHERE repo_id = $1 AND ref_name = $2")
        .bind(repo_id)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Maximum symbolic-ref chain depth before [`resolve_ref`] gives up.
const MAX_RESOLVE_DEPTH: u32 = 8;

/// Resolve a ref to a hash SHA, following symbolic refs.
///
/// Returns `None` if the chain dead-ends (no such ref) or exceeds
/// [`MAX_RESOLVE_DEPTH`] (cycle protection).
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn resolve_ref(
    pool: &PgPool,
    repo_id: Uuid,
    name: &str,
) -> Result<Option<String>, SharpError> {
    let mut current = name.to_string();
    for _ in 0..=MAX_RESOLVE_DEPTH {
        match get_ref(pool, repo_id, &current).await? {
            None => return Ok(None),
            Some(RefTarget::Hash(sha)) => return Ok(Some(sha)),
            Some(RefTarget::Symbolic(next)) => current = next,
        }
    }
    // Depth exceeded — treat as an unresolvable (likely cyclic) chain.
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_to_target_hash() {
        let t = row_to_target("hash", Some("deadbeef".into()), None).expect("hash target");
        assert_eq!(t, RefTarget::Hash("deadbeef".into()));
    }

    #[test]
    fn row_to_target_symbolic() {
        let t = row_to_target("symbolic", None, Some("refs/heads/main".into()))
            .expect("symbolic target");
        assert_eq!(t, RefTarget::Symbolic("refs/heads/main".into()));
    }

    #[test]
    fn row_to_target_hash_missing_sha_errors() {
        assert!(row_to_target("hash", None, None).is_err());
    }

    #[test]
    fn row_to_target_symbolic_missing_target_errors() {
        assert!(row_to_target("symbolic", None, None).is_err());
    }

    #[test]
    fn row_to_target_unknown_kind_errors() {
        assert!(row_to_target("bogus", Some("x".into()), None).is_err());
    }
}
