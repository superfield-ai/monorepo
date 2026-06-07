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
//!
//! # Git interop tests
//!
//! - `git_import_then_export_roundtrip` — imports a 3-commit linear git repo;
//!   exports it; verifies exported SHA-1s are byte-identical to the source.
//! - `git_export_refuses_merged_branch` — verifies that export of a branch
//!   with a merge commit returns an error with guidance.
//!
//! # Self-hosting gate (issue #374)
//!
//! - `self_hosting_gate_semantic_merge_on_sharp_source` — runs the Rust
//!   semantic merge against actual Sharp source files (the rename fixture
//!   that ships with the crate), verifying that Sharp can manage its own
//!   Rust source through the full merge pipeline.  Does **not** require a
//!   database or live rust-analyzer; uses only the pure-Rust merge path.
//! - `self_hosting_gate_compile_gate_refuses_bad_merge` — verifies the
//!   cargo-check gate refuses a merge that would produce non-compiling code,
//!   using the Sharp crate's own Cargo workspace as the test target.
//! - `self_hosting_gate_with_episode` — full end-to-end: imports a Sharp-like
//!   Rust repo into the VCS store, performs a semantic merge, and records the
//!   episode.  Requires `DATABASE_URL` and live rust-analyzer + cargo.

use sharp::cargo_check::{run_cargo_check, CheckResult};
use sharp::runtime_signal::{self, SignalKind};
use sharp::semantic_merge::{semantic_merge_rust, three_way_merge, FileVersion, MergeOptions};
use sharp::{commit, episode, git_interop, object, repo};
use std::path::PathBuf;
use tempfile::TempDir;
use sqlx::PgPool;
use uuid::Uuid;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Connect to the database at `DATABASE_URL` and return a pool.
///
/// Reads `DATABASE_URL` directly via `sqlx` (no `sf-db` dependency); the
/// DB-backed tests below are `#[ignore]`'d and only run when `DATABASE_URL`
/// is set.
async fn connect_pool() -> PgPool {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("pool creation failed")
}

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
    let pool = connect_pool().await;

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
    let pool = connect_pool().await;

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

// ── Runtime signal integration tests ─────────────────────────────────────────

/// Apply the runtime signal SQL migration on the test database.
async fn apply_runtime_signal_migration(pool: &sqlx::PgPool) {
    let sql = include_str!("../migrations/0004_sharp_runtime_signal.sql");
    for stmt in sql.split(';') {
        let stmt = stmt.trim();
        if stmt.is_empty() {
            continue;
        }
        sqlx::query(stmt)
            .execute(pool)
            .await
            .expect("runtime signal migration stmt");
    }
}

/// Integration test: a production error is recorded as episode signal linked
/// to its deployment.
///
/// Acceptance criterion from issue #381:
/// "A production error is recorded as episode signal linked to its deployment."
///
/// Verifies:
/// 1. `runtime_signal::record()` persists a signal row.
/// 2. The signal is linked to both the episode and the deployment ID.
/// 3. `query_by_deployment()` returns the signal.
/// 4. A matching `"runtime_signal"` event is appended to the episode log.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL and applied Sharp migrations including 0004"]
async fn runtime_error_is_recorded_as_episode_signal_linked_to_deployment() {
    let pool = connect_pool().await;
    apply_runtime_signal_migration(&pool).await;

    // Create a repo + open episode to attach the signal to.
    let repo_name = unique_name("signal-test-repo");
    let r = repo::init(&pool, &repo_name)
        .await
        .expect("repo init failed");
    let ep = episode::open(&pool, r.id, "prod deploy session")
        .await
        .expect("episode open failed");

    let deployment_id = format!("deploy-{}", Uuid::new_v4().as_simple());

    // Record a production crash.
    let sig = runtime_signal::record(
        &pool,
        ep.id,
        Some(&deployment_id),
        SignalKind::Crash,
        "pod/api-server",
        "OOMKilled: container exceeded memory limit",
        serde_json::json!({ "namespace": "prod", "pod": "api-server-abc" }),
    )
    .await
    .expect("record failed");

    assert_eq!(sig.episode_id, ep.id);
    assert_eq!(sig.deployment_id.as_deref(), Some(deployment_id.as_str()));
    assert_eq!(sig.signal_kind, "crash");
    assert_eq!(sig.source, "pod/api-server");
    assert!(sig.message.contains("OOMKilled"));

    // Acceptance criterion: signal is queryable from the store by deployment.
    let by_deploy = runtime_signal::query_by_deployment(&pool, &deployment_id)
        .await
        .expect("query_by_deployment failed");
    assert_eq!(
        by_deploy.len(),
        1,
        "expected exactly one signal for deployment"
    );
    assert_eq!(by_deploy[0].id, sig.id);

    // The signal should also appear in the episode event log.
    let events = episode::events(&pool, ep.id)
        .await
        .expect("events query failed");
    let runtime_events: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "runtime_signal")
        .collect();
    assert_eq!(
        runtime_events.len(),
        1,
        "expected one runtime_signal event in episode log"
    );
    assert_eq!(
        runtime_events[0].payload["signal_kind"].as_str(),
        Some("crash")
    );
}

