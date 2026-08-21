//! Step: CodeChangeProposal — propose a validated source change through the
//! Sharp semantic-merge gate (issue #706).
//!
//! This is the step that converts the appliance from a knowledge gardener into
//! a self-improving software project (PRD §1/§5: agents propose *validated code
//! changes* humans approve). Where every other gardening step writes documents
//! (`nexum.page_revisions`) or project-graph nodes (`nexum.project_nodes`), this
//! step:
//!
//! 1. Selects an open Issue/Feature node from the project graph
//!    ([`sf_db::list_nodes`]).
//! 2. Asks the agent executor for a proposed source diff scoped to that node.
//! 3. Opens a Sharp episode and runs
//!    [`sharp::semantic_merge::semantic_merge_rust`] + `cargo check` as the
//!    validation gate (via [`sharp::merge_flow::run_merge_flow`]).
//! 4. Stores the candidate change with provenance **only if it compiles**.
//!    A proposal that fails to compile is refused
//!    ([`sharp::SharpError::MergeRefused`]) and discarded — never stored.
//!
//! # Proposal format
//!
//! The agent emits a single target file's full proposed contents, framed by a
//! leading `FILE:` line:
//!
//! ```text
//! FILE: crates/foo/src/lib.rs
//! pub fn improved() -> u32 { 42 }
//! ```
//!
//! [`parse_proposal`] extracts the `(path, content)` pair. The merge then runs
//! `ours = proposed`, `theirs = base`, so the gate validates that the proposed
//! file compiles against the rest of the workspace. A proposal with no `FILE:`
//! line is treated as empty (the step advances the cursor without proposing).
//!
//! # No-store guarantee
//!
//! The store is the Sharp episode: a `merge_result` event is appended **after**
//! the compile gate passes. On [`sharp::SharpError::MergeRefused`],
//! `run_merge_flow` records a `merge_refused` event (audit) and surfaces the
//! error; this step swallows that specific error so the loop's cursor still
//! advances, but the *candidate change* (`merge_result`) is never stored. Any
//! other Sharp error propagates as a [`StepError`].
//!
//! # Workspace root
//!
//! The compile gate needs a real Cargo workspace. The root is read from
//! `SF_CODE_CHANGE_WORKSPACE` (falling back to the current directory). In CI /
//! unit tests there is no DB and no cargo workspace wired in, so the DB-gated
//! integration tests are `#[ignore]`d (matching the other loop steps); the
//! pure-parse unit tests below run everywhere.

use crate::agent::{AgentExecutor, AgentRequest};
use crate::steps::{StepError, StepOutcome};
use sharp::merge_flow::{run_merge_flow, MergeRequest};
use sharp::semantic_merge::{FileVersion, MergeOptions};
use sharp::SharpError;
use std::path::PathBuf;
use uuid::Uuid;

/// The Sharp repo name the loop's code-change candidates are recorded against.
const REPO_NAME: &str = "superfield-ai/monorepo";

/// A parsed code-change proposal: the target path and its full proposed content.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Proposal {
    /// Relative path of the file the agent proposes to change.
    pub path: String,
    /// Full proposed contents of that file.
    pub content: String,
}

/// Parse the agent's proposal output.
///
/// Recognises a leading `FILE:` line (case-insensitive, leading markdown
/// bullet / fence / whitespace tolerated). Everything after that line — minus a
/// trailing fence — is the proposed file content. Returns `None` when no
/// `FILE:` line or an empty/blank path is found.
pub(crate) fn parse_proposal(text: &str) -> Option<Proposal> {
    // Find the FILE: line; capture its path.
    let mut path: Option<String> = None;
    let mut content_lines: Vec<&str> = Vec::new();
    let mut in_body = false;

    for raw in text.lines() {
        if !in_body {
            // Strip a leading markdown fence (``` / ```rust) before the marker.
            let trimmed = raw.trim_start_matches([' ', '\t', '-', '*', '+']).trim();
            if trimmed.starts_with("```") {
                continue;
            }
            if let Some(rest) = strip_prefix_ci(trimmed, "FILE:") {
                let p = rest.trim().trim_matches('`').trim();
                if !p.is_empty() {
                    path = Some(p.to_string());
                    in_body = true;
                }
            }
            continue;
        }

        // In the body: stop at a closing fence.
        if raw.trim() == "```" {
            break;
        }
        content_lines.push(raw);
    }

    let path = path?;
    let mut content = content_lines.join("\n");
    if !content.is_empty() {
        content.push('\n');
    }
    Some(Proposal { path, content })
}

