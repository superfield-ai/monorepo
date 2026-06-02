//! Integration tests for the Sharp VCS core, episode schema, and Rust semantic merge.
//!
//! # VCS core tests
//!
//! These tests require a live Postgres instance with the Sharp schema already
//! applied (run migrations from `crates/sharp/migrations/` first).
//!
//! Run with:
//!   DATABASE_URL=postgres://... cargo test -p sharp -- --include-ignored integration
//!
//! # Semantic merge tests
//!
//! These tests exercise the full Tier-1 semantic merge pipeline:
//!
//! 1. **Differential test** — Sharp resolves a rename-vs-edit conflict that
//!    git would mishandle (merge `main.rs` where "ours" renames `compute_value`
//!    to `calculate_result` and "theirs" edits the body of `compute_value`).
//!
//! 2. **Compilation gate** — a merge whose output would not compile is refused
//!    before it can be committed.
//!
//! Tests that require a live `rust-analyzer` and `cargo` are gated with
//! `#[ignore]` so they do not break CI environments that lack those tools.
//! Run them with:
//!
//! ```text
//! cargo test -- --ignored
//! ```
//!
//! §architecture.md — Sharp subsystem (Tier-1 Rust semantic merge)

use sf_db::{connect, DbConfig};
use sharp::cargo_check::{run_cargo_check, CheckResult};
use sharp::semantic_merge::{semantic_merge_rust, three_way_merge, FileVersion, MergeOptions};
use sharp::{commit, episode, object, repo};
use std::path::PathBuf;
use tempfile::TempDir;
use uuid::Uuid;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Helper: unique repo name per test run.
fn unique_name(prefix: &str) -> String {
    format!("{}-{}", prefix, Uuid::new_v4().as_simple())
}

/// Create a temporary Cargo project with the given `src/main.rs` content.
/// Returns the temp dir (caller must keep it alive) and the path to
/// `src/main.rs`.
fn make_temp_project(src: &str) -> (TempDir, PathBuf) {
    let dir = TempDir::new().expect("tempdir");
    let cargo_toml = dir.path().join("Cargo.toml");
    std::fs::write(
        &cargo_toml,
        r#"[package]
name = "test-project"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "test-project"
path = "src/main.rs"
"#,
    )
    .expect("write Cargo.toml");

    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("create src");
    let main_rs = src_dir.join("main.rs");
    std::fs::write(&main_rs, src).expect("write main.rs");
    (dir, main_rs)
}

// ── VCS core integration tests ────────────────────────────────────────────────

/// Integration test: init / add / commit roundtrip persists to the shared instance.
///
/// Verifies:
/// 1. A repo can be created (`repo::init`).
/// 2. A blob object can be stored (`object::store`).
/// 3. A commit can be created against the repo and the blob (`commit::commit`).
/// 4. The branch head SHA matches the returned commit SHA.
/// 5. A second commit with the first as parent advances the branch.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL and applied Sharp migrations"]
async fn init_add_commit_roundtrip() {
    let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
    let pool = connect(&cfg).await.expect("pool creation failed");

    let repo_name = unique_name("test-repo");
    let r = repo::init(&pool, &repo_name)
        .await
        .expect("repo init failed");
    assert_eq!(r.name, repo_name);

    // Add a blob object.
    let content = b"Hello, Sharp!";
    let blob_sha = object::store(&pool, r.id, object::ObjectType::Blob, content)
        .await
        .expect("object store failed");

    // Verify sha256.
    assert_eq!(blob_sha, sharp::object::sha256_hex(content));

    // Add a tree object (a minimal JSON tree listing for testing).
    let tree_data = serde_json::to_vec(&serde_json::json!({
        "entries": [{ "path": "hello.txt", "sha": blob_sha }]
    }))
    .unwrap();
    let tree_sha = object::store(&pool, r.id, object::ObjectType::Tree, &tree_data)
        .await
        .expect("tree store failed");

    // Create the first commit.
    let paths = vec![("hello.txt".to_owned(), Some(blob_sha.clone()))];
    let commit_sha = commit::commit(
        &pool,
        r.id,
        "main",
        &tree_sha,
        None,
        "Initial commit",
        "Test Author",
        &paths,
    )
    .await
    .expect("commit failed");

    // Branch head should point at the commit.
    let head = commit::branch_head(&pool, r.id, "main")
        .await
        .expect("branch_head failed");
    assert_eq!(head, commit_sha);

    // Create a second commit with the first as parent.
    let content2 = b"Second file";
    let blob2_sha = object::store(&pool, r.id, object::ObjectType::Blob, content2)
        .await
        .expect("object store 2 failed");
    let paths2 = vec![("second.txt".to_owned(), Some(blob2_sha.clone()))];
    let commit2_sha = commit::commit(
        &pool,
        r.id,
        "main",
        &tree_sha,
        Some(&commit_sha),
        "Second commit",
        "Test Author",
        &paths2,
    )
    .await
    .expect("second commit failed");

    let head2 = commit::branch_head(&pool, r.id, "main")
        .await
        .expect("branch_head 2 failed");
    assert_eq!(head2, commit2_sha);

    // Log should have two entries.
    let history = commit::log(&pool, r.id).await.expect("log failed");
    assert_eq!(history.len(), 2);
    // Most recent first.
    assert_eq!(history[0].commit_sha, commit2_sha);
    assert_eq!(history[0].parent_sha.as_deref(), Some(commit_sha.as_str()));
    assert_eq!(history[1].commit_sha, commit_sha);
    assert!(history[1].parent_sha.is_none());
}

