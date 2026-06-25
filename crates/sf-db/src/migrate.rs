//! Rust migration runner for the daemon health-gated boot sequence.
//!
//! On first run the appliance provisions its own Postgres instance (see
//! [`crate::provisioner`]) and must apply the component schema before the HTTP
//! server accepts traffic. This module is the in-process migration runner that
//! the daemon invokes between the Postgres health gate and binding the server.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle — the `provision -> wait healthy
//!   -> migrate -> serve` ordering; the migration runner runs against the
//!   now-live instance before `StartupResult::Ok` is sent.
//! - `packages/db/migrator.ts` — the authoritative standalone migrator. This
//!   runner mirrors its component dependency order, its idempotent SQL
//!   application, and its `schema_migrations` tracking-table contract so the
//!   two runners are interchangeable against the same database.
//!
//! # Component order
//!
//! Component SQL directories are applied in dependency order:
//!
//!   `sf-db` (substrate) -> `sf-auth` -> `nexum` -> `sharp` -> `orchestrator`
//!
//! The `orchestrator` schema (the gardening loop's resumable cursor) sorts last
//! as a cross-cutting concern that depends only on the component tables
//! existing (issue #762).
//!
//! Within each directory, files are applied in ascending filename order
//! (`NNNN_description.sql`). The recorded migration id is
//! `<component>/<filename-without-extension>`, identical to the TypeScript
//! migrator, so a database migrated by either runner is recognised by the
//! other.
//!
//! # Cross-cutting migrations run last
//!
//! The workspace-isolation RLS policies span tables in every schema, so they
//! must run after all component tables exist. The TS migrator applies them last
//! (from `packages/db/migrations`, which this runner does NOT walk); to mirror
//! that ordering, the appliance copy lives in the **last** component directory
//! as `crates/sharp/migrations/0009_rls_workspace_isolation.sql` (the
//! highest-numbered sharp migration, so it sorts after later sharp schema files
//! such as `0008_sharp_runtime_signal_workspace.sql`). See
//! `docs/architecture.md` §Cross-component joins and RLS scoping and issue #710.
//!
//! # Idempotency
//!
//! The runner creates `schema_migrations` if absent, reads the set of applied
//! ids, and applies only the pending files. Each SQL file must itself be
//! idempotent (`CREATE … IF NOT EXISTS`) so a partially-applied database
//! re-converges on retry.

use std::path::{Path, PathBuf};

use sqlx::PgPool;
use thiserror::Error;

/// Error raised while applying component migrations.
///
/// Distinct from [`crate::provisioner::ProvisionerError`] so the daemon can
/// surface a migration failure as an actionable error that is unambiguously
/// *not* a provisioning failure (issue #670 acceptance criteria).
#[derive(Debug, Error)]
pub enum MigrationError {
    /// A migration SQL directory could not be read.
    #[error("cannot read migration directory {path}: {source}")]
    ReadDir {
        /// The directory that could not be read.
        path: String,
        /// The underlying I/O error.
        source: std::io::Error,
    },

    /// A migration SQL file could not be read.
    #[error("cannot read migration file {path}: {source}")]
    ReadFile {
        /// The file that could not be read.
        path: String,
        /// The underlying I/O error.
        source: std::io::Error,
    },

    /// The `schema_migrations` tracking table could not be created or queried.
    #[error("schema_migrations tracking error: {0}")]
    Tracking(String),

    /// A migration's SQL failed to apply. Carries the migration id so the
    /// daemon log identifies exactly which file aborted boot.
    #[error("migration '{id}' failed: {source}")]
    Apply {
        /// The `<component>/<file>` id that failed.
        id: String,
        /// The underlying database error.
        source: sqlx::Error,
    },
}

/// A single discovered migration: its stable id and the SQL to apply.
#[derive(Debug, Clone)]
pub struct Migration {
    /// `<component>/<filename-without-extension>` — stable across runs and
    /// shared with the TypeScript migrator.
    pub id: String,
    /// The full SQL text of the migration file.
    pub sql: String,
}

/// Component migration directories, in the order they must be applied.
///
/// Mirrors `COMPONENT_MIGRATION_DIRS` in `packages/db/migrator.ts`. Paths are
/// resolved relative to the repository root passed to [`discover_migrations`].
const COMPONENT_DIRS: &[(&str, &[&str])] = &[
    ("sf-db", &["crates", "sf-db", "migrations"]),
    ("sf-auth", &["crates", "sf-auth", "src", "migrations"]),
    ("nexum", &["crates", "nexum", "migrations"]),
    ("sharp", &["crates", "sharp", "migrations"]),
    // The gardening loop engine's resumable cursor lives in its own
    // `orchestrator` schema (issue #491). The daemon's running loop writes
    // `orchestrator.gardening_cursor` and the live eval runner reads it, so the
    // appliance boot must apply this migration too — without it the loop cannot
    // commit a cursor and the eval observer polls a non-existent relation
    // forever (issue #762). It is a cross-cutting concern that depends only on
    // the component schemas existing, so it sorts last.
    ("orchestrator", &["orchestrator", "migrations"]),
];

