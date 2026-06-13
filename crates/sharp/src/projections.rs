//! Continuous speculative merge — projections.
//!
//! Ports `sharp/apps/server/src/projections.ts`.
//!
//! A projection for `(repo_id, branch_ref, target_ref)` holds the
//! always-up-to-date result of running the Tier-1 (text) merge over those two
//! branches. It is computed *lazily*: on first access or when marked stale. A
//! trigger on `sharp.refs` (see migration `0007_sharp_projections.sql`) marks
//! any matching projection stale whenever either input ref advances.
//!
//! # Port notes
//!
//! - **Commit model:** the TS prototype writes git-canonical two-parent commits
//!   plus standalone tree objects. The Rust crate uses the existing single-parent
//!   JSON commit model ([`crate::commit`]) backed by `sharp.commit_paths` (no
//!   separate tree objects). [`materialize_tree`] therefore reconstructs the
//!   path→content map from `commit_paths` rather than walking tree objects, and
//!   projection commits are stored as JSON commit objects with the branch tip as
//!   their single parent.
//! - **Hashes** are hex `String`s throughout (per `docs/rust-reorg-decisions.md`
//!   §2), not `bytea`.
//! - **Merge:** the per-path combine uses the text Tier-1 merge
//!   ([`crate::semantic_merge::three_way_merge`]); `target_ref` is the base
//!   (common-ancestor approximation for v1, a real LCA walk is a follow-up).
//!
//! See `docs/architecture.md §Sharp — Tier-1 Rust Semantic Merge § Components (crates/sharp)` and whitepaper §6.7.

use std::collections::BTreeMap;

use serde_json::Value as Json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::SharpError;
use crate::object::{self, ObjectType};
use crate::refs;
use crate::semantic_merge::three_way_merge;

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

/// Lifecycle state of a projection row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionStatus {
    /// Inputs merged cleanly; `projection_commit` holds the merged commit.
    Clean,
    /// The merge surfaced a dilemma; `dilemma` holds the payload.
    Dilemma,
    /// The projection is out of date and must be recomputed on next access.
    Stale,
    /// Recompute failed (e.g. a ref did not resolve); `dilemma` holds the reason.
    Error,
}

impl ProjectionStatus {
    /// The database string for this status.
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectionStatus::Clean => "clean",
            ProjectionStatus::Dilemma => "dilemma",
            ProjectionStatus::Stale => "stale",
            ProjectionStatus::Error => "error",
        }
    }

    /// Parse a status from its database string.
    fn parse_str(s: &str) -> Result<Self, SharpError> {
        match s {
            "clean" => Ok(ProjectionStatus::Clean),
            "dilemma" => Ok(ProjectionStatus::Dilemma),
            "stale" => Ok(ProjectionStatus::Stale),
            "error" => Ok(ProjectionStatus::Error),
            other => Err(SharpError::GitInterop(format!(
                "projection row has unknown status: {other}"
            ))),
        }
    }
}

/// A projection row, mirroring `sharp.projections`.
#[derive(Debug, Clone)]
pub struct ProjectionRow {
    pub repo_id: Uuid,
    pub branch_ref: String,
    pub target_ref: String,
    /// Hex SHA of the branch tip at compute time, if computed.
    pub branch_tip: Option<String>,
    /// Hex SHA of the target tip at compute time, if computed.
    pub target_tip: Option<String>,
    /// Hex SHA of the merged projection commit, set when `status == Clean`.
    pub projection_commit: Option<String>,
    pub status: ProjectionStatus,
    /// Dilemma / error payload, set when `status` is `Dilemma` or `Error`.
    pub dilemma: Option<Json>,
    pub computed_at: chrono::DateTime<chrono::Utc>,
}

/// The full `RETURNING` / `SELECT` column list shared by every query below.
const PROJECTION_COLS: &str = "repo_id, branch_ref, target_ref, branch_tip, target_tip, \
     projection_commit, status, dilemma, computed_at";

