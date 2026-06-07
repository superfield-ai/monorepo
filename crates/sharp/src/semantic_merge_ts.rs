//! Tier-1 semantic merge for TypeScript source files.
//!
//! The TypeScript analogue of [`crate::semantic_merge`]'s Rust path. Where the
//! Rust path consults rust-analyzer, this path drives the existing
//! [`crate::tsserver_bridge_client`] — spawning the `tsserver-bridge`
//! subprocess and using the TypeScript LanguageService (`findRenameLocations`)
//! to detect renamed top-level exports and to rewrite identifier references
//! without touching string literals or comments.
//!
//! Ports the rename-detection + rename-propagation core of the TypeScript
//! merge engine (`detectRenamesAcrossTrees` + `replaceIdentifierAst` for the
//! `ts` branch, in `sharp/apps/client/src/merge/index.ts` and
//! `semantic/symbols.ts`).
//!
//! # Algorithm
//!
//! 1. **Rename detection** — for each `.ts`/`.tsx` file changed in `ours`
//!    relative to `base`, call `analyze` to get the renamed top-level exports.
//! 2. **Rename propagation** — apply the union of detected renames to every
//!    file in `theirs` via `apply` (LanguageService-driven, so imports,
//!    re-exports, type references, and JSX usage are handled; string literals
//!    are not).
//! 3. **Textual baseline** — run the same minimal 3-way text merge used by the
//!    Rust path on (base, ours, rename-propagated-theirs).
//!
//! Unlike the Rust path there is no `cargo check` compile gate here — there is
//! no equivalent in-process TypeScript type-check available to a pure library
//! crate, and adding one is out of scope. The bridge's LanguageService still
//! guarantees rename edits are syntactically sound.
//!
//! §architecture.md — Sharp subsystem (Tier-1 TypeScript semantic merge)

use crate::error::SharpError;
use crate::semantic_merge::{three_way_merge, FileVersion, MergeResult};
use crate::tsserver_bridge_client::{
    TsRename, TsserverBridgeClient, TsserverBridgeClientOptions,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Options for [`semantic_merge_ts`].
#[derive(Debug, Clone, Default)]
pub struct TsMergeOptions {
    /// Options forwarded to the tsserver-bridge client (runtime, script path,
    /// timeout). Defaults locate `bun`/`node` and the bundled bridge script.
    pub bridge: TsserverBridgeClientOptions,
}

/// `true` when `path` is a TypeScript source file the bridge can analyze.
pub fn is_typescript_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts") | Some("tsx")
    )
}

/// Perform a Tier-1 semantic merge of `ours`/`theirs` over `base` for
/// TypeScript files, using the tsserver-bridge for rename detection and
/// propagation.
///
/// Mirrors [`crate::semantic_merge::semantic_merge_rust`] in shape: returns the
/// merged [`MergeResult`] (files + detected renames as
/// [`crate::semantic_merge::DetectedRename`]-free TS renames recorded on the
/// result via the textual merge). The detected renames are returned so callers
/// can log them.
pub async fn semantic_merge_ts(
    base: &[FileVersion],
    ours: &[FileVersion],
    theirs: &[FileVersion],
    opts: &TsMergeOptions,
) -> Result<TsMergeResult, SharpError> {
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

    let all_paths: HashSet<&Path> = base_map
        .keys()
        .chain(ours_map.keys())
        .chain(theirs_map.keys())
        .copied()
        .collect();

    // Step 1: rename detection over TS files changed in `ours`.
    let mut client = TsserverBridgeClient::new(opts.bridge.clone())?;
    client.start().await?;

    let mut detected: Vec<TsRename> = Vec::new();
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let detect_result = detect_renames(&mut client, ours, &base_map, &mut detected, &mut seen).await;

    // Step 2: apply detected renames to each `theirs` file.
    let apply_result = if detect_result.is_ok() {
        apply_renames(&mut client, &theirs_map, &all_paths, &detected).await
    } else {
        Ok(HashMap::new())
    };

    // Always stop the bridge, regardless of outcome.
    let _ = client.stop().await;

    detect_result?;
    let updated_theirs = apply_result?;

    // Step 3: 3-way textual merge per path.
    let mut merged_files: Vec<FileVersion> = Vec::new();
    for path in &all_paths {
        let base_text = base_map.get(path).copied().unwrap_or("");
        let ours_text = ours_map.get(path).copied().unwrap_or("");
        let theirs_text = updated_theirs
            .get(*path)
            .map(String::as_str)
            .or_else(|| theirs_map.get(path).copied())
            .unwrap_or("");
        let merged = three_way_merge(base_text, ours_text, theirs_text);
        merged_files.push(FileVersion {
            path: PathBuf::from(path),
            content: merged,
        });
    }
    merged_files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(TsMergeResult {
        result: MergeResult {
            files: merged_files,
            renames: Vec::new(),
        },
        ts_renames: detected,
    })
}

