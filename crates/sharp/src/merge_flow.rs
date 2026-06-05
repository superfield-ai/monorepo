//! Self-hosting merge flow — Sharp manages Superfield's own Rust source.
//!
//! This module is the production entry point for the self-hosting gate
//! (issue #447).  It orchestrates the full merge pipeline for Superfield's
//! own Rust workspace (`crates/sharp`) through Sharp:
//!
//! 1. **Onboarding** — registers the workspace as a Sharp repo via
//!    [`repo::init`][crate::repo::init].
//! 2. **Merge routing** — every merge request passes through
//!    [`semantic_merge_rust`][crate::semantic_merge::semantic_merge_rust]:
//!    rename detection via rust-analyzer, 3-way textual baseline, and the
//!    `cargo check` structural verification gate.
//! 3. **Episode recording** — opens an episode, appends a `merge_result`
//!    event, then finishes the episode so the merge is fully traceable.
//!
//! # Merge guarantee
//!
//! A merge that produces non-compiling output is **refused** before it
//! reaches storage.  The gate is exercised end-to-end on Superfield's own
//! Rust source, proving the no-non-compiling-merge guarantee at production
//! scale.
//!
//! # Usage
//!
//! ```no_run
//! use sharp::merge_flow::{MergeRequest, run_merge_flow};
//! use sharp::semantic_merge::{FileVersion, MergeOptions};
//! use sqlx::PgPool;
//! use std::path::PathBuf;
//!
//! async fn example(pool: &PgPool) {
//!     let req = MergeRequest {
//!         repo_name: "superfield-ai/superfield-cli-ts".to_string(),
//!         workspace_root: PathBuf::from("/path/to/workspace"),
//!         base_files: vec![],
//!         our_files: vec![],
//!         their_files: vec![],
//!         merge_options: MergeOptions::default(),
//!         pr_title: "feat: example PR".to_string(),
//!     };
//!     let result = run_merge_flow(pool, req).await.unwrap();
//!     println!("Merged {} files, episode: {}", result.files_merged, result.episode_id);
//! }
//! ```
//!
//! §architecture.md — Sharp subsystem (Self-hosting gate)

use crate::episode;
use crate::error::SharpError;
use crate::repo;
use crate::semantic_merge::{semantic_merge_rust, FileVersion, MergeOptions, MergeResult};
use sqlx::PgPool;
use uuid::Uuid;

// ── Public types ──────────────────────────────────────────────────────────────

/// A merge request through the Sharp self-hosting gate.
#[derive(Debug)]
pub struct MergeRequest {
    /// The Sharp repo name (e.g. `"superfield-ai/superfield-cli-ts"`).
    pub repo_name: String,
    /// Absolute path to the Cargo workspace root.
    pub workspace_root: std::path::PathBuf,
    /// Common ancestor file versions (base of the 3-way merge).
    pub base_files: Vec<FileVersion>,
    /// "Our" branch file versions (may include renames).
    pub our_files: Vec<FileVersion>,
    /// "Their" branch file versions (edits against the common ancestor).
    pub their_files: Vec<FileVersion>,
    /// Workspace and tooling configuration for the semantic merge.
    pub merge_options: MergeOptions,
    /// Human-readable title for the merge episode (e.g. the PR title).
    pub pr_title: String,
}