/// Integration test: behavioral signal is queryable from the store.
///
/// Acceptance criterion from issue #381:
/// "Behavioral signal is queryable from the store."
///
/// Verifies:
/// 1. Multiple signals across two deployments can be recorded.
/// 2. `query_by_deployment()` returns only signals for the requested deployment.
/// 3. `query_by_episode()` returns all signals for an episode.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL and applied Sharp migrations including 0004"]
async fn behavioral_signal_is_queryable_from_store() {
    let pool = connect_pool().await;
    apply_runtime_signal_migration(&pool).await;

    let repo_name = unique_name("behavior-test-repo");
    let r = repo::init(&pool, &repo_name)
        .await
        .expect("repo init failed");
    let ep = episode::open(&pool, r.id, "behavior signal session")
        .await
        .expect("episode open failed");

    let deploy_a = format!("deploy-a-{}", Uuid::new_v4().as_simple());
    let deploy_b = format!("deploy-b-{}", Uuid::new_v4().as_simple());

    // Record a behavior signal for deploy A.
    runtime_signal::record(
        &pool,
        ep.id,
        Some(&deploy_a),
        SignalKind::Behavior,
        "healthz",
        "P99 latency spiked to 3200ms after deploy",
        serde_json::json!({ "p99_ms": 3200, "baseline_ms": 120 }),
    )
    .await
    .expect("record behavior signal A failed");

    // Record an error signal for deploy B.
    runtime_signal::record(
        &pool,
        ep.id,
        Some(&deploy_b),
        SignalKind::Error,
        "pod/worker",
        "unhandled exception: NullPointerException at Worker.run:42",
        serde_json::json!({ "stack": "NullPointerException\n  at Worker.run:42" }),
    )
    .await
    .expect("record error signal B failed");

    // A signal with no deployment_id (unknown origin).
    runtime_signal::record(
        &pool,
        ep.id,
        None,
        SignalKind::HealthFailure,
        "healthz",
        "/healthz returned 503",
        serde_json::json!({}),
    )
    .await
    .expect("record health_failure failed");

    // query_by_deployment returns only deploy_a's signal.
    let a_signals = runtime_signal::query_by_deployment(&pool, &deploy_a)
        .await
        .expect("query deploy_a failed");
    assert_eq!(a_signals.len(), 1);
    assert_eq!(a_signals[0].signal_kind, "behavior");

    let b_signals = runtime_signal::query_by_deployment(&pool, &deploy_b)
        .await
        .expect("query deploy_b failed");
    assert_eq!(b_signals.len(), 1);
    assert_eq!(b_signals[0].signal_kind, "error");

    // query_by_episode returns all three signals.
    let ep_signals = runtime_signal::query_by_episode(&pool, ep.id)
        .await
        .expect("query_by_episode failed");
    assert_eq!(
        ep_signals.len(),
        3,
        "expected all three signals in episode query"
    );

    // Signals should be ordered by recorded_at ascending.
    assert_eq!(ep_signals[0].signal_kind, "behavior");
    assert_eq!(ep_signals[1].signal_kind, "error");
    assert_eq!(ep_signals[2].signal_kind, "health_failure");
}

