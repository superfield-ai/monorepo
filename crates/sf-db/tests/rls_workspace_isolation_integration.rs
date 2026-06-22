//! Integration tests: the appliance boot migration runner applies the RLS
//! workspace-isolation policies, so cross-workspace reads/writes are denied by
//! Postgres (issue #710).
//!
//! These tests stand up a throwaway Postgres cluster with `initdb` + `pg_ctl`
//! via [`LocalPostgresProvisioner`] (the same harness as
//! `provision_migrate_integration.rs`), then drive `run_migrations` /
//! `apply_migrations` exactly as the daemon boot sequence does. They skip
//! cleanly when the Postgres server binaries are not installed so offline CI is
//! not broken.
//!
//! The cluster is initialised with `--auth=trust`, so the test connects as a
//! purpose-made non-superuser app role to exercise the policies: a Postgres
//! SUPERUSER bypasses even FORCE ROW LEVEL SECURITY, so RLS can only be
//! observed from a non-superuser, non-BYPASSRLS role.
//!
//! Run with the Postgres binaries available:
//! ```bash
//! cargo test -p sf-db --test rls_workspace_isolation_integration -- --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use sf_db::{LocalPostgresProvisioner, Migration, PostgresProvisioner};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool};

/// `SET LOCAL app.workspace_id = '<uuid>'` SQL for a test-controlled UUID.
///
/// PostgreSQL's `SET` command does not accept bind parameters, so the UUID
/// (always a fixed, test-controlled value) is interpolated as a literal. This
/// mirrors what `setWorkspaceContext` does in `packages/db/rls.ts`.
fn set_workspace_sql(workspace: &str) -> String {
    format!("SET LOCAL app.workspace_id = '{workspace}'")
}

/// The migration id under test — the RLS file mirrored into the last component
/// directory so the appliance runner applies it after every schema exists.
const RLS_MIGRATION_ID: &str = "sharp/0009_rls_workspace_isolation";

/// Locate a Postgres bin dir with `initdb`, or `None` to skip the test.
fn pg_bin_dir_or_skip() -> Option<PathBuf> {
    let base = Path::new("/usr/lib/postgresql");
    let mut best: Option<(u32, PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(base) {
        for e in entries.flatten() {
            let bin = e.path().join("bin");
            if bin.join("initdb").is_file() {
                let major = e
                    .file_name()
                    .to_str()
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0);
                if best.as_ref().map(|(m, _)| major > *m).unwrap_or(true) {
                    best = Some((major, bin));
                }
            }
        }
    }
    if best.is_none() {
        eprintln!("skipping rls integration: no /usr/lib/postgresql/<major>/bin with initdb");
    }
    best.map(|(_, p)| p)
}

/// Pick a likely-free high port for the throwaway instance.
fn ephemeral_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    port
}

/// The migrations the appliance applies that need no Postgres extensions.
///
/// The full set includes the nexum schema, which requires `CREATE EXTENSION
/// vector` (a host package outside this issue's scope). We restrict discovery
/// to the substrate (`sf-db`) + `sharp` migrations: that gives us `sharp.repos`
/// (a workspace-keyed table) plus the RLS migration that protects it, with no
/// extension dependency.
fn extension_free_migrations() -> Vec<Migration> {
    let all = sf_db::discover_migrations(&sf_db::repo_root()).expect("discover migrations");
    all.into_iter()
        .filter(|m| m.id.starts_with("sf-db/") || m.id.starts_with("sharp/"))
        .collect()
}

/// Build a value into `sharp.repos` for a workspace, returning its id. Runs as
/// the (BYPASSRLS-free but) superuser pool so seeding is unaffected by RLS.
async fn seed_repo(admin: &PgPool, workspace: &str, name: &str) {
    admin
        .execute(
            sqlx::query("INSERT INTO sharp.repos (name, workspace_id) VALUES ($1, $2::uuid)")
                .bind(name)
                .bind(workspace),
        )
        .await
        .expect("seed repo");
}