/// Integration test: episode open/append/finish/query works end-to-end.
///
/// Verifies:
/// 1. An episode can be opened against a repo.
/// 2. Events can be appended with monotonically increasing seq numbers.
/// 3. The episode can be finished.
/// 4. Finishing an already-finished episode returns `EpisodeNotOpen`.
/// 5. `list_open` returns only open episodes.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL and applied Sharp migrations"]
async fn episode_open_append_finish_query() {
    let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
    let pool = connect(&cfg).await.expect("pool creation failed");

    // Need a repo for the FK.
    let repo_name = unique_name("ep-test-repo");
    let r = repo::init(&pool, &repo_name)
        .await
        .expect("repo init failed");

    // Open an episode.
    let ep = episode::open(&pool, r.id, "Test episode")
        .await
        .expect("episode open failed");
    assert_eq!(ep.state, "open");
    assert_eq!(ep.title, "Test episode");
    assert!(ep.finished_at.is_none());

    // Append two events.
    let ev1 = episode::append(
        &pool,
        ep.id,
        "tool_call",
        serde_json::json!({ "tool": "read_file", "path": "foo.rs" }),
    )
    .await
    .expect("append ev1 failed");
    assert_eq!(ev1.seq, 0);
    assert_eq!(ev1.event_type, "tool_call");

    let ev2 = episode::append(
        &pool,
        ep.id,
        "note",
        serde_json::json!({ "text": "Looks good." }),
    )
    .await
    .expect("append ev2 failed");
    assert_eq!(ev2.seq, 1);

    // Query events — should be in order.
    let evs = episode::events(&pool, ep.id).await.expect("events failed");
    assert_eq!(evs.len(), 2);
    assert_eq!(evs[0].seq, 0);
    assert_eq!(evs[1].seq, 1);

    // list_open should include this episode.
    let open_eps = episode::list_open(&pool, r.id)
        .await
        .expect("list_open failed");
    assert!(open_eps.iter().any(|e| e.id == ep.id));

    // Finish the episode.
    let finished = episode::finish(&pool, ep.id).await.expect("finish failed");
    assert_eq!(finished.state, "finished");
    assert!(finished.finished_at.is_some());

    // list_open should no longer include it.
    let open_after = episode::list_open(&pool, r.id)
        .await
        .expect("list_open after finish failed");
    assert!(!open_after.iter().any(|e| e.id == ep.id));

    // Finishing again should return EpisodeNotOpen.
    let err = episode::finish(&pool, ep.id).await;
    assert!(
        matches!(err, Err(sharp::SharpError::EpisodeNotOpen(id, _)) if id == ep.id),
        "expected EpisodeNotOpen, got {err:?}"
    );

    // Appending to a finished episode should also return EpisodeNotOpen.
    let err2 = episode::append(
        &pool,
        ep.id,
        "note",
        serde_json::json!({ "text": "Should fail" }),
    )
    .await;
    assert!(
        matches!(err2, Err(sharp::SharpError::EpisodeNotOpen(id, _)) if id == ep.id),
        "expected EpisodeNotOpen on append, got {err2:?}"
    );
}

// ── Semantic merge unit tests (no external tools) ────────────────────────────