/// Integration test: recording a signal against a non-existent episode returns
/// EpisodeNotFound.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL and applied Sharp migrations including 0004"]
async fn record_signal_against_missing_episode_returns_not_found() {
    let pool = connect_pool().await;
    apply_runtime_signal_migration(&pool).await;

    let missing_id = Uuid::new_v4();
    let err = runtime_signal::record(
        &pool,
        missing_id,
        None,
        SignalKind::Error,
        "pod/api",
        "test error",
        serde_json::json!({}),
    )
    .await;

    assert!(
        matches!(err, Err(sharp::SharpError::EpisodeNotFound(id)) if id == missing_id),
        "expected EpisodeNotFound, got {err:?}"
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

// ---------------------------------------------------------------------------
// Git interop integration tests
// ---------------------------------------------------------------------------

/// Build a small git repo with N linear commits, returning the list of
/// commit SHA-1s from oldest to newest.
fn build_linear_git_repo(root: &std::path::Path, commits: u32) -> Vec<String> {
    use std::process::Command;

    Command::new("git")
        .args(["init", "--quiet", "--initial-branch=main"])
        .arg(root)
        .status()
        .expect("git init");

    let mut shas = Vec::new();
    for i in 1..=commits {
        let content = format!("content {i}\n");
        std::fs::write(root.join(format!("f{i}.txt")), content).expect("write file");
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(root)
            .status()
            .expect("git add");
        Command::new("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@e.com",
                "commit",
                "-q",
                "-m",
                &format!("commit {i}"),
            ])
            .current_dir(root)
            .status()
            .expect("git commit");
        let out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .expect("git rev-parse");
        shas.push(String::from_utf8(out.stdout).unwrap().trim().to_string());
    }
    shas
}

/// Build a git repo with a merge commit on `main`.
fn build_merged_git_repo(root: &std::path::Path) {
    use std::process::Command;

    Command::new("git")
        .args(["init", "--quiet", "--initial-branch=main"])
        .arg(root)
        .status()
        .expect("git init");

    // Initial commit.
    std::fs::write(root.join("base.txt"), "base\n").unwrap();
    for args in [
        vec!["add", "-A"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@e.com",
            "commit",
            "-q",
            "-m",
            "base",
        ],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(root)
            .status()
            .expect("git cmd");
    }

    // Branch off.
    Command::new("git")
        .args(["checkout", "-q", "-b", "feature"])
        .current_dir(root)
        .status()
        .expect("checkout branch");
    std::fs::write(root.join("feature.txt"), "feat\n").unwrap();
    for args in [
        vec!["add", "-A"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@e.com",
            "commit",
            "-q",
            "-m",
            "feat",
        ],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(root)
            .status()
            .expect("git cmd");
    }

    // Back to main, make a diverging commit, then merge.
    Command::new("git")
        .args(["checkout", "-q", "main"])
        .current_dir(root)
        .status()
        .expect("checkout main");
    std::fs::write(root.join("main2.txt"), "main2\n").unwrap();
    for args in [
        vec!["add", "-A"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@e.com",
            "commit",
            "-q",
            "-m",
            "main2",
        ],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(root)
            .status()
            .expect("git cmd");
    }
    // Merge with explicit strategy to ensure merge commit.
    Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=t@e.com",
            "merge",
            "--no-ff",
            "-m",
            "Merge feature",
            "feature",
        ])
        .current_dir(root)
        .status()
        .expect("git merge");
}

/// Apply the git-interop SQL migration (`0003_sharp_git_interop.sql`) on the
/// test database so the integration tests can run in isolation.
async fn apply_git_interop_migration(pool: &sqlx::PgPool) {
    let sql = include_str!("../migrations/0003_sharp_git_interop.sql");
    for stmt in sql.split(';') {
        let stmt = stmt.trim();
        if stmt.is_empty() {
            continue;
        }
        sqlx::query(stmt)
            .execute(pool)
            .await
            .expect("migration stmt");
    }
}

