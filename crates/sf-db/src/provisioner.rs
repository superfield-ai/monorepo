//! Local Postgres provisioner for the self-provisioning brain appliance.
//!
//! Defines the [`PostgresProvisioner`] trait, which abstracts the lifecycle of
//! the local Postgres instance the Superfield daemon stands up on first run.
//! The daemon boot sequence is `provision -> wait healthy -> migrate -> serve`
//! (issue #670); this module owns the *provision* and *wait healthy* steps.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle — authoritative design for the
//!   daemon-owned Postgres start/stop/health-gate sequence.
//! - `docs/prd.md` §5 'Provisioning the Forge', §4, Constraint §9
//!   (self-sufficiency: the brain's data store may be local to the Forge host).
//!
//! # Seam contract
//!
//! The daemon calls [`PostgresProvisioner::start`] on startup, waits for the
//! health gate, runs migrations against [`PostgresProvisioner::database_url`],
//! and only then responds with `StartupResult::Ok` over the startup-notify
//! socket. On graceful shutdown the daemon calls [`PostgresProvisioner::stop`]
//! after the gardening loop has drained.
//!
//! # Implementations
//!
//! - [`LocalPostgresProvisioner`] — the real appliance provisioner. It runs
//!   `initdb` into a durable data directory under `~/.superfield/daemon/` if
//!   absent, starts the instance with `pg_ctl`, polls `pg_isready` until the
//!   health gate passes, and exposes the local `DATABASE_URL`. No Docker, no
//!   root, no network database — Constraint §9 self-sufficiency.
//! - [`TestProvisioner`] — no-op that returns `Ok(())` immediately. Used by
//!   component crates and tests that do not own provisioning, and on the path
//!   where `DATABASE_URL` is supplied externally (no local provisioning).
//! - [`FailingProvisioner`] — returns an injected error from `start`, used by
//!   the daemon boot tests to assert the server never binds on a provisioning
//!   failure.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::time::{Duration, Instant};

/// Boxed future alias used by [`PostgresProvisioner`] trait methods.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Error type for [`PostgresProvisioner`] operations.
#[derive(Debug, thiserror::Error)]
pub enum ProvisionerError {
    /// The Postgres instance could not be started or stopped.
    #[error("postgres instance error: {0}")]
    Container(String),

    /// The health gate timed out before Postgres accepted connections.
    #[error("postgres health-gate timeout after {0}s")]
    HealthTimeout(u64),

    /// A required Postgres tool (`initdb`, `pg_ctl`, `pg_isready`) was not found.
    #[error("postgres tool not found: {0}")]
    ToolNotFound(String),

    /// A lower-level I/O or database error.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Seam interface for starting and stopping the local Postgres instance.
///
/// # Required interface
///
/// - [`start`] — ensure Postgres is running and the health gate has passed.
/// - [`stop`] — stop the instance cleanly (after the loop has drained).
/// - [`database_url`] — the connection string the daemon migrates and serves
///   against. Returns `None` for provisioners that do not own a URL (the
///   daemon then falls back to `DATABASE_URL` from the environment).
pub trait PostgresProvisioner: Send + Sync {
    /// Ensure Postgres is running and the health gate (`pg_isready`) has passed.
    ///
    /// Returns `Ok(())` when Postgres is accepting connections and is ready for
    /// the migration runner. Idempotent: calling `start` when already running
    /// is a no-op.
    fn start(&self) -> BoxFuture<'_, Result<(), ProvisionerError>>;

    /// Stop the Postgres instance cleanly.
    ///
    /// Idempotent: calling `stop` when already stopped returns `Ok(())`.
    fn stop(&self) -> BoxFuture<'_, Result<(), ProvisionerError>>;

