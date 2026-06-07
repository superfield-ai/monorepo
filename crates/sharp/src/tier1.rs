//! Unified Tier-1 merge driver.
//!
//! Direct port of the TypeScript `tier1Merge` orchestrator
//! (`sharp/apps/client/src/merge/index.ts`). Where the language-specific
//! paths ([`crate::semantic_merge`] for Rust via rust-analyzer,
//! [`crate::semantic_merge_ts`] for TypeScript via the tsserver-bridge) port
//! only the rename-detection + rename-propagation *core*, this module wires the
//! full Tier-1 pipeline together:
//!
//!   1. **Three-way classification** ([`crate::oracle::classify_path`]) of every
//!      path across (base, A, B).
//!   2. **File-level rename redirection** ([`crate::file_rename::detect_file_renames`]):
//!      an `a_deleted_b_edited` path whose source A moved to a new path routes
//!      B's edited content to the new path instead of escalating to a dilemma.
//!   3. **Symbol-rename propagation**: renames detected by a language path are
//!      applied to B-only / `both_different` files. These are supplied as a
//!      parameter so this driver stays infrastructure-free (no rust-analyzer /
//!      tsserver-bridge needed); the pure resolution paths below all run
//!      without live tooling.
//!   4. **Whitespace-equivalence** ([`crate::ast_equivalence::ast_equal`]): a
//!      pure-reformat side yields to the semantic side.
//!   5. **Concat-additions**: both sides only added lines → interleave them.
//!   6. **Tier-3 modify/delete escalation**: `a_deleted_b_edited` /
//!      `b_deleted_a_edited` (with no file-rename redirect) collect into a
//!      [`DilemmaPayload`].
//!   7. **Tier-2 oracle** ([`crate::oracle::select_candidate`]): when more than
//!      one candidate tree exists, score against oracle branches; a tie is a
//!      dilemma.
//!   8. **Pre-merge hooks** ([`crate::hooks::run_pre_merge_hooks`]): a veto
//!      turns the clean candidate into a dilemma.
//!
//! The tier ordering and short-circuit semantics match the TS `tier1Merge`
//! exactly: dilemmas short-circuit before `unhandled`, which short-circuits
//! before the oracle, which precedes the hook gate, which precedes `clean_ok`.
//!
//! §architecture.md — Sharp subsystem (Tier-1 unified merge driver)

use crate::ast_equivalence::ast_equal;
use crate::error::SharpError;
use crate::file_rename::detect_file_renames;
use crate::oracle::{classify_path, select_candidate, Candidate, Classification, FileSet, OracleSelection};
use crate::semantic_merge::{replace_whole_word, DetectedRename};
use std::collections::BTreeSet;
use std::path::Path;

/// A symbol rename to propagate into B-only / both-modified files. Kept
/// independent of the rust-analyzer [`DetectedRename`] location set so the
/// driver can be fed renames from either language path (or none).
#[derive(Debug, Clone)]
pub struct SymbolRename {
    /// Original identifier on base.
    pub old_name: String,
    /// New identifier on the renaming branch (A).
    pub new_name: String,
}

impl From<&DetectedRename> for SymbolRename {
    fn from(r: &DetectedRename) -> Self {
        SymbolRename {
            old_name: r.old_name.clone(),
            new_name: r.new_name.clone(),
        }
    }
}

/// The stable dilemma shape (whitepaper §6.5), mirroring the TS
/// `DilemmaPayload`. Emitted when Tier-1/2 deliberately refuse to silently pick
/// between two semantically valid resolutions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DilemmaPayload {
    /// Human-readable reason the merge was escalated.
    pub reason: String,
    /// The candidate resolutions a human (or higher tier) must choose between.
    pub candidates: Vec<DilemmaCandidate>,
    /// The paths that triggered the dilemma.
    pub involved_paths: Vec<String>,
}

/// One option presented in a [`DilemmaPayload`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DilemmaCandidate {
    /// Stable identifier for the option (e.g. `"keep_b_edited"`).
    pub id: String,
    /// Short human-readable description.
    pub summary: String,
}