/// The 3-way textual merge takes "ours" when only our side changed.
#[test]
fn three_way_merge_ours_wins_when_base_matches_theirs() {
    let base = "fn compute_value(x: i32) -> i32 {\n    x * 2\n}\n";
    let ours = "fn calculate_result(x: i32) -> i32 {\n    x * 2\n}\n";
    let theirs = "fn compute_value(x: i32) -> i32 {\n    x * 2\n}\n"; // unchanged
    let merged = three_way_merge(base, ours, theirs);
    assert_eq!(merged, ours, "ours should win when theirs == base");
}

/// The 3-way textual merge takes "theirs" when only their side changed.
#[test]
fn three_way_merge_theirs_wins_when_base_matches_ours() {
    let base = "fn compute_value(x: i32) -> i32 {\n    x * 2\n}\n";
    let ours = "fn compute_value(x: i32) -> i32 {\n    x * 2\n}\n"; // unchanged
    let theirs = "fn compute_value(x: i32) -> i32 {\n    x * 3\n}\n";
    let merged = three_way_merge(base, ours, theirs);
    assert_eq!(merged, theirs, "theirs should win when ours == base");
}

/// When both sides agree, the result is that common version.
#[test]
fn three_way_merge_identical_both_sides() {
    let base = "fn f() {}\n";
    let both = "fn g() {}\n";
    assert_eq!(three_way_merge(base, both, both), both);
}

/// When both sides disagree on the same line, conflict markers are emitted.
#[test]
fn three_way_merge_conflict_markers_on_line_divergence() {
    let base = "fn f() { 1 }\n";
    let ours = "fn f() { 2 }\n";
    let theirs = "fn f() { 3 }\n";
    let merged = three_way_merge(base, ours, theirs);
    assert!(
        merged.contains("<<<<<<<"),
        "conflict marker expected: {merged}"
    );
}

// ── Semantic merge integration tests (require cargo + rust-analyzer) ─────────

/// **Differential test**: Sharp beats git on a Rust rename/edit fixture.
///
/// Scenario:
/// - base:   `compute_value(x: i32) -> i32 { x * 2 }` called from `main`
/// - ours:   rename `compute_value` → `calculate_result` everywhere
/// - theirs: change the body `x * 2` → `x * 3` (still uses old name)
///
/// Git would produce a textual conflict or a silently broken result.
/// Sharp should:
/// 1. Detect the rename via rust-analyzer.
/// 2. Propagate the rename to theirs' edit site.
/// 3. Produce a merged file that compiles and uses the new name.
#[tokio::test]
#[ignore = "requires live rust-analyzer + cargo"]
async fn sharp_beats_git_on_rename_edit_fixture() {
    let base_src = r#"fn compute_value(x: i32) -> i32 {
    x * 2
}

fn main() {
    let result = compute_value(21);
    println!("result = {result}");
}
"#;

    let ours_src = r#"fn calculate_result(x: i32) -> i32 {
    x * 2
}

fn main() {
    let result = calculate_result(21);
    println!("result = {result}");
}
"#;

    let theirs_src = r#"fn compute_value(x: i32) -> i32 {
    x * 3
}

fn main() {
    let result = compute_value(21);
    println!("result = {result}");
}
"#;

    // Create the workspace with the "ours" version already written
    // (semantic_merge_rust writes merged output in-place).
    let (dir, main_rs) = make_temp_project(ours_src);

    let base = vec![FileVersion {
        path: main_rs.clone(),
        content: base_src.to_string(),
    }];
    let ours = vec![FileVersion {
        path: main_rs.clone(),
        content: ours_src.to_string(),
    }];
    let theirs = vec![FileVersion {
        path: main_rs.clone(),
        content: theirs_src.to_string(),
    }];

    let opts = MergeOptions {
        workspace_root: dir.path().to_path_buf(),
        rust_analyzer_path: None,
        ra_timeout_ms: 90_000,
    };

    let result = semantic_merge_rust(&base, &ours, &theirs, &opts)
        .await
        .expect("merge should succeed");

    // Verify the merged file uses the new name and the edited body.
    let merged_content = &result.files[0].content;
    assert!(
        merged_content.contains("calculate_result"),
        "merged file should use the new name 'calculate_result': {merged_content}"
    );
    assert!(
        !merged_content.contains("compute_value"),
        "merged file should not contain the old name 'compute_value': {merged_content}"
    );
    assert!(
        merged_content.contains("x * 3"),
        "merged file should retain theirs' body edit (x * 3): {merged_content}"
    );

    // Verify the result compiles.
    let check = run_cargo_check(dir.path())
        .await
        .expect("cargo check should succeed");
    assert!(
        check.success,
        "merged result should compile: {:?}",
        check.errors
    );
}

