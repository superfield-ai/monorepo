//! Workspace and role context established by a validated session.
//!
//! After a session is validated, the caller builds an [`AuthContext`] and
//! passes it to `sf_db::acquire_workspace` so that the connection's
//! `app.current_principal_id` session variable is set before any
//! data-modifying statement runs.  RLS policies on every schema reference
//! `current_setting('app.current_principal_id')` to filter rows.
//!
//! See `docs/architecture.md` §RLS policies are scoped per schema.

use uuid::Uuid;

/// The role of an authenticated principal within a workspace.
///
/// Roles are coarse-grained at the auth layer; fine-grained permissions are
/// enforced by RLS policies in each component schema.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Full administrative access to the workspace.
    Admin,
    /// Standard member access — can read and write within the workspace.
    Member,
    /// Read-only viewer access.
    Viewer,
}

impl Role {
    /// Return the string identifier stored in the database and used in RLS.
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Member => "member",
            Role::Viewer => "viewer",
        }
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The authenticated context set on a database connection for a request.
///
/// Built from a validated [`crate::Session`] and passed to
/// `sf_db::acquire_workspace` so that per-schema RLS policies can fire.
///
/// The `principal_id` field is the value written to
/// `app.current_principal_id` via `SET LOCAL`.  It is a workspace-scoped
/// UUID, not a raw user UUID, so that RLS policies stay workspace-aware even
/// when a user belongs to multiple workspaces.
#[derive(Debug, Clone)]
pub struct AuthContext {
    /// Workspace-scoped principal identity used by RLS.
    ///
    /// Stored as `"<workspace_id>/<user_id>"` so the RLS policy can split on
    /// `/` when it needs the raw workspace or user UUID.
    pub principal_id: String,

    /// The workspace this session is scoped to.
    pub workspace_id: Uuid,

    /// The user who owns the session.
    pub user_id: Uuid,

    /// The role granted to `user_id` within `workspace_id`.
    pub role: Role,
}

impl AuthContext {
    /// Build an [`AuthContext`] from its component parts.
    pub fn new(workspace_id: Uuid, user_id: Uuid, role: Role) -> Self {
        let principal_id = format!("{}/{}", workspace_id, user_id);
        Self {
            principal_id,
            workspace_id,
            user_id,
            role,
        }
    }

    /// The value to pass as `principal_id` to `sf_db::acquire_workspace`.
    ///
    /// Format: `"<workspace_id>/<user_id>"`.
    pub fn principal_id(&self) -> &str {
        &self.principal_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principal_id_format() {
        let ws = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        let user = Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap();
        let ctx = AuthContext::new(ws, user, Role::Member);
        assert_eq!(
            ctx.principal_id(),
            "00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002"
        );
        assert_eq!(ctx.role, Role::Member);
    }

    #[test]
    fn role_display() {
        assert_eq!(Role::Admin.to_string(), "admin");
        assert_eq!(Role::Member.to_string(), "member");
        assert_eq!(Role::Viewer.to_string(), "viewer");
    }

    #[test]
    fn context_workspace_and_user_ids_preserved() {
        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();
        let ctx = AuthContext::new(ws, user, Role::Admin);
        assert_eq!(ctx.workspace_id, ws);
        assert_eq!(ctx.user_id, user);
    }
}
