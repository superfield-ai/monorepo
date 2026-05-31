//! Typed configuration for the shared database pool.
//!
//! Config is loaded once at startup and shared across all component crates.
//! The primary source is the `DATABASE_URL` environment variable, which must
//! be a valid `postgres://` connection string.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

use thiserror::Error;

/// Error returned when [`DbConfig`] cannot be built from the environment.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// The `DATABASE_URL` environment variable is missing or empty.
    #[error("DATABASE_URL is not set")]
    MissingDatabaseUrl,

    /// `DATABASE_URL` is set but is not a valid `postgres://` URL.
    #[error("DATABASE_URL must be a postgres:// URL, got: {0}")]
    InvalidDatabaseUrl(String),
}

/// Typed configuration for the shared Postgres connection pool.
///
/// Built once at startup; every component crate receives a clone or a shared
/// reference.  No component may open a database connection without going
/// through [`crate::connect`].
#[derive(Debug, Clone)]
pub struct DbConfig {
    /// Full `postgres://` connection string.
    pub database_url: String,

    /// Maximum number of connections in the pool.
    ///
    /// Defaults to 10 when not set via `DATABASE_POOL_MAX_CONNECTIONS`.
    pub max_connections: u32,
}

impl DbConfig {
    /// Build [`DbConfig`] from the process environment.
    ///
    /// Reads:
    /// - `DATABASE_URL` (required) — must start with `postgres://` or
    ///   `postgresql://`.
    /// - `DATABASE_POOL_MAX_CONNECTIONS` (optional, default 10).
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError::MissingDatabaseUrl`] when `DATABASE_URL` is
    /// absent or empty, and [`ConfigError::InvalidDatabaseUrl`] when it does
    /// not look like a Postgres URL.
    pub fn from_env() -> Result<Self, ConfigError> {
        let database_url = std::env::var("DATABASE_URL")
            .map_err(|_| ConfigError::MissingDatabaseUrl)
            .and_then(|v| {
                if v.is_empty() {
                    Err(ConfigError::MissingDatabaseUrl)
                } else {
                    Ok(v)
                }
            })?;

        if !database_url.starts_with("postgres://")
            && !database_url.starts_with("postgresql://")
        {
            return Err(ConfigError::InvalidDatabaseUrl(database_url));
        }

        let max_connections = std::env::var("DATABASE_POOL_MAX_CONNECTIONS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(10);

        Ok(Self {
            database_url,
            max_connections,
        })
    }

    /// Build [`DbConfig`] from a `postgres://` URL string directly.
    ///
    /// Useful in tests where you want to pass a URL from a test fixture
    /// rather than setting environment variables.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError::InvalidDatabaseUrl`] when `url` does not start
    /// with `postgres://` or `postgresql://`.
    pub fn from_url(url: impl Into<String>) -> Result<Self, ConfigError> {
        let database_url = url.into();
        if !database_url.starts_with("postgres://")
            && !database_url.starts_with("postgresql://")
        {
            return Err(ConfigError::InvalidDatabaseUrl(database_url));
        }
        Ok(Self {
            database_url,
            max_connections: 10,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_url() {
        // Ensure env var is not set for this test.
        std::env::remove_var("DATABASE_URL");
        let err = DbConfig::from_env().unwrap_err();
        assert!(
            matches!(err, ConfigError::MissingDatabaseUrl),
            "expected MissingDatabaseUrl, got {err}"
        );
    }

    #[test]
    fn rejects_non_postgres_url() {
        let err = DbConfig::from_url("mysql://localhost/db").unwrap_err();
        assert!(
            matches!(err, ConfigError::InvalidDatabaseUrl(_)),
            "expected InvalidDatabaseUrl"
        );
    }

    #[test]
    fn accepts_postgres_url() {
        let cfg = DbConfig::from_url("postgres://user:pass@localhost/mydb").unwrap();
        assert_eq!(cfg.database_url, "postgres://user:pass@localhost/mydb");
        assert_eq!(cfg.max_connections, 10);
    }

    #[test]
    fn accepts_postgresql_scheme() {
        let cfg = DbConfig::from_url("postgresql://localhost/mydb").unwrap();
        assert_eq!(cfg.database_url, "postgresql://localhost/mydb");
    }
}
