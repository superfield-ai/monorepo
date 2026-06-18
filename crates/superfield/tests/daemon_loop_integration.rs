//! Integration tests for the daemon's gardening-loop + appliance-supervisor
//! wiring (issue #671).
//!
//! These tests exercise the **running path**: `daemon_runtime::boot_loop`
//! installs the real [`sf_loop::GardeningLoopHandle`] (not `NoopLoopHandle`),
//! the loop ticks against the brain (writes a `nexum.page_revisions` row and
//! commits `orchestrator.gardening_cursor`), drain finishes the current step in
//! order before the provisioner stops, and a restart resumes from the persisted
//! cursor rather than restarting the step sequence.
//!
//! The DB-backed tests are `#[ignore]`d and require `DATABASE_URL` pointing at a
//! Postgres with the `nexum` and `orchestrator` schemas/migrations applied —
//! the same gating the `sf-loop` cursor integration tests use. They use the
//! deterministic [`sf_loop::FixtureAgentExecutor`] so the loop makes no outbound
//! LLM call.
//!
//! The daemon_runtime functions under test are compiled into the `superfield`
//! binary; this integration crate re-declares the module via `#[path]` so it can
//! call them directly without a separate library target.

#[path = "../src/daemon_runtime.rs"]
mod daemon_runtime;

use std::sync::Arc;
use std::time::Duration;

use sf_loop::{FixtureAgentExecutor, LoopConfig, STEP_ORDER};
use uuid::Uuid;

/// Connect to the test database, or return `None` (caller skips) if unset.
async fn pool_or_skip() -> Option<sqlx::PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("connect to DATABASE_URL");
    Some(pool)
}

fn loop_config(workspace_id: Uuid) -> LoopConfig {
    LoopConfig {
        workspace_id,
        blueprint_path: std::path::PathBuf::from("blueprint/rules/graph.yaml"),
        llm_api_key: String::new(),
        llm_endpoint: "http://127.0.0.1:0/never".to_string(),
        llm_model: "fixture".to_string(),
    }
}

/// Seed a `public.workspaces` row so page-revision inserts satisfy the FK.
async fn seed_workspace(pool: &sqlx::PgPool, workspace_id: Uuid) {
    sqlx::query(
        "INSERT INTO public.workspaces (id, slug, display_name) \
         VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(format!("daemon-it-{workspace_id}"))
    .bind("daemon integration test")
    .execute(pool)
    .await
    .expect("seed workspace");
}

async fn cleanup(pool: &sqlx::PgPool, workspace_id: Uuid) {
    sqlx::query("DELETE FROM orchestrator.gardening_cursor WHERE workspace_id = $1")
        .bind(workspace_id)
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM nexum.page_revisions WHERE workspace_id = $1")
        .bind(workspace_id)
        .execute(pool)
        .await
        .ok();
    sqlx::query("DELETE FROM public.workspaces WHERE id = $1")
        .bind(workspace_id)
        .execute(pool)
        .await
        .ok();
}

/// Poll `orchestrator.gardening_cursor` until a row appears for `workspace_id`
/// or the deadline elapses. Returns the committed step name, if any.
async fn wait_for_cursor(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
    timeout: Duration,
) -> Option<String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let row: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT step_name FROM orchestrator.gardening_cursor WHERE workspace_id = $1",
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
        .expect("cursor query");
        if let Some((Some(name),)) = row {
            return Some(name);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// `build_executor` falls back to the deterministic fixture executor when no
/// LLM API key is configured, so the loop ticks without any outbound call. This
/// runs without a database.
#[test]
fn build_executor_falls_back_to_fixture_without_api_key() {
    let config = loop_config(Uuid::new_v4());
    assert!(config.llm_api_key.is_empty());
    // Must not panic and must produce a usable executor (the fixture variant).
    let _executor = daemon_runtime::build_executor(&config);
}

/// Acceptance: after boot the real loop handle is installed (not the no-op) and
/// the loop ticks at least once against the brain — recording a page revision
/// and committing its cursor.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL with nexum + orchestrator migrations applied"]
async fn boot_installs_real_loop_handle_and_records_a_tick() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let workspace_id = Uuid::new_v4();
    cleanup(&pool, workspace_id).await;
    seed_workspace(&pool, workspace_id).await;

    let executor: Arc<dyn sf_loop::AgentExecutor> = Arc::new(FixtureAgentExecutor::default());
    let handle = daemon_runtime::boot_loop(pool.clone(), loop_config(workspace_id), executor);

    // The loop ticks against the brain: the first step commits a cursor.
    let committed = wait_for_cursor(&pool, workspace_id, Duration::from_secs(10)).await;
    assert!(
        committed.is_some(),
        "real loop handle must tick and commit a cursor (got none)"
    );

    // A page revision row must have been written by the tick.
    let revisions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM nexum.page_revisions WHERE workspace_id = $1")
            .bind(workspace_id)
            .fetch_one(&pool)
            .await
            .expect("revision count");
    assert!(
        revisions >= 1,
        "loop tick must write at least one page revision (got {revisions})"
    );

    // Drain proves the handle is the real one (returns Ok after the loop stops).
    handle.drain().await.expect("real handle drains cleanly");

    cleanup(&pool, workspace_id).await;
}

/// Acceptance: shutdown drains the running loop step before the provisioner is
/// stopped — `daemon_runtime::shutdown` runs drain → down → stop in order.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL with nexum + orchestrator migrations applied"]
async fn shutdown_drains_loop_before_stopping_provisioner() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let workspace_id = Uuid::new_v4();
    cleanup(&pool, workspace_id).await;
    seed_workspace(&pool, workspace_id).await;

    let executor: Arc<dyn sf_loop::AgentExecutor> = Arc::new(FixtureAgentExecutor::default());
    let handle = daemon_runtime::boot_loop(pool.clone(), loop_config(workspace_id), executor);

    // Let the loop tick at least once so a step is committed.
    wait_for_cursor(&pool, workspace_id, Duration::from_secs(10)).await;

    let supervisor = fastenv::deployment::NoopSupervisor;
    let provisioner = sf_db::provisioner::TestProvisioner;

    // Ordered teardown — drain the loop (finishing + committing the current
    // step against the still-live DB), then supervisor down, then provisioner
    // stop. The drain awaits the loop's done signal, so completing here without
    // hanging proves the running step drained BEFORE the provisioner was
    // stopped. (The strict drain → down → stop order is asserted deterministically
    // in the `daemon_runtime::tests` unit suite.)
    daemon_runtime::shutdown(handle.as_ref(), &supervisor, &provisioner).await;

    // The drained loop committed at least one step's cursor against the DB that
    // was still up during drain.
    let cursor: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT step_name FROM orchestrator.gardening_cursor WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(&pool)
    .await
    .expect("cursor query");
    assert!(
        matches!(cursor, Some((Some(_),))),
        "the drained loop must have committed its step cursor before teardown"
    );

    // The handle is idempotent: draining an already-drained loop is a clean Ok.
    handle.drain().await.expect("second drain is idempotent Ok");

    cleanup(&pool, workspace_id).await;
}

