//! Session issue and validation backed by `auth.sessions` in Postgres.
//!
//! # Lifecycle
//!
//! 1. **Issue** — call [`SessionStore::issue`] to create a new session row and
//!    return an opaque [`Session`] token.  The token is a random UUID v4.
//! 2. **Validate** — call [`SessionStore::validate`] with the token.  Returns
//!    an [`AuthContext`] containing the workspace, user, and role, ready to be
//!    applied to a database connection for RLS.
//! 3. **Revoke** — call [`SessionStore::revoke`] to mark the session as revoked
//!    and remove it from the active set.
//!
//! # Schema
//!
//! Sessions live in the `auth` PostgreSQL schema.  The migration that creates
//! the schema and tables is at
//! `crates/sf-auth/src/migrations/0001_auth_schema.sql`.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

use crate::context::{AuthContext, Role};

/// An active session token.
///
/// The token is an opaque UUID v4.  Callers store it as a bearer token
/// (cookie, header, etc.); the server validates it with [`SessionStore::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    /// The session token — passed back to the client.
    pub token: Uuid,

    /// The workspace this session is scoped to.
    pub workspace_id: Uuid,

    /// The user who owns this session.
    pub user_id: Uuid,

    /// The role granted to the user in the workspace.
    pub role: Role,

    /// When this session expires.
    pub expires_at: DateTime<Utc>,
}

impl Session {
    /// Build an [`AuthContext`] from this session.
    ///
    /// The context is passed to `sf_db::acquire_workspace` to set the
    /// `app.current_principal_id` session variable on a database connection
    /// so that per-schema RLS policies fire correctly.
    pub fn into_auth_context(self) -> AuthContext {
        AuthContext::new(self.workspace_id, self.user_id, self.role)
    }
}

/// Errors returned by [`SessionStore`] operations.
#[derive(Debug, Error)]
pub enum SessionError {
    /// The session token is not in the `auth.sessions` table.
    #[error("session not found")]
    NotFound,

    /// The session exists but has expired.
    #[error("session expired")]
    Expired,

    /// The session has been explicitly revoked.
    #[error("session revoked")]
    Revoked,

    /// A role stored in the database could not be parsed.
    #[error("unknown role value in database: {0}")]
    UnknownRole(String),

    /// A database error from sqlx.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

/// Validates and parses a `role` column value from the database.
fn parse_role(s: &str) -> Result<Role, SessionError> {
    match s {
        "admin" => Ok(Role::Admin),
        "member" => Ok(Role::Member),
        "viewer" => Ok(Role::Viewer),
        other => Err(SessionError::UnknownRole(other.to_string())),
    }
}

/// Handle to the `auth.sessions` table.
///
/// Cheap to clone — holds only an `Arc`-wrapped pool reference via [`PgPool`].
#[derive(Debug, Clone)]
pub struct SessionStore {
    pool: PgPool,
    /// Default session lifetime in seconds (default: 24 h).
    session_ttl_secs: i64,
}

impl SessionStore {
    /// Build a [`SessionStore`] from a shared pool.
    ///
    /// `session_ttl_secs` controls how long newly issued sessions stay valid.
    /// Pass `None` to use the default of 86 400 seconds (24 hours).
    pub fn new(pool: PgPool, session_ttl_secs: Option<i64>) -> Self {
        Self {
            pool,
            session_ttl_secs: session_ttl_secs.unwrap_or(86_400),
        }
    }