/// Connect a fresh non-superuser app-role pool to the provisioned cluster.
///
/// `--auth=trust` lets us connect as any existing role without a password.
async fn app_pool(superuser_url: &str, app_role: &str) -> PgPool {
    // superuser_url is postgres://superfield@127.0.0.1:PORT/superfield
    let app_url = superuser_url.replacen("//superfield@", &format!("//{app_role}@"), 1);
    PgPoolOptions::new()
        .max_connections(2)
        .connect(&app_url)
        .await
        .expect("connect app-role pool")
}

/// Full boot-and-prove flow shared by the test bodies. Returns a started
/// provisioner, the superuser pool, and the data dir for cleanup.
struct Harness {
    provisioner: LocalPostgresProvisioner,
    admin: PgPool,
    url: String,
    data_dir: PathBuf,
}

async fn boot_and_migrate() -> Option<Harness> {
    let _bin = pg_bin_dir_or_skip()?;
    let data_dir = std::env::temp_dir().join(format!("sf-rls-it-{}", uuid::Uuid::new_v4()));
    let port = ephemeral_port();
    let provisioner = LocalPostgresProvisioner::new(&data_dir)
        .with_port(port)
        .with_health_timeout(Duration::from_secs(60));
    provisioner.start().await.expect("provision postgres");

    let url = provisioner.database_url().expect("local url");
    let cfg = sf_db::DbConfig::from_url(&url).expect("cfg");
    let admin = sf_db::connect(&cfg).await.expect("connect superuser");

    // The boot sequence: apply the component migrations against the live DB.
    let migs = extension_free_migrations();
    let applied = sf_db::apply_migrations(&admin, &migs)
        .await
        .expect("apply migrations");
    assert!(
        applied.iter().any(|id| id == RLS_MIGRATION_ID),
        "RLS migration must be applied on boot, got {applied:?}"
    );

    Some(Harness {
        provisioner,
        admin,
        url,
        data_dir,
    })
}

async fn teardown(h: Harness) {
    h.admin.close().await;
    h.provisioner.stop().await.expect("stop");
    let _ = Command::new("rm").arg("-rf").arg(&h.data_dir).status();
}

/// Create a non-superuser app role and grant it CRUD on the protected table.
async fn create_app_role(admin: &PgPool, role: &str) {
    // Drop-and-recreate so the test is deterministic. NOSUPERUSER + no
    // BYPASSRLS so RLS is actually enforced for this role.
    let _ = admin
        .execute(sqlx::query(&format!("DROP ROLE IF EXISTS {role}")))
        .await;
    admin
        .execute(sqlx::query(&format!(
            "CREATE ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS"
        )))
        .await
        .expect("create app role");
    admin
        .execute(sqlx::query(&format!(
            "GRANT USAGE ON SCHEMA sharp TO {role}"
        )))
        .await
        .expect("grant schema");
    admin
        .execute(sqlx::query(&format!(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON sharp.repos TO {role}"
        )))
        .await
        .expect("grant table");
}

// ---------------------------------------------------------------------------
// AC1: cross-workspace SELECT is denied after run_migrations.
// ---------------------------------------------------------------------------
#[tokio::test(flavor = "multi_thread")]
async fn cross_workspace_select_is_denied_after_migration() {
    use sqlx::Acquire;

    let Some(h) = boot_and_migrate().await else {
        return;
    };

    let ws_a = "00000000-0000-0000-0000-00000000000a";
    let ws_b = "00000000-0000-0000-0000-00000000000b";
    seed_repo(&h.admin, ws_a, "alpha-repo").await;
    seed_repo(&h.admin, ws_b, "beta-repo").await;

    create_app_role(&h.admin, "sf_app_select").await;
    let app = app_pool(&h.url, "sf_app_select").await;

    // Under workspace A, only A's rows are visible; B's are denied.
    let mut conn = app.acquire().await.expect("acquire");
    let mut tx = conn.begin().await.expect("begin");
    tx.execute(sqlx::query(&set_workspace_sql(ws_a)))
        .await
        .expect("set workspace A");

    let visible: Vec<(String,)> = sqlx::query_as("SELECT name FROM sharp.repos ORDER BY name")
        .fetch_all(&mut *tx)
        .await
        .expect("select under A");
    assert_eq!(
        visible,
        vec![("alpha-repo".to_string(),)],
        "workspace A must see only its own rows, not workspace B's"
    );
    tx.rollback().await.expect("rollback");

    // With NO workspace context, the policy is fail-closed: zero rows.
    let mut conn2 = app.acquire().await.expect("acquire 2");
    let mut tx2 = conn2.begin().await.expect("begin 2");
    let unscoped: (i64,) = sqlx::query_as("SELECT count(*) FROM sharp.repos")
        .fetch_one(&mut *tx2)
        .await
        .expect("unscoped count");
    assert_eq!(
        unscoped.0, 0,
        "an unscoped connection must see no workspace-keyed rows (fail-closed)"
    );
    tx2.rollback().await.expect("rollback 2");

    // Release both checked-out connections back to the pool BEFORE closing it.
    // `PgPool::close()` waits for every checked-out connection to be returned;
    // `conn`/`conn2` are still live locals here, so closing without dropping
    // them first would deadlock.
    drop(conn);
    drop(conn2);
    app.close().await;
    teardown(h).await;
}