    /// The `DATABASE_URL` this provisioner stood up, if it owns one.
    ///
    /// The daemon uses this to build the pool and run migrations after the
    /// health gate. The default returns `None` — provisioners that do not own
    /// a database (e.g. [`TestProvisioner`]) rely on the environment instead.
    fn database_url(&self) -> Option<String> {
        None
    }
}

// ---------------------------------------------------------------------------
// LocalPostgresProvisioner — the real appliance provisioner
// ---------------------------------------------------------------------------

/// Real provisioner: stands up a local Postgres instance with no external
/// dependencies beyond the Postgres client/server binaries on `PATH`.
///
/// On [`start`] it:
/// 1. Runs `initdb` into `data_dir` if the directory is not already a cluster.
/// 2. Starts the instance with `pg_ctl start`, listening on `port` (TCP
///    loopback) so the daemon and `sqlx` connect over a stable URL.
/// 3. Polls `pg_isready` until it succeeds or `health_timeout` elapses.
/// 4. Ensures the application database exists.
///
/// The data directory is durable, so a restart reuses the existing cluster and
/// `initdb` is skipped (idempotent first-run promise).
pub struct LocalPostgresProvisioner {
    data_dir: PathBuf,
    port: u16,
    user: String,
    database: String,
    health_timeout: Duration,
    bin_dir: Option<PathBuf>,
}

impl LocalPostgresProvisioner {
    /// Default Postgres port for the appliance-local instance.
    pub const DEFAULT_PORT: u16 = 5432;

