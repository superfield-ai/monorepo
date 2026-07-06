//! Policy engine for autonomous-versus-approval governance.
//!
//! Implements the Policy entity required by PRD US4 and §3 (the Owner "sets
//! policy: what risk level may ship without human review, and what requires
//! sign-off"). A policy traverses the PRD §6 lifecycle
//!
//! ```text
//! drafted → active → revised → retired
//! ```
//!
//! and carries a **risk threshold** the change-merge path consults before
//! merging (PRD Constraint §9 — "no change above the policy-defined risk
//! threshold may ship without human approval"). This module owns:
//!
//! - [`PolicyState`]: the PRD §6 lifecycle states, with a legal-transition table
//!   ([`PolicyState::can_transition_to`] / [`PolicyState::transition`]) that is
//!   pure (no database) so the rules are unit-testable in isolation.
//! - [`RiskLevel`]: a 0..=100 score for a change's blast radius / risk.
//! - [`Policy`]: the active-policy decision surface — [`Policy::evaluate`] maps a
//!   change's [`RiskLevel`] to a [`MergeDecision`] (autonomous-ship vs
//!   approval-required), the heart of the merge gate.
//! - The persistence path against the `forge` schema
//!   (`crates/sf-db/migrations/0005_policy_engine.sql`): [`insert_policy`],
//!   [`fetch_policy`], [`fetch_active_policy`], [`transition_policy`], and the
//!   merge-gate entrypoint [`evaluate_change_against_active_policy`].
//!
//! # Merge gate (PRD Constraint §9)
//!
//! The policy decision is expressed in two places that agree by construction:
//!
//! 1. In-memory: [`Policy::evaluate`] is pure and total — it returns
//!    [`MergeDecision::Autonomous`] only when the policy permits autonomy *and*
//!    the change's risk is at or below the policy threshold; otherwise it returns
//!    [`MergeDecision::RequiresApproval`].
//! 2. Persisted: [`evaluate_change_against_active_policy`] resolves the single
//!    `active` policy for a workspace and applies the same rule, so the merge
//!    path cannot auto-ship a change above the active threshold.
//!
//! When no policy is `active`, the gate is fail-closed: every change
//! [`MergeDecision::RequiresApproval`] (a missing policy must not silently grant
//! autonomy).
//!
//! # Canonical docs
//!
//! - `docs/prd.md` §3 (Owner role / policy), US4, §6 (Policy lifecycle),
//!   Constraint §9 (the policy-defined risk threshold).
//! - `docs/architecture.md` §Change Lifecycle and Validation Gate (which notes
//!   the policy risk evaluation as "tracked separately" — that is this module).

use sqlx::PgPool;
use std::fmt;
use thiserror::Error;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

/// The PRD §6 lifecycle states of a [`Policy`].
///
/// `drafted → active → revised → retired`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PolicyState {
    /// The policy is being authored; it does not yet govern changes.
    Drafted,
    /// The policy is active and consulted by the merge gate.
    Active,
    /// The policy is being revised; a successor draft supersedes it. It no
    /// longer governs changes but is retained for audit.
    Revised,
    /// The policy is retired (terminal): it no longer governs changes.
    Retired,
}

