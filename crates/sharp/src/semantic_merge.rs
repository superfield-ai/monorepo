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
use crate::rust_analyzer_client::{RustAnalyzerClient, RustAnalyzerClientOptions, RenameLocation};
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
    let base_map: HashMap<&Path, &str> = base.iter().map(|f| (f.path.as_path(), f.content.as_str())).collect();
    let ours_map: HashMap<&Path, &str> = ours.iter().map(|f| (f.path.as_path(), f.content.as_str())).collect();
    let theirs_map: HashMap<&Path, &str> = theirs.iter().map(|f| (f.path.as_path(), f.content.as_str())).collect();

    // Collect all paths across all versions.
    let all_paths: std::collections::HashSet<&Path> = base_map.keys()
        .chain(ours_map.keys())
        .chain(theirs_map.keys())
        .copied()
        .collect();

    // Step 1: Rename detection via rust-analyzer.
    let mut detected_renames: Vec<DetectedRename> = Vec::new();
    let mut ra_client = start_ra_client(opts).await?;

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
        let _ = ra_client.open_file(path, content).await;
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
                .get_rename_locations(&file.path, line, col, true)
                .await
            {
                Ok(locations) if !locations.is_empty() => {
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
        let base_text = base_map.get(path).copied().unwrap_or("");
        let ours_text = ours_map.get(path).copied().unwrap_or("");
        let theirs_text = theirs_map.get(path).copied().unwrap_or("");

        // Apply rename propagation to "theirs" first: if "ours" renamed a
        // symbol, update all occurrences on the "theirs" side as well.
        let mut updated_theirs = theirs_text.to_string();
        for rename in &detected_renames {
            if !rename.locations.iter().any(|loc| loc.file == **path) {
                continue;
            }
            // Simple string replacement of the old name with the new name.
            // In production this would be span-aware; for the Tier-1 pass a
            // conservative whole-word replacement is sufficient.
            updated_theirs = replace_whole_word(&updated_theirs, &rename.old_name, &rename.new_name);
        }

        // 3-way textual merge.
        let merged = three_way_merge(base_text, ours_text, &updated_theirs);
        merged_files.push(FileVersion {
            path: PathBuf::from(path),
            content: merged,
        });
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

/// Find identifiers that appear at the same line/col in base but have a
/// different name in the new version.
///
/// Returns `(0-based-line, 0-based-char, old_name, new_name)`.
///
/// This is a heuristic diff: we align lines, then scan each line for the
/// first identifier that differs at the same character offset.
fn find_renamed_identifiers(
    base: &str,
    new: &str,
) -> Vec<(u32, u32, String, String)> {
    let mut results = Vec::new();
    let base_lines: Vec<&str> = base.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    for (li, (base_line, new_line)) in base_lines.iter().zip(new_lines.iter()).enumerate() {
        if base_line == new_line {
            continue;
        }
        // Walk character by character to find the first divergence.
        let diverge_col = base_line
            .chars()
            .zip(new_line.chars())
            .position(|(a, b)| a != b)
            .unwrap_or(0);

        // Extract identifiers starting at or near the divergence.
        if let (Some(old_id), Some(new_id)) = (
            extract_ident_at(base_line, diverge_col),
            extract_ident_at(new_line, diverge_col),
        ) {
            if old_id != new_id && is_identifier(&old_id) && is_identifier(&new_id) {
                results.push((li as u32, diverge_col as u32, old_id, new_id));
            }
        }
    }
    results
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
            .map_or(false, |c| c.is_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// Replace all whole-word occurrences of `old` with `new` in `text`.
fn replace_whole_word(text: &str, old: &str, new: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(old) {
        // Check word boundaries.
        let before = pos.checked_sub(1).map(|i| rest.as_bytes()[i] as char);
        let after = rest.get(pos + old.len()..pos + old.len() + 1)
            .map(|s| s.chars().next().unwrap());
        let before_ok = before.map_or(true, |c| !c.is_alphanumeric() && c != '_');
        let after_ok = after.map_or(true, |c| !c.is_alphanumeric() && c != '_');
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

    // Line-level merge.
    let base_lines: Vec<&str> = base.lines().collect();
    let ours_lines: Vec<&str> = ours.lines().collect();
    let theirs_lines: Vec<&str> = theirs.lines().collect();

    let max_len = ours_lines.len().max(theirs_lines.len());
    let mut output = Vec::new();

    for i in 0..max_len {
        let b = base_lines.get(i).copied().unwrap_or("");
        let o = ours_lines.get(i).copied().unwrap_or("");
        let t = theirs_lines.get(i).copied().unwrap_or("");

        if o == t {
            output.push(o.to_string());
        } else if b == o {
            // Only theirs changed.
            output.push(t.to_string());
        } else if b == t {
            // Only ours changed.
            output.push(o.to_string());
        } else {
            // Both sides changed — conflict marker (should be rare after rename propagation).
            output.push(format!("<<<<<<< ours"));
            output.push(o.to_string());
            output.push(format!("======="));
            output.push(t.to_string());
            output.push(format!(">>>>>>> theirs"));
        }
    }

    let mut result = output.join("\n");
    // Preserve trailing newline.
    if ours.ends_with('\n') || theirs.ends_with('\n') {
        result.push('\n');
    }
    result
}