// ---------------------------------------------------------------------------
// AC1 (write side): a cross-workspace INSERT/UPDATE is denied.
// ---------------------------------------------------------------------------
#[tokio::test(flavor = "multi_thread")]
async fn cross_workspace_write_is_denied_after_migration() {
    use sqlx::Acquire;

    let Some(h) = boot_and_migrate().await else {
        return;
    };

    let ws_a = "00000000-0000-0000-0000-0000000000aa";
    let ws_b = "00000000-0000-0000-0000-0000000000bb";
    seed_repo(&h.admin, ws_a, "owned-by-a").await;

    create_app_role(&h.admin, "sf_app_write").await;
    let app = app_pool(&h.url, "sf_app_write").await;

    let mut conn = app.acquire().await.expect("acquire");
    let mut tx = conn.begin().await.expect("begin");
    tx.execute(sqlx::query(&set_workspace_sql(ws_a)))
        .await
        .expect("set workspace A");

    // INSERT stamped for a DIFFERENT workspace must fail the WITH CHECK.
    let bad_insert =
        sqlx::query("INSERT INTO sharp.repos (name, workspace_id) VALUES ($1, $2::uuid)")
            .bind("smuggled")
            .bind(ws_b)
            .execute(&mut *tx)
            .await;
    assert!(
        bad_insert.is_err(),
        "inserting a row stamped for another workspace must be denied by RLS"
    );
    tx.rollback().await.expect("rollback");

    // A correctly-stamped INSERT under the active workspace succeeds.
    let mut conn2 = app.acquire().await.expect("acquire 2");
    let mut tx2 = conn2.begin().await.expect("begin 2");
    tx2.execute(sqlx::query(&set_workspace_sql(ws_a)))
        .await
        .expect("set workspace A again");
    sqlx::query("INSERT INTO sharp.repos (name, workspace_id) VALUES ($1, $2::uuid)")
        .bind("legit")
        .bind(ws_a)
        .execute(&mut *tx2)
        .await
        .expect("in-workspace insert must succeed");
    tx2.commit().await.expect("commit");

    // Release the checked-out connections before closing the pool (see the
    // select test for why closing with live `PoolConnection`s deadlocks).
    drop(conn);
    drop(conn2);
    app.close().await;
    teardown(h).await;
}

// ---------------------------------------------------------------------------
// AC2: schema_migrations records the RLS id, idempotently on re-run.
// ---------------------------------------------------------------------------
#[tokio::test(flavor = "multi_thread")]
async fn rls_migration_recorded_exactly_once_idempotently() {
    let Some(h) = boot_and_migrate().await else {
        return;
    };

    let recorded: (i64,) = sqlx::query_as("SELECT count(*) FROM schema_migrations WHERE id = $1")
        .bind(RLS_MIGRATION_ID)
        .fetch_one(&h.admin)
        .await
        .expect("query schema_migrations");
    assert_eq!(recorded.0, 1, "RLS migration must be recorded exactly once");

    // Re-running the full set applies nothing and does not double-record.
    let migs = extension_free_migrations();
    let again = sf_db::apply_migrations(&h.admin, &migs)
        .await
        .expect("re-run migrations");
    assert!(
        !again.iter().any(|id| id == RLS_MIGRATION_ID),
        "second run must not re-apply the RLS migration"
    );

    let recorded_after: (i64,) =
        sqlx::query_as("SELECT count(*) FROM schema_migrations WHERE id = $1")
            .bind(RLS_MIGRATION_ID)
            .fetch_one(&h.admin)
            .await
            .expect("query schema_migrations after re-run");
    assert_eq!(
        recorded_after.0, 1,
        "RLS migration must remain recorded exactly once after re-run"
    );

    teardown(h).await;
}