/// The outcome of [`tier1_merge`], mirroring the TS `MergeResult.outcome`
/// union.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    /// A clean, fully-resolved merge.
    CleanOk {
        /// The merged tree (`path -> content`).
        files: FileSet,
    },
    /// A deliberate refusal — the caller must choose a resolution.
    Dilemma(DilemmaPayload),
    /// The engine has no Tier-1 rule for this shape (e.g. both sides modified
    /// the same file in incompatible ways).
    Unhandled {
        /// Why the engine fell through.
        reason: String,
    },
}

/// Options for [`tier1_merge`].
#[derive(Debug, Clone, Default)]
pub struct Tier1Options {
    /// Workspace root used to discover pre-merge hooks. `None` skips the hook
    /// gate.
    pub workspace_root: Option<std::path::PathBuf>,
    /// Oracle branches scored against when more than one candidate exists.
    pub oracle_branches: Vec<FileSet>,
}

/// Run the unified Tier-1 merge of `a`/`b` over `base`.
///
/// `renames` are symbol renames already detected on A by a language path
/// (rust-analyzer or the tsserver-bridge); pass an empty slice to run the
/// infrastructure-free path (file-rename redirection, whitespace-equivalence,
/// concat-additions, and modify/delete escalation all work without it).
///
/// Returns a [`MergeOutcome`]. The only `Err` is an unexpected host I/O error
/// from the hook gate — dilemmas and unhandled shapes are non-error outcomes.
pub async fn tier1_merge(
    base: &FileSet,
    a: &FileSet,
    b: &FileSet,
    renames: &[SymbolRename],
    opts: &Tier1Options,
) -> Result<MergeOutcome, SharpError> {
    let mut result: FileSet = FileSet::new();

    // Union of all paths across the three trees (BTreeSet → deterministic).
    let mut all_paths: BTreeSet<&String> = BTreeSet::new();
    all_paths.extend(base.keys());
    all_paths.extend(a.keys());
    all_paths.extend(b.keys());

    // File-level rename map (A vs base): oldPath -> newPath.
    let file_renames = detect_file_renames(base, a);
    let mut consumed_by_rename: BTreeSet<String> = BTreeSet::new();

    let mut dilemma_paths: Vec<String> = Vec::new();
    let mut unhandled: Option<String> = None;

    for path in all_paths {
        match classify_path(path, base, a, b) {
            // Pure take-one-side cases.
            Classification::Unchanged
            | Classification::AOnly
            | Classification::BOnly
            | Classification::BothSame => {
                // For these, the chosen content is identical between the
                // relevant side and what classify saw; recover it from the
                // trees in the same precedence the TS `content` field used.
                if let Some(c) = pick_single_side(path, base, a, b) {
                    result.insert(path.clone(), c);
                }
            }
            Classification::AAdded => {
                // A introduced this path. Skip if it is the destination of a
                // file-rename whose source B edited (already written below).
                if !consumed_by_rename.contains(path) {
                    if let Some(c) = a.get(path) {
                        result.insert(path.clone(), c.clone());
                    }
                }
            }
            Classification::BAdded => {
                // B introduced this path. Apply A's renames to it.
                let mut content = b.get(path).cloned().unwrap_or_default();
                content = apply_renames(&content, renames);
                result.insert(path.clone(), content);
            }
            Classification::AAddedBAddedSame => {
                if let Some(c) = a.get(path) {
                    result.insert(path.clone(), c.clone());
                }
            }
            Classification::AAddedBAddedDiff => {
                unhandled.get_or_insert_with(|| {
                    format!("both branches added {path} with different content")
                });
            }
            Classification::BothDifferent => {
                let base_c = base.get(path).cloned().unwrap_or_default();
                let a_c = a.get(path).cloned().unwrap_or_default();
                let b_c = b.get(path).cloned().unwrap_or_default();

                // Rename-only-on-A: if A's diff vs base is fully accounted for
                // by the renames, the merge is B's content with renames applied.
                if let Some(merged) = try_apply_renames_to_b(&base_c, &a_c, &b_c, renames) {
                    result.insert(path.clone(), merged);
                    continue;
                }
                // Whitespace-equivalence: one side is a pure reformat → take the
                // other (semantic) side, then propagate renames.
                if let Some(equiv) = try_whitespace_equivalent(path, &base_c, &a_c, &b_c)? {
                    result.insert(path.clone(), apply_renames(&equiv, renames));
                    continue;
                }
                // Concat-additions: both sides only added lines.
                if let Some(merged) = try_concat_additions(&base_c, &a_c, &b_c) {
                    result.insert(path.clone(), apply_renames(&merged, renames));
                } else {
                    unhandled
                        .get_or_insert_with(|| format!("both branches modified {path}"));
                }
            }
            Classification::ADeletedBEdited => {
                // If A moved `path` → newPath, route B's edited content there.
                if let Some(new_path) = file_renames.get(path) {
                    if let Some(b_c) = b.get(path) {
                        result.insert(new_path.clone(), b_c.clone());
                    }
                    consumed_by_rename.insert(new_path.clone());
                } else {
                    dilemma_paths.push(path.clone());
                }
            }
            Classification::BDeletedAEdited => {
                dilemma_paths.push(path.clone());
            }
            Classification::BothDeleted => {
                // Both agreed to delete; emit nothing.
            }
        }
    }

    // Tier-3 modify/delete escalation short-circuits first.
    if !dilemma_paths.is_empty() {
        return Ok(MergeOutcome::Dilemma(DilemmaPayload {
            reason: "delete-then-edit on the same path; correct policy is intent-dependent"
                .to_string(),
            candidates: vec![
                DilemmaCandidate {
                    id: "keep_b_edited".to_string(),
                    summary: "keep the edited file from B; ignore A's deletion".to_string(),
                },
                DilemmaCandidate {
                    id: "apply_a_deletion".to_string(),
                    summary: "apply A's deletion; discard B's edits".to_string(),
                },
            ],
            involved_paths: dilemma_paths,
        }));
    }

    if let Some(reason) = unhandled {
        return Ok(MergeOutcome::Unhandled { reason });
    }

    // Tier-2 oracle: only fires with >= 2 candidate trees and >= 1 oracle.
    // Tier-1 currently always produces a single candidate, matching the TS
    // single-candidate invariant, so this is a no-op unless a caller supplies
    // additional candidates in a future revision. We still route the single
    // candidate through `select_candidate`'s guard for fidelity.
    let candidates = vec![Candidate {
        id: "candidate_0".to_string(),
        files: result.clone(),
    }];
    if let Some(selection) = select_candidate(&candidates, base, &opts.oracle_branches) {
        match selection {
            OracleSelection::Winner { files, .. } => {
                result = files;
            }
            OracleSelection::Tied { scored } => {
                return Ok(MergeOutcome::Dilemma(DilemmaPayload {
                    reason: "Tier 2 oracle: multiple candidates tied; cannot determine correct merge automatically"
                        .to_string(),
                    candidates: scored
                        .into_iter()
                        .map(|(id, score)| DilemmaCandidate {
                            summary: format!("oracle conflict score: {score}"),
                            id,
                        })
                        .collect(),
                    involved_paths: result.keys().cloned().collect(),
                }));
            }
        }
    }

    // Pre-merge hook gate: a veto becomes a dilemma.
    if let Some(workspace_root) = &opts.workspace_root {
        if let Some(dilemma) = run_hook_gate(workspace_root, &result).await? {
            return Ok(MergeOutcome::Dilemma(dilemma));
        }
    }

    Ok(MergeOutcome::CleanOk { files: result })
}