/// The outcome of a successful merge through the self-hosting gate.
#[derive(Debug)]
pub struct MergeOutcome {
    /// The episode ID that records this merge for audit/tracing.
    pub episode_id: Uuid,
    /// The Sharp repo ID the merge was recorded against.
    pub repo_id: Uuid,
    /// Number of files in the merged result.
    pub files_merged: usize,
    /// Number of renames detected and propagated.
    pub renames_propagated: usize,
    /// The full merge result (merged file contents, detected renames).
    pub merge_result: MergeResult,
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Run the full Sharp merge flow for one merge request.
///
/// Steps:
/// 1. Ensures the repo is registered (idempotent `repo::init`).
/// 2. Opens a merge episode.
/// 3. Runs the Rust semantic merge (rename detection + cargo check gate).
/// 4. Records the merge result as an episode event.
/// 5. Finishes the episode.
///
/// Returns a [`MergeOutcome`] on success, or a [`SharpError`] if the merge
/// is refused (e.g. non-compiling output) or any infrastructure step fails.
///
/// # Errors
///
/// - [`SharpError::MergeRefused`] — the merged result failed `cargo check`.
/// - [`SharpError::Db`] — a database operation failed.
/// - Other variants for rust-analyzer or I/O failures.
pub async fn run_merge_flow(pool: &PgPool, req: MergeRequest) -> Result<MergeOutcome, SharpError> {
    // Step 1: Ensure the repo is registered.
    let r = repo::init(pool, &req.repo_name).await?;

    // Step 2: Open a merge episode.
    let ep = episode::open(pool, r.id, &req.pr_title).await?;

    // Step 3: Run semantic merge (rename detection + cargo check gate).
    // If the merge is refused (non-compiling), we close the episode as failed
    // before returning the error so the audit trail is complete.
    let merge_result = match semantic_merge_rust(
        &req.base_files,
        &req.our_files,
        &req.their_files,
        &req.merge_options,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            // Record the refusal in the episode before surfacing the error.
            let _ = episode::append(
                pool,
                ep.id,
                "merge_refused",
                serde_json::json!({
                    "reason": e.to_string(),
                    "repo": req.repo_name,
                    "workspace": req.workspace_root.to_string_lossy(),
                }),
            )
            .await;
            let _ = episode::finish(pool, ep.id).await;
            return Err(e);
        }
    };

    // Step 4: Record the successful merge result as an episode event.
    let rename_descriptions: Vec<String> = merge_result
        .renames
        .iter()
        .map(|r| format!("{} → {}", r.old_name, r.new_name))
        .collect();

    episode::append(
        pool,
        ep.id,
        "merge_result",
        serde_json::json!({
            "type": "rust_semantic_merge",
            "repo": req.repo_name,
            "workspace": req.workspace_root.to_string_lossy(),
            "renames_propagated": rename_descriptions,
            "merged_files": merge_result.files.len(),
            "compile_gate": "passed",
        }),
    )
    .await?;

    // Step 5: Finish the episode.
    episode::finish(pool, ep.id).await?;

    Ok(MergeOutcome {
        episode_id: ep.id,
        repo_id: r.id,
        files_merged: merge_result.files.len(),
        renames_propagated: merge_result.renames.len(),
        merge_result,
    })
}

// ── Onboarding ────────────────────────────────────────────────────────────────

/// Onboard a Rust workspace onto Sharp as its primary VCS.
///
/// Registers the given `repo_name` (idempotent) and returns the Sharp repo
/// record.  After onboarding, all merges for this workspace should go through
/// [`run_merge_flow`].
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn onboard_workspace(
    pool: &PgPool,
    repo_name: &str,
) -> Result<repo::Repo, SharpError> {
    repo::init(pool, repo_name).await
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic_merge::{FileVersion, MergeOptions};
    use std::path::PathBuf;

    /// Verify that `MergeRequest` can be constructed with representative
    /// Superfield Rust repo values — pure type test, no DB or cargo required.
    #[test]
    fn merge_request_fields_are_correct() {
        let req = MergeRequest {
            repo_name: "superfield-ai/superfield-cli-ts".to_string(),
            workspace_root: PathBuf::from("/repo/crates/sharp"),
            base_files: vec![FileVersion {
                path: PathBuf::from("src/lib.rs"),
                content: "pub fn foo() {}".to_string(),
            }],
            our_files: vec![FileVersion {
                path: PathBuf::from("src/lib.rs"),
                content: "pub fn bar() {}".to_string(),
            }],
            their_files: vec![FileVersion {
                path: PathBuf::from("src/lib.rs"),
                content: "pub fn foo() { println!(\"hi\"); }".to_string(),
            }],
            merge_options: MergeOptions {
                workspace_root: PathBuf::from("/repo/crates/sharp"),
                rust_analyzer_path: None,
                ra_timeout_ms: 60_000,
            },
            pr_title: "feat(sharp): self-hosting gate".to_string(),
        };

        assert_eq!(req.repo_name, "superfield-ai/superfield-cli-ts");
        assert_eq!(req.workspace_root, PathBuf::from("/repo/crates/sharp"));
        assert_eq!(req.base_files.len(), 1);
        assert_eq!(req.our_files.len(), 1);
        assert_eq!(req.their_files.len(), 1);
        assert_eq!(req.pr_title, "feat(sharp): self-hosting gate");
        assert_eq!(req.merge_options.ra_timeout_ms, 60_000);
    }
}