/// Map a [`sqlx`] row to a [`ProjectionRow`].
fn row_to_projection(r: &sqlx::postgres::PgRow) -> Result<ProjectionRow, SharpError> {
    let status: String = r.try_get("status")?;
    Ok(ProjectionRow {
        repo_id: r.try_get("repo_id")?,
        branch_ref: r.try_get("branch_ref")?,
        target_ref: r.try_get("target_ref")?,
        branch_tip: r.try_get("branch_tip")?,
        target_tip: r.try_get("target_tip")?,
        projection_commit: r.try_get("projection_commit")?,
        status: ProjectionStatus::parse_str(&status)?,
        dilemma: r.try_get("dilemma")?,
        computed_at: r.try_get("computed_at")?,
    })
}

/// Identity used as author/committer for projection commits.
const SHARP_PROJECTION_AUTHOR: &str = "Sharp <sharp-projection@sharp.dev>";

// ───────────────────────────────────────────────────────────────────────────────
// CRUD helpers
// ───────────────────────────────────────────────────────────────────────────────

/// Register a projection for `(repo_id, branch_ref, target_ref)`, or reset an
/// existing one to `stale`. Returns the (stale) row; call [`recompute_projection`]
/// or [`get_projection`] to materialize it.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn register_projection(
    pool: &PgPool,
    repo_id: Uuid,
    branch_ref: &str,
    target_ref: &str,
) -> Result<ProjectionRow, SharpError> {
    let sql = format!(
        r#"
        INSERT INTO sharp.projections (repo_id, branch_ref, target_ref, status)
        VALUES ($1, $2, $3, 'stale')
        ON CONFLICT (repo_id, branch_ref, target_ref) DO UPDATE
            SET status = 'stale', computed_at = now()
        RETURNING {PROJECTION_COLS}
        "#
    );
    let row = sqlx::query(&sql)
        .bind(repo_id)
        .bind(branch_ref)
        .bind(target_ref)
        .fetch_one(pool)
        .await?;
    row_to_projection(&row)
}

/// List projections in a repo, optionally filtered by `status`, ordered by
/// `(branch_ref, target_ref)`.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn list_projections(
    pool: &PgPool,
    repo_id: Uuid,
    status: Option<ProjectionStatus>,
) -> Result<Vec<ProjectionRow>, SharpError> {
    let rows = match status {
        Some(s) => {
            let sql = format!(
                r#"
                SELECT {PROJECTION_COLS}
                FROM   sharp.projections
                WHERE  repo_id = $1 AND status = $2
                ORDER  BY branch_ref, target_ref
                "#
            );
            sqlx::query(&sql)
                .bind(repo_id)
                .bind(s.as_str())
                .fetch_all(pool)
                .await?
        }
        None => {
            let sql = format!(
                r#"
                SELECT {PROJECTION_COLS}
                FROM   sharp.projections
                WHERE  repo_id = $1
                ORDER  BY branch_ref, target_ref
                "#
            );
            sqlx::query(&sql).bind(repo_id).fetch_all(pool).await?
        }
    };
    rows.iter().map(row_to_projection).collect()
}

/// Delete a projection. A no-op if it does not exist.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn delete_projection(
    pool: &PgPool,
    repo_id: Uuid,
    branch_ref: &str,
    target_ref: &str,
) -> Result<(), SharpError> {
    sqlx::query(
        r#"
        DELETE FROM sharp.projections
        WHERE repo_id = $1 AND branch_ref = $2 AND target_ref = $3
        "#,
    )
    .bind(repo_id)
    .bind(branch_ref)
    .bind(target_ref)
    .execute(pool)
    .await?;
    Ok(())
}

/// Return the projection row, recomputing it if stale. Returns `None` if no
/// projection has been registered for `(repo_id, branch_ref, target_ref)`.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn get_projection(
    pool: &PgPool,
    repo_id: Uuid,
    branch_ref: &str,
    target_ref: &str,
) -> Result<Option<ProjectionRow>, SharpError> {
    let sql = format!(
        r#"
        SELECT {PROJECTION_COLS}
        FROM   sharp.projections
        WHERE  repo_id = $1 AND branch_ref = $2 AND target_ref = $3
        LIMIT  1
        "#
    );
    let row = sqlx::query(&sql)
        .bind(repo_id)
        .bind(branch_ref)
        .bind(target_ref)
        .fetch_optional(pool)
        .await?;

    let Some(row) = row else { return Ok(None) };
    let projection = row_to_projection(&row)?;
    if projection.status == ProjectionStatus::Stale {
        return recompute_projection(pool, repo_id, branch_ref, target_ref)
            .await
            .map(Some);
    }
    Ok(Some(projection))
}

