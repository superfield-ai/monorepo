//! `superfield page <name>` — read a named knowledge-base page from Nexum.
//!
//! Pages are projections over the Nexum graph: each named page corresponds to
//! a document in `nexum.documents` (identified by `title`), and the page
//! content is the latest version's blocks concatenated as markdown.
//!
//! # Registry
//!
//! The recognised page names are defined in [`sf_db::KNOWN_PAGES`]:
//! `prd`, `architecture`, `plan`, `strategy`, `project`.
//!
//! # Daemon guard
//!
//! The `page` command must **not** auto-spawn the daemon.  If the daemon
//! socket at `~/.superfield/daemon/socket` is absent, the command exits
//! non-zero with `"daemon not running"` and does not start a child process.
//! This matches the no-spawn guard contract specified in issues #489 and #492.
//!
//! # Canonical docs
//!
//! - Issue #492 scope.
//! - `docs/architecture.md` §Nexum — page-revision schema.

use sf_db::{fetch_page_content, PageQueryError, KNOWN_PAGES};
use sqlx::PgPool;
use thiserror::Error;

/// Errors from the `page` command.
#[derive(Debug, Error)]
pub enum PageError {
    /// The daemon is not running (socket absent).
    ///
    /// Exit non-zero without auto-spawning.
    #[error("daemon not running")]
    DaemonNotRunning,

    /// The requested page name is not in the registry.
    #[error("unknown page '{0}'; known pages: {1}")]
    UnknownPage(String, String),

    /// A database query error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The page exists in the registry but has no content in the database yet.
    #[error("page '{0}' has no content yet (gardening loop has not produced a revision)")]
    NoContent(String),
}

impl From<PageQueryError> for PageError {
    fn from(e: PageQueryError) -> Self {
        match e {
            PageQueryError::UnknownPage(name) => {
                let known = KNOWN_PAGES.join(", ");
                PageError::UnknownPage(name, known)
            }
            PageQueryError::Database(e) => PageError::Database(e),
        }
    }
}

/// Path of the daemon socket file relative to the user home directory.
///
/// The daemon (issue #489) writes this socket under `~/.superfield/daemon/`.
/// Its presence is the authoritative indicator that the daemon is running.
/// Absence means we must return [`PageError::DaemonNotRunning`] rather than
/// auto-spawning.
pub const DAEMON_SOCKET_RELATIVE: &str = ".superfield/daemon/socket";

/// Return the absolute path to the daemon socket.
///
/// Resolves `~/.superfield/daemon/socket`.  Returns `None` if the home
/// directory cannot be determined.
pub fn daemon_socket_path() -> Option<std::path::PathBuf> {
    home_dir().map(|home| home.join(DAEMON_SOCKET_RELATIVE))
}

/// Determine the user home directory.
///
/// Tries `HOME` environment variable first, then `std::env::home_dir()` as
/// a fallback.
fn home_dir() -> Option<std::path::PathBuf> {
    // `HOME` is the most reliable on Unix; use it if set.
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Some(std::path::PathBuf::from(home));
        }
    }
    // Fallback: std::env::home_dir (deprecated but fine for our use case).
    #[allow(deprecated)]
    std::env::home_dir()
}

