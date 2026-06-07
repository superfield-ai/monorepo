//! Tier-1 semantic merge for Rust source files.
//!
//! Sharp's semantic merge for Rust beats plain git merge by consulting
//! rust-analyzer's rename-location index.  When two branches each touch a
//! file at a position that maps to the same symbol, Sharp can determine
//! whether the conflict is a *rename-vs-edit* (one side renames the symbol,
//! the other edits it) and resolve it correctly rather than producing a
//! textual conflict or — worse — a silently broken merge.
//!
//! After producing the candidate merged text, `cargo check` is run against the
//! workspace.  Any merge whose output fails to compile is refused before it
//! reaches storage.
//!
//! # Algorithm
//!
//! 1. **Rename detection** — for each file that differs between the two sides,
//!    ask rust-analyzer for the rename-location set of every symbol touched
//!    by the non-base side.  If the same symbol position is renamed on one
//!    side and edited on the other, the rename wins and all reference
//!    locations are updated.
//!
//! 2. **Textual baseline** — apply a standard 3-way text merge (base, ours,
//!    theirs) on the result.  If the rename-aware pass already resolved a
//!    conflict, the textual merge will be clean for that symbol.
//!
//! 3. **Verification gate** — run `cargo check` on the workspace that
//!    contains the merged files.  A non-zero exit means the merge is refused
//!    with a [`SharpError::MergeRefused`] carrying the diagnostics.
//!
//! §architecture.md — Sharp subsystem (Tier-1 Rust semantic merge)

use crate::cargo_check::run_cargo_check;
use crate::error::SharpError;
use crate::rust_analyzer_client::{RenameLocation, RustAnalyzerClient, RustAnalyzerClientOptions};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ── Public types ──────────────────────────────────────────────────────────────

/// The content of a single Rust source file at a point in a merge.
#[derive(Debug, Clone)]
pub struct FileVersion {
    /// Absolute path of the file in the workspace.
    pub path: PathBuf,
    /// Source text of the file.
    pub content: String,
}

/// A detected rename: a symbol was renamed on one branch.
#[derive(Debug, Clone)]
pub struct DetectedRename {
    /// File containing the renamed symbol.
    pub file: PathBuf,
    /// All locations (definition + all references) that refer to the symbol.
    pub locations: Vec<RenameLocation>,
    /// New name on the renaming branch.
    pub new_name: String,
    /// Original name on the base.
    pub old_name: String,
}

/// Result of a successful semantic merge.
#[derive(Debug, Clone)]
pub struct MergeResult {
    /// Merged file versions, ready to be written to disk and committed.
    pub files: Vec<FileVersion>,
    /// Renames that were detected and propagated.
    pub renames: Vec<DetectedRename>,
}

// ── Entry points ──────────────────────────────────────────────────────────────

/// Options for [`semantic_merge_rust`].
#[derive(Debug, Clone)]
pub struct MergeOptions {
    /// Absolute path to the Cargo workspace root.
    pub workspace_root: PathBuf,
    /// Override path to `rust-analyzer`.  If `None`, the standard search
    /// (PATH → rustup) is used.
    pub rust_analyzer_path: Option<PathBuf>,
    /// Timeout for each rust-analyzer LSP request (ms).  Default: 60 000.
    pub ra_timeout_ms: u64,
}

impl Default for MergeOptions {
    fn default() -> Self {
        Self {
            workspace_root: std::env::current_dir().unwrap_or_default(),
            rust_analyzer_path: None,
            ra_timeout_ms: 60_000,
        }
    }
}