// ───────────────────────────────────────────────────────────────────────────────
// Materialization
// ───────────────────────────────────────────────────────────────────────────────

/// Materialize a commit's file tree into a `path → content` map.
///
/// Reconstructs the tree from `sharp.commit_paths` (the single-parent JSON
/// commit model; no separate tree objects). Each non-deletion row's blob is
/// loaded and decoded as UTF-8; deletion rows (`blob_sha IS NULL`) are skipped.
/// Binary blobs that are not valid UTF-8 are decoded lossily, matching the TS
/// prototype's "non-text paths do not crash the merge" behavior.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error or [`SharpError::ObjectNotFound`]
/// if a referenced blob is missing.
pub async fn materialize_tree(
    pool: &PgPool,
    repo_id: Uuid,
    commit_sha: &str,
) -> Result<BTreeMap<String, String>, SharpError> {
    let rows = sqlx::query(
        r#"
        SELECT path, blob_sha
        FROM   sharp.commit_paths
        WHERE  repo_id = $1 AND commit_sha = $2
        ORDER  BY path
        "#,
    )
    .bind(repo_id)
    .bind(commit_sha)
    .fetch_all(pool)
    .await?;

    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for r in &rows {
        let path: String = r.try_get("path")?;
        let blob_sha: Option<String> = r.try_get("blob_sha")?;
        let Some(blob_sha) = blob_sha else { continue };
        let data = object::load(pool, &blob_sha).await?;
        out.insert(path, String::from_utf8_lossy(&data).into_owned());
    }
    Ok(out)
}

// ───────────────────────────────────────────────────────────────────────────────
// Recompute
// ───────────────────────────────────────────────────────────────────────────────

/// Combine `branch` over `target` per path using the text Tier-1 merge.
///
/// `target` is treated as the merge base (v1 LCA approximation). For each path:
/// the base is its `target` content (or empty if absent), `ours` is the `branch`
/// content (or empty), `theirs` is the `target` content (or empty). The result
/// is the union of all paths. A path present in `branch` but absent in `target`
/// is taken verbatim from `branch`; a `target`-only path is taken verbatim.
fn combine_text(
    branch: &BTreeMap<String, String>,
    target: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut merged: BTreeMap<String, String> = BTreeMap::new();
    for path in branch.keys().chain(target.keys()) {
        if merged.contains_key(path) {
            continue;
        }
        match (branch.get(path), target.get(path)) {
            // Present on both sides → 3-way merge with target as the base.
            (Some(ours), Some(theirs)) => {
                merged.insert(path.clone(), three_way_merge(theirs, ours, theirs));
            }
            // Branch-only or target-only → take the present side verbatim. A
            // path missing on the other side is an addition, not a deletion;
            // running the line merge would read the absent side as an empty
            // file and drop the content.
            (Some(only), None) | (None, Some(only)) => {
                merged.insert(path.clone(), only.clone());
            }
            (None, None) => unreachable!("path came from one of the two maps"),
        }
    }
    merged
}

/// Whether any merged file still carries conflict markers, indicating the text
/// merge could not resolve cleanly (the projection's "dilemma" condition).
fn has_conflict(files: &BTreeMap<String, String>) -> bool {
    files
        .values()
        .any(|c| c.contains("<<<<<<< ours") || c.contains(">>>>>>> theirs"))
}