/// Result of a TypeScript semantic merge.
#[derive(Debug, Clone)]
pub struct TsMergeResult {
    /// The merged files. (`renames` on the inner [`MergeResult`] is empty: TS
    /// renames are reported separately as [`Self::ts_renames`], which carry the
    /// bridge's `old_name`/`new_name`/`kind` rather than RA location sets.)
    pub result: MergeResult,
    /// The renames detected by the tsserver-bridge and propagated into theirs.
    pub ts_renames: Vec<TsRename>,
}

async fn detect_renames(
    client: &mut TsserverBridgeClient,
    ours: &[FileVersion],
    base_map: &HashMap<&Path, &str>,
    detected: &mut Vec<TsRename>,
    seen: &mut HashSet<(String, String, String)>,
) -> Result<(), SharpError> {
    for file in ours {
        if !is_typescript_path(&file.path) {
            continue;
        }
        let base_content = base_map.get(file.path.as_path()).copied().unwrap_or("");
        if base_content == file.content.as_str() {
            continue; // unchanged on our side
        }
        let renames = client.analyze(base_content, &file.content).await?;
        for r in renames {
            let key = (r.kind.clone(), r.old_name.clone(), r.new_name.clone());
            if seen.insert(key) {
                detected.push(r);
            }
        }
    }
    Ok(())
}

async fn apply_renames(
    client: &mut TsserverBridgeClient,
    theirs_map: &HashMap<&Path, &str>,
    all_paths: &HashSet<&Path>,
    detected: &[TsRename],
) -> Result<HashMap<PathBuf, String>, SharpError> {
    let mut out: HashMap<PathBuf, String> = HashMap::new();
    if detected.is_empty() {
        return Ok(out);
    }
    for path in all_paths {
        if !is_typescript_path(path) {
            continue;
        }
        let Some(content) = theirs_map.get(path).copied() else {
            continue;
        };
        let applied = client.apply(content, detected).await?;
        if applied.changed {
            out.insert(PathBuf::from(path), applied.content);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_typescript_paths() {
        assert!(is_typescript_path(Path::new("a/b.ts")));
        assert!(is_typescript_path(Path::new("a/b.tsx")));
        assert!(!is_typescript_path(Path::new("a/b.rs")));
        assert!(!is_typescript_path(Path::new("a/b")));
    }

    /// Full bridge round-trip requires `bun`/`node` + the tsserver-bridge
    /// script, which is unavailable in CI; gated like the rust-analyzer tests.
    #[tokio::test]
    #[ignore = "requires tsserver-bridge subprocess (bun/node + bridge script)"]
    async fn merge_propagates_rename() {
        let base = vec![
            FileVersion {
                path: PathBuf::from("mod.ts"),
                content: "export function greet() {}".into(),
            },
            FileVersion {
                path: PathBuf::from("use.ts"),
                content: "import { greet } from './mod'; greet();".into(),
            },
        ];
        let ours = vec![
            FileVersion {
                path: PathBuf::from("mod.ts"),
                content: "export function hello() {}".into(),
            },
            FileVersion {
                path: PathBuf::from("use.ts"),
                content: "import { greet } from './mod'; greet();".into(),
            },
        ];
        let theirs = base.clone();
        let res = semantic_merge_ts(&base, &ours, &theirs, &TsMergeOptions::default())
            .await
            .unwrap();
        assert!(!res.ts_renames.is_empty());
    }
}