/// Recover the single agreed-upon content for the take-one-side
/// classifications, matching the TS `classifyPath` `content` precedence.
fn pick_single_side(path: &str, base: &FileSet, a: &FileSet, b: &FileSet) -> Option<String> {
    // Unchanged → base; a_only → a; b_only → b; both_same → a.
    // We don't know which variant produced the call here, so recompute the
    // same precedence classify_path used. The cheapest correct rule: prefer a
    // non-base side that differs from base, else base.
    let base_c = base.get(path);
    let a_c = a.get(path);
    let b_c = b.get(path);
    match (base_c, a_c, b_c) {
        // a deleted, b unchanged (a_only via deletion): take b's (== base).
        (Some(_), None, Some(bc)) => Some(bc.clone()),
        // b deleted, a unchanged (b_only via deletion): take a's (== base).
        (Some(_), Some(ac), None) => Some(ac.clone()),
        (bc, ac, bbc) => {
            // Present in base + both sides (or additions handled elsewhere).
            // a_only: a != base, b == base → a. b_only: b != base, a == base → b.
            // both_same: a == b. unchanged: all equal. In every case a's value
            // (falling back to b, then base) is correct because a_only/both_same
            // carry a's content and b_only carries b's which equals base==a here.
            if let (Some(ac), Some(bbc), Some(bc)) = (ac, bbc, bc) {
                if ac == bc {
                    Some(bbc.clone()) // a unchanged → b's content (b_only)
                } else {
                    Some(ac.clone()) // a changed → a's content (a_only/both_same)
                }
            } else {
                ac.or(bbc).or(bc).cloned()
            }
        }
    }
}

