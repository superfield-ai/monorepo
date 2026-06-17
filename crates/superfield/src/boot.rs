//! Health-gated daemon boot sequence: provision -> wait healthy -> migrate -> serve.
//!
//! Issue #670 — the appliance stands up its own company brain on first run. The
//! daemon boot ordering is strict and non-negotiable:
//!
//!   1. **provision** — [`sf_db::PostgresProvisioner::start`] starts a local
//!      Postgres instance and waits for `pg_isready` (the health gate).
//!   2. **migrate** — [`sf_db::run_migrations`] applies every component schema
//!      against the now-live instance.
//!   3. **serve** — only after both succeed does the caller bind the HTTP
//!      server.
//!
//! A provisioning failure and a migration failure are surfaced as *distinct*
//! [`BootError`] variants so the caller can abort boot with an actionable
//! message and never bind the server against an empty or unmigrated brain.
//!
//! When `DATABASE_URL` is supplied externally the appliance honours it and
//! skips local provisioning (the caller passes a [`sf_db::TestProvisioner`]);
//! when it is absent the appliance provisions its own instance and the
//! provisioner reports the URL via [`sf_db::PostgresProvisioner::database_url`].
//!
//! See `docs/architecture.md` §Daemon Lifecycle §Startup-notify handshake.

use std::path::Path;

use sf_db::{PostgresProvisioner, ProvisionerError};

/// A distinct boot-sequence failure. The two failure stages — provisioning and
/// migration — are separate variants so the daemon can tell the operator
/// exactly which gate failed (issue #670 acceptance criteria 2 & 3).
#[derive(Debug, thiserror::Error)]
pub enum BootError {
    /// Postgres could not be provisioned or did not pass the health gate.
    #[error("provisioning failed: {0}")]
    Provision(#[from] ProvisionerError),

    /// The pool could not be built against the (provisioned or supplied) URL.
    #[error("database connection failed: {0}")]
    Connect(String),

    /// Migrations failed to apply against the live instance.
    #[error("migration failed: {0}")]
    Migrate(#[from] sf_db::MigrationError),

    /// No database URL was available: neither supplied externally nor reported
    /// by the provisioner.
    #[error("no database url: provisioner reported none and DATABASE_URL is unset")]
    NoDatabaseUrl,
}

/// The outcome of a successful health gate: a live, migrated pool ready to serve.
#[derive(Debug)]
pub struct BootReady {
    /// Connection pool bound to the provisioned (or supplied) database.
    pub pool: sqlx::PgPool,
    /// The resolved database URL the daemon is serving against.
    pub database_url: String,
}

/// Resolve which database URL the daemon should use.
///
/// `DATABASE_URL` (external) takes precedence and means local provisioning is
/// skipped. Otherwise the provisioner's own URL is used.
pub fn resolve_database_url(
    external: Option<String>,
    provisioner: &dyn PostgresProvisioner,
) -> Result<String, BootError> {
    if let Some(url) = external.filter(|u| !u.is_empty()) {
        return Ok(url);
    }
    provisioner
        .database_url()
        .filter(|u| !u.is_empty())
        .ok_or(BootError::NoDatabaseUrl)
}

/// Run the full health gate: provision -> wait healthy -> migrate.
///
/// On success returns a [`BootReady`] holding a live pool. On failure returns a
/// [`BootError`] whose variant identifies the stage that aborted boot — the
/// caller must NOT bind the HTTP server on any error.
///
/// `external_database_url` is the value of `DATABASE_URL` from the environment
/// (or `None`). When present, local provisioning is skipped — `provisioner`
/// should be a no-op [`sf_db::TestProvisioner`] in that case, but `start` is
/// still called (a no-op) to keep the ordering uniform.
pub async fn health_gate(
    provisioner: &dyn PostgresProvisioner,
    external_database_url: Option<String>,
    repo_root: &Path,
) -> Result<BootReady, BootError> {
    // 1. Provision: start Postgres and wait for the health gate.
    provisioner.start().await?;

    // Resolve the URL only after provisioning (a local provisioner may not know
    // its URL until it has stood up the instance).
    let database_url = resolve_database_url(external_database_url, provisioner)?;

    // Build the pool against the now-live instance.
    let cfg =
        sf_db::DbConfig::from_url(&database_url).map_err(|e| BootError::Connect(e.to_string()))?;
    let pool = sf_db::connect(&cfg)
        .await
        .map_err(|e| BootError::Connect(e.to_string()))?;

    // 2. Migrate: apply every component schema before serving.
    sf_db::run_migrations(&pool, repo_root).await?;

    // 3. Caller serves.
    Ok(BootReady { pool, database_url })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sf_db::{FailingProvisioner, LocalPostgresProvisioner, TestProvisioner};
    use std::path::PathBuf;

    fn empty_repo_root() -> PathBuf {
        std::env::temp_dir().join(format!("sfboot-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn external_url_takes_precedence_over_provisioner() {
        let prov = LocalPostgresProvisioner::new("/tmp/x").with_port(6000);
        let url = resolve_database_url(Some("postgres://ext@host/db".to_string()), &prov).unwrap();
        assert_eq!(url, "postgres://ext@host/db");
    }

    #[test]
    fn provisioner_url_used_when_no_external() {
        let prov = LocalPostgresProvisioner::new("/tmp/x").with_port(6001);
        let url = resolve_database_url(None, &prov).unwrap();
        assert_eq!(url, "postgres://superfield@127.0.0.1:6001/superfield");
    }

    #[test]
    fn empty_external_url_falls_back_to_provisioner() {
        let prov = LocalPostgresProvisioner::new("/tmp/x").with_port(6002);
        let url = resolve_database_url(Some(String::new()), &prov).unwrap();
        assert_eq!(url, "postgres://superfield@127.0.0.1:6002/superfield");
    }

    #[test]
    fn no_url_anywhere_is_an_error() {
        // TestProvisioner reports no URL and no external one is given.
        let prov = TestProvisioner;
        let err = resolve_database_url(None, &prov).unwrap_err();
        assert!(matches!(err, BootError::NoDatabaseUrl));
    }

    #[tokio::test]
    async fn provisioning_failure_aborts_before_migration() {
        // The health gate must fail at the provision stage and never reach
        // migration or serving.
        let prov = FailingProvisioner::new("postgres did not become ready");
        let err = health_gate(&prov, None, &empty_repo_root())
            .await
            .unwrap_err();
        match err {
            BootError::Provision(_) => {}
            other => panic!("expected Provision error, got {other:?}"),
        }
        assert!(err.to_string().contains("provisioning failed"));
    }

    #[tokio::test]
    async fn ordering_is_provision_then_resolve_url() {
        // With a failing provisioner the URL is never resolved — proves
        // provisioning gates everything downstream (provision -> migrate ->
        // serve ordering).
        let prov = FailingProvisioner::new("boom");
        // Even with a valid external URL, a provisioning failure aborts first.
        let err = health_gate(
            &prov,
            Some("postgres://ext@host/db".to_string()),
            &empty_repo_root(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, BootError::Provision(_)),
            "provision must gate the sequence even when an external URL is set"
        );
    }
}