impl PolicyState {
    /// Every PRD §6 policy state, in lifecycle order.
    ///
    /// The acceptance criteria assert all four states exist; this slice is the
    /// single source of truth used by both the tests and the SQL `CHECK`
    /// vocabulary in `0005_policy_engine.sql`.
    pub const ALL: &'static [PolicyState] = &[
        PolicyState::Drafted,
        PolicyState::Active,
        PolicyState::Revised,
        PolicyState::Retired,
    ];

    /// The canonical wire/database string for this state (PRD §6 spelling).
    pub fn as_str(self) -> &'static str {
        match self {
            PolicyState::Drafted => "drafted",
            PolicyState::Active => "active",
            PolicyState::Revised => "revised",
            PolicyState::Retired => "retired",
        }
    }

    /// Parse a state from its canonical string, or [`PolicyError::UnknownState`].
    pub fn parse(s: &str) -> Result<PolicyState, PolicyError> {
        PolicyState::ALL
            .iter()
            .copied()
            .find(|st| st.as_str() == s)
            .ok_or_else(|| PolicyError::UnknownState(s.to_string()))
    }

    /// Whether this state is terminal (no outgoing transitions).
    pub fn is_terminal(self) -> bool {
        matches!(self, PolicyState::Retired)
    }

    /// Whether the merge gate consults a policy in this state.
    pub fn is_governing(self) -> bool {
        matches!(self, PolicyState::Active)
    }

    /// Whether a direct transition `self → next` is legal in the PRD §6 graph.
    ///
    /// Legal edges:
    /// - `drafted → active | retired`
    /// - `active  → revised | retired`
    /// - `revised → active | retired`
    /// - `retired` is terminal (no outgoing edges).
    ///
    /// `revised → active` lets an Owner revise an active policy and re-activate
    /// the revised version (PRD §6 `revised` is a continuous editing state, not a
    /// terminal one).
    pub fn can_transition_to(self, next: PolicyState) -> bool {
        use PolicyState::*;
        matches!(
            (self, next),
            (Drafted, Active)
                | (Drafted, Retired)
                | (Active, Revised)
                | (Active, Retired)
                | (Revised, Active)
                | (Revised, Retired)
        )
    }

    /// Attempt the transition `self → next`, enforcing the legal-transition graph.
    ///
    /// Returns `next` on success.
    ///
    /// # Errors
    ///
    /// - [`PolicyError::IllegalTransition`] — `self → next` is not a legal edge.
    pub fn transition(self, next: PolicyState) -> Result<PolicyState, PolicyError> {
        if !self.can_transition_to(next) {
            return Err(PolicyError::IllegalTransition {
                from: self,
                to: next,
            });
        }
        Ok(next)
    }
}

impl fmt::Display for PolicyState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Risk + decision
// ---------------------------------------------------------------------------

/// The risk score of a change, on a `0..=100` scale (higher is riskier).
///
/// `0` is a trivially-safe change; `100` is maximal risk. The scale is the same
/// one a [`Policy`] threshold is expressed on, so the two compare directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RiskLevel(u8);

impl RiskLevel {
    /// The lowest (safest) risk.
    pub const MIN: RiskLevel = RiskLevel(0);
    /// The highest (riskiest) risk.
    pub const MAX: RiskLevel = RiskLevel(100);

    /// Construct a risk level, clamping into the `0..=100` range.
    pub fn new(score: u8) -> RiskLevel {
        RiskLevel(score.min(100))
    }

    /// The underlying `0..=100` score.
    pub fn score(self) -> u8 {
        self.0
    }
}

/// The decision the merge gate derives from the active policy for a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeDecision {
    /// The change may ship autonomously (auto-merge without human approval): the
    /// policy permits autonomy and the change risk is at or below the threshold.
    Autonomous,
    /// The change must be held for human approval (routed to the change
    /// lifecycle's `awaiting-approval` state): either no policy permits autonomy
    /// for it, or its risk exceeds the policy threshold.
    RequiresApproval,
}

impl MergeDecision {
    /// Whether this decision permits an autonomous (no-approval) merge.
    pub fn is_autonomous(self) -> bool {
        matches!(self, MergeDecision::Autonomous)
    }
}

// ---------------------------------------------------------------------------
// Persisted row
// ---------------------------------------------------------------------------

/// A persisted policy row read back from `forge.policies`.
#[derive(Debug, Clone)]
pub struct Policy {
    /// `forge.policies.id`.
    pub id: Uuid,
    /// Owning workspace.
    pub workspace_id: Uuid,
    /// Human-readable name / summary.
    pub name: String,
    /// Current lifecycle state.
    pub state: PolicyState,
    /// The risk threshold (`0..=100`): a change at or below this may ship
    /// autonomously when [`Policy::autonomous`] is `true`.
    pub risk_threshold: RiskLevel,
    /// Whether changes at or below the threshold ship autonomously.
    pub autonomous: bool,
}