/// Apply every rename to `content` via whole-word replacement (the
/// infrastructure-free analogue of the language paths' AST-aware rewrite).
fn apply_renames(content: &str, renames: &[SymbolRename]) -> String {
    let mut out = content.to_string();
    for r in renames {
        out = replace_whole_word(&out, &r.old_name, &r.new_name);
    }
    out
}

/// If A's diff vs base is fully accounted for by `renames` (reverse-applying
/// them to A yields base), the merge is B's content with the renames applied.
/// Mirrors the TS `tryApplyRenamesToBContent`.
fn try_apply_renames_to_b(
    base: &str,
    a: &str,
    b: &str,
    renames: &[SymbolRename],
) -> Option<String> {
    if renames.is_empty() {
        return None;
    }
    // Reverse-apply A's renames (new → old). If that recovers base, A was
    // rename-only.
    let mut unrenamed = a.to_string();
    for r in renames {
        unrenamed = replace_whole_word(&unrenamed, &r.new_name, &r.old_name);
    }
    if unrenamed != base {
        return None;
    }
    Some(apply_renames(b, renames))
}

/// Returns the semantic side's content if exactly one of A/B is a
/// whitespace-equivalent reformat of base. Mirrors the TS
/// `tryWhitespaceEquivalent`. Only Rust source is parseable here (the TS path
/// runs out-of-process); other extensions return `Ok(None)`.
fn try_whitespace_equivalent(
    path: &str,
    base: &str,
    a: &str,
    b: &str,
) -> Result<Option<String>, SharpError> {
    if !is_rust_path(path) {
        return Ok(None);
    }
    let a_is_reformat = ast_equal(base, a)?;
    let b_is_reformat = ast_equal(base, b)?;
    if a_is_reformat && !b_is_reformat {
        return Ok(Some(b.to_string()));
    }
    if b_is_reformat && !a_is_reformat {
        return Ok(Some(a.to_string()));
    }
    Ok(None)
}

fn is_rust_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e == "rs")
}

/// Run the pre-merge hook gate against a materialized copy of `result`.
/// Returns `Ok(Some(dilemma))` on veto, `Ok(None)` when no hook vetoes.
async fn run_hook_gate(
    workspace_root: &Path,
    result: &FileSet,
) -> Result<Option<DilemmaPayload>, SharpError> {
    let hooks = crate::hooks::discover_hooks(workspace_root, crate::hooks::HookEvent::PreMerge)
        .await?;
    if hooks.is_empty() {
        return Ok(None);
    }
    let tmp = tempfile::tempdir()?;
    materialize_candidate_tree(tmp.path(), result)?;
    let opts = crate::hooks::HookExecOptions {
        cwd: tmp.path().to_path_buf(),
        context: Some(
            serde_json::json!({
                "event": "pre-merge",
                "workspaceRoot": workspace_root.display().to_string(),
            })
            .to_string(),
        ),
        timeout_ms: 60_000,
    };
    let run = crate::hooks::run_hooks(&hooks, &opts).await?;
    if run.ok {
        return Ok(None);
    }
    let failed = run
        .results
        .last()
        .expect("a failed run has at least one result");
    let detail = if failed.timed_out {
        "timed out".to_string()
    } else {
        let mut d = format!("exited {}", failed.exit_code);
        let stderr = failed.stderr.trim();
        if !stderr.is_empty() {
            d.push_str(" — ");
            d.push_str(stderr);
        }
        d
    };
    Ok(Some(DilemmaPayload {
        reason: format!(
            "pre-merge hook vetoed the candidate tree: {} {}",
            failed.hook_path.display(),
            detail
        ),
        candidates: vec![
            DilemmaCandidate {
                id: "fix_and_retry".to_string(),
                summary: "resolve the issue the hook reported and retry the merge".to_string(),
            },
            DilemmaCandidate {
                id: "skip_hooks".to_string(),
                summary: "retry without hooks (remove or disable the failing hook)".to_string(),
            },
        ],
        involved_paths: result.keys().cloned().collect(),
    }))
}