    /// Issue a new session for `(workspace_id, user_id, role)`.
    ///
    /// Inserts a row into `auth.sessions` and returns the new [`Session`].
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::Db`] on any Postgres error.
    pub async fn issue(
        &self,
        workspace_id: Uuid,
        user_id: Uuid,
        role: Role,
    ) -> Result<Session, SessionError> {
        let token = Uuid::new_v4();
        let now = Utc::now();
        let expires_at = now + chrono::Duration::seconds(self.session_ttl_secs);

        sqlx::query(
            "INSERT INTO auth.sessions \
             (token, workspace_id, user_id, role, issued_at, expires_at, revoked) \
             VALUES ($1, $2, $3, $4, $5, $6, FALSE)",
        )
        .bind(token)
        .bind(workspace_id)
        .bind(user_id)
        .bind(role.as_str())
        .bind(now)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;

        Ok(Session {
            token,
            workspace_id,
            user_id,
            role,
            expires_at,
        })
    }

    /// Validate `token` and return the associated [`AuthContext`].
    ///
    /// Checks that the session:
    /// - exists in `auth.sessions`,
    /// - has not been revoked,
    /// - has not expired (`expires_at > NOW()`).
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::NotFound`], [`SessionError::Revoked`],
    /// [`SessionError::Expired`], or [`SessionError::Db`].
    pub async fn validate(&self, token: Uuid) -> Result<AuthContext, SessionError> {
        let row: Option<(Uuid, Uuid, String, DateTime<Utc>, bool)> = sqlx::query_as(
            "SELECT workspace_id, user_id, role, expires_at, revoked \
             FROM auth.sessions \
             WHERE token = $1",
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await?;

        let (workspace_id, user_id, role_str, expires_at, revoked) =
            row.ok_or(SessionError::NotFound)?;

        if revoked {
            return Err(SessionError::Revoked);
        }

        if Utc::now() > expires_at {
            return Err(SessionError::Expired);
        }

        let role = parse_role(&role_str)?;
        Ok(AuthContext::new(workspace_id, user_id, role))
    }

    /// Revoke `token` by setting `revoked = TRUE` on the session row.
    ///
    /// Returns `Ok(())` even if the token does not exist (idempotent).
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::Db`] on any Postgres error.
    pub async fn revoke(&self, token: Uuid) -> Result<(), SessionError> {
        sqlx::query("UPDATE auth.sessions SET revoked = TRUE WHERE token = $1")
            .bind(token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    // ---------------------------------------------------------------------------
    // Unit tests — no live database required
    // ---------------------------------------------------------------------------

    /// Session::into_auth_context propagates workspace, user, and role.
    #[test]
    fn session_into_auth_context_propagates_fields() {
        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();
        let session = Session {
            token: Uuid::new_v4(),
            workspace_id: ws,
            user_id: user,
            role: Role::Admin,
            expires_at: Utc::now() + Duration::hours(1),
        };

        let ctx = session.into_auth_context();
        assert_eq!(ctx.workspace_id, ws);
        assert_eq!(ctx.user_id, user);
        assert_eq!(ctx.role, Role::Admin);
        // principal_id encodes both ws and user.
        assert!(ctx.principal_id().contains(&ws.to_string()));
        assert!(ctx.principal_id().contains(&user.to_string()));
    }

    /// parse_role accepts all known roles.
    #[test]
    fn parse_role_accepts_known_values() {
        assert!(matches!(parse_role("admin"), Ok(Role::Admin)));
        assert!(matches!(parse_role("member"), Ok(Role::Member)));
        assert!(matches!(parse_role("viewer"), Ok(Role::Viewer)));
    }

    /// parse_role rejects unknown strings.
    #[test]
    fn parse_role_rejects_unknown() {
        let err = parse_role("superuser").unwrap_err();
        assert!(matches!(err, SessionError::UnknownRole(_)));
    }

    // ---------------------------------------------------------------------------
    // Integration tests — require DATABASE_URL
    // ---------------------------------------------------------------------------

    /// Integration test: issue then validate returns matching context.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn issue_and_validate_round_trip() {
        let cfg = sf_db::DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = sf_db::connect(&cfg).await.expect("pool creation failed");
        let store = SessionStore::new(pool, None);

        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();

        let session = store
            .issue(ws, user, Role::Member)
            .await
            .expect("issue failed");

        assert_eq!(session.workspace_id, ws);
        assert_eq!(session.user_id, user);
        assert_eq!(session.role, Role::Member);

        let ctx = store
            .validate(session.token)
            .await
            .expect("validate failed");

        assert_eq!(ctx.workspace_id, ws);
        assert_eq!(ctx.user_id, user);
        assert_eq!(ctx.role, Role::Member);
    }

    /// Integration test: revoked session is rejected by validate.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn revoked_session_is_rejected() {
        let cfg = sf_db::DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = sf_db::connect(&cfg).await.expect("pool creation failed");
        let store = SessionStore::new(pool, None);

        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();

        let session = store
            .issue(ws, user, Role::Viewer)
            .await
            .expect("issue failed");

        store.revoke(session.token).await.expect("revoke failed");

        let err = store.validate(session.token).await.unwrap_err();
        assert!(matches!(err, SessionError::Revoked));
    }

    /// Integration test: validate sets workspace+role context consumed by RLS.
    ///
    /// Validates that the [`AuthContext`] returned by `validate` carries the
    /// correct `principal_id` format expected by `sf_db::acquire_workspace`.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with auth schema migrated"]
    async fn validated_session_establishes_expected_context() {
        let cfg = sf_db::DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = sf_db::connect(&cfg).await.expect("pool creation failed");
        let store = SessionStore::new(pool.clone(), None);

        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();
        let session = store
            .issue(ws, user, Role::Admin)
            .await
            .expect("issue failed");

        let ctx = store.validate(session.token).await.expect("validate failed");

        // The context principal_id must be the compound workspace/user key.
        let expected_principal = format!("{}/{}", ws, user);
        assert_eq!(ctx.principal_id(), expected_principal);

        // acquire_workspace must accept the principal_id without error.
        let _conn = sf_db::acquire_workspace(&pool, ctx.principal_id())
            .await
            .expect("acquire_workspace failed");
    }
}