impl Policy {
    /// Evaluate a change's risk against this policy and return the merge decision.
    ///
    /// Pure and total. The change may ship autonomously only when **both** hold:
    ///
    /// - the policy permits autonomy ([`Policy::autonomous`] is `true`), and
    /// - the change risk is at or below the policy [`Policy::risk_threshold`].
    ///
    /// Otherwise the change [`MergeDecision::RequiresApproval`]. A non-`active`
    /// policy never grants autonomy — it is not a governing policy.
    pub fn evaluate(&self, risk: RiskLevel) -> MergeDecision {
        if self.state.is_governing() && self.autonomous && risk <= self.risk_threshold {
            MergeDecision::Autonomous
        } else {
            MergeDecision::RequiresApproval
        }
    }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors from the policy engine.
#[derive(Debug, Error)]
pub enum PolicyError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The `forge.policies` table does not exist (migration not applied).
    #[error("forge.policies table not found — apply sf-db migration 0005 first")]
    TableMissing,

    /// No policy exists with the requested id.
    #[error("policy {0} not found")]
    NotFound(Uuid),

    /// A string is not a recognised state vocabulary entry.
    #[error("unknown state '{0}'")]
    UnknownState(String),

    /// A risk threshold outside the legal `0..=100` range was supplied.
    #[error("risk threshold {0} out of range (must be 0..=100)")]
    ThresholdOutOfRange(i32),

    /// The requested transition is not a legal edge in the PRD §6 graph.
    #[error("illegal policy transition: {from} → {to}")]
    IllegalTransition {
        /// The current state.
        from: PolicyState,
        /// The rejected target state.
        to: PolicyState,
    },
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/// Map a sqlx error to [`PolicyError::TableMissing`] when the `forge.policies`
/// table is absent, else [`PolicyError::Database`].
fn map_db_err(e: sqlx::Error) -> PolicyError {
    let msg = e.to_string();
    if msg.contains("forge.policies") && msg.contains("does not exist") {
        PolicyError::TableMissing
    } else {
        PolicyError::Database(e)
    }
}

/// Insert a new policy in the `drafted` state and return its id.
///
/// # Arguments
///
/// * `pool`           — shared [`sqlx::PgPool`].
/// * `workspace_id`   — tenant UUID; must exist in `public.workspaces(id)`.
/// * `name`           — human-readable name / summary.
/// * `risk_threshold` — `0..=100`; changes at or below this may ship
///   autonomously when `autonomous` is `true`.
/// * `autonomous`     — whether at-or-below-threshold changes ship autonomously.
pub async fn insert_policy(
    pool: &PgPool,
    workspace_id: Uuid,
    name: &str,
    risk_threshold: RiskLevel,
    autonomous: bool,
) -> Result<Uuid, PolicyError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO forge.policies (workspace_id, name, state, risk_threshold, autonomous) \
         VALUES ($1, $2, 'drafted', $3, $4) RETURNING id",
    )
    .bind(workspace_id)
    .bind(name)
    .bind(i32::from(risk_threshold.score()))
    .bind(autonomous)
    .fetch_one(pool)
    .await
    .map_err(map_db_err)?;

    Ok(id)
}

/// Decode a `forge.policies` row tuple into a [`Policy`].
fn row_to_policy(
    (id, workspace_id, name, state, risk_threshold, autonomous): (
        Uuid,
        Uuid,
        String,
        String,
        i32,
        bool,
    ),
) -> Result<Policy, PolicyError> {
    if !(0..=100).contains(&risk_threshold) {
        return Err(PolicyError::ThresholdOutOfRange(risk_threshold));
    }
    Ok(Policy {
        id,
        workspace_id,
        name,
        state: PolicyState::parse(&state)?,
        risk_threshold: RiskLevel::new(risk_threshold as u8),
        autonomous,
    })
}

