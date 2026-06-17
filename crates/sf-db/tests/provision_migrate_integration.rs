//! End-to-end integration test for the self-provisioning brain (issue #670).
//!
//! Exercises the real boot health gate building blocks:
//!   provision (LocalPostgresProvisioner) -> wait healthy -> migrate -> connect.
//!
//! These tests stand up a throwaway Postgres cluster with `initdb` + `pg_ctl`
//! into a temp data directory, so they require the Postgres server binaries
//! (`initdb`, `pg_ctl`, `pg_isready`, `createdb`). When those tools are not on
//! `PATH` (or under `/usr/lib/postgresql/<major>/bin`), the tests skip cleanly
//! so offline CI is not broken.
//!
//! Run with the binaries available:
//! ```bash
//! cargo test -p sf-db --test provision_migrate_integration -- --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use sf_db::{LocalPostgresProvisioner, PostgresProvisioner};

/// Locate the Postgres bin dir (mirrors the provisioner's own detection) and
/// confirm the required tools exist. Returns `None` to skip the test.
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
        eprintln!("skipping: no /usr/lib/postgresql/<major>/bin with initdb found");
    }
    best.map(|(_, p)| p)
}

/// Whether the pgvector extension is installed on this host. The nexum schema
/// requires `CREATE EXTENSION vector`, which is a host package outside the
/// scope of issue #670 (self-provisioning brain). When it is absent we still
/// prove the provision -> health -> migrate boot mechanics against the
/// substrate migrations that need no extension.
fn pgvector_available(bin_dir: &Path) -> bool {
    // The extension control file lives next to the server's share dir:
    // /usr/share/postgresql/<major>/extension/vector.control. Derive the major
    // from the bin dir (/usr/lib/postgresql/<major>/bin).
    let major = bin_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("");
    Path::new(&format!(
        "/usr/share/postgresql/{major}/extension/vector.control"
    ))
    .is_file()
}