/// Perform a Tier-1 semantic merge of `ours` over `base`, incorporating
/// rename information from rust-analyzer, then verify the result compiles.
///
/// # Parameters
///
/// - `base`   — the common ancestor file versions
/// - `ours`   — "our" branch file versions (may include renames)
/// - `theirs` — "their" branch file versions (edits referencing old names)
/// - `opts`   — workspace and tooling configuration
///
/// # Returns
///
/// The merged [`MergeResult`] on success, or a [`SharpError::MergeRefused`]
/// if the merged result does not compile.
pub async fn semantic_merge_rust(
    base: &[FileVersion],
    ours: &[FileVersion],
    theirs: &[FileVersion],
    opts: &MergeOptions,
) -> Result<MergeResult, SharpError> {
    // Index by path for easy lookup.
    let base_map: HashMap<&Path, &str> = base
        .iter()
        .map(|f| (f.path.as_path(), f.content.as_str()))
        .collect();
    let ours_map: HashMap<&Path, &str> = ours
        .iter()
        .map(|f| (f.path.as_path(), f.content.as_str()))
        .collect();
    let theirs_map: HashMap<&Path, &str> = theirs
        .iter()
        .map(|f| (f.path.as_path(), f.content.as_str()))
        .collect();

    // Collect all paths across all versions.
    let all_paths: std::collections::HashSet<&Path> = base_map
        .keys()
        .chain(ours_map.keys())
        .chain(theirs_map.keys())
        .copied()
        .collect();

    // File-move routing (mirrors `crate::tier1`'s ADeletedBEdited branch): if
    // "ours" moved a file old->new and "theirs" still carries an edited old, the
    // per-file 3-way loop below would see old as deleted-vs-edited and conflict,
    // dropping the edit. Detect the rename and route theirs' content to the new
    // path, skipping both paths in the loop. As in tier1, B's content wins for a
    // move+edit (A's move relocates it; B's edit is preserved at the new path).
    let to_btree = |fs: &[FileVersion]| -> std::collections::BTreeMap<String, String> {
        fs.iter()
            .map(|f| (f.path.to_string_lossy().into_owned(), f.content.clone()))
            .collect()
    };
    let file_renames =
        crate::file_rename::detect_file_renames(&to_btree(base), &to_btree(ours));
    let mut routed_files: Vec<(PathBuf, String)> = Vec::new();
    let mut skip_paths: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for (old_path, new_path) in &file_renames {
        let old = PathBuf::from(old_path);
        if let Some(theirs_old) = theirs_map.get(old.as_path()) {
            routed_files.push((PathBuf::from(new_path), theirs_old.to_string()));
            skip_paths.insert(old);
            skip_paths.insert(PathBuf::from(new_path));
        }
    }

    // Step 1: Rename detection via rust-analyzer.
    let mut detected_renames: Vec<DetectedRename> = Vec::new();
    let mut ra_client = start_ra_client(opts).await?;

    // rust-analyzer loaded the project rooted at `workspace_root`, so all LSP
    // calls must use absolute on-disk paths. File paths here are relative to the
    // tree root; resolve them against `workspace_root` (the merge later writes
    // its output to the same `workspace_root.join(path)` locations). Returned
    // reference locations are normalised back to relative paths so they match
    // the relative keys used during merge.
    let to_abs = |rel: &Path| opts.workspace_root.join(rel);
    let to_rel = |abs: &Path| -> PathBuf {
        abs.strip_prefix(&opts.workspace_root)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| abs.to_path_buf())
    };

    // Open all "ours" files in rust-analyzer so it can build the index.
    for path in &all_paths {
        let content = ours_map
            .get(path)
            .or_else(|| base_map.get(path))
            .copied()
            .unwrap_or("");
        if content.is_empty() {
            continue;
        }
        let _ = ra_client.open_file(&to_abs(path), content).await;
    }

    // For each file changed in "ours" relative to base, probe symbol positions.
    for file in ours {
        let base_content = base_map.get(file.path.as_path()).copied().unwrap_or("");
        if base_content == file.content.as_str() {
            continue; // unchanged on our side
        }

        // Find identifier positions that differ between base and ours.
        let rename_candidates = find_renamed_identifiers(base_content, &file.content);
        for (line, col, old_name, new_name) in rename_candidates {
            match ra_client
                .get_rename_locations(&to_abs(&file.path), line, col, true)
                .await
            {
                Ok(locations) if !locations.is_empty() => {
                    let locations = locations
                        .into_iter()
                        .map(|mut loc| {
                            loc.file = to_rel(&loc.file);
                            loc
                        })
                        .collect();
                    detected_renames.push(DetectedRename {
                        file: file.path.clone(),
                        locations,
                        new_name,
                        old_name,
                    });
                }
                _ => {} // no locations or ra error — fall through to textual merge
            }
        }
    }

    let _ = ra_client.stop().await;

    // Step 2: Produce merged content for each file.
    let mut merged_files: Vec<FileVersion> = Vec::new();

    for path in &all_paths {
        if skip_paths.contains(*path) {
            continue; // handled by file-move routing above
        }
        let base_text = base_map.get(path).copied().unwrap_or("");
        let ours_text = ours_map.get(path).copied().unwrap_or("");
        let theirs_text = theirs_map.get(path).copied().unwrap_or("");

        // Apply rename propagation to "theirs" first: if "ours" renamed a
        // symbol, update all occurrences on the "theirs" side as well.
        //
        // A file that is new on "theirs" only (absent from both base and ours)
        // was never opened in rust-analyzer during detection, so it cannot
        // appear in any rename's `locations` even when it references the renamed
        // symbol. Propagate into those B-only files too — otherwise a brand-new
        // file on the other branch keeps the old name and fails the compile gate
        // (the cross-file / B-only rename gap, #44).
        let is_theirs_only =
            base_text.is_empty() && ours_text.is_empty() && !theirs_text.is_empty();
        let mut updated_theirs = theirs_text.to_string();
        for rename in &detected_renames {
            let referenced_here = rename.locations.iter().any(|loc| loc.file == **path);
            if !referenced_here && !is_theirs_only {
                continue;
            }
            // Simple string replacement of the old name with the new name.
            // In production this would be span-aware; for the Tier-1 pass a
            // conservative whole-word replacement is sufficient.
            updated_theirs =
                replace_whole_word(&updated_theirs, &rename.old_name, &rename.new_name);
        }

        // Tier-1 enhancements (mirror `crate::tier1`'s BothDifferent ladder):
        // prefer whitespace-equivalence (one side is a pure reformat → take the
        // semantic side) and concat-additions (both sides only appended) before
        // falling back to a line-level 3-way merge. Both helpers return `None`
        // when inapplicable, so genuine conflicts still reach `three_way_merge`.
        let path_str = path.to_str().unwrap_or("");
        let merged = if let Some(equiv) = crate::tier1::try_whitespace_equivalent(
            path_str,
            base_text,
            ours_text,
            &updated_theirs,
        )? {
            equiv
        } else if let Some(concat) =
            crate::tier1::try_concat_additions(base_text, ours_text, &updated_theirs)
        {
            concat
        } else {
            three_way_merge(base_text, ours_text, &updated_theirs)
        };
        merged_files.push(FileVersion {
            path: PathBuf::from(path),
            content: merged,
        });
    }

    // Emit the file-move-routed outputs (theirs' content at the new path).
    for (path, content) in routed_files {
        merged_files.push(FileVersion { path, content });
    }

    // Step 3: Write merged files to the workspace and run cargo check.
    // We write to the workspace_root in-place so cargo check sees the result.
    for file in &merged_files {
        let dest = if file.path.is_absolute() {
            file.path.clone()
        } else {
            opts.workspace_root.join(&file.path)
        };
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, &file.content)?;
    }

    let check = run_cargo_check(&opts.workspace_root).await?;
    if !check.success {
        return Err(SharpError::MergeRefused {
            diagnostics: check.format_errors(),
        });
    }

    Ok(MergeResult {
        files: merged_files,
        renames: detected_renames,
    })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async fn start_ra_client(opts: &MergeOptions) -> Result<RustAnalyzerClient, SharpError> {
    let mut client = RustAnalyzerClient::new(RustAnalyzerClientOptions {
        rust_analyzer_path: opts.rust_analyzer_path.clone(),
        workspace_root: opts.workspace_root.clone(),
        timeout_ms: opts.ra_timeout_ms,
    })?;
    client.start().await?;
    Ok(client)
}