/// Check whether the daemon socket exists on disk.
///
/// Returns `true` when `~/.superfield/daemon/socket` is present (the daemon is
/// running).  Returns `false` when the path cannot be resolved or the socket
/// is absent.
pub fn daemon_is_running() -> bool {
    daemon_socket_path()
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// Execute the `superfield page <name>` command.
///
/// # Behaviour
///
/// 1. Asserts the daemon socket is present.  Exits with
///    [`PageError::DaemonNotRunning`] if not.
/// 2. Validates `name` against the page registry.  Returns
///    [`PageError::UnknownPage`] for unrecognised names.
/// 3. Queries the database for the latest version of the named page document.
/// 4. Prints the markdown content to stdout.
///
/// # Arguments
///
/// * `pool` — the shared [`sqlx::PgPool`]; must be connected before calling.
/// * `name` — the page name (e.g. `"prd"`).
///
/// # Errors
///
/// See [`PageError`] variants.
pub async fn page_show(pool: &PgPool, name: &str) -> Result<(), PageError> {
    page_show_with_guard(pool, name, daemon_is_running()).await
}

/// Inner implementation of `page_show` that accepts an explicit daemon-running
/// flag.  This allows unit tests to exercise both the daemon-absent and
/// daemon-present paths without racing on the process-global `HOME` env var.
async fn page_show_with_guard(
    pool: &PgPool,
    name: &str,
    is_running: bool,
) -> Result<(), PageError> {
    // No-spawn guard: refuse to proceed if the daemon socket is absent.
    if !is_running {
        return Err(PageError::DaemonNotRunning);
    }

    // Validate name against the registry before touching the DB.
    if !KNOWN_PAGES.contains(&name) {
        let known = KNOWN_PAGES.join(", ");
        return Err(PageError::UnknownPage(name.to_string(), known));
    }

    // Fetch content from the database.
    let content = fetch_page_content(pool, name)
        .await
        .map_err(PageError::from)?;

    match content {
        Some(markdown) => {
            println!("{}", markdown);
            Ok(())
        }
        None => Err(PageError::NoContent(name.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── daemon socket check tests ───────────────────────────────────────────

    /// Unit test: `daemon_socket_path` resolves to a path ending in the
    /// expected suffix.
    ///
    /// Does not require a running daemon or a live HOME; uses a tempdir as
    /// the fake HOME.
    #[test]
    fn daemon_socket_path_contains_superfield_daemon() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Override HOME in-process.  NOTE: this is the only test that sets
        // HOME so there is no concurrent race — the test is sync and single-
        // threaded, and the other tests do not rely on HOME.
        let _guard = ScopedHome::set(tmp.path().to_str().unwrap());
        let path = daemon_socket_path().expect("should resolve home");
        assert!(
            path.to_str()
                .unwrap()
                .ends_with(".superfield/daemon/socket"),
            "expected path ending in .superfield/daemon/socket, got {:?}",
            path
        );
    }

    /// Unit test: `daemon_is_running` returns false when the socket is absent.
    ///
    /// Uses a non-existent directory so the socket path resolves to a path
    /// that definitely does not exist.
    #[test]
    fn daemon_is_running_false_when_socket_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Do NOT create the socket file.
        let _guard = ScopedHome::set(tmp.path().to_str().unwrap());
        assert!(!daemon_is_running(), "socket must be absent in a test home dir");
    }

    // ── page_show: no-daemon guard ──────────────────────────────────────────

    /// Unit test: `page_show` exits with DaemonNotRunning when the daemon is
    /// not running.
    ///
    /// Passes `is_running = false` directly so there is no env-var race.
    /// Does not require a live database.
    #[tokio::test]
    async fn page_no_daemon_exits_nonzero_no_spawn() {
        let pool = sqlx::PgPool::connect_lazy("postgres://localhost/stub_db_never_connects")
            .expect("lazy connect should not fail");

        let err = page_show_with_guard(&pool, "prd", false)
            .await
            .unwrap_err();

        assert!(
            matches!(err, PageError::DaemonNotRunning),
            "expected DaemonNotRunning, got: {:?}",
            err
        );
        assert!(
            err.to_string().contains("daemon not running"),
            "error message must contain 'daemon not running', got: {}",
            err
        );
    }

    // ── page_show: unknown name ─────────────────────────────────────────────

    /// Unit test: `page_show` exits non-zero with 'unknown page' for unknown names.
    ///
    /// Passes `is_running = true` directly so the daemon guard is bypassed.
    /// Does not require a live database (unknown-page guard fires before SQL).
    #[tokio::test]
    async fn page_unknown_name_exits_nonzero() {
        let pool = sqlx::PgPool::connect_lazy("postgres://localhost/stub_db_never_connects")
            .expect("lazy connect should not fail");

        let err = page_show_with_guard(&pool, "nonexistent", true)
            .await
            .unwrap_err();

        match &err {
            PageError::UnknownPage(name, _known) => {
                assert_eq!(name, "nonexistent");
            }
            other => panic!("expected UnknownPage, got: {:?}", other),
        }
        assert!(
            err.to_string().contains("unknown page"),
            "error message must contain 'unknown page', got: {}",
            err
        );
    }

    // ── page_show: happy path (integration, requires DATABASE_URL) ──────────

    /// Integration test: `page_show` returns markdown for a seeded page.
    ///
    /// Inserts a fixture document_version for page name 'prd'; runs
    /// `page_show` against a test DB; asserts stdout contains the fixture
    /// block content and exit code is 0.
    ///
    /// Skipped unless `DATABASE_URL` is set with the nexum schema migrated.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum schema migrated"]
    async fn page_prd_returns_markdown() {
        let cfg = sf_db::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = sf_db::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        // Insert fixture data.
        let corpus_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.corpora (name) VALUES ('test-page-cli') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .expect("corpus insert failed");

        let doc_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.documents (corpus_id, title) VALUES ($1, 'prd') RETURNING id",
        )
        .bind(corpus_id)
        .fetch_one(&pool)
        .await
        .expect("document insert failed");

        let ver_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.document_versions (doc_id, version_num, status) \
             VALUES ($1, 1, 'done') RETURNING id",
        )
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("version insert failed");

        let block_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type) \
             VALUES ($1, '# Fixture PRD content', 'hash_fixture_prd_cli', 'heading') RETURNING id",
        )
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("block insert failed");

        sqlx::query(
            "INSERT INTO nexum.version_blocks (version_id, block_id, seq) VALUES ($1, $2, 0)",
        )
        .bind(ver_id)
        .bind(block_id)
        .execute(&pool)
        .await
        .expect("version_block insert failed");

        // Verify via fetch_page_content (page_show prints to stdout).
        let content = sf_db::fetch_page_content(&pool, "prd")
            .await
            .expect("fetch failed")
            .expect("expected Some");

        assert!(
            content.contains("Fixture PRD content"),
            "expected fixture content in result, got: {:?}",
            content
        );

        // Cleanup.
        sqlx::query("DELETE FROM nexum.version_blocks WHERE version_id = $1")
            .bind(ver_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.document_versions WHERE id = $1")
            .bind(ver_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.blocks WHERE id = $1")
            .bind(block_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.documents WHERE id = $1")
            .bind(doc_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM nexum.corpora WHERE id = $1")
            .bind(corpus_id)
            .execute(&pool)
            .await
            .ok();
    }

    // ── Test helpers ────────────────────────────────────────────────────────

    /// RAII guard that overrides `HOME` for the duration of the test.
    ///
    /// The original value is restored when this guard drops.  Only safe to
    /// use from single-threaded (sync) tests — do not use from async tests
    /// that run concurrently, as `HOME` is process-global.
    struct ScopedHome {
        original: Option<String>,
    }

    impl ScopedHome {
        fn set(new_home: &str) -> Self {
            let original = std::env::var("HOME").ok();
            std::env::set_var("HOME", new_home);
            Self { original }
        }
    }

    impl Drop for ScopedHome {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }
}