/// Pick a likely-free high port for the throwaway instance.
fn ephemeral_port() -> u16 {
    // Bind a TcpListener on port 0, read the assigned port, then drop it.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn provisions_postgres_migrates_and_connects_with_no_external_url() {
    let Some(bin) = pg_bin_dir_or_skip() else {
        return;
    };

    let data_dir = std::env::temp_dir().join(format!("sf-prov-it-{}", uuid::Uuid::new_v4()));
    let port = ephemeral_port();
    let provisioner = LocalPostgresProvisioner::new(&data_dir)
        .with_port(port)
        .with_health_timeout(Duration::from_secs(60));

    // 1. Provision: starts initdb + pg_ctl, waits for pg_isready.
    provisioner
        .start()
        .await
        .expect("provisioner.start should bring up a healthy Postgres");

    // The provisioner reports the local URL with no external DATABASE_URL.
    let url = provisioner
        .database_url()
        .expect("local provisioner must report its URL");

    // 2. Migrate against the now-live instance.
    let cfg = sf_db::DbConfig::from_url(&url).expect("valid url");
    let pool = sf_db::connect(&cfg)
        .await
        .expect("connect to provisioned pg");

    // The nexum schema requires the pgvector extension. When it is not
    // installed on this host (outside issue #670's scope), restrict discovery
    // to the substrate (sf-db) migrations so the boot mechanics are still
    // exercised end-to-end.
    let has_vector = pgvector_available(&bin);
    let all = sf_db::discover_migrations(&sf_db::repo_root()).expect("discover migrations");
    let to_apply: Vec<sf_db::Migration> = if has_vector {
        all
    } else {
        eprintln!("pgvector not installed: applying substrate (sf-db) migrations only");
        all.into_iter()
            .filter(|m| m.id.starts_with("sf-db/"))
            .collect()
    };

    let applied = sf_db::apply_migrations(&pool, &to_apply)
        .await
        .expect("migrations should apply against the live instance");
    assert!(
        applied.iter().any(|id| id.starts_with("sf-db/")),
        "expected substrate migrations applied, got {applied:?}"
    );
    if has_vector {
        // 3. The schema is present: the nexum schema exists and is queryable.
        let row: (i64,) = sqlx::query_as(
            "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'nexum'",
        )
        .fetch_one(&pool)
        .await
        .expect("query nexum schema presence");
        assert_eq!(row.0, 1, "nexum schema must exist after migration");
    } else {
        // The substrate schema (workspaces) is present.
        let row: (i64,) = sqlx::query_as(
            "SELECT count(*) FROM information_schema.tables \
             WHERE table_name = 'workspaces'",
        )
        .fetch_one(&pool)
        .await
        .expect("query workspaces table presence");
        assert!(row.0 >= 1, "substrate workspaces table must exist");
    }

    // schema_migrations recorded the applied ids (idempotency tracking).
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM schema_migrations")
        .fetch_one(&pool)
        .await
        .expect("schema_migrations queryable");
    assert!(
        count.0 > 0,
        "schema_migrations should track applied migrations"
    );

    // Re-running the same set is a no-op (idempotent).
    let again = sf_db::apply_migrations(&pool, &to_apply)
        .await
        .expect("re-run migrations");
    assert!(again.is_empty(), "second migration run must apply nothing");

    pool.close().await;

    // Stop cleanly; idempotent second stop.
    provisioner.stop().await.expect("stop");
    provisioner.stop().await.expect("idempotent stop");

    // Cleanup the data dir.
    let _ = Command::new("rm").arg("-rf").arg(&data_dir).status();
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_reuses_existing_cluster_without_reinitialising() {
    let Some(_bin) = pg_bin_dir_or_skip() else {
        return;
    };

    let data_dir = std::env::temp_dir().join(format!("sf-prov-reuse-{}", uuid::Uuid::new_v4()));
    let port = ephemeral_port();
    let provisioner = LocalPostgresProvisioner::new(&data_dir).with_port(port);

    provisioner.start().await.expect("first start");
    // PG_VERSION proves initdb ran and the cluster is durable.
    assert!(
        data_dir.join("PG_VERSION").is_file(),
        "data dir must hold an initialised cluster"
    );
    provisioner.stop().await.expect("stop");

    // Start again — reuses the same durable cluster.
    provisioner
        .start()
        .await
        .expect("second start reuses cluster");
    provisioner.stop().await.expect("final stop");

    let _ = Command::new("rm").arg("-rf").arg(&data_dir).status();
}

#[tokio::test(flavor = "multi_thread")]
async fn injected_migration_failure_aborts_with_distinct_error_and_no_record() {
    // Issue #670 AC3 / test plan: a migration failure must abort with an
    // actionable error distinct from a provisioning failure, and must NOT be
    // recorded — so a retry re-applies and the brain is never served unmigrated.
    let Some(_bin) = pg_bin_dir_or_skip() else {
        return;
    };

    let data_dir = std::env::temp_dir().join(format!("sf-prov-mig-{}", uuid::Uuid::new_v4()));
    let port = ephemeral_port();
    let provisioner = LocalPostgresProvisioner::new(&data_dir).with_port(port);
    provisioner.start().await.expect("provision");

    let url = provisioner.database_url().expect("url");
    let cfg = sf_db::DbConfig::from_url(&url).expect("cfg");
    let pool = sf_db::connect(&cfg).await.expect("connect");

    // A deliberately invalid migration — distinct from any provisioning fault.
    let bad = vec![sf_db::Migration {
        id: "test/0001_intentionally_broken".to_string(),
        sql: "THIS IS NOT VALID SQL;".to_string(),
    }];

    let err = sf_db::apply_migrations(&pool, &bad)
        .await
        .expect_err("invalid migration must fail");
    match err {
        sf_db::MigrationError::Apply { id, .. } => {
            assert_eq!(id, "test/0001_intentionally_broken");
        }
        other => panic!("expected MigrationError::Apply, got {other:?}"),
    }

    // The failed migration was NOT recorded (left for retry after a fix).
    let recorded: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM schema_migrations WHERE id = 'test/0001_intentionally_broken'",
    )
    .fetch_one(&pool)
    .await
    .expect("query schema_migrations");
    assert_eq!(recorded.0, 0, "failed migration must not be recorded");

    pool.close().await;
    provisioner.stop().await.expect("stop");
    let _ = Command::new("rm").arg("-rf").arg(&data_dir).status();
}