/// Write `tree` (`path -> content`) under `root`, creating parents.
fn materialize_candidate_tree(root: &Path, tree: &FileSet) -> Result<(), SharpError> {
    for (rel, content) in tree {
        let dest = root.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, content)?;
    }
    Ok(())
}

// ── Concat-additions (pure line-level merge) ───────────────────────────────────

/// Split `s` keeping line terminators, so the join is lossless. Mirrors the TS
/// `splitLines`.
fn split_lines(s: &str) -> Vec<String> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' {
            out.push(s[start..=i].to_string());
            start = i + 1;
        }
    }
    if start < s.len() {
        out.push(s[start..].to_string());
    }
    out
}

/// Compute the pure-insertion map turning `base` into `derived`, anchored at
/// the base index after which each new block belongs. Returns `None` if any
/// base line was deleted or replaced. Mirrors the TS `pureInsertionsOrUndefined`.
fn pure_insertions(base: &[String], derived: &[String]) -> Option<std::collections::BTreeMap<usize, Vec<String>>> {
    let mut insertions: std::collections::BTreeMap<usize, Vec<String>> =
        std::collections::BTreeMap::new();
    let mut bi = 0usize;
    let mut di = 0usize;
    while bi < base.len() {
        let mut dj = di;
        while dj < derived.len() && derived[dj] != base[bi] {
            dj += 1;
        }
        if dj >= derived.len() {
            return None; // base[bi] missing from derived → not pure insertion
        }
        if dj > di {
            insertions
                .entry(bi)
                .or_default()
                .extend_from_slice(&derived[di..dj]);
        }
        di = dj + 1;
        bi += 1;
    }
    if di < derived.len() {
        insertions
            .entry(base.len())
            .or_default()
            .extend_from_slice(&derived[di..]);
    }
    Some(insertions)
}