// ---------------------------------------------------------------------------
// AC3: no-RLS regression — if the RLS migration is dropped from the runner,
// cross-workspace isolation is NOT enforced. This proves the test would catch
// a regression that removed the migration from the applied set.
// ---------------------------------------------------------------------------
#[tokio::test(flavor = "multi_thread")]
async fn without_rls_migration_isolation_is_not_enforced() {
    use sqlx::Acquire;

    let Some(_bin) = pg_bin_dir_or_skip() else {
        return;
    };
    let data_dir = std::env::temp_dir().join(format!("sf-rls-neg-{}", uuid::Uuid::new_v4()));
    let port = ephemeral_port();
    let provisioner = LocalPostgresProvisioner::new(&data_dir)
        .with_port(port)
        .with_health_timeout(Duration::from_secs(60));
    provisioner.start().await.expect("provision");

    let url = provisioner.database_url().expect("url");
    let cfg = sf_db::DbConfig::from_url(&url).expect("cfg");
    let admin = sf_db::connect(&cfg).await.expect("connect");

    // Apply the SAME migration set but WITH THE RLS MIGRATION REMOVED, emulating
    // a runner that no longer ships it.
    let migs: Vec<Migration> = extension_free_migrations()
        .into_iter()
        .filter(|m| m.id != RLS_MIGRATION_ID)
        .collect();
    assert!(
        !migs.iter().any(|m| m.id == RLS_MIGRATION_ID),
        "RLS migration must be excluded from this negative run"
    );
    sf_db::apply_migrations(&admin, &migs)
        .await
        .expect("apply migrations without RLS");

    // The RLS migration is also what adds the workspace_id column on the
    // appliance path (sf-db/0003 threading runs before sharp tables exist).
    // Without it the column is absent, so add it here so we can seed and
    // observe the *absence* of isolation. This isolates the regression to the
    // policy enforcement, not the column.
    admin
        .execute(sqlx::query(
            "ALTER TABLE sharp.repos ADD COLUMN IF NOT EXISTS workspace_id UUID",
        ))
        .await
        .expect("add workspace_id column for negative test");

    let ws_a = "00000000-0000-0000-0000-0000000000a1";
    let ws_b = "00000000-0000-0000-0000-0000000000b1";
    seed_repo(&admin, ws_a, "neg-alpha").await;
    seed_repo(&admin, ws_b, "neg-beta").await;

    create_app_role(&admin, "sf_app_neg").await;
    let app = app_pool(&url, "sf_app_neg").await;

    // Without RLS, workspace A sees BOTH rows — isolation is not enforced.
    let mut conn = app.acquire().await.expect("acquire");
    let mut tx = conn.begin().await.expect("begin");
    tx.execute(sqlx::query(&set_workspace_sql(ws_a)))
        .await
        .expect("set workspace A");
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM sharp.repos")
        .fetch_one(&mut *tx)
        .await
        .expect("count under A");
    assert_eq!(
        count.0, 2,
        "without the RLS migration, workspace A must see ALL rows — proving the \
         positive test's denial is caused by the migration, not the schema"
    );
    tx.rollback().await.expect("rollback");

    // Release the checked-out connection before closing the pool (a live
    // `PoolConnection` would otherwise make `close()` wait forever).
    drop(conn);
    app.close().await;
    admin.close().await;
    provisioner.stop().await.expect("stop");
    let _ = Command::new("rm").arg("-rf").arg(&data_dir).status();
}