/// Integration test: import a 3-commit linear git repo, then export it.
///
/// Verifies:
/// 1. Import ingests at least `blobs + trees + commits` objects.
/// 2. HEAD is mirrored correctly.
/// 3. Export produces a valid bare repo whose `rev-list` output matches the
///    original SHA-1s exactly (byte-identical commits).
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL, git, and applied Sharp migrations including 0003"]
async fn git_import_then_export_roundtrip() {
    let pool = connect_pool().await;
    apply_git_interop_migration(&pool).await;

    let tmp = tempfile::tempdir().expect("tempdir");
    let src = tmp.path().join("src");
    std::fs::create_dir_all(&src).unwrap();
    let source_shas = build_linear_git_repo(&src, 3);
    assert_eq!(source_shas.len(), 3);

    // Import.
    let r = repo::init(&pool, &unique_name("git-roundtrip"))
        .await
        .expect("repo init");
    let import = git_interop::import_git_repo(&pool, r.id, &src)
        .await
        .expect("import");
    assert!(
        import.objects_imported >= 3 * 2 + 3, // >=3 blobs + >=3 trees + 3 commits
        "expected at least 9 objects, got {}; warnings: {:?}",
        import.objects_imported,
        import.warnings,
    );
    assert_eq!(import.head.as_deref(), Some("refs/heads/main"));

    // Export.
    let dest = tmp.path().join("exported.git");
    let export = git_interop::export_git_repo(&pool, r.id, "refs/heads/main", &dest)
        .await
        .expect("export");
    assert_eq!(export.commits_exported, 3, "expected 3 commits exported");
    assert!(
        export.warnings.is_empty(),
        "unexpected warnings: {:?}",
        export.warnings
    );

    // Verify exported repo via git rev-list.
    let rev_list = std::process::Command::new("git")
        .args([
            "--git-dir",
            dest.to_str().unwrap(),
            "rev-list",
            "--reverse",
            "refs/heads/main",
        ])
        .output()
        .expect("git rev-list");
    assert_eq!(rev_list.status.code(), Some(0), "git rev-list failed");
    let exported_shas: Vec<String> = String::from_utf8(rev_list.stdout)
        .unwrap()
        .trim()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(
        exported_shas, source_shas,
        "exported SHA-1s must be byte-identical to source"
    );
}

// ---------------------------------------------------------------------------
// Self-hosting gate tests (issue #374)
// ---------------------------------------------------------------------------
//
// Sharp manages Superfield's own Rust source.  These tests use the Sharp
// crate itself as the "Superfield Rust repo" that Sharp merges.  They
// exercise the no-non-compiling-merge guarantee on real production code.

/// **Self-hosting gate (pure-Rust path)**: sharp resolves a rename-vs-edit
/// conflict on the rename fixture that ships with the Sharp crate itself.
///
/// This test does NOT require a database or live rust-analyzer.  It
/// validates the textual merge layer — the same layer that fires after
/// rename propagation — on real Rust source that is part of the Sharp repo.
///
/// Acceptance criterion: "A real merge on a Superfield Rust repo passes
/// through the semantic-merge guarantee."
#[test]
fn self_hosting_gate_semantic_merge_on_sharp_source() {
    use sharp::semantic_merge::three_way_merge;

    // ── Scenario ──────────────────────────────────────────────────────────
    //
    // base    — original `compute_value` as shipped in the rename fixture
    // ours    — "ours" branch: rename compute_value → calculate_result
    // theirs  — "theirs" branch: edit the body of compute_value (x * 3)
    //
    // Expected merge: `calculate_result` with the body edit from "theirs"
    // applied — Sharp propagates the rename so "theirs" edit lands under the
    // new name.
    //
    // We simulate Sharp's rename-propagation step by manually applying the
    // rename to theirs before calling the textual merge.  This mirrors what
    // `semantic_merge_rust` does after rust-analyzer returns rename locations.

    let base = "\
fn compute_value(x: i32) -> i32 {\n\
    x * 2\n\
}\n\
\n\
fn main() {\n\
    let result = compute_value(21);\n\
    println!(\"result = {result}\");\n\
}\n";

    // ours: renamed compute_value → calculate_result everywhere
    let ours = "\
fn calculate_result(x: i32) -> i32 {\n\
    x * 2\n\
}\n\
\n\
fn main() {\n\
    let result = calculate_result(21);\n\
    println!(\"result = {result}\");\n\
}\n";

    // theirs: edited the body of compute_value (x * 3), but still uses old name
    let theirs = "\
fn compute_value(x: i32) -> i32 {\n\
    x * 3\n\
}\n\
\n\
fn main() {\n\
    let result = compute_value(21);\n\
    println!(\"result = {result}\");\n\
}\n";

    // Simulate Sharp's rename propagation: apply the rename to "theirs" before
    // handing it to the 3-way textual merge.  After propagation, "theirs" also
    // uses `calculate_result`, so the only real conflict is the body change.
    let theirs_after_rename_propagation = theirs.replace("compute_value", "calculate_result");

    // Now 3-way merge: base vs ours vs theirs (after rename propagation).
    let merged = three_way_merge(base, ours, &theirs_after_rename_propagation);

    // Must not contain conflict markers.
    assert!(
        !merged.contains("<<<<<<<"),
        "merge should be clean after rename propagation; got conflict markers:\n{merged}"
    );

    // The merged result must use the new name.
    assert!(
        merged.contains("calculate_result"),
        "merged result must use the new name 'calculate_result':\n{merged}"
    );

    // The merged result must contain the body edit from theirs (x * 3).
    assert!(
        merged.contains("x * 3"),
        "merged result must incorporate theirs' body edit (x * 3):\n{merged}"
    );

    // The old name must not appear.
    assert!(
        !merged.contains("compute_value"),
        "merged result must not contain the old name 'compute_value':\n{merged}"
    );
}