const SELECT_COLUMNS: &str = "id, workspace_id, name, state, risk_threshold, autonomous";

/// Fetch a policy by id.
///
/// # Errors
///
/// - [`PolicyError::NotFound`] when no policy has that id.
/// - [`PolicyError::TableMissing`] when migration 0005 has not been applied.
pub async fn fetch_policy(pool: &PgPool, id: Uuid) -> Result<Policy, PolicyError> {
    let row: Option<(Uuid, Uuid, String, String, i32, bool)> = sqlx::query_as(&format!(
        "SELECT {SELECT_COLUMNS} FROM forge.policies WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_err)?;

    match row {
        Some(r) => row_to_policy(r),
        None => Err(PolicyError::NotFound(id)),
    }
}

/// Fetch the single `active` policy for a workspace, if any.
///
/// The `policies_one_active_per_workspace_idx` partial unique index guarantees
/// at most one row, so this returns `Ok(None)` when no policy is active and the
/// active policy otherwise.
pub async fn fetch_active_policy(
    pool: &PgPool,
    workspace_id: Uuid,
) -> Result<Option<Policy>, PolicyError> {
    let row: Option<(Uuid, Uuid, String, String, i32, bool)> = sqlx::query_as(&format!(
        "SELECT {SELECT_COLUMNS} FROM forge.policies \
         WHERE workspace_id = $1 AND state = 'active'"
    ))
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .map_err(map_db_err)?;

    row.map(row_to_policy).transpose()
}

/// Transition a persisted policy to `next`, enforcing the legal-transition graph.
///
/// Reads the policy's current state, applies [`PolicyState::transition`], and
/// persists the new state on success. Returns the new state.
///
/// # Errors
///
/// - [`PolicyError::NotFound`] — no policy with that id.
/// - [`PolicyError::IllegalTransition`] — `current → next` is not legal.
/// - [`PolicyError::Database`] — e.g. activating a second policy for a workspace
///   violates the single-active-policy unique index.
pub async fn transition_policy(
    pool: &PgPool,
    id: Uuid,
    next: PolicyState,
) -> Result<PolicyState, PolicyError> {
    let current = fetch_policy(pool, id).await?.state;
    let new_state = current.transition(next)?;

    sqlx::query("UPDATE forge.policies SET state = $1, updated_at = now() WHERE id = $2")
        .bind(new_state.as_str())
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_err)?;

    Ok(new_state)
}

/// The merge-gate entrypoint: evaluate a change's risk against the workspace's
/// active policy and return the [`MergeDecision`].
///
/// Resolves the single `active` policy for `workspace_id` (via
/// [`fetch_active_policy`]) and applies [`Policy::evaluate`]. When **no** policy
/// is active the gate is fail-closed: the decision is
/// [`MergeDecision::RequiresApproval`] so a missing policy never silently grants
/// autonomy (PRD Constraint §9).
///
/// This is what the change-merge path consults before allowing an autonomous
/// merge versus routing the change to `awaiting-approval`.
pub async fn evaluate_change_against_active_policy(
    pool: &PgPool,
    workspace_id: Uuid,
    risk: RiskLevel,
) -> Result<MergeDecision, PolicyError> {
    match fetch_active_policy(pool, workspace_id).await? {
        Some(policy) => Ok(policy.evaluate(risk)),
        None => Ok(MergeDecision::RequiresApproval),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a governing (active) policy for evaluation tests.
    fn active_policy(threshold: u8, autonomous: bool) -> Policy {
        Policy {
            id: Uuid::nil(),
            workspace_id: Uuid::nil(),
            name: "test".to_string(),
            state: PolicyState::Active,
            risk_threshold: RiskLevel::new(threshold),
            autonomous,
        }
    }

    // ── Pure state-machine tests (no database) ──────────────────────────────

    /// Acceptance criterion: every PRD §6 Policy state exists and round-trips
    /// through its canonical string.
    #[test]
    fn all_prd_policy_states_exist() {
        let expected = ["drafted", "active", "revised", "retired"];
        let actual: Vec<&str> = PolicyState::ALL.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            actual, expected,
            "PolicyState::ALL must list exactly the PRD §6 states in lifecycle order"
        );

        for s in expected {
            let parsed = PolicyState::parse(s).expect("each PRD state must parse");
            assert_eq!(
                parsed.as_str(),
                s,
                "state must round-trip through its string"
            );
        }
        assert!(PolicyState::parse("bogus").is_err());
    }

    /// Acceptance criterion: the PRD §6 legal-transition table is enforced.
    #[test]
    fn legal_policy_transitions() {
        use PolicyState::*;
        // Legal edges.
        for (from, to) in [
            (Drafted, Active),
            (Drafted, Retired),
            (Active, Revised),
            (Active, Retired),
            (Revised, Active),
            (Revised, Retired),
        ] {
            assert_eq!(
                from.transition(to).expect("edge must be legal"),
                to,
                "{from} → {to} must be legal"
            );
        }

        // The canonical happy path drafted → active → revised → active → retired.
        let s = Drafted.transition(Active).unwrap();
        let s = s.transition(Revised).unwrap();
        let s = s.transition(Active).unwrap();
        let s = s.transition(Retired).unwrap();
        assert_eq!(s, Retired);
    }

    /// Acceptance criterion: illegal transitions return an error, and `retired`
    /// is terminal.
    #[test]
    fn illegal_policy_transitions_return_error() {
        use PolicyState::*;
        // drafted → revised skips activation: illegal.
        let err = Drafted
            .transition(Revised)
            .expect_err("drafted → revised must be illegal");
        assert!(matches!(err, PolicyError::IllegalTransition { from, to }
            if from == Drafted && to == Revised));

        // retired is terminal.
        assert!(Retired.is_terminal());
        for to in [Drafted, Active, Revised] {
            assert!(
                Retired.transition(to).is_err(),
                "retired → {to} must be rejected"
            );
        }
    }

    /// `RiskLevel::new` clamps out-of-range scores into `0..=100`.
    #[test]
    fn risk_level_clamps() {
        assert_eq!(RiskLevel::new(0).score(), 0);
        assert_eq!(RiskLevel::new(100).score(), 100);
        assert_eq!(RiskLevel::new(250).score(), 100);
        assert!(RiskLevel::MIN < RiskLevel::MAX);
    }

    /// Acceptance criterion: a change whose risk exceeds an active policy
    /// threshold is held for approval rather than auto-merged.
    #[test]
    fn change_above_threshold_requires_approval() {
        let policy = active_policy(50, true);
        let decision = policy.evaluate(RiskLevel::new(80));
        assert_eq!(
            decision,
            MergeDecision::RequiresApproval,
            "risk 80 above threshold 50 must require approval"
        );
        assert!(!decision.is_autonomous());
    }

    /// Acceptance criterion: a change at or below the threshold under an
    /// autonomous policy is allowed to merge.
    #[test]
    fn change_below_threshold_under_autonomous_policy_merges() {
        let policy = active_policy(50, true);
        // Below threshold.
        assert_eq!(
            policy.evaluate(RiskLevel::new(20)),
            MergeDecision::Autonomous,
            "risk 20 below threshold 50 under an autonomous policy must auto-merge"
        );
        // Exactly at the threshold is also allowed (at-or-below).
        assert_eq!(
            policy.evaluate(RiskLevel::new(50)),
            MergeDecision::Autonomous,
            "risk equal to the threshold must auto-merge"
        );
    }

    /// A policy that does not permit autonomy holds even below-threshold changes
    /// for approval (an approval-only policy).
    #[test]
    fn approval_only_policy_never_auto_merges() {
        let policy = active_policy(100, false);
        assert_eq!(
            policy.evaluate(RiskLevel::MIN),
            MergeDecision::RequiresApproval,
            "an approval-only policy must hold even the safest change"
        );
    }

    /// A non-active (e.g. drafted) policy never grants autonomy even if it would
    /// otherwise permit it — only the `active` policy governs.
    #[test]
    fn non_active_policy_never_auto_merges() {
        let mut policy = active_policy(100, true);
        for state in [
            PolicyState::Drafted,
            PolicyState::Revised,
            PolicyState::Retired,
        ] {
            policy.state = state;
            assert_eq!(
                policy.evaluate(RiskLevel::MIN),
                MergeDecision::RequiresApproval,
                "a {state} policy must not govern the merge gate"
            );
        }
    }

    /// Fail-closed regression (test plan item, issue #865): with no *governing*
    /// policy — the fresh-appliance state a non-active/absent policy models —
    /// `evaluate` must return `MergeDecision::RequiresApproval` at *every* risk
    /// level, not just the safest one. This is the property the `icp-fidelity`
    /// eval's `install-policy-fail-closed` grader relies on
    /// (`crates/sf-eval/src/graders.rs`).
    #[test]
    fn non_active_policy_fail_closed_holds_at_every_risk_level() {
        let mut policy = active_policy(100, true);
        for state in [
            PolicyState::Drafted,
            PolicyState::Revised,
            PolicyState::Retired,
        ] {
            policy.state = state;
            for score in [0u8, 1, 20, 50, 99, 100] {
                assert_eq!(
                    policy.evaluate(RiskLevel::new(score)),
                    MergeDecision::RequiresApproval,
                    "a {state} policy must not govern the merge gate at risk {score}"
                );
            }
        }
    }

    // ── Integration tests (require DATABASE_URL) ────────────────────────────

    /// Integration test: a policy persists in `drafted`, activates, and the
    /// merge gate then holds an above-threshold change for approval while
    /// auto-merging a below-threshold one. When no policy is active the gate is
    /// fail-closed (requires approval).
    ///
    /// Requires `DATABASE_URL` + `WORKSPACE_ID` with sf-db migrations applied.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with sf-db migration 0005 applied"]
    async fn merge_gate_consults_active_policy() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");
        let workspace_id: Uuid = std::env::var("WORKSPACE_ID")
            .expect("WORKSPACE_ID must be set")
            .parse()
            .expect("WORKSPACE_ID must be a UUID");

        // No active policy yet: the gate is fail-closed.
        let decision = evaluate_change_against_active_policy(&pool, workspace_id, RiskLevel::MIN)
            .await
            .expect("evaluate failed");
        assert_eq!(
            decision,
            MergeDecision::RequiresApproval,
            "with no active policy the gate must require approval"
        );

        // Draft and activate an autonomous policy with threshold 50.
        let id = insert_policy(
            &pool,
            workspace_id,
            "autonomy <= 50",
            RiskLevel::new(50),
            true,
        )
        .await
        .expect("insert_policy failed");
        assert_eq!(
            fetch_policy(&pool, id).await.unwrap().state,
            PolicyState::Drafted
        );
        transition_policy(&pool, id, PolicyState::Active)
            .await
            .expect("drafted → active failed");

        // Below threshold auto-merges; above threshold requires approval.
        assert_eq!(
            evaluate_change_against_active_policy(&pool, workspace_id, RiskLevel::new(20))
                .await
                .unwrap(),
            MergeDecision::Autonomous
        );
        assert_eq!(
            evaluate_change_against_active_policy(&pool, workspace_id, RiskLevel::new(80))
                .await
                .unwrap(),
            MergeDecision::RequiresApproval
        );

        // Cleanup.
        transition_policy(&pool, id, PolicyState::Retired)
            .await
            .ok();
        sqlx::query("DELETE FROM forge.policies WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .ok();
    }
}