/// Resolve the repository root used to locate the component migration SQL.
///
/// Resolution order:
/// 1. `SF_REPO_ROOT` environment variable, when set — the appliance points this
///    at the directory containing `crates/*/migrations`.
/// 2. The first ancestor of the current working directory that contains a
///    `crates/sf-db/migrations` directory.
/// 3. The current working directory as a last resort.
///
/// This lets the daemon find migrations both when run from a repo checkout
/// (development / CI) and when packaged with `SF_REPO_ROOT` set explicitly.
pub fn repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("SF_REPO_ROOT") {
        if !root.is_empty() {
            return PathBuf::from(root);
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut cur: Option<&Path> = Some(cwd.as_path());
    while let Some(dir) = cur {
        if dir.join("crates").join("sf-db").join("migrations").is_dir() {
            return dir.to_path_buf();
        }
        cur = dir.parent();
    }
    cwd
}

/// Discover all component migrations under `repo_root`, in apply order.
///
/// Reads each component directory in dependency order and, within each, sorts
/// `*.sql` files by ascending filename. A missing component directory is
/// treated as "no migrations for this component" rather than an error, so the
/// runner tolerates components that ship no schema.
///
/// # Errors
///
/// Returns [`MigrationError::ReadDir`] / [`MigrationError::ReadFile`] only for
/// directories that exist but cannot be read, or files that cannot be opened.
pub fn discover_migrations(repo_root: &Path) -> Result<Vec<Migration>, MigrationError> {
    let mut migrations = Vec::new();

    for (component, parts) in COMPONENT_DIRS {
        let mut dir = repo_root.to_path_buf();
        for p in *parts {
            dir.push(p);
        }
        migrations.extend(load_component_migrations(component, &dir)?);
    }

    Ok(migrations)
}

/// Load the migrations for one component directory, in ascending filename order.
fn load_component_migrations(
    component: &str,
    dir: &Path,
) -> Result<Vec<Migration>, MigrationError> {
    if !dir.is_dir() {
        // A component with no migration directory contributes nothing.
        return Ok(Vec::new());
    }

    let mut sql_files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|source| MigrationError::ReadDir {
            path: dir.display().to_string(),
            source,
        })?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "sql").unwrap_or(false))
        .collect();

    // Ascending filename order (NNNN_description.sql).
    sql_files.sort();

    let mut out = Vec::with_capacity(sql_files.len());
    for path in sql_files {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let sql = std::fs::read_to_string(&path).map_err(|source| MigrationError::ReadFile {
            path: path.display().to_string(),
            source,
        })?;
        out.push(Migration {
            id: format!("{component}/{stem}"),
            sql,
        });
    }

    Ok(out)
}

/// Apply all pending migrations from `repo_root` against `pool`.
///
/// Convenience wrapper over [`discover_migrations`] + [`apply_migrations`].
/// Returns the ids that were applied in this run (empty when the database was
/// already up to date).
pub async fn run_migrations(
    pool: &PgPool,
    repo_root: &Path,
) -> Result<Vec<String>, MigrationError> {
    let migrations = discover_migrations(repo_root)?;
    apply_migrations(pool, &migrations).await
}