    /// Build a provisioner for a data directory, using appliance defaults
    /// (port 5432, user `superfield`, database `superfield`, 60 s health gate).
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            port: Self::DEFAULT_PORT,
            user: "superfield".to_string(),
            database: "superfield".to_string(),
            health_timeout: Duration::from_secs(60),
            bin_dir: detect_pg_bin_dir(),
        }
    }

    /// Override the TCP port (used by tests to avoid clashing with 5432).
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    /// Override the health-gate timeout (default 60 s).
    pub fn with_health_timeout(mut self, timeout: Duration) -> Self {
        self.health_timeout = timeout;
        self
    }

    /// Override the directory holding the Postgres binaries (`initdb`, …).
    /// When unset, the binaries are looked up on `PATH`.
    pub fn with_bin_dir(mut self, bin_dir: impl Into<PathBuf>) -> Self {
        self.bin_dir = Some(bin_dir.into());
        self
    }

    /// The `DATABASE_URL` for the provisioned instance.
    pub fn url(&self) -> String {
        format!(
            "postgres://{}@127.0.0.1:{}/{}",
            self.user, self.port, self.database
        )
    }

    /// Resolve a Postgres tool path: `<bin_dir>/<tool>` if a bin dir is known,
    /// else the bare tool name (looked up on `PATH`).
    fn tool(&self, name: &str) -> PathBuf {
        match &self.bin_dir {
            Some(dir) => dir.join(name),
            None => PathBuf::from(name),
        }
    }

    /// True when `data_dir` already holds an initialised cluster.
    fn is_initialised(&self) -> bool {
        self.data_dir.join("PG_VERSION").is_file()
    }

    fn run_initdb(&self) -> Result<(), ProvisionerError> {
        std::fs::create_dir_all(&self.data_dir)?;
        let out = Command::new(self.tool("initdb"))
            .arg("-D")
            .arg(&self.data_dir)
            .arg("-U")
            .arg(&self.user)
            .arg("--auth=trust")
            .arg("--encoding=UTF8")
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    ProvisionerError::ToolNotFound("initdb".into())
                } else {
                    ProvisionerError::Io(e)
                }
            })?;
        if !out.status.success() {
            return Err(ProvisionerError::Container(format!(
                "initdb failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    /// Path of the Postgres server log file inside the data dir.
    fn server_log_path(&self) -> PathBuf {
        self.data_dir.join("postgres.log")
    }

    fn run_pg_ctl_start(&self) -> Result<(), ProvisionerError> {
        // `-o "-p PORT -h 127.0.0.1 -k DIR"` binds the loopback TCP socket so
        // sqlx connects via the standard postgres:// URL, and points the Unix
        // socket directory at the data dir so the default `/var/run/postgresql`
        // (root-owned, not writable by an unprivileged appliance) is never
        // touched — Constraint §9 self-sufficiency, no root required.
        //
        // `-l <logfile>` is mandatory: without it `pg_ctl` lets the detached
        // postgres server inherit our stdout/stderr, and since the server is
        // long-lived it never closes those pipes — a `Command::output()` call
        // would then block forever reading to EOF. Redirecting the server log
        // to a file frees our stdio. We also null our own child stdio so the
        // `pg_ctl` invocation itself cannot inherit-and-hold a pipe.
        use std::process::Stdio;
        let status = Command::new(self.tool("pg_ctl"))
            .arg("-D")
            .arg(&self.data_dir)
            .arg("-l")
            .arg(self.server_log_path())
            .arg("-o")
            .arg(format!(
                "-p {} -h 127.0.0.1 -k {}",
                self.port,
                self.data_dir.display()
            ))
            .arg("-w")
            .arg("start")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    ProvisionerError::ToolNotFound("pg_ctl".into())
                } else {
                    ProvisionerError::Io(e)
                }
            })?;
        if !status.success() {
            // Surface the server log tail so the operator sees why it failed.
            let log = std::fs::read_to_string(self.server_log_path()).unwrap_or_default();
            let tail: String = log.lines().rev().take(10).collect::<Vec<_>>().join("\n");
            return Err(ProvisionerError::Container(format!(
                "pg_ctl start failed (exit {:?}); server log tail:\n{tail}",
                status.code()
            )));
        }
        Ok(())
    }

    fn is_running(&self) -> bool {
        Command::new(self.tool("pg_ctl"))
            .arg("-D")
            .arg(&self.data_dir)
            .arg("status")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Poll `pg_isready` until it succeeds or the health timeout elapses.
    fn wait_healthy(&self) -> Result<(), ProvisionerError> {
        let deadline = Instant::now() + self.health_timeout;
        loop {
            let ready = Command::new(self.tool("pg_isready"))
                .arg("-h")
                .arg("127.0.0.1")
                .arg("-p")
                .arg(self.port.to_string())
                .arg("-U")
                .arg(&self.user)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if ready {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(ProvisionerError::HealthTimeout(
                    self.health_timeout.as_secs(),
                ));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// Ensure the application database exists (idempotent). Runs once the server
    /// is healthy and accepting connections.
    ///
    /// Uses `psql` against the `postgres` maintenance database (always present
    /// after `initdb`) rather than `createdb`, because `createdb` defaults to
    /// connecting to a database named after the connecting role — which does
    /// not exist on a fresh cluster. `CREATE DATABASE` cannot be run with `IF
    /// NOT EXISTS`, so we guard it with a `SELECT` against `pg_database` and
    /// only create it when absent.
    fn ensure_database(&self) -> Result<(), ProvisionerError> {
        let exists_sql = format!(
            "SELECT 1 FROM pg_database WHERE datname = '{}'",
            self.database
        );
        let existing = self.run_psql("postgres", &["-tAc", &exists_sql])?;
        if existing.trim() == "1" {
            return Ok(());
        }

        let create_sql = format!("CREATE DATABASE \"{}\"", self.database);
        let out = Command::new(self.tool("psql"))
            .arg("-h")
            .arg("127.0.0.1")
            .arg("-p")
            .arg(self.port.to_string())
            .arg("-U")
            .arg(&self.user)
            .arg("-d")
            .arg("postgres")
            .arg("-v")
            .arg("ON_ERROR_STOP=1")
            .arg("-c")
            .arg(&create_sql)
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    ProvisionerError::ToolNotFound("psql".into())
                } else {
                    ProvisionerError::Io(e)
                }
            })?;
        // A concurrent creator may have won the race ("already exists").
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stderr.contains("already exists") {
                return Err(ProvisionerError::Container(format!(
                    "create database failed: {stderr}"
                )));
            }
        }
        Ok(())
    }

    /// Run `psql` against `dbname` on the local instance with the given extra
    /// args, returning stdout on success.
    fn run_psql(&self, dbname: &str, extra: &[&str]) -> Result<String, ProvisionerError> {
        let out = Command::new(self.tool("psql"))
            .arg("-h")
            .arg("127.0.0.1")
            .arg("-p")
            .arg(self.port.to_string())
            .arg("-U")
            .arg(&self.user)
            .arg("-d")
            .arg(dbname)
            .args(extra)
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    ProvisionerError::ToolNotFound("psql".into())
                } else {
                    ProvisionerError::Io(e)
                }
            })?;
        if !out.status.success() {
            return Err(ProvisionerError::Container(format!(
                "psql failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Synchronous start used by the async [`PostgresProvisioner::start`] via
    /// `spawn_blocking` — Postgres tooling is blocking subprocess work.
    fn start_blocking(&self) -> Result<(), ProvisionerError> {
        if self.is_running() {
            // Idempotent: already running. Still confirm health and database.
            self.wait_healthy()?;
            self.ensure_database()?;
            return Ok(());
        }
        if !self.is_initialised() {
            self.run_initdb()?;
        }
        self.run_pg_ctl_start()?;
        self.wait_healthy()?;
        self.ensure_database()?;
        Ok(())
    }

    fn stop_blocking(&self) -> Result<(), ProvisionerError> {
        if !self.is_initialised() || !self.is_running() {
            return Ok(());
        }
        let out = Command::new(self.tool("pg_ctl"))
            .arg("-D")
            .arg(&self.data_dir)
            .arg("-m")
            .arg("fast")
            .arg("-w")
            .arg("stop")
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    ProvisionerError::ToolNotFound("pg_ctl".into())
                } else {
                    ProvisionerError::Io(e)
                }
            })?;
        if !out.status.success() {
            return Err(ProvisionerError::Container(format!(
                "pg_ctl stop failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }
}

impl PostgresProvisioner for LocalPostgresProvisioner {
    fn start(&self) -> BoxFuture<'_, Result<(), ProvisionerError>> {
        Box::pin(async move {
            let me = self.clone_config();
            tokio::task::spawn_blocking(move || me.start_blocking())
                .await
                .map_err(|e| ProvisionerError::Container(format!("join error: {e}")))?
        })
    }

    fn stop(&self) -> BoxFuture<'_, Result<(), ProvisionerError>> {
        Box::pin(async move {
            let me = self.clone_config();
            tokio::task::spawn_blocking(move || me.stop_blocking())
                .await
                .map_err(|e| ProvisionerError::Container(format!("join error: {e}")))?
        })
    }

    fn database_url(&self) -> Option<String> {
        Some(self.url())
    }
}

impl LocalPostgresProvisioner {
    /// Clone the value config (fields are all owned/Copy) so the blocking
    /// closure can own it without borrowing `&self` across the await point.
    fn clone_config(&self) -> Self {
        Self {
            data_dir: self.data_dir.clone(),
            port: self.port,
            user: self.user.clone(),
            database: self.database.clone(),
            health_timeout: self.health_timeout,
            bin_dir: self.bin_dir.clone(),
        }
    }
}

/// Detect the directory holding the Postgres server binaries.
///
/// `initdb`/`pg_ctl` are server programs that Debian/Ubuntu place under
/// `/usr/lib/postgresql/<major>/bin`, not on the default `PATH`. We pick the
/// highest installed major version. Returns `None` when nothing is found, in
/// which case the bare tool names are looked up on `PATH`.
fn detect_pg_bin_dir() -> Option<PathBuf> {
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
    best.map(|(_, p)| p)
}

// ---------------------------------------------------------------------------
// TestProvisioner — no-op stub for tests and externally-supplied DATABASE_URL
// ---------------------------------------------------------------------------

/// No-op implementation of [`PostgresProvisioner`].
///
/// Both [`start`] and [`stop`] return `Ok(())` immediately without touching any
/// process or socket. Used by component crates and on the path where
/// `DATABASE_URL` is supplied externally — the daemon skips local provisioning
/// and serves against the supplied URL.
///
/// ```rust,no_run
/// use sf_db::provisioner::{PostgresProvisioner, TestProvisioner};
/// # async fn example() {
/// let p = TestProvisioner;
/// assert!(p.start().await.is_ok());
/// assert!(p.stop().await.is_ok());
/// assert!(p.database_url().is_none());
/// # }
/// ```
pub struct TestProvisioner;

impl PostgresProvisioner for TestProvisioner {
    fn start(&self) -> BoxFuture<'_, Result<(), ProvisionerError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<'_, Result<(), ProvisionerError>> {
        Box::pin(async { Ok(()) })
    }
}

// ---------------------------------------------------------------------------
// FailingProvisioner — injects a provisioning failure for boot tests
// ---------------------------------------------------------------------------

/// Provisioner whose [`start`] always fails with the configured message.
///
/// Used by daemon boot tests to assert that a provisioning failure aborts boot
/// with an actionable error and the HTTP server never binds (issue #670
/// acceptance criterion 2).
pub struct FailingProvisioner {
    reason: String,
}

impl FailingProvisioner {
    /// Build a provisioner that fails `start` with `reason`.
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl PostgresProvisioner for FailingProvisioner {
    fn start(&self) -> BoxFuture<'_, Result<(), ProvisionerError>> {
        let reason = self.reason.clone();
        Box::pin(async move { Err(ProvisionerError::Container(reason)) })
    }

    fn stop(&self) -> BoxFuture<'_, Result<(), ProvisionerError>> {
        Box::pin(async { Ok(()) })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_provisioner_start_returns_ok() {
        let p = TestProvisioner;
        assert!(p.start().await.is_ok());
    }

    #[tokio::test]
    async fn test_provisioner_stop_returns_ok() {
        let p = TestProvisioner;
        assert!(p.stop().await.is_ok());
    }

    #[tokio::test]
    async fn test_provisioner_has_no_database_url() {
        let p = TestProvisioner;
        assert!(p.database_url().is_none());
    }

    #[tokio::test]
    async fn test_provisioner_start_stop_idempotent() {
        let p = TestProvisioner;
        assert!(p.start().await.is_ok());
        assert!(p.start().await.is_ok());
        assert!(p.stop().await.is_ok());
        assert!(p.stop().await.is_ok());
    }

    #[tokio::test]
    async fn failing_provisioner_aborts_start() {
        let p = FailingProvisioner::new("docker socket unreachable");
        let err = p.start().await.unwrap_err();
        assert!(matches!(err, ProvisionerError::Container(_)));
        assert!(err.to_string().contains("docker socket unreachable"));
        // stop is still a clean no-op.
        assert!(p.stop().await.is_ok());
    }

    #[test]
    fn local_provisioner_builds_loopback_url() {
        let p = LocalPostgresProvisioner::new("/tmp/sf-data").with_port(55432);
        assert_eq!(p.url(), "postgres://superfield@127.0.0.1:55432/superfield");
        assert_eq!(
            p.database_url().as_deref(),
            Some("postgres://superfield@127.0.0.1:55432/superfield")
        );
    }

    #[test]
    fn uninitialised_data_dir_is_not_running() {
        let tmp = std::env::temp_dir().join(format!("sf-empty-{}", uuid::Uuid::new_v4()));
        let p = LocalPostgresProvisioner::new(&tmp);
        assert!(!p.is_initialised());
    }
}