/// Find identifiers that were renamed in place between `base` and `new`.
///
/// Returns `(0-based-line-in-new, 0-based-char, old_name, new_name)` — the
/// line/col are positions in `new`, since the probe opens the new content.
///
/// Lines are aligned with a line-level LCS first, and only genuine
/// *substitutions* (a deleted base line paired with an added new line between
/// the same pair of common anchors) yield candidates. Naively zipping by index
/// would mis-read an inserted line as a substitution — e.g. inserting
/// `use BTreeMap;` above `use HashMap;` would look like `HashMap`→`BTreeMap`
/// and manufacture a bogus rename.
fn find_renamed_identifiers(base: &str, new: &str) -> Vec<(u32, u32, String, String)> {
    let base_lines: Vec<&str> = base.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    let mut results = Vec::new();
    for (bi, nj) in substitution_pairs(&base_lines, &new_lines) {
        let base_line = base_lines[bi];
        let new_line = new_lines[nj];
        // Walk character by character to find the first divergence.
        let diverge_col = base_line
            .chars()
            .zip(new_line.chars())
            .position(|(a, b)| a != b)
            .unwrap_or(0);

        if let (Some(old_id), Some(new_id)) = (
            extract_ident_at(base_line, diverge_col),
            extract_ident_at(new_line, diverge_col),
        ) {
            if old_id != new_id && is_identifier(&old_id) && is_identifier(&new_id) {
                results.push((nj as u32, diverge_col as u32, old_id, new_id));
            }
        }
    }
    results
}