/// Write a `path → content` map as a single-parent JSON projection commit.
///
/// Stores each file's content as a blob, records the blobs as `commit_paths`,
/// and writes a JSON commit object (the same shape [`crate::commit::commit`]
/// produces) with `parent` set to `branch_tip`. Unlike [`crate::commit::commit`],
/// this does **not** move any branch ref — a projection is not a branch and must
/// not retrigger the stale trigger. Returns the projection commit SHA.
async fn write_projection_commit(
    pool: &PgPool,
    repo_id: Uuid,
    branch_tip: &str,
    branch_ref: &str,
    target_ref: &str,
    files: &BTreeMap<String, String>,
) -> Result<String, SharpError> {
    // Store blobs and collect (path, blob_sha) pairs.
    let mut paths: Vec<(String, String)> = Vec::with_capacity(files.len());
    for (path, content) in files {
        let blob_sha = object::store(pool, repo_id, ObjectType::Blob, content.as_bytes()).await?;
        paths.push((path.clone(), blob_sha));
    }

    let message = format!("sharp: projection of {branch_ref} onto {target_ref}\n");
    let payload = serde_json::json!({
        "tree":    Json::Null,
        "parent":  branch_tip,
        "message": message,
        "author":  SHARP_PROJECTION_AUTHOR,
    });
    let data =
        serde_json::to_vec(&payload).expect("serde_json::to_vec never fails for a simple Value");
    let commit_sha = object::store(pool, repo_id, ObjectType::Commit, &data).await?;

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
    .bind(branch_tip)
    .bind(&message)
    .bind(SHARP_PROJECTION_AUTHOR)
    .execute(pool)
    .await?;

    for (path, blob_sha) in &paths {
        sqlx::query(
            r#"
            INSERT INTO sharp.commit_paths (commit_sha, repo_id, path, blob_sha)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(&commit_sha)
        .bind(repo_id)
        .bind(path)
        .bind(blob_sha)
        .execute(pool)
        .await?;
    }

    Ok(commit_sha)
}

/// Update a projection row to `error` with no resolved tips (a ref did not
/// resolve). Returns the updated row.
async fn store_error(
    pool: &PgPool,
    repo_id: Uuid,
    branch_ref: &str,
    target_ref: &str,
    reason: &str,
) -> Result<ProjectionRow, SharpError> {
    let sql = format!(
        r#"
        UPDATE sharp.projections
           SET status = 'error',
               dilemma = $4,
               computed_at = now()
         WHERE repo_id = $1 AND branch_ref = $2 AND target_ref = $3
        RETURNING {PROJECTION_COLS}
        "#
    );
    let row = sqlx::query(&sql)
        .bind(repo_id)
        .bind(branch_ref)
        .bind(target_ref)
        .bind(serde_json::json!({ "reason": reason }))
        .fetch_one(pool)
        .await?;
    row_to_projection(&row)
}

/// Recompute the projection on the current ref tips and persist the result.
///
/// Resolves `branch_ref` and `target_ref` to their current tips, materializes
/// each commit's file tree, combines `branch` over `target` with the text Tier-1
/// merge, and updates the row:
///
/// - both refs resolve and the merge is conflict-free → `clean`, with a fresh
///   projection commit;
/// - the merge leaves conflict markers → `dilemma`, no commit;
/// - either ref fails to resolve → `error`.
///
/// Always returns the updated row.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error or [`SharpError::ObjectNotFound`]
/// if a referenced blob is missing.
pub async fn recompute_projection(
    pool: &PgPool,
    repo_id: Uuid,
    branch_ref: &str,
    target_ref: &str,
) -> Result<ProjectionRow, SharpError> {
    let branch_tip = refs::resolve_ref(pool, repo_id, branch_ref).await?;
    let target_tip = refs::resolve_ref(pool, repo_id, target_ref).await?;

    let (Some(branch_tip), Some(target_tip)) = (branch_tip, target_tip) else {
        return store_error(
            pool,
            repo_id,
            branch_ref,
            target_ref,
            "branch_ref or target_ref did not resolve",
        )
        .await;
    };

    let branch_files = materialize_tree(pool, repo_id, &branch_tip).await?;
    let target_files = materialize_tree(pool, repo_id, &target_tip).await?;

    let merged = combine_text(&branch_files, &target_files);

    if has_conflict(&merged) {
        let involved: Vec<&String> = merged
            .iter()
            .filter(|(_, c)| c.contains("<<<<<<< ours") || c.contains(">>>>>>> theirs"))
            .map(|(p, _)| p)
            .collect();
        let dilemma = serde_json::json!({
            "sharp_dilemma": 1,
            "kind": "dilemma",
            "reason": "text merge produced conflicts",
            "involved_paths": involved,
        });
        let sql = format!(
            r#"
            UPDATE sharp.projections
               SET status = 'dilemma',
                   branch_tip = $4,
                   target_tip = $5,
                   projection_commit = NULL,
                   dilemma = $6,
                   computed_at = now()
             WHERE repo_id = $1 AND branch_ref = $2 AND target_ref = $3
            RETURNING {PROJECTION_COLS}
            "#
        );
        let row = sqlx::query(&sql)
            .bind(repo_id)
            .bind(branch_ref)
            .bind(target_ref)
            .bind(&branch_tip)
            .bind(&target_tip)
            .bind(dilemma)
            .fetch_one(pool)
            .await?;
        return row_to_projection(&row);
    }

    let commit_sha =
        write_projection_commit(pool, repo_id, &branch_tip, branch_ref, target_ref, &merged)
            .await?;

    let sql = format!(
        r#"
        UPDATE sharp.projections
           SET status = 'clean',
               branch_tip = $4,
               target_tip = $5,
               projection_commit = $6,
               dilemma = NULL,
               computed_at = now()
         WHERE repo_id = $1 AND branch_ref = $2 AND target_ref = $3
        RETURNING {PROJECTION_COLS}
        "#
    );
    let row = sqlx::query(&sql)
        .bind(repo_id)
        .bind(branch_ref)
        .bind(target_ref)
        .bind(&branch_tip)
        .bind(&target_tip)
        .bind(&commit_sha)
        .fetch_one(pool)
        .await?;
    row_to_projection(&row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_round_trips() {
        for s in [
            ProjectionStatus::Clean,
            ProjectionStatus::Dilemma,
            ProjectionStatus::Stale,
            ProjectionStatus::Error,
        ] {
            assert_eq!(ProjectionStatus::parse_str(s.as_str()).unwrap(), s);
        }
    }

    #[test]
    fn status_unknown_errors() {
        assert!(ProjectionStatus::parse_str("bogus").is_err());
    }

    #[test]
    fn combine_takes_branch_only_path_verbatim() {
        let mut branch = BTreeMap::new();
        branch.insert("a.rs".to_string(), "fn a() {}\n".to_string());
        let target = BTreeMap::new();
        let merged = combine_text(&branch, &target);
        assert_eq!(merged.get("a.rs").map(String::as_str), Some("fn a() {}\n"));
    }

    #[test]
    fn combine_takes_target_only_path_verbatim() {
        let branch = BTreeMap::new();
        let mut target = BTreeMap::new();
        target.insert("b.rs".to_string(), "fn b() {}\n".to_string());
        let merged = combine_text(&branch, &target);
        assert_eq!(merged.get("b.rs").map(String::as_str), Some("fn b() {}\n"));
    }

    #[test]
    fn combine_clean_when_only_branch_changed() {
        // base == theirs == target, ours == branch differs → take branch.
        let mut branch = BTreeMap::new();
        branch.insert("f.rs".to_string(), "v2\n".to_string());
        let mut target = BTreeMap::new();
        target.insert("f.rs".to_string(), "v1\n".to_string());
        let merged = combine_text(&branch, &target);
        // base = target ("v1"), ours = branch ("v2"), theirs = target ("v1")
        // → base == theirs → take ours.
        assert_eq!(merged.get("f.rs").map(String::as_str), Some("v2\n"));
        assert!(!has_conflict(&merged));
    }

    #[test]
    fn has_conflict_detects_markers() {
        let mut files = BTreeMap::new();
        files.insert(
            "c.rs".to_string(),
            "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n".to_string(),
        );
        assert!(has_conflict(&files));
    }

    #[test]
    fn has_conflict_false_for_clean() {
        let mut files = BTreeMap::new();
        files.insert("c.rs".to_string(), "clean\n".to_string());
        assert!(!has_conflict(&files));
    }
}