/// Both-pure-additions merge: preserve every base line and interleave each
/// side's insertions at their anchor. Returns `None` if either side deleted or
/// modified a base line. Mirrors the TS `tryConcatAdditions`.
pub fn try_concat_additions(base: &str, a: &str, b: &str) -> Option<String> {
    let base_lines = split_lines(base);
    let a_lines = split_lines(a);
    let b_lines = split_lines(b);
    let a_ins = pure_insertions(&base_lines, &a_lines)?;
    let b_ins = pure_insertions(&base_lines, &b_lines)?;

    let mut out: Vec<String> = Vec::new();
    for i in 0..=base_lines.len() {
        let a_here = a_ins.get(&i).cloned().unwrap_or_default();
        let b_here = b_ins.get(&i).cloned().unwrap_or_default();
        // Block-level dedup: identical blocks at the same anchor appear once.
        if !a_here.is_empty() && !b_here.is_empty() && a_here.join("") == b_here.join("") {
            out.extend(a_here);
        } else {
            out.extend(a_here);
            out.extend(b_here);
        }
        if i < base_lines.len() {
            out.push(base_lines[i].clone());
        }
    }
    Some(out.join(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs(pairs: &[(&str, &str)]) -> FileSet {
        pairs
            .iter()
            .map(|(p, c)| (p.to_string(), c.to_string()))
            .collect()
    }

    #[tokio::test]
    async fn delete_then_edit_is_a_dilemma() {
        // A deletes legacy.rs (and edits lib.rs to drop the mod); B edits
        // legacy.rs. The modify/delete conflict must escalate to a dilemma.
        let base = fs(&[
            ("src/lib.rs", "pub mod legacy;\n"),
            ("src/legacy.rs", "pub fn legacy_helper() -> &'static str {\n    \"old\"\n}\n"),
        ]);
        let a = fs(&[("src/lib.rs", "// removed\n")]);
        let b = fs(&[
            ("src/lib.rs", "pub mod legacy;\n"),
            (
                "src/legacy.rs",
                "pub fn legacy_helper() -> &'static str {\n    \"old (improved)\"\n}\n",
            ),
        ]);
        let out = tier1_merge(&base, &a, &b, &[], &Tier1Options::default())
            .await
            .unwrap();
        match out {
            MergeOutcome::Dilemma(d) => {
                assert_eq!(d.involved_paths, vec!["src/legacy.rs".to_string()]);
                assert_eq!(d.candidates.len(), 2);
            }
            other => panic!("expected dilemma, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn b_deleted_a_edited_is_a_dilemma() {
        let base = fs(&[("f.rs", "fn f() { 1 }\n")]);
        let a = fs(&[("f.rs", "fn f() { 2 }\n")]); // a edited
        let b = fs(&[]); // b deleted
        let out = tier1_merge(&base, &a, &b, &[], &Tier1Options::default())
            .await
            .unwrap();
        assert!(matches!(out, MergeOutcome::Dilemma(_)));
    }

    #[tokio::test]
    async fn file_rename_redirect_avoids_dilemma() {
        // A moves old.rs → new.rs (high similarity); B edits old.rs. The
        // a_deleted_b_edited path should redirect B's content to new.rs.
        let body = "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\n";
        let base = fs(&[("old.rs", body)]);
        let a = fs(&[("new.rs", &format!("// moved\n{body}"))]);
        let b = fs(&[("old.rs", &format!("{body}fn e() {{}}\n"))]);
        let out = tier1_merge(&base, &a, &b, &[], &Tier1Options::default())
            .await
            .unwrap();
        match out {
            MergeOutcome::CleanOk { files } => {
                assert!(files.contains_key("new.rs"));
                assert!(!files.contains_key("old.rs"));
            }
            other => panic!("expected clean_ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn parallel_additions_merge_clean() {
        let base = fs(&[("m.rs", "fn base() {}\n")]);
        let a = fs(&[("m.rs", "use a;\nfn base() {}\n")]);
        let b = fs(&[("m.rs", "fn base() {}\nfn extra() {}\n")]);
        let out = tier1_merge(&base, &a, &b, &[], &Tier1Options::default())
            .await
            .unwrap();
        match out {
            MergeOutcome::CleanOk { files } => {
                let m = &files["m.rs"];
                assert!(m.contains("use a;"));
                assert!(m.contains("fn extra()"));
            }
            other => panic!("expected clean_ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn whitespace_reformat_yields_to_semantic_side() {
        let base = fs(&[("w.rs", "fn f(){let x=1;}\n")]);
        // A is a pure reformat; B carries the real change.
        let a = fs(&[("w.rs", "fn f() {\n    let x = 1;\n}\n")]);
        let b = fs(&[("w.rs", "fn f(){let x=2;}\n")]);
        let out = tier1_merge(&base, &a, &b, &[], &Tier1Options::default())
            .await
            .unwrap();
        match out {
            MergeOutcome::CleanOk { files } => assert!(files["w.rs"].contains("x=2")),
            other => panic!("expected clean_ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn both_modified_incompatibly_is_unhandled() {
        let base = fs(&[("c.rs", "fn f() { 1 }\n")]);
        let a = fs(&[("c.rs", "fn f() { 2 }\n")]);
        let b = fs(&[("c.rs", "fn f() { 3 }\n")]);
        let out = tier1_merge(&base, &a, &b, &[], &Tier1Options::default())
            .await
            .unwrap();
        assert!(matches!(out, MergeOutcome::Unhandled { .. }));
    }

    #[tokio::test]
    async fn both_deleted_is_clean_empty() {
        let base = fs(&[("g.rs", "x\n")]);
        let a = fs(&[]);
        let b = fs(&[]);
        let out = tier1_merge(&base, &a, &b, &[], &Tier1Options::default())
            .await
            .unwrap();
        match out {
            MergeOutcome::CleanOk { files } => assert!(files.is_empty()),
            other => panic!("expected clean_ok, got {other:?}"),
        }
    }

    #[test]
    fn concat_additions_interleaves() {
        let base = "b1\nb2\n";
        let a = "a0\nb1\nb2\n";
        let b = "b1\nb2\nb3\n";
        let merged = try_concat_additions(base, a, b).unwrap();
        assert_eq!(merged, "a0\nb1\nb2\nb3\n");
    }

    #[test]
    fn concat_additions_bails_on_deletion() {
        let base = "b1\nb2\n";
        let a = "b2\n"; // deleted b1
        let b = "b1\nb2\nb3\n";
        assert!(try_concat_additions(base, a, b).is_none());
    }
}