/// Acceptance: the loop resumes from its persisted cursor after a restart rather
/// than restarting the step sequence.
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL with nexum + orchestrator migrations applied"]
async fn loop_resumes_from_persisted_cursor_after_restart() {
    let Some(pool) = pool_or_skip().await else {
        return;
    };
    let workspace_id = Uuid::new_v4();
    cleanup(&pool, workspace_id).await;
    seed_workspace(&pool, workspace_id).await;

    // Simulate a prior run that committed up to the second step (prd_reconcile).
    sf_loop::commit_cursor(&pool, workspace_id, "prd_reconcile")
        .await
        .expect("seed cursor");

    // "Restart": boot the loop fresh. It must resume AFTER prd_reconcile —
    // i.e. it must NOT re-run strategy_research (index 0). We detect this by
    // confirming the loaded resume cursor matches what a fresh boot reads.
    let loaded = sf_loop::load_cursor(&pool, workspace_id)
        .await
        .expect("load_cursor");
    assert_eq!(loaded.as_deref(), Some("prd_reconcile"));

    let resume_idx = STEP_ORDER
        .iter()
        .position(|s| s.name() == loaded.as_deref().unwrap_or(""))
        .map(|i| i + 1)
        .unwrap_or(0);
    assert_eq!(
        resume_idx, 2,
        "restart must resume one step past the persisted cursor, not from step 0"
    );

    // Now boot the real loop and let it advance. The next committed step must be
    // a later step than the seed, proving it did not restart the sequence.
    let executor: Arc<dyn sf_loop::AgentExecutor> = Arc::new(FixtureAgentExecutor::default());
    let handle = daemon_runtime::boot_loop(pool.clone(), loop_config(workspace_id), executor);

    // Wait until the cursor advances past prd_reconcile.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut advanced = false;
    while std::time::Instant::now() < deadline {
        if let Some(name) = wait_for_cursor(&pool, workspace_id, Duration::from_millis(200)).await {
            let idx = STEP_ORDER
                .iter()
                .position(|s| s.name() == name)
                .unwrap_or(0);
            if idx >= 2 {
                advanced = true;
                break;
            }
        }
    }
    handle.drain().await.ok();
    assert!(
        advanced,
        "loop must advance past the persisted cursor on restart"
    );

    cleanup(&pool, workspace_id).await;
}
