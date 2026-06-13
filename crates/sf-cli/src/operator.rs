//! Operator CLI commands.
//!
//! Operator commands let a human or automated operator manage the shared
//! Postgres store:
//!
//! - **`repo init`** — create or get a Sharp repo (idempotent).
//! - **`repo list`** — list all repos.
//! - **`session issue`** — issue a session token for a workspace/user/role.
//!
//! All output is written to stdout as line-delimited text.  Callers who need
//! structured output should use the returned values directly rather than
//! parsing stdout.
//!
//! # Architecture
//!
//! See `docs/architecture.md` §CLI — Command Surface.  Operator commands are
//! the human-steering surface of the owned stack;
//! they use the same `sf-db` pool and `sharp` crate as agent commands.

use sf_auth::{Role, Session, SessionStore};
use sharp::repo;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

/// Errors from operator commands.
#[derive(Debug, Error)]
pub enum OperatorError {
    /// A Sharp error (repo not found, DB error, etc.).
    #[error("sharp error: {0}")]
    Sharp(#[from] sharp::SharpError),

    /// A session error (DB error, etc.).
    #[error("session error: {0}")]
    Session(#[from] sf_auth::SessionError),

    /// A raw database error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// Create or get a Sharp repo by name and print its ID.
///
/// Delegates to [`sharp::repo::init`] which is idempotent: if a repo with
/// `name` already exists, the existing record is returned.
///
/// # Output
///
/// Prints `repo.id  repo.name` to stdout.
pub async fn repo_init(pool: &PgPool, name: &str) -> Result<(), OperatorError> {
    let r = repo::init(pool, name).await?;
    println!("{}  {}", r.id, r.name);
    Ok(())
}

/// List all Sharp repos and print their IDs and names.
///
/// # Output
///
/// Prints one `repo.id  repo.name` line per repo to stdout.
pub async fn repo_list(pool: &PgPool) -> Result<(), OperatorError> {
    let rows = sqlx::query("SELECT id, name, created_at FROM sharp.repos ORDER BY created_at")
        .fetch_all(pool)
        .await?;
    if rows.is_empty() {
        println!("(no repos)");
    } else {
        for row in &rows {
            let id: Uuid = sqlx::Row::try_get(row, "id")?;
            let name: String = sqlx::Row::try_get(row, "name")?;
            println!("{}  {}", id, name);
        }
    }
    Ok(())
}

/// Issue a session token for a workspace/user/role triple and print it.
///
/// Delegates to [`SessionStore::issue`].  The printed token is an opaque UUID
/// that the holder passes as a bearer token in subsequent requests.
///
/// # Output
///
/// Prints the session token UUID to stdout.
pub async fn session_issue(
    pool: &PgPool,
    workspace_id: Uuid,
    user_id: Uuid,
    role: Role,
) -> Result<(), OperatorError> {
    let store = SessionStore::new(pool.clone(), None);
    let session: Session = store.issue(workspace_id, user_id, role).await?;
    println!("{}", session.token);
    Ok(())
}

#[cfg(test)]
mod tests {
    // Integration tests that require a live Postgres instance are gated behind
    // `DATABASE_URL` so they are skipped in offline CI.
    //
    // Run them with:
    //   DATABASE_URL=postgres://… cargo test -p sf-cli -- --include-ignored integration

    /// Verify that parsing a valid role string succeeds.
    #[test]
    fn role_roundtrip() {
        use sf_auth::Role;
        assert_eq!(Role::Admin.as_str(), "admin");
        assert_eq!(Role::Member.as_str(), "member");
        assert_eq!(Role::Viewer.as_str(), "viewer");
    }
}
