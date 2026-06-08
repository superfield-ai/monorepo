//! Scenario-driven differential merge tests for the Rust Tier-1 semantic merge.
//!
//! This is the Rust port of the TypeScript scenario harness
//! (`sharp/tests/harness/` + `sharp/tests/scenarios/`). It walks the fixture
//! corpus under `tests/scenarios/<category>/rust/<name>/`, runs each scenario
//! through [`sharp::semantic_merge::semantic_merge_rust`], classifies the
//! result into an [`Outcome`], and asserts it matches the
//! `expected_sharp_outcome` declared in the fixture's `meta.yaml`.
//!
//! # Fixture layout
//!
//! ```text
//! tests/scenarios/<category>/rust/<name>/
//!   meta.yaml      (required — deserialized into ScenarioMeta)
//!   base/          (required — common ancestor tree)
//!   branch_a/      (required — "ours")
//!   branch_b/      (required — "theirs")
//!   expected/      (optional — canonical merged tree for tree-compare)
//! ```
//!
//! # Classification (mirrors harness/classify/index.ts)
//!
//! 1. The lane returns [`Outcome::Conflict`] when the merged tree contains
//!    git-style conflict markers.
//! 2. Otherwise the merge ran the `cargo check` gate internally:
//!    - `Ok(_)`                        → provisional clean; tree-compare against
//!      `expected/` if present, else [`Outcome::CleanOk`].
//!    - `Err(MergeRefused { .. })`     → [`Outcome::CleanWrong`] (compiled gate
//!      rejected the textual merge — the result was wrong).
//!    - any other error                → [`Outcome::Error`].
//!
//! Note: the engine does not emit [`Outcome::Dilemma`] today (modify/delete
//! escalation is a TS-only Tier-3 path). Scenarios whose
//! `expected_sharp_outcome` is `dilemma` are therefore expected to fail until
//! that path lands in Rust; see the `delete_then_edit` scenario.
//!
//! # Gating
//!
//! Every scenario test needs a live `rust-analyzer` and `cargo`, so each is
//! `#[ignore]`'d. Run the whole corpus with:
//!
//! ```text
//! cargo test -p sharp --test scenarios -- --ignored
//! ```
//!
//! §architecture.md — Sharp subsystem (Tier-1 Rust semantic merge)

use sharp::error::SharpError;
use sharp::oracle::FileSet;
use sharp::semantic_merge::{semantic_merge_rust, FileVersion, MergeOptions};
use sharp::tier1::{tier1_merge, MergeOutcome, Tier1Options};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// ── Outcome taxonomy (mirrors harness/types.ts `Outcome`) ──────────────────────

/// The five-outcome failure-mode taxonomy from docs/test-plan.md §6.
///
/// `Dilemma` is Sharp-only — Sharp's deliberate refusal to silently pick
/// between two semantically valid resolutions. The Rust engine does not emit
/// it yet (see module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    CleanOk,
    CleanWrong,
    Conflict,
    Dilemma,
    Error,
}

impl Outcome {
    /// Parse the snake_case form used in `meta.yaml`.
    fn parse(s: &str) -> Option<Self> {
        match s {
            "clean_ok" => Some(Outcome::CleanOk),
            "clean_wrong" => Some(Outcome::CleanWrong),
            "conflict" => Some(Outcome::Conflict),
            "dilemma" => Some(Outcome::Dilemma),
            "error" => Some(Outcome::Error),
            _ => None,
        }
    }
}

// ── meta.yaml deserialization (mirrors harness/fixture/schema.ts) ──────────────

/// Typed view of a scenario's `meta.yaml`. Only the fields the Rust harness
/// consumes are required; `expected_sharp_outcome` drives the assertion.
#[derive(Debug, serde::Deserialize)]
struct ScenarioMeta {
    name: String,
    category: String,
    language: String,
    #[allow(dead_code)]
    summary: String,
    #[allow(dead_code)]
    expected_git_outcome: String,
    expected_sharp_outcome: String,
    #[serde(default)]
    #[allow(dead_code)]
    validator: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    notes: Option<String>,
}