/// Apply the given ordered migrations against `pool`, skipping any already
/// recorded in `schema_migrations`.
///
/// Mirrors the TypeScript migrator's `up`/tracking contract: the tracking
/// table is created if absent, applied ids are read, and only the pending
/// migrations are applied — each recorded immediately after a successful apply.
///
/// # Errors
///
/// - [`MigrationError::Tracking`] if `schema_migrations` cannot be created or
///   read.
/// - [`MigrationError::Apply`] if a migration's SQL fails. The migration is
///   left unrecorded so it is retried on the next boot after the fix.
pub async fn apply_migrations(
    pool: &PgPool,
    migrations: &[Migration],
) -> Result<Vec<String>, MigrationError> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (\
            id TEXT PRIMARY KEY, \
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    )
    .execute(pool)
    .await
    .map_err(|e| MigrationError::Tracking(e.to_string()))?;

    let applied: Vec<String> = sqlx::query_scalar("SELECT id FROM schema_migrations")
        .fetch_all(pool)
        .await
        .map_err(|e| MigrationError::Tracking(e.to_string()))?;
    let applied: std::collections::HashSet<String> = applied.into_iter().collect();

    let mut newly_applied = Vec::new();
    for m in migrations {
        if applied.contains(&m.id) {
            continue;
        }

        // Apply the full SQL file as one batch. `Executor::execute` on a
        // `&str` runs the whole string as a simple (multi-statement) query,
        // matching the TypeScript migrator's `sql.unsafe(sqlText)`. Each file
        // is idempotent DDL.
        use sqlx::Executor;
        pool.execute(m.sql.as_str())
            .await
            .map_err(|source| MigrationError::Apply {
                id: m.id.clone(),
                source,
            })?;

        sqlx::query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(&m.id)
            .execute(pool)
            .await
            .map_err(|e| MigrationError::Tracking(e.to_string()))?;

        newly_applied.push(m.id.clone());
    }

    Ok(newly_applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Build a throwaway repo layout with component migration dirs and files.
    fn scaffold(root: &Path, files: &[(&str, &str, &str)]) {
        for (component_path, filename, body) in files {
            let dir = root.join(component_path);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(filename), body).unwrap();
        }
    }

    #[test]
    fn discovers_components_in_dependency_order() {
        let tmp = std::env::temp_dir().join(format!("sfmig-{}", uuid::Uuid::new_v4()));
        scaffold(
            &tmp,
            &[
                ("orchestrator/migrations", "0001_cursor.sql", "-- cursor"),
                ("crates/sharp/migrations", "0001_sharp.sql", "-- sharp"),
                ("crates/nexum/migrations", "0001_nexum.sql", "-- nexum"),
                ("crates/sf-auth/src/migrations", "0001_auth.sql", "-- auth"),
                ("crates/sf-db/migrations", "0001_db.sql", "-- db"),
            ],
        );

        let migs = discover_migrations(&tmp).unwrap();
        let ids: Vec<&str> = migs.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "sf-db/0001_db",
                "sf-auth/0001_auth",
                "nexum/0001_nexum",
                "sharp/0001_sharp",
                "orchestrator/0001_cursor",
            ],
            "components must apply in sf-db -> sf-auth -> nexum -> sharp -> \
             orchestrator order"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn orders_files_within_component_ascending() {
        let tmp = std::env::temp_dir().join(format!("sfmig-{}", uuid::Uuid::new_v4()));
        scaffold(
            &tmp,
            &[
                ("crates/sharp/migrations", "0003_c.sql", "-- c"),
                ("crates/sharp/migrations", "0001_a.sql", "-- a"),
                ("crates/sharp/migrations", "0002_b.sql", "-- b"),
            ],
        );

        let migs = discover_migrations(&tmp).unwrap();
        let ids: Vec<&str> = migs.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["sharp/0001_a", "sharp/0002_b", "sharp/0003_c"],
            "files within a component must apply in ascending filename order"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn missing_component_dir_is_not_an_error() {
        let tmp = std::env::temp_dir().join(format!("sfmig-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        // No component dirs at all.
        let migs = discover_migrations(&tmp).unwrap();
        assert!(migs.is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn discovers_real_repo_migrations_when_run_from_repo_root() {
        // CARGO_MANIFEST_DIR points at crates/sf-db; the repo root is two up.
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest.parent().and_then(|p| p.parent());
        let Some(repo_root) = repo_root else {
            return;
        };
        let migs = discover_migrations(repo_root).unwrap();
        // The repo ships sf-db, sf-auth, nexum and sharp migrations.
        assert!(
            migs.iter().any(|m| m.id.starts_with("sf-db/")),
            "expected at least one sf-db migration, got {:?}",
            migs.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert!(migs.iter().any(|m| m.id.starts_with("sharp/")));
        // The orchestrator gardening-cursor migration must be discovered too —
        // the running loop and the live eval runner depend on it (issue #762).
        assert!(
            migs.iter().any(|m| m.id.starts_with("orchestrator/")),
            "expected the orchestrator gardening-cursor migration, got {:?}",
            migs.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        // sf-db must precede sharp.
        let first_sharp = migs.iter().position(|m| m.id.starts_with("sharp/"));
        let last_db = migs.iter().rposition(|m| m.id.starts_with("sf-db/"));
        if let (Some(s), Some(d)) = (first_sharp, last_db) {
            assert!(d < s, "all sf-db migrations must precede sharp migrations");
        }
        // orchestrator sorts last — after all sharp migrations.
        let first_orch = migs.iter().position(|m| m.id.starts_with("orchestrator/"));
        let last_sharp = migs.iter().rposition(|m| m.id.starts_with("sharp/"));
        if let (Some(o), Some(s)) = (first_orch, last_sharp) {
            assert!(
                s < o,
                "all sharp migrations must precede the orchestrator migration"
            );
        }
    }
}