/// **Compilation gate**: a non-compiling merge is blocked.
///
/// We directly synthesize a merge result with a type error and verify that
/// `cargo check` detects it and the gate refuses the merge.
#[tokio::test]
#[ignore = "requires live cargo"]
async fn non_compiling_merge_is_blocked() {
    // Source with an intentional type error: passing a string where i32 expected.
    let bad_src = r#"fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    let _ = add("not a number", 2);
}
"#;

    let (dir, _main_rs) = make_temp_project(bad_src);

    let check: CheckResult = run_cargo_check(dir.path())
        .await
        .expect("cargo check should run (even if it fails)");

    assert!(
        !check.success,
        "cargo check should report failure for type-error source"
    );
    assert!(
        !check.errors.is_empty(),
        "at least one compiler error expected"
    );

    let formatted = check.format_errors();
    assert!(
        formatted.contains("E0308") || formatted.to_lowercase().contains("mismatched"),
        "expected E0308 or 'mismatched' in errors: {formatted}"
    );
}

/// **Compilation gate via semantic_merge_rust**: a merge whose output would
/// not compile is refused with `SharpError::MergeRefused`.
#[tokio::test]
#[ignore = "requires live rust-analyzer + cargo"]
async fn semantic_merge_refuses_non_compiling_output() {
    // ours deliberately introduces a type error.
    let base_src = "fn main() { let _x: i32 = 1; }\n";
    let ours_src = "fn main() { let _x: i32 = \"type error here\"; }\n";
    let theirs_src = "fn main() { let _x: i32 = 1; }\n"; // theirs unchanged

    let (dir, main_rs) = make_temp_project(ours_src);

    let base = vec![FileVersion {
        path: main_rs.clone(),
        content: base_src.to_string(),
    }];
    let ours = vec![FileVersion {
        path: main_rs.clone(),
        content: ours_src.to_string(),
    }];
    let theirs = vec![FileVersion {
        path: main_rs.clone(),
        content: theirs_src.to_string(),
    }];

    let opts = MergeOptions {
        workspace_root: dir.path().to_path_buf(),
        rust_analyzer_path: None,
        ra_timeout_ms: 90_000,
    };

    let result = semantic_merge_rust(&base, &ours, &theirs, &opts).await;

    assert!(
        result.is_err(),
        "non-compiling merge should be refused; got Ok"
    );

    let err = result.unwrap_err();
    let err_str = err.to_string();
    assert!(
        err_str.contains("merge refused") || err_str.contains("cargo check"),
        "error should mention merge refusal or cargo check: {err_str}"
    );
}

/// Verify rust-analyzer finds rename locations for a known symbol.
///
/// Opens the rename fixture's `main.rs` and asks for references to the
/// `compute_value` symbol.  Expects ≥ 2 locations (definition + call site).
#[tokio::test]
#[ignore = "requires live rust-analyzer"]
async fn rust_analyzer_finds_rename_locations() {
    use sharp::rust_analyzer_client::{RustAnalyzerClient, RustAnalyzerClientOptions};

    let fixture_dir =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rename-fixture");
    let main_rs = fixture_dir.join("src/main.rs");

    let src = std::fs::read_to_string(&main_rs).expect("read fixture");

    let mut client = RustAnalyzerClient::new(RustAnalyzerClientOptions {
        workspace_root: fixture_dir.clone(),
        timeout_ms: 90_000,
        ..Default::default()
    })
    .expect("create client");

    client.start().await.expect("start");
    client.open_file(&main_rs, &src).await.expect("open_file");

    // `compute_value` is defined on line 6 (0-based line 5), starting at col 3.
    // The definition is `fn compute_value(x: i32) -> i32 {`
    //                        ^ col 3 (0-based)
    let locations = client
        .get_rename_locations(&main_rs, 5, 3, true)
        .await
        .expect("get_rename_locations");

    client.stop().await.expect("stop");

    assert!(
        locations.len() >= 2,
        "expected ≥ 2 rename locations (definition + call site), got {}: {locations:#?}",
        locations.len()
    );

    // At least one location should be in main.rs.
    let in_main = locations.iter().filter(|l| l.file == main_rs).count();
    assert!(
        in_main >= 2,
        "expected ≥ 2 locations in main.rs, got {in_main}: {locations:#?}"
    );
}