/// A loaded scenario: its parsed metadata plus the absolute path to the
/// fixture directory.
#[derive(Debug)]
pub struct Scenario {
    /// Stable id of the form `<category>/rust/<name>`.
    pub id: String,
    /// Absolute path to the fixture directory.
    pub path: PathBuf,
    /// The expected Sharp outcome the scenario passes iff matched.
    pub expected_sharp_outcome: Outcome,
}

/// Root of the Rust scenario corpus.
fn scenarios_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenarios")
}

/// Walk `tests/scenarios/*/rust/*/meta.yaml` and return every loadable
/// scenario. Panics on a malformed fixture so a broken fixture cannot silently
/// disappear from a corpus run (matches the TS loader's fail-loud contract).
pub fn load_rust_scenarios() -> Vec<Scenario> {
    let root = scenarios_root();
    let mut scenarios = Vec::new();

    if !root.is_dir() {
        return scenarios;
    }

    // Layout: <root>/<category>/rust/<name>/meta.yaml
    for category in read_dirs(&root) {
        let rust_dir = category.join("rust");
        if !rust_dir.is_dir() {
            continue;
        }
        for fixture in read_dirs(&rust_dir) {
            let meta_path = fixture.join("meta.yaml");
            if !meta_path.is_file() {
                continue;
            }
            let raw = std::fs::read_to_string(&meta_path)
                .unwrap_or_else(|e| panic!("read {}: {e}", meta_path.display()));
            let meta: ScenarioMeta = serde_yaml::from_str(&raw)
                .unwrap_or_else(|e| panic!("parse {}: {e}", meta_path.display()));

            // Physical layout is the source of truth; meta drift is a bug.
            let name_from_path = fixture.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let category_from_path = category.file_name().and_then(|s| s.to_str()).unwrap_or("");
            assert_eq!(
                meta.name,
                name_from_path,
                "{}: meta.name disagrees with directory name",
                meta_path.display()
            );
            assert_eq!(
                meta.category,
                category_from_path,
                "{}: meta.category disagrees with directory layout",
                meta_path.display()
            );
            assert_eq!(
                meta.language,
                "rust",
                "{}: only rust fixtures live in this corpus",
                meta_path.display()
            );

            let expected_sharp_outcome = Outcome::parse(&meta.expected_sharp_outcome)
                .unwrap_or_else(|| {
                    panic!(
                        "{}: unknown expected_sharp_outcome '{}'",
                        meta_path.display(),
                        meta.expected_sharp_outcome
                    )
                });

            scenarios.push(Scenario {
                id: format!("{}/rust/{}", meta.category, meta.name),
                path: fixture,
                expected_sharp_outcome,
            });
        }
    }

    scenarios.sort_by(|a, b| a.id.cmp(&b.id));
    scenarios
}

/// List immediate subdirectories of `dir`, sorted by name.
fn read_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort();
    out
}

// ── Tree reading & conflict detection (mirrors lanes/sharp + classify) ─────────

/// Read every file under `root` recursively into a list of [`FileVersion`]
/// whose `path` is *relative* to `root`. Skips VCS/build noise so the merge
/// engine only sees source files (mirrors `readTreeFromDisk`).
fn read_tree(root: &Path) -> Vec<FileVersion> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
        let name = e.file_name().to_str().unwrap_or("");
        !matches!(
            name,
            ".git" | ".sharp" | "node_modules" | "target" | ".cargo"
        )
    }) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        let content = match std::fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue, // skip binaries / unreadable
        };
        out.push(FileVersion { path: rel, content });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Project a list of [`FileVersion`] into the unified driver's
/// `path -> content` [`FileSet`], keying on the relative path string.
fn file_set(files: &[FileVersion]) -> FileSet {
    files
        .iter()
        .map(|f| (f.path.to_string_lossy().into_owned(), f.content.clone()))
        .collect()
}

