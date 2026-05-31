//! Integration tests for the Sharp VCS core and episode schema.
//!
//! These tests require a live Postgres instance with the Sharp schema already
//! applied (run migrations from `crates/sharp/migrations/` first).
//!
//! Run with:
//!   DATABASE_URL=postgres://... cargo test -p sharp -- --include-ignored integration
//!
//! # Test coverage
//!
//! - `init_add_commit_roundtrip` — verifies that init/add/commit persists to
//!   the shared instance and that the branch head is updated.
//! - `episode_open_append_finish_query` — verifies that episode lifecycle
//!   works end-to-end.

use sf_db::{connect, DbConfig};
use sharp::{commit, episode, object, repo};
use uuid::Uuid;

/// Helper: unique repo name per test run.
fn unique_name(prefix: &str) -> String {
    format!("{}-{}", prefix, Uuid::new_v4().as_simple())
}

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
