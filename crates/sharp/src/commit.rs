//! Sharp VCS commit and branch operations — `sharp commit` and `sharp branch`.
//!
//! A commit stores a tree SHA, parent SHA, message, and author.  The commit
//! object is stored in `sharp.objects`; denormalised metadata is stored in
//! `sharp.commit_metadata`.  Refs (branches) point to commit objects via
//! `sharp.refs`.
//!
//! See `docs/architecture.md` §sharp schema.

use crate::error::SharpError;
use crate::object::{self, ObjectType};
use crate::refs;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// A commit record from `sharp.commit_metadata`.
#[derive(Debug, Clone)]
pub struct CommitRecord {
    pub commit_sha: String,
    pub repo_id: Uuid,
    pub parent_sha: Option<String>,
    pub message: String,
    pub author: String,
    pub authored_at: DateTime<Utc>,
    pub committed_at: DateTime<Utc>,
}

/// Create a commit and update the named branch ref.
///
/// Serialises the commit payload as JSON, stores it as a commit object, writes
/// `commit_metadata`, records `commit_paths` for each `(path, blob_sha)` pair,
/// and upserts the branch ref.
///
/// Returns the SHA-256 hex of the new commit object.
///
/// # Arguments
///
/// * `pool`       — shared connection pool
/// * `repo_id`    — target repo
/// * `branch`     — branch name, e.g. `"main"` (stored as `refs/heads/main`)
/// * `tree_sha`   — SHA of the tree object being committed
/// * `parent_sha` — SHA of the parent commit, or `None` for a root commit
/// * `message`    — commit message
/// * `author`     — author identity string
/// * `paths`      — `(file_path, blob_sha_or_none)` pairs (deletions have `None`)
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
#[allow(clippy::too_many_arguments)]
pub async fn commit(
    pool: &PgPool,
    repo_id: Uuid,
    branch: &str,
    tree_sha: &str,
    parent_sha: Option<&str>,
    message: &str,
    author: &str,
    paths: &[(String, Option<String>)],
) -> Result<String, SharpError> {
    let payload = serde_json::json!({
        "tree":   tree_sha,
        "parent": parent_sha,
        "message": message,
        "author": author,
    });
    let data =
        serde_json::to_vec(&payload).expect("serde_json::to_vec never fails for a simple Value");

    let commit_sha = object::store(pool, repo_id, ObjectType::Commit, &data).await?;

    // Upsert commit_metadata
    sqlx::query(
        r#"
        INSERT INTO sharp.commit_metadata
            (commit_sha, repo_id, parent_sha, message, author, authored_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (commit_sha) DO NOTHING
        "#,
    )
    .bind(&commit_sha)
    .bind(repo_id)
    .bind(parent_sha)
    .bind(message)
    .bind(author)
    .execute(pool)
    .await?;

    // Insert commit_paths
    for (path, blob_sha) in paths {
        sqlx::query(
            r#"
            INSERT INTO sharp.commit_paths (commit_sha, repo_id, path, blob_sha)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(&commit_sha)
        .bind(repo_id)
        .bind(path)
        .bind(blob_sha.as_deref())
        .execute(pool)
        .await?;
    }

    // Upsert the branch ref via the refs model.
    let ref_name = format!("refs/heads/{branch}");
    refs::set_ref(pool, repo_id, &ref_name, &commit_sha).await?;

    Ok(commit_sha)
}

/// Create a new branch pointing at an existing commit SHA.
///
/// If the branch already exists, its `target_sha` is updated.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn create_branch(
    pool: &PgPool,
    repo_id: Uuid,
    branch: &str,
    target_sha: &str,
) -> Result<(), SharpError> {
    let ref_name = format!("refs/heads/{branch}");
    refs::set_ref(pool, repo_id, &ref_name, target_sha).await?;
    Ok(())
}

/// Look up the commit SHA that a branch currently points to.
///
/// # Errors
///
/// Returns [`SharpError::RefNotFound`] when the branch does not exist.
pub async fn branch_head(pool: &PgPool, repo_id: Uuid, branch: &str) -> Result<String, SharpError> {
    let ref_name = format!("refs/heads/{branch}");
    refs::resolve_ref(pool, repo_id, &ref_name)
        .await?
        .ok_or(SharpError::RefNotFound(ref_name))
}

/// Return all commit_metadata rows for `repo_id` in reverse chronological order.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn log(pool: &PgPool, repo_id: Uuid) -> Result<Vec<CommitRecord>, SharpError> {
    let rows = sqlx::query(
        r#"
        SELECT commit_sha, repo_id, parent_sha, message, author,
               authored_at, committed_at
        FROM   sharp.commit_metadata
        WHERE  repo_id = $1
        ORDER  BY committed_at DESC
        "#,
    )
    .bind(repo_id)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|r| {
            Ok(CommitRecord {
                commit_sha: r.try_get("commit_sha")?,
                repo_id: r.try_get("repo_id")?,
                parent_sha: r.try_get("parent_sha")?,
                message: r.try_get("message")?,
                author: r.try_get("author")?,
                authored_at: r.try_get("authored_at")?,
                committed_at: r.try_get("committed_at")?,
            })
        })
        .collect()
}