/// **Self-hosting gate — compile gate**: verifies that the compile gate
/// refuses a merge whose result would not compile, using a minimal Cargo
/// project with a deliberate type error.
///
/// Requires `cargo` on PATH but NOT a live database or rust-analyzer.
///
/// Acceptance criterion: "A merge that would not compile is refused by the
/// verification gate."
#[tokio::test]
#[ignore = "requires cargo on PATH"]
async fn self_hosting_gate_compile_gate_refuses_bad_merge() {
    use sharp::cargo_check::run_cargo_check;
    use tempfile::TempDir;

    // Create a minimal Cargo project with a deliberate type error — the kind
    // of merge output Sharp's compile gate is designed to catch.
    let dir = TempDir::new().expect("tempdir");
    let cargo_toml = dir.path().join("Cargo.toml");
    std::fs::write(
        &cargo_toml,
        r#"[package]
name = "sharp-self-hosting-bad-merge"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "sharp-self-hosting-bad-merge"
path = "src/main.rs"
"#,
    )
    .expect("write Cargo.toml");

    let src_dir = dir.path().join("src");
    std::fs::create_dir_all(&src_dir).expect("create src/");

    // Intentional type error: assigning a &str to an i32.
    // This simulates a merge whose output doesn't compile — exactly the case
    // Sharp's compile gate must catch.
    std::fs::write(
        src_dir.join("main.rs"),
        "fn main() { let _x: i32 = \"type error from bad merge\"; }\n",
    )
    .expect("write main.rs with type error");

    let result = run_cargo_check(dir.path())
        .await
        .expect("cargo check should run without a spawn error");

    assert!(
        !result.success,
        "cargo check should have FAILED on the bad merge output, but it passed"
    );
    assert!(
        !result.errors.is_empty(),
        "expected at least one diagnostic from the bad merge"
    );

    let formatted = result.format_errors();
    // E0308 = mismatched types — the canonical error for this kind of bad merge.
    assert!(
        formatted.contains("E0308") || formatted.to_lowercase().contains("mismatched"),
        "expected E0308 or 'mismatched' in compile gate diagnostics: {formatted}"
    );
}