/// True iff any merged file contains a git-style conflict marker line
/// (mirrors classify/conflictMarkers.ts). A clean exit that nonetheless leaves
/// markers must be classified as [`Outcome::Conflict`].
fn has_conflict_markers(files: &[FileVersion]) -> bool {
    for f in files {
        for line in f.content.lines() {
            if line.starts_with("<<<<<<<")
                || line.starts_with("=======")
                || line.starts_with(">>>>>>>")
            {
                return true;
            }
        }
    }
    false
}

// ── Scenario runner ────────────────────────────────────────────────────────────

/// Run a single scenario through the Rust semantic merge engine and classify
/// the result into an [`Outcome`].
///
/// Seeds a temporary Cargo workspace from `branch_a/` (so `Cargo.toml` and any
/// untouched files exist for the `cargo check` gate), then calls
/// [`semantic_merge_rust`] with `workspace_root` pointed at the temp dir.
async fn run_scenario(scenario: &Scenario) -> Outcome {
    let base = read_tree(&scenario.path.join("base"));
    let ours = read_tree(&scenario.path.join("branch_a"));
    let theirs = read_tree(&scenario.path.join("branch_b"));

    // Tier-3 modify/delete escalation runs in the pure unified driver: no
    // rust-analyzer or cargo needed. Run it first; if it produces a dilemma,
    // that is the engine's outcome and we short-circuit before the
    // infrastructure-bound rename-aware path. (We pass no symbol renames — the
    // dilemma classification depends only on path-level classification +
    // file-rename detection, both pure.)
    if let Ok(MergeOutcome::Dilemma(_)) = tier1_merge(
        &file_set(&base),
        &file_set(&ours),
        &file_set(&theirs),
        &[],
        &Tier1Options::default(),
    )
    .await
    {
        return Outcome::Dilemma;
    }

    // Seed a temp workspace from branch_a so the cargo-check gate has a full,
    // buildable tree (Cargo.toml + any files the merge doesn't touch). The
    // merge writes its merged output in-place over this tree.
    let workspace = match tempfile::tempdir() {
        Ok(d) => d,
        Err(_) => return Outcome::Error,
    };
    if copy_tree(&scenario.path.join("branch_a"), workspace.path()).is_err() {
        return Outcome::Error;
    }

    let opts = MergeOptions {
        workspace_root: workspace.path().to_path_buf(),
        rust_analyzer_path: None,
        ra_timeout_ms: 90_000,
    };

    match semantic_merge_rust(&base, &ours, &theirs, &opts).await {
        Ok(result) => {
            // Defense against silent leftover conflict markers despite a clean
            // (Ok) merge — classify those as Conflict, not CleanOk.
            if has_conflict_markers(&result.files) {
                Outcome::Conflict
            } else {
                // The cargo-check gate inside semantic_merge_rust already
                // passed, so the tree compiles. No expected/ dirs ship with
                // the Rust corpus, so a passing gate is CleanOk.
                Outcome::CleanOk
            }
        }
        // The compile gate rejected the textual merge: it produced wrong code.
        Err(SharpError::MergeRefused { .. }) => Outcome::CleanWrong,
        Err(_) => Outcome::Error,
    }
}

/// Recursively copy `src` into `dst` (creating `dst` and parents as needed),
/// skipping VCS/build noise.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in WalkDir::new(src).into_iter().filter_entry(|e| {
        let name = e.file_name().to_str().unwrap_or("");
        !matches!(
            name,
            ".git" | ".sharp" | "node_modules" | "target" | ".cargo"
        )
    }) {
        let entry = entry?;
        let rel = match entry.path().strip_prefix(src) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Assert that `scenario` produces its declared `expected_sharp_outcome`.
async fn assert_scenario(id: &str) {
    let scenarios = load_rust_scenarios();
    let scenario = scenarios
        .iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("scenario fixture not found: {id}"));

    let actual = run_scenario(scenario).await;
    assert_eq!(
        actual, scenario.expected_sharp_outcome,
        "scenario {id}: expected {:?}, got {actual:?}",
        scenario.expected_sharp_outcome
    );
}