/// Align `base`/`new` lines via a line-level LCS and return the `(base_idx,
/// new_idx)` pairs that are substitutions: within each gap between common
/// anchors, the deleted base lines are paired positionally with the added new
/// lines (up to the shorter run). Pure insertions/deletions are excluded.
fn substitution_pairs(base: &[&str], new: &[&str]) -> Vec<(usize, usize)> {
    // LCS length table over lines.
    let n = base.len();
    let m = new.len();
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if base[i] == new[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    // Backtrack into runs of deletions/insertions between common anchors.
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if base[i] == new[j] {
            i += 1;
            j += 1;
            continue;
        }
        // Collect the maximal non-matching run on each side up to the next anchor.
        let del_start = i;
        let ins_start = j;
        while i < n && j < m && base[i] != new[j] {
            if dp[i + 1][j] >= dp[i][j + 1] {
                i += 1; // base[i] is a deletion
            } else {
                j += 1; // new[j] is an insertion
            }
        }
        // Pair the deleted base lines with the added new lines positionally.
        let dels: Vec<usize> = (del_start..i).collect();
        let inss: Vec<usize> = (ins_start..j).collect();
        for (bi, nj) in dels.into_iter().zip(inss.into_iter()) {
            pairs.push((bi, nj));
        }
    }
    pairs
}

