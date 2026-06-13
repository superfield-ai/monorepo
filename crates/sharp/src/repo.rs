//! Sharp VCS repo management — `sharp init` and repo lookup.
//!
//! Repos are the root namespace for Sharp VCS objects, refs, and commits.
//! Every repo has a unique name; all objects, refs, and commits belong to a
//! repo.
//!
//! See `docs/architecture.md §Sharp — Tier-1 Rust Semantic Merge § Components (crates/sharp)`.

use crate::error::SharpError;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// A Sharp repository record.
#[derive(Debug, Clone)]
pub struct Repo {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

/// Create a new Sharp repo with the given name.
///
/// If a repo with that name already exists, the existing record is returned
/// (idempotent).
///
/// Returns the [`Repo`].
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn init(pool: &PgPool, name: &str) -> Result<Repo, SharpError> {
    let row = sqlx::query(
        r#"
        INSERT INTO sharp.repos (name)
        VALUES ($1)
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, name, created_at
        "#,
    )
    .bind(name)
    .fetch_one(pool)
    .await?;

    Ok(Repo {
        id: sqlx::Row::try_get(&row, "id")?,
        name: sqlx::Row::try_get(&row, "name")?,
        created_at: sqlx::Row::try_get(&row, "created_at")?,
    })
}

/// Look up a repo by name.
///
/// # Errors
///
/// Returns [`SharpError::RepoNotFound`] when no repo with that name exists.
pub async fn find_by_name(pool: &PgPool, name: &str) -> Result<Repo, SharpError> {
    let row = sqlx::query("SELECT id, name, created_at FROM sharp.repos WHERE name = $1")
        .bind(name)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| SharpError::RepoNotFound(name.to_owned()))?;

    Ok(Repo {
        id: sqlx::Row::try_get(&row, "id")?,
        name: sqlx::Row::try_get(&row, "name")?,
        created_at: sqlx::Row::try_get(&row, "created_at")?,
    })
}