// ── Loader smoke test (no external tools) ──────────────────────────────────────

/// The corpus loader finds all 12 Rust fixtures and every `meta.yaml`
/// deserializes cleanly. Pure filesystem + serde — no rust-analyzer or cargo,
/// so this test runs in normal CI.
#[test]
fn loader_finds_all_rust_scenarios() {
    let scenarios = load_rust_scenarios();
    assert_eq!(
        scenarios.len(),
        12,
        "expected 12 Rust scenarios, found {}: {:#?}",
        scenarios.len(),
        scenarios.iter().map(|s| &s.id).collect::<Vec<_>>()
    );
    // ids are unique and sorted.
    let mut ids: Vec<&str> = scenarios.iter().map(|s| s.id.as_str()).collect();
    let before = ids.clone();
    ids.dedup();
    assert_eq!(ids.len(), before.len(), "scenario ids must be unique");
}

// ── Per-scenario tests (require live rust-analyzer + cargo) ─────────────────────

macro_rules! scenario_test {
    ($fn_name:ident, $id:literal) => {
        scenario_test!(
            $fn_name,
            $id,
            "scenario: requires live rust-analyzer + cargo"
        );
    };
    ($fn_name:ident, $id:literal, $reason:literal) => {
        #[tokio::test]
        #[ignore = $reason]
        async fn $fn_name() {
            assert_scenario($id).await;
        }
    };
}

// #44 (cross-file / branch-B-only rename propagation) was closed 2026-06-07:
// `semantic_merge_rust` now waits for rust-analyzer to finish indexing, addresses
// it with absolute on-disk paths, propagates renames into B-only files, routes
// file moves, and merges via an LCS-anchored diff3. All four rename scenarios
// below now reach `clean_ok` with live infrastructure.

scenario_test!(
    cross_file_rename_struct_renamed_one_branch_used_in_other,
    "cross_file_rename/rust/struct_renamed_one_branch_used_in_other"
);

// Tier-3 modify/delete escalation (issue #41) is now implemented in the unified
// driver (`sharp::tier1::tier1_merge`). The dilemma is reached by pure
// path-level classification + Jaccard file-rename detection — no rust-analyzer
// or cargo — so this scenario runs un-#[ignore]'d in normal CI. `run_scenario`
// short-circuits to `Outcome::Dilemma` via the unified driver before the
// infrastructure-bound rename-aware path.
#[tokio::test]
async fn delete_edit_delete_then_edit() {
    assert_scenario("delete_edit/rust/delete_then_edit").await;
}

scenario_test!(format_format_then_edit, "format/rust/format_then_edit");

scenario_test!(
    import_merge_parallel_use_additions_sorted,
    "import_merge/rust/parallel_use_additions_sorted"
);
scenario_test!(
    import_merge_parallel_use_lines,
    "import_merge/rust/parallel_use_lines"
);

scenario_test!(move_edit_move_then_edit, "move_edit/rust/move_then_edit");

scenario_test!(
    refactor_struct_field_rename_with_usage,
    "refactor/rust/struct_field_rename_with_usage"
);
scenario_test!(
    refactor_trait_method_rename,
    "refactor/rust/trait_method_rename"
);

scenario_test!(
    reorder_parallel_enum_variant_additions,
    "reorder/rust/parallel_enum_variant_additions"
);
scenario_test!(
    reorder_parallel_impl_additions,
    "reorder/rust/parallel_impl_additions"
);
scenario_test!(
    reorder_parallel_struct_field_additions,
    "reorder/rust/parallel_struct_field_additions"
);

scenario_test!(
    whitespace_only_whitespace_vs_edit,
    "whitespace_only/rust/whitespace_vs_edit"
);