/// Extract the identifier token starting at or containing `col`.
fn extract_ident_at(line: &str, col: usize) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let start_col = col.min(chars.len().saturating_sub(1));

    // Walk back to start of identifier.
    let start = (0..=start_col)
        .rev()
        .take_while(|&i| i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_'))
        .last()
        .unwrap_or(start_col);

    // Walk forward to end of identifier.
    let end = (start..chars.len())
        .take_while(|&i| chars[i].is_alphanumeric() || chars[i] == '_')
        .last()
        .map(|i| i + 1)
        .unwrap_or(start);

    if start < end {
        Some(chars[start..end].iter().collect())
    } else {
        None
    }
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .next()
            .is_some_and(|c| c.is_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// Replace all whole-word occurrences of `old` with `new` in `text`.
pub fn replace_whole_word(text: &str, old: &str, new: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(old) {
        // Check word boundaries.
        let before = pos.checked_sub(1).map(|i| rest.as_bytes()[i] as char);
        let after = rest
            .get(pos + old.len()..pos + old.len() + 1)
            .map(|s| s.chars().next().unwrap());
        let before_ok = before.is_none_or(|c| !c.is_alphanumeric() && c != '_');
        let after_ok = after.is_none_or(|c| !c.is_alphanumeric() && c != '_');
        result.push_str(&rest[..pos]);
        if before_ok && after_ok {
            result.push_str(new);
        } else {
            result.push_str(old);
        }
        rest = &rest[pos + old.len()..];
    }
    result.push_str(rest);
    result
}

/// Minimal 3-way text merge.
///
/// For each line in `ours` and `theirs` relative to `base`:
/// - If only one side changed a line, take that side's version.
/// - If both sides changed the same line identically, take that version.
/// - If both sides changed the same line differently, emit conflict markers.
///
/// This is intentionally simple — the semantic layer above handles the hard
/// cases (renames) before this function is called.
pub fn three_way_merge(base: &str, ours: &str, theirs: &str) -> String {
    if ours == theirs {
        return ours.to_string();
    }
    if base == ours {
        return theirs.to_string();
    }
    if base == theirs {
        return ours.to_string();
    }

    // Line-level diff3 anchored on the LCS of base with each side. Aligning by
    // raw index would mis-handle insertions: one side adding a line shifts every
    // following line and fabricates a conflict (or worse, a wrong take). Anchors
    // are base lines that survive unchanged in BOTH ours and theirs; between
    // consecutive anchors we merge the diverging chunks.
    let base_lines: Vec<&str> = base.lines().collect();
    let ours_lines: Vec<&str> = ours.lines().collect();
    let theirs_lines: Vec<&str> = theirs.lines().collect();

    let o_match: std::collections::HashMap<usize, usize> =
        lcs_pairs(&base_lines, &ours_lines).into_iter().collect();
    let t_match: std::collections::HashMap<usize, usize> =
        lcs_pairs(&base_lines, &theirs_lines).into_iter().collect();

    let mut output: Vec<String> = Vec::new();
    let (mut bi, mut oi, mut ti) = (0usize, 0usize, 0usize);
    for anchor in 0..base_lines.len() {
        let (Some(&ao), Some(&at)) = (o_match.get(&anchor), t_match.get(&anchor)) else {
            continue; // not common to both sides — handled inside the chunk below
        };
        merge_chunk(
            &mut output,
            &base_lines[bi..anchor],
            &ours_lines[oi..ao],
            &theirs_lines[ti..at],
        );
        output.push(base_lines[anchor].to_string());
        bi = anchor + 1;
        oi = ao + 1;
        ti = at + 1;
    }
    merge_chunk(
        &mut output,
        &base_lines[bi..],
        &ours_lines[oi..],
        &theirs_lines[ti..],
    );

    let mut result = output.join("\n");
    // Preserve trailing newline.
    if ours.ends_with('\n') || theirs.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// Line-level LCS of `a` and `b` as matched `(a_idx, b_idx)` pairs, ascending.
fn lcs_pairs(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    pairs
}

/// Merge one diverging chunk (the lines between two shared anchors) by classic
/// diff3 rules: identical edits collapse, one-sided edits win, genuine
/// divergence emits conflict markers.
///
/// When all three chunks are the same length the divergence is a block of
/// in-place substitutions, so each line is aligned and resolved individually —
/// this recovers clean merges where the two sides agree on some lines and only
/// one side changed others (whole-chunk resolution would conflict the lot).
/// Unequal lengths mean an insertion/deletion, where per-line alignment is
/// invalid, so the chunk is resolved as a whole.
fn merge_chunk(out: &mut Vec<String>, base: &[&str], ours: &[&str], theirs: &[&str]) {
    let push_all = |out: &mut Vec<String>, lines: &[&str]| {
        out.extend(lines.iter().map(|s| s.to_string()))
    };
    if ours == theirs {
        push_all(out, ours);
        return;
    }
    if ours == base {
        push_all(out, theirs); // only theirs changed
        return;
    }
    if theirs == base {
        push_all(out, ours); // only ours changed
        return;
    }

    if base.len() == ours.len() && ours.len() == theirs.len() {
        for i in 0..base.len() {
            if ours[i] == theirs[i] || base[i] == theirs[i] {
                out.push(ours[i].to_string()); // agree, or only ours changed
            } else if base[i] == ours[i] {
                out.push(theirs[i].to_string()); // only theirs changed
            } else {
                out.push("<<<<<<< ours".to_string());
                out.push(ours[i].to_string());
                out.push("=======".to_string());
                out.push(theirs[i].to_string());
                out.push(">>>>>>> theirs".to_string());
            }
        }
        return;
    }

    out.push("<<<<<<< ours".to_string());
    push_all(out, ours);
    out.push("=======".to_string());
    push_all(out, theirs);
    out.push(">>>>>>> theirs".to_string());
}

#[cfg(test)]
mod merge_tests {
    use super::three_way_merge;

    #[test]
    fn insertion_on_one_side_does_not_conflict() {
        // theirs inserts a line; ours edits a later line. A naive index-aligned
        // merge would mis-align and conflict — the LCS-anchored diff3 must not.
        let base = "use a;\n\nuse old;\n";
        let ours = "use a;\n\nuse new;\n";
        let theirs = "use a;\nuse extra;\n\nuse old;\n";
        let merged = three_way_merge(base, ours, theirs);
        assert!(!merged.contains("<<<<<<<"), "unexpected conflict:\n{merged}");
        assert!(merged.contains("use extra;"), "lost theirs insertion:\n{merged}");
        assert!(merged.contains("use new;"), "lost ours edit:\n{merged}");
    }

    #[test]
    fn equal_length_block_resolves_per_line() {
        // Both sides change line 1 identically (a rename); only theirs changes
        // line 2. The shared change must collapse and theirs's edit must win.
        let base = "fn compute() {\n    x * 2\n}\n";
        let ours = "fn calc() {\n    x * 2\n}\n";
        let theirs = "fn calc() {\n    x * 3\n}\n";
        let merged = three_way_merge(base, ours, theirs);
        assert_eq!(merged, "fn calc() {\n    x * 3\n}\n");
    }

    #[test]
    fn genuine_divergence_still_conflicts() {
        let base = "value = 1\n";
        let ours = "value = 2\n";
        let theirs = "value = 3\n";
        let merged = three_way_merge(base, ours, theirs);
        assert!(merged.contains("<<<<<<<") && merged.contains(">>>>>>>"));
    }

    #[test]
    fn identical_sides_take_either() {
        let base = "a\n";
        let ours = "b\n";
        let theirs = "b\n";
        assert_eq!(three_way_merge(base, ours, theirs), "b\n");
    }
}