/// Case-insensitive prefix strip. Returns the remainder if `s` starts with
/// `prefix` (ignoring ASCII case), else `None`.
fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// Resolve the Cargo workspace root for the compile gate.
fn workspace_root() -> PathBuf {
    std::env::var("SF_CODE_CHANGE_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default())
}

/// Build the agent request that asks for a source diff scoped to `node_title`.
fn build_request(node_title: &str) -> AgentRequest {
    let system = "You are a senior Rust engineer improving the Superfield codebase. \
                  Propose the smallest source change that advances the selected work item. \
                  Emit exactly one file's full new contents in this format:\n\
                  FILE: <relative path to a .rs file>\n\
                  <the complete new file contents>\n\
                  Output only the FILE: line and the file body — no prose, no diff markers, \
                  no markdown fences. The change MUST compile.";
    let user = format!(
        "Selected work item: {node_title}\n\n\
         Propose a validated Rust source change for this item."
    );
    AgentRequest {
        system: system.to_string(),
        user,
    }
}

/// Run the CodeChangeProposal step.
///
/// Selects an open Issue/Feature node, asks the executor for a proposed source
/// change, and gates it through Sharp's semantic merge + `cargo check`. On a
/// compiling proposal the candidate is stored as a Sharp episode `merge_result`
/// event. A non-compiling proposal is refused and discarded (the step still
/// returns `Ok` so the cursor advances). Returns an empty [`StepOutcome`] with
/// no work when there is no open node; otherwise the returned outcome carries
/// the cost the executor reported (issue #712).
pub(super) async fn run(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    executor: &dyn AgentExecutor,
) -> Result<StepOutcome, StepError> {
    // Step 1: select an open Issue/Feature node.
    let Some(node) = select_open_node(pool).await? else {
        // Nothing to propose against — advance cursor, no executor call, no cost.
        return Ok(StepOutcome::default());
    };

    // Step 2: ask the agent for a proposed source diff.
    let resp = executor.run(build_request(&node.content)).await?;
    let outcome = StepOutcome {
        cost_usd: resp.cost_usd,
    };
    let Some(proposal) = parse_proposal(&resp.content) else {
        return Ok(outcome); // no parseable proposal — advance cursor (cost already incurred).
    };

    // Step 3: read the current on-disk content (base) for the target file.
    let root = workspace_root();
    let abs = root.join(&proposal.path);
    let base_content = tokio::fs::read_to_string(&abs).await.unwrap_or_default();

    let base = vec![FileVersion {
        path: PathBuf::from(&proposal.path),
        content: base_content.clone(),
    }];
    // "ours" carries the proposed change; "theirs" matches base (no competing
    // edit), so the gate validates that the proposed file compiles.
    let ours = vec![FileVersion {
        path: PathBuf::from(&proposal.path),
        content: proposal.content.clone(),
    }];
    let theirs = base.clone();

    // Step 4: open a Sharp episode and run the semantic-merge + cargo check gate.
    let req = MergeRequest {
        repo_name: REPO_NAME.to_string(),
        workspace_root: root.clone(),
        base_files: base,
        our_files: ours,
        their_files: theirs,
        merge_options: MergeOptions {
            workspace_root: root,
            rust_analyzer_path: None,
            ra_timeout_ms: 60_000,
        },
        pr_title: format!("loop: code change for {}", node.content),
    };

    match run_merge_flow(pool, req).await {
        Ok(_merge_outcome) => {
            // Issue #861 loop wiring: once a code-change proposal for a
            // Feature node compiles and merges, execute that Feature's
            // attached acceptance criteria and record one verdict per
            // criterion. See `crate::acceptance::resolve_attached_criteria`'s
            // doc comment for why this currently no-ops (the assertion-schema
            // migration is sibling issue #860's, not yet shipped) — this call
            // site is the forward-compatible seam for once it lands.
            if node.node_type == "Feature" {
                let change_title = format!("loop: code change for {}", node.content);
                if let Err(e) = crate::acceptance::execute_criteria_for_feature_change(
                    pool,
                    workspace_id,
                    &node,
                    &change_title,
                )
                .await
                {
                    tracing::warn!(
                        feature = %node.content,
                        error = %e,
                        "code_change_proposal: acceptance-criteria execution failed for feature"
                    );
                }
            }
            Ok(outcome)
        }
        // A non-compiling proposal is refused, not stored — advance the cursor.
        Err(SharpError::MergeRefused { diagnostics }) => {
            tracing::info!(
                "code_change_proposal: proposal for {:?} refused (non-compiling), discarded:\n{}",
                node.content,
                diagnostics
            );
            Ok(outcome)
        }
        Err(e) => Err(StepError::Sharp(e)),
    }
}

/// Select the first open Issue or Feature node, preferring Issues.
///
/// Returns `None` when no open node exists.
async fn select_open_node(pool: &sqlx::PgPool) -> Result<Option<sf_db::ProjectNode>, StepError> {
    for node_type in ["Issue", "Feature"] {
        let nodes = sf_db::list_nodes(pool, Some(node_type)).await?;
        if let Some(node) = nodes.into_iter().find(|n| n.state == "open") {
            return Ok(Some(node));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::steps::GardeningStep;

    #[test]
    fn step_name() {
        assert_eq!(
            GardeningStep::CodeChangeProposal.name(),
            "code_change_proposal"
        );
    }

    #[test]
    fn parse_basic_proposal() {
        let text = "FILE: crates/foo/src/lib.rs\npub fn f() -> u32 { 1 }";
        let p = parse_proposal(text).expect("must parse");
        assert_eq!(p.path, "crates/foo/src/lib.rs");
        assert_eq!(p.content, "pub fn f() -> u32 { 1 }\n");
    }

    #[test]
    fn parse_tolerates_fences_and_case() {
        let text = "```rust\n- file: `src/main.rs`\nfn main() {}\n```";
        let p = parse_proposal(text).expect("must parse");
        assert_eq!(p.path, "src/main.rs");
        assert_eq!(p.content, "fn main() {}\n");
    }

    #[test]
    fn parse_multiline_body_preserved() {
        let text = "FILE: src/lib.rs\nfn a() {}\n\nfn b() {}";
        let p = parse_proposal(text).expect("must parse");
        assert_eq!(p.content, "fn a() {}\n\nfn b() {}\n");
    }

    #[test]
    fn parse_no_file_line_yields_none() {
        assert!(parse_proposal("just prose, no proposal here").is_none());
    }

    #[test]
    fn parse_blank_path_yields_none() {
        assert!(parse_proposal("FILE:\nfn main() {}").is_none());
    }

    #[test]
    fn build_request_mentions_node_and_format() {
        let req = build_request("Add retry to the loop");
        assert!(req.user.contains("Add retry to the loop"));
        assert!(req.system.contains("FILE:"));
    }

    /// Integration: the code-change step opens a Sharp episode and invokes
    /// `semantic_merge_rust` for a selected open node using
    /// `FixtureAgentExecutor`.
    ///
    /// Acceptance criterion (#706): asserts the code-change step opens a Sharp
    /// episode and invokes `semantic_merge_rust` for a selected node.
    ///
    /// Requires DATABASE_URL (nexum project-graph + sharp migrations) and cargo
    /// on PATH for the compile gate — hence `#[ignore]` (CI has neither).
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL (nexum+sharp migrations) and cargo on PATH"]
    async fn code_change_step_opens_episode_and_merges() {
        use sharp::episode;

        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect");

        // Seed an open Issue node for the step to select.
        let issue_id = sf_db::insert_issue(&pool, "Code change loop integration issue", None)
            .await
            .expect("insert issue");

        // A compiling proposal: an empty-but-valid Rust file in a scratch crate.
        let scratch = tempfile::TempDir::new().expect("tempdir");
        std::fs::write(
            scratch.path().join("Cargo.toml"),
            "[package]\nname = \"scratch\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[[bin]]\nname = \"scratch\"\npath = \"src/main.rs\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(scratch.path().join("src")).unwrap();
        std::fs::write(scratch.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        std::env::set_var("SF_CODE_CHANGE_WORKSPACE", scratch.path());

        let executor = crate::agent::FixtureAgentExecutor::new(
            "FILE: src/main.rs\nfn main() { let _ = 1 + 1; }",
            "fixture:code_change_proposal",
        );

        super::run(&pool, uuid::Uuid::new_v4(), &executor)
            .await
            .expect("code_change_proposal must succeed on a compiling proposal");

        // A Sharp episode must have been opened (and finished) for this run.
        let r = sharp::repo::init(&pool, REPO_NAME).await.expect("repo");
        let episodes = episode::list_for_repo(&pool, r.id).await.expect("episodes");
        assert!(
            episodes
                .iter()
                .any(|e| e.title.contains("Code change loop integration issue")),
            "expected an episode titled for the selected node"
        );

        // The fixture executor was invoked exactly once for the selected node.
        assert_eq!(executor.call_count(), 1);

        std::env::remove_var("SF_CODE_CHANGE_WORKSPACE");

        // Cleanup the seeded issue node.
        let issues = sf_db::list_nodes(&pool, Some("Issue")).await.expect("list");
        for n in issues
            .iter()
            .filter(|n| n.content == "Code change loop integration issue" || n.id == issue_id)
        {
            sqlx::query("DELETE FROM nexum.links WHERE src = $1 OR dst = $1")
                .bind(n.block_id)
                .execute(&pool)
                .await
                .ok();
            sqlx::query("DELETE FROM nexum.project_nodes WHERE id = $1")
                .bind(n.id)
                .execute(&pool)
                .await
                .ok();
            sqlx::query("DELETE FROM nexum.blocks WHERE id = $1")
                .bind(n.block_id)
                .execute(&pool)
                .await
                .ok();
        }
    }
}