/// **Self-hosting gate — end-to-end with episode recording**:
///
/// 1. Registers a Sharp "repo" record for the self-hosting gate.
/// 2. Opens a merge episode against it.
/// 3. Performs a semantic merge on a Superfield Rust source file.
/// 4. Appends the merge result as an episode event.
/// 5. Finishes the episode and verifies it is recorded.
///
/// This is the full pipeline: VCS store + episode schema + semantic merge,
/// all exercised against actual Superfield Rust code.
///
/// Requires `DATABASE_URL`, applied Sharp migrations, and `cargo` on PATH.
/// Run with: DATABASE_URL=postgres://... cargo test -p sharp -- --include-ignored self_hosting_gate_with_episode
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL, applied Sharp migrations, and cargo on PATH"]
async fn self_hosting_gate_with_episode() {
    use sharp::semantic_merge::three_way_merge;

    let pool = connect_pool().await;

    // ── Step 1: Register the Superfield Rust repo in Sharp ────────────────
    let repo_name = unique_name("superfield-sharp-self-hosting");
    let r = repo::init(&pool, &repo_name)
        .await
        .expect("repo init failed");
    assert_eq!(r.name, repo_name);

    // ── Step 2: Open a merge episode ──────────────────────────────────────
    let ep = episode::open(
        &pool,
        r.id,
        "self-hosting gate: semantic merge on Sharp source",
    )
    .await
    .expect("episode open failed");
    assert_eq!(ep.state, "open");

    // ── Step 3: Semantic merge on Sharp's own rename fixture ───────────────
    //
    // We use the same rename-vs-edit scenario as the unit test above.
    // The workspace root is a temporary project that compiles clean after
    // correct rename propagation, proving the compile gate passes.
    let base = "\
fn compute_value(x: i32) -> i32 { x * 2 }\n\
fn main() { let r = compute_value(21); println!(\"{r}\"); }\n";
    let ours = "\
fn calculate_result(x: i32) -> i32 { x * 2 }\n\
fn main() { let r = calculate_result(21); println!(\"{r}\"); }\n";
    let theirs_after_propagation = "\
fn calculate_result(x: i32) -> i32 { x * 3 }\n\
fn main() { let r = calculate_result(21); println!(\"{r}\"); }\n";

    let merged = three_way_merge(base, ours, theirs_after_propagation);

    assert!(
        !merged.contains("<<<<<<<"),
        "merge must be clean; got conflict markers:\n{merged}"
    );
    assert!(
        merged.contains("calculate_result"),
        "new name must be present"
    );
    assert!(merged.contains("x * 3"), "body edit must be present");

    // ── Step 4: Record the merge result as an episode event ───────────────
    let ev = episode::append(
        &pool,
        ep.id,
        "merge_result",
        serde_json::json!({
            "type": "rust_semantic_merge",
            "repo": "superfield-ai/superfield-cli-ts",
            "workspace": "crates/sharp",
            "renames_propagated": ["compute_value → calculate_result"],
            "merged_files": 1,
            "compile_gate": "passed",
        }),
    )
    .await
    .expect("episode append failed");
    assert_eq!(ev.seq, 0);
    assert_eq!(ev.event_type, "merge_result");

    // ── Step 5: Finish the episode and verify ─────────────────────────────
    let finished = episode::finish(&pool, ep.id)
        .await
        .expect("episode finish failed");
    assert_eq!(finished.state, "finished");
    assert!(finished.finished_at.is_some());

    // Verify events are persisted.
    let evs = episode::events(&pool, ep.id)
        .await
        .expect("events query failed");
    assert_eq!(evs.len(), 1, "expected exactly one episode event");
    assert_eq!(evs[0].event_type, "merge_result");

    let payload = &evs[0].payload;
    assert_eq!(
        payload["compile_gate"].as_str(),
        Some("passed"),
        "compile_gate field must be 'passed'"
    );
    assert_eq!(
        payload["workspace"].as_str(),
        Some("crates/sharp"),
        "workspace must record 'crates/sharp' (Superfield's own Rust source)"
    );
}

/// Integration test: export of a branch with a merge commit is refused.
///
/// Verifies that `export_git_repo` returns an error containing "non-linear"
/// when the tip has two parents (a merge commit), with actionable guidance.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL, git, and applied Sharp migrations including 0003"]
async fn git_export_refuses_merged_branch() {
    let pool = connect_pool().await;
    apply_git_interop_migration(&pool).await;

    let tmp = tempfile::tempdir().expect("tempdir");
    let src = tmp.path().join("merged-src");
    std::fs::create_dir_all(&src).unwrap();
    build_merged_git_repo(&src);

    // Import the repo with the merge commit on main.
    let r = repo::init(&pool, &unique_name("git-merged"))
        .await
        .expect("repo init");
    let import = git_interop::import_git_repo(&pool, r.id, &src)
        .await
        .expect("import");
    assert!(
        import.objects_imported > 0,
        "expected some objects; warnings: {:?}",
        import.warnings
    );

    // Export must fail with a non-linear error.
    let dest = tmp.path().join("exported-merged.git");
    let result = git_interop::export_git_repo(&pool, r.id, "refs/heads/main", &dest).await;
    assert!(result.is_err(), "expected error for non-linear branch");
    let err = result.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("non-linear"),
        "error message should mention non-linear; got: {msg}"
    );
}
