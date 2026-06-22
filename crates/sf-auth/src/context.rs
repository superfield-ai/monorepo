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
/// These are the seven roles defined in PRD §3 (User Roles). The role model
/// is the *same* across both surfaces — the delivered app and the control
/// panel — so a person's permissions are consistent wherever they act
/// (PRD §3, US12).
///
/// Roles are coarse-grained at the auth layer; route-level authorization
/// ([`Role::can_write`] / [`Role::is_owner`]) gates HTTP routes, and
/// fine-grained data isolation is enforced by RLS policies in each component
/// schema.
///
/// # Capability summary
///
/// | Role         | Read | Write | Set policy (Owner-only) |
/// |--------------|------|-------|-------------------------|
/// | Owner        | yes  | yes   | yes                     |
/// | Requestor    | yes  | yes   | no                      |
/// | Steerer      | yes  | yes   | no                      |
/// | Collaborator | yes  | yes   | no                      |
/// | Agent        | yes  | yes   | no                      |
/// | Auditor      | yes  | no    | no                      |
/// | Viewer       | yes  | no    | no                      |
///
/// See `docs/prd.md` §3 User Roles.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Owner / Sponsor — provisions and governs the Forge; the only role that
    /// may set policy (PRD §3).
    Owner,
    /// Requestor (business unit) — owns an unserved need, requests an app, and
    /// operates it once it exists.
    Requestor,
    /// Steerer (Product / Engineering lead) — directs agent work and reviews
    /// or approves gated changes.
    Steerer,
    /// Collaborator — proposes and reviews changes within a workspace and
    /// operates the software so its behavior becomes signal.
    Collaborator,
    /// Agent — a first-class, non-human actor that reads the brain and writes
    /// observations, candidate changes, validation results, and outcomes,
    /// acting only within the policy set by the Owner.
    Agent,
    /// Auditor / Compliance reviewer — read-only access to the full history of
    /// changes, decisions, and the reasons behind them.
    Auditor,
    /// Viewer — read-only access to project state.
    Viewer,
}

/// The complete set of PRD §3 roles, in declaration order.
///
/// Used by tests to assert the role model has exactly the seven roles the PRD
/// requires.
pub const ALL_ROLES: [Role; 7] = [
    Role::Owner,
    Role::Requestor,
    Role::Steerer,
    Role::Collaborator,
    Role::Agent,
    Role::Auditor,
    Role::Viewer,
];

impl Role {
    /// Return the string identifier stored in the database and used in RLS.
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Requestor => "requestor",
            Role::Steerer => "steerer",
            Role::Collaborator => "collaborator",
            Role::Agent => "agent",
            Role::Auditor => "auditor",
            Role::Viewer => "viewer",
        }
    }

    /// Whether this role may perform write operations (create / mutate state).
    ///
    /// Auditor and Viewer are read-only (PRD §3); every other role may write
    /// within the policy set by the Owner.
    pub fn can_write(&self) -> bool {
        !matches!(self, Role::Auditor | Role::Viewer)
    }

    /// Whether this role may set workspace policy.
    ///
    /// Only the Owner sets policy — "what counts as a valid correction, what
    /// risk level may ship without human review, and what requires sign-off"
    /// (PRD §3).
    pub fn is_owner(&self) -> bool {
        matches!(self, Role::Owner)
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
        let ctx = AuthContext::new(ws, user, Role::Collaborator);
        assert_eq!(
            ctx.principal_id(),
            "00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002"
        );
        assert_eq!(ctx.role, Role::Collaborator);
    }

    #[test]
    fn role_display() {
        assert_eq!(Role::Owner.to_string(), "owner");
        assert_eq!(Role::Requestor.to_string(), "requestor");
        assert_eq!(Role::Steerer.to_string(), "steerer");
        assert_eq!(Role::Collaborator.to_string(), "collaborator");
        assert_eq!(Role::Agent.to_string(), "agent");
        assert_eq!(Role::Auditor.to_string(), "auditor");
        assert_eq!(Role::Viewer.to_string(), "viewer");
    }

    #[test]
    fn context_workspace_and_user_ids_preserved() {
        let ws = Uuid::new_v4();
        let user = Uuid::new_v4();
        let ctx = AuthContext::new(ws, user, Role::Owner);
        assert_eq!(ctx.workspace_id, ws);
        assert_eq!(ctx.user_id, user);
    }

    /// PRD §3 mandates exactly seven roles. Guard against drift.
    #[test]
    fn role_model_has_exactly_seven_roles() {
        assert_eq!(ALL_ROLES.len(), 7);
        // Every role's wire string is unique.
        let mut seen = std::collections::HashSet::new();
        for role in &ALL_ROLES {
            assert!(seen.insert(role.as_str()), "duplicate role: {}", role);
        }
        assert_eq!(seen.len(), 7);
    }

    /// Auditor and Viewer are read-only; all five other roles may write.
    #[test]
    fn write_capability_matches_prd() {
        assert!(Role::Owner.can_write());
        assert!(Role::Requestor.can_write());
        assert!(Role::Steerer.can_write());
        assert!(Role::Collaborator.can_write());
        assert!(Role::Agent.can_write());
        assert!(!Role::Auditor.can_write());
        assert!(!Role::Viewer.can_write());
    }

    /// Only the Owner may set policy.
    #[test]
    fn only_owner_sets_policy() {
        assert!(Role::Owner.is_owner());
        for role in ALL_ROLES.iter().filter(|r| **r != Role::Owner) {
            assert!(!role.is_owner(), "{} must not be owner", role);
        }
    }
}
