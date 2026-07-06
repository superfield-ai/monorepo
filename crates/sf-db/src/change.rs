//! Change lifecycle and validation-gate state machine.
//!
//! Implements the Change entity required by PRD US13 and Constraint §9 (the
//! validation gate). A change traverses the PRD §6 lifecycle
//!
//! ```text
//! draft → validating → awaiting-approval → merged | rejected | abandoned
//! ```
//!
//! and **cannot reach `merged` without a recorded passing validation run** plus
//! any policy-required approval. This module owns:
//!
//! - [`ChangeState`]: the PRD §6 lifecycle states, with a legal-transition table
//!   ([`ChangeState::can_transition_to`] / [`ChangeState::transition`]) that is
//!   pure (no database) so the rules are unit-testable in isolation.
//! - [`ValidationRunState`]: the PRD §6 validation-run states
//!   (`queued → running → passed | failed`).
//! - The persistence path against the `forge` schema
//!   (`crates/sf-db/migrations/0004_change_lifecycle.sql`):
//!   [`insert_change`], [`fetch_change`], [`record_validation_run`], and the
//!   gated [`transition_change`] that re-checks the validation precondition
//!   against persisted runs before moving a change to `merged`.
//!
//! # Validation gate
//!
//! The merge precondition is enforced in two places that agree by construction:
//!
//! 1. In-memory: [`ChangeState::transition`] takes a `has_passing_validation`
//!    flag and refuses `* → merged` when it is `false`
//!    ([`ChangeError::ValidationGate`]).
//! 2. Persisted: [`transition_change`] derives that flag from the recorded
//!    `forge.validation_runs` rows for the change, so a caller cannot merge a
//!    change whose database has no `passed` run.
//!
//! # Canonical docs
//!
//! - `docs/prd.md` §6 (entity lifecycles), US13, Constraint §9 (validation gate).
//! - `docs/architecture.md` §Change Lifecycle and Validation Gate.
//! - `docs/eval-design.md` §"The missing primitive: executable acceptance
//!   criteria" — the per-criterion verdict-row seam below.
//!
//! # Per-criterion verdict-row seam (dev-scout #869, documented contract)
//!
//! [`CriterionVerdictKey`] pins the **additive** schema seam between #861 (the
//! feature that executes acceptance criteria and writes per-criterion
//! verdicts) and #862 (the feature that reads the latest verdict per
//! criterion for the project-page projection). This dev-scout section is
//! documentation plus a compile-time key type — no migration, no new column,
//! and no change to [`record_validation_run`] / [`has_passing_validation`] /
//! [`transition_change`] ships here; those stay exactly as they are today.
//!
//! **The additive migration shape** (implemented by #861 in
//! `crates/sf-db/migrations/0006_criterion_verdicts.sql`): `forge.validation_runs`
//! gains a nullable `criterion_node_id UUID` column.
//!
//! - `NULL` (every row before this migration, and every row a caller that
//!   does not know about criteria ever inserts) means "change-level aggregate
//!   run" — the exact run this module already models. Existing rows and
//!   existing callers are untouched by the addition.
//! - Non-`NULL` means "this row is the verdict for one `AcceptanceCriterion`
//!   node (identified by its `nexum.project_nodes.id`) belonging to the
//!   change", one row per criterion per execution — written by
//!   [`record_criterion_validation_run`] (#861's
//!   `per_criterion_verdicts_recorded` acceptance criterion).
//!
//! **No foreign key.** The dev-scout stub this replaces described the column
//! as `REFERENCES nexum.project_nodes(id) ON DELETE CASCADE`, but the
//! in-process migration runner (`crate::migrate`) applies component
//! directories in a fixed order — `sf-db -> sf-auth -> nexum -> sharp ->
//! orchestrator` — so this sf-db migration runs *before* the nexum component
//! creates `nexum.project_nodes`. A forward FK would fail on first boot, so
//! `criterion_node_id` is a bare UUID; referential integrity is enforced at
//! the application layer (the sf-loop criterion executor only ever passes an
//! id it resolved from an existing `AcceptanceCriterion` node).
//!
//! **How `has_passing_validation` composes with criterion rows (the
//! resolved open question from #861/#862):** the run-state machine
//! (`queued → running → passed | failed`) and the row shape are unchanged —
//! a criterion-linked row is a [`ValidationRunState`] just like an aggregate
//! row. [`has_passing_validation`] AND-aggregates once criterion rows exist:
//! a change with any criterion-linked rows passes the gate iff **every
//! distinct `criterion_node_id` recorded for that change has its most recent
//! row in state `passed`** (one failing or errored criterion fails the whole
//! change, per #861's mixed-result acceptance criterion); a change with zero
//! criterion-linked rows keeps today's behaviour unchanged (any `passed`
//! aggregate row satisfies the gate, preserving pre-#861 callers and the "no
//! criteria, no synthetic pass" acceptance criterion).
//!
//! **The read-side key (#862's join):** [`CriterionVerdictKey`] is the pair
//! `(change_id, criterion_node_id)` #862's latest-verdict query groups and
//! orders by (`DISTINCT ON (criterion_node_id) ... ORDER BY criterion_node_id,
//! created_at DESC`) to resolve one latest verdict per `AcceptanceCriterion`
//! node for rendering — never-run is simply "no row exists for this key",
//! requiring no sentinel state.

use sqlx::PgPool;
use std::fmt;
use thiserror::Error;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// State enums
// ---------------------------------------------------------------------------

/// The PRD §6 lifecycle states of a [`Change`].
///
/// `draft → validating → awaiting-approval → merged | rejected | abandoned`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeState {
    /// The change has been proposed but validation has not started.
    Draft,
    /// Validation is running against the current baseline.
    Validating,
    /// Validation passed; the change awaits policy-required human approval.
    AwaitingApproval,
    /// The change merged (terminal). Requires a passing validation run.
    Merged,
    /// The change was rejected (terminal).
    Rejected,
    /// The change was abandoned before completion (terminal).
    Abandoned,
}

impl ChangeState {
    /// Every PRD §6 change state, in lifecycle order.
    ///
    /// The acceptance criteria assert all six states exist; this slice is the
    /// single source of truth used by both the tests and the SQL `CHECK`
    /// vocabulary in `0004_change_lifecycle.sql`.
    pub const ALL: &'static [ChangeState] = &[
        ChangeState::Draft,
        ChangeState::Validating,
        ChangeState::AwaitingApproval,
        ChangeState::Merged,
        ChangeState::Rejected,
        ChangeState::Abandoned,
    ];

    /// The canonical wire/database string for this state (PRD §6 spelling).
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeState::Draft => "draft",
            ChangeState::Validating => "validating",
            ChangeState::AwaitingApproval => "awaiting-approval",
            ChangeState::Merged => "merged",
            ChangeState::Rejected => "rejected",
            ChangeState::Abandoned => "abandoned",
        }
    }

    /// Parse a state from its canonical string, or [`ChangeError::UnknownState`].
    pub fn parse(s: &str) -> Result<ChangeState, ChangeError> {
        ChangeState::ALL
            .iter()
            .copied()
            .find(|st| st.as_str() == s)
            .ok_or_else(|| ChangeError::UnknownState(s.to_string()))
    }

    /// Whether this state is terminal (no outgoing transitions).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ChangeState::Merged | ChangeState::Rejected | ChangeState::Abandoned
        )
    }

    /// Whether a direct transition `self → next` is legal in the PRD §6 graph,
    /// ignoring the validation gate.
    ///
    /// Legal edges:
    /// - `draft            → validating | abandoned`
    /// - `validating       → awaiting-approval | rejected | abandoned`
    /// - `awaiting-approval → merged | rejected | abandoned`
    /// - terminal states have no outgoing edges.
    ///
    /// The `* → merged` edge is structurally legal here but additionally gated
    /// on a passing validation run by [`transition`](Self::transition); use that
    /// method rather than this predicate when actually moving a change.
    pub fn can_transition_to(self, next: ChangeState) -> bool {
        use ChangeState::*;
        matches!(
            (self, next),
            (Draft, Validating)
                | (Draft, Abandoned)
                | (Validating, AwaitingApproval)
                | (Validating, Rejected)
                | (Validating, Abandoned)
                | (AwaitingApproval, Merged)
                | (AwaitingApproval, Rejected)
                | (AwaitingApproval, Abandoned)
        )
    }

    /// Attempt the transition `self → next`, enforcing both the legal-transition
    /// graph and the validation gate.
    ///
    /// Returns `next` on success.
    ///
    /// # Validation gate (PRD Constraint §9)
    ///
    /// A transition into [`ChangeState::Merged`] requires `has_passing_validation
    /// == true`; otherwise [`ChangeError::ValidationGate`] is returned even
    /// though the edge is structurally legal. Every other transition ignores the
    /// flag.
    ///
    /// # Errors
    ///
    /// - [`ChangeError::IllegalTransition`] — `self → next` is not a legal edge.
    /// - [`ChangeError::ValidationGate`] — `next` is `merged` but no passing
    ///   validation run is recorded.
    pub fn transition(
        self,
        next: ChangeState,
        has_passing_validation: bool,
    ) -> Result<ChangeState, ChangeError> {
        if !self.can_transition_to(next) {
            return Err(ChangeError::IllegalTransition {
                from: self,
                to: next,
            });
        }
        if next == ChangeState::Merged && !has_passing_validation {
            return Err(ChangeError::ValidationGate);
        }
        Ok(next)
    }
}

impl fmt::Display for ChangeState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The PRD §6 validation-run states: `queued → running → passed | failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ValidationRunState {
    /// The run is queued but not yet started.
    Queued,
    /// The run is executing in its provisioned fastenv instance.
    Running,
    /// The run passed — satisfies the validation gate.
    Passed,
    /// The run failed.
    Failed,
}

impl ValidationRunState {
    /// Every validation-run state.
    pub const ALL: &'static [ValidationRunState] = &[
        ValidationRunState::Queued,
        ValidationRunState::Running,
        ValidationRunState::Passed,
        ValidationRunState::Failed,
    ];

    /// The canonical wire/database string for this validation-run state.
    pub fn as_str(self) -> &'static str {
        match self {
            ValidationRunState::Queued => "queued",
            ValidationRunState::Running => "running",
            ValidationRunState::Passed => "passed",
            ValidationRunState::Failed => "failed",
        }
    }

    /// Parse a validation-run state from its canonical string.
    pub fn parse(s: &str) -> Result<ValidationRunState, ChangeError> {
        ValidationRunState::ALL
            .iter()
            .copied()
            .find(|st| st.as_str() == s)
            .ok_or_else(|| ChangeError::UnknownState(s.to_string()))
    }
}

impl fmt::Display for ValidationRunState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors from the change lifecycle / validation-gate state machine.
#[derive(Debug, Error)]
pub enum ChangeError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The `forge.changes` table does not exist (migration not applied).
    #[error("forge.changes table not found — apply sf-db migration 0004 first")]
    TableMissing,

    /// No change exists with the requested id.
    #[error("change {0} not found")]
    NotFound(Uuid),

    /// A string is not a recognised state vocabulary entry.
    #[error("unknown state '{0}'")]
    UnknownState(String),

    /// The requested transition is not a legal edge in the PRD §6 graph.
    #[error("illegal change transition: {from} → {to}")]
    IllegalTransition {
        /// The current state.
        from: ChangeState,
        /// The rejected target state.
        to: ChangeState,
    },

    /// A merge was attempted without a recorded passing validation run
    /// (PRD Constraint §9, the validation gate).
    #[error("validation gate: a change cannot merge without a passing validation run")]
    ValidationGate,
}

// ---------------------------------------------------------------------------
// Persisted row
// ---------------------------------------------------------------------------

/// A persisted change row read back from `forge.changes`.
#[derive(Debug, Clone)]
pub struct Change {
    /// `forge.changes.id`.
    pub id: Uuid,
    /// Owning workspace.
    pub workspace_id: Uuid,
    /// Human-readable title / summary.
    pub title: String,
    /// Current lifecycle state.
    pub state: ChangeState,
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/// Map a sqlx error to [`ChangeError::TableMissing`] when the `forge.changes`
/// (or `forge.validation_runs`) table is absent, else [`ChangeError::Database`].
fn map_db_err(e: sqlx::Error) -> ChangeError {
    let msg = e.to_string();
    if (msg.contains("forge.changes") || msg.contains("forge.validation_runs"))
        && msg.contains("does not exist")
    {
        ChangeError::TableMissing
    } else {
        ChangeError::Database(e)
    }
}

/// Insert a new change in the `draft` state and return its id.
///
/// # Arguments
///
/// * `pool`         — shared [`sqlx::PgPool`].
/// * `workspace_id` — tenant UUID; must exist in `public.workspaces(id)`.
/// * `title`        — human-readable title / summary of the change.
pub async fn insert_change(
    pool: &PgPool,
    workspace_id: Uuid,
    title: &str,
) -> Result<Uuid, ChangeError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO forge.changes (workspace_id, title, state) \
         VALUES ($1, $2, 'draft') RETURNING id",
    )
    .bind(workspace_id)
    .bind(title)
    .fetch_one(pool)
    .await
    .map_err(map_db_err)?;

    Ok(id)
}

/// Fetch a change by id, returning its current state.
///
/// # Errors
///
/// - [`ChangeError::NotFound`] when no change has that id.
/// - [`ChangeError::TableMissing`] when migration 0004 has not been applied.
pub async fn fetch_change(pool: &PgPool, id: Uuid) -> Result<Change, ChangeError> {
    let row: Option<(Uuid, Uuid, String, String)> =
        sqlx::query_as("SELECT id, workspace_id, title, state FROM forge.changes WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(map_db_err)?;

    match row {
        Some((id, workspace_id, title, state)) => Ok(Change {
            id,
            workspace_id,
            title,
            state: ChangeState::parse(&state)?,
        }),
        None => Err(ChangeError::NotFound(id)),
    }
}

/// Record a validation run for a change in the given state and return its id.
///
/// A `passed` run satisfies the validation gate enforced by
/// [`transition_change`].
pub async fn record_validation_run(
    pool: &PgPool,
    change_id: Uuid,
    state: ValidationRunState,
) -> Result<Uuid, ChangeError> {
    // Resolve the change's workspace so the run is tenant-scoped consistently.
    let workspace_id: Option<Uuid> =
        sqlx::query_scalar("SELECT workspace_id FROM forge.changes WHERE id = $1")
            .bind(change_id)
            .fetch_optional(pool)
            .await
            .map_err(map_db_err)?;

    let workspace_id = workspace_id.ok_or(ChangeError::NotFound(change_id))?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO forge.validation_runs (change_id, workspace_id, state) \
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(change_id)
    .bind(workspace_id)
    .bind(state.as_str())
    .fetch_one(pool)
    .await
    .map_err(map_db_err)?;

    Ok(id)
}

/// Record a per-criterion validation-run verdict for `criterion_node_id` on
/// `change_id` and return the new row's id.
///
/// This is the write side of the per-criterion verdict-row seam (see the
/// module doc comment "Per-criterion verdict-row seam" above): the inserted
/// row's `criterion_node_id` is non-`NULL`, so [`has_passing_validation`]
/// AND-aggregates it with any sibling criterion rows for the same change
/// instead of treating it as a change-level aggregate run.
///
/// `state` should be [`ValidationRunState::Passed`] or
/// [`ValidationRunState::Failed`] — the acceptance-criteria executor
/// (`sf-loop`'s `acceptance` module, issue #861) produces exactly one
/// terminal verdict per criterion, fail-closed on any execution error (a
/// probe that cannot be reached, a missing test runtime, an unprovisioned
/// browser) records `Failed`, never a skip and never `Queued`/`Running`.
///
/// # Errors
///
/// - [`ChangeError::NotFound`] — no change exists with `change_id`.
/// - [`ChangeError::TableMissing`] — migration 0004/0006 not applied.
/// - [`ChangeError::Database`] — any other Postgres error.
pub async fn record_criterion_validation_run(
    pool: &PgPool,
    change_id: Uuid,
    criterion_node_id: Uuid,
    state: ValidationRunState,
) -> Result<Uuid, ChangeError> {
    // Resolve the change's workspace so the run is tenant-scoped consistently
    // (mirrors record_validation_run) and doubles as an existence check.
    let workspace_id: Option<Uuid> =
        sqlx::query_scalar("SELECT workspace_id FROM forge.changes WHERE id = $1")
            .bind(change_id)
            .fetch_optional(pool)
            .await
            .map_err(map_db_err)?;

    let workspace_id = workspace_id.ok_or(ChangeError::NotFound(change_id))?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO forge.validation_runs (change_id, workspace_id, state, criterion_node_id) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(change_id)
    .bind(workspace_id)
    .bind(state.as_str())
    .bind(criterion_node_id)
    .fetch_one(pool)
    .await
    .map_err(map_db_err)?;

    Ok(id)
}

/// Whether a change satisfies the validation gate.
///
/// # Aggregation rule (issue #861)
///
/// - If the change has **no criterion-linked rows** (`criterion_node_id IS
///   NULL` for every row, including "no rows at all"), the pre-#861 behaviour
///   is unchanged: passing iff at least one change-level aggregate run is
///   recorded `passed`.
/// - If the change **has** criterion-linked rows, the gate AND-aggregates:
///   passing iff every distinct `criterion_node_id` recorded for the change
///   has its most-recent row in state `passed`. One failing or errored
///   criterion fails the whole change — this is what lets a mixed
///   pass/fail result block the merge gate even though a passing
///   change-level aggregate run might also exist.
pub async fn has_passing_validation(pool: &PgPool, change_id: Uuid) -> Result<bool, ChangeError> {
    let criterion_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT criterion_node_id FROM forge.validation_runs \
         WHERE change_id = $1 AND criterion_node_id IS NOT NULL",
    )
    .bind(change_id)
    .fetch_all(pool)
    .await
    .map_err(map_db_err)?;

    if criterion_ids.is_empty() {
        // No criteria linked to this change: preserve pre-#861 semantics.
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM forge.validation_runs \
             WHERE change_id = $1 AND state = 'passed' AND criterion_node_id IS NULL",
        )
        .bind(change_id)
        .fetch_one(pool)
        .await
        .map_err(map_db_err)?;

        return Ok(count > 0);
    }

    // Criteria exist: every distinct criterion's most recent row must be
    // 'passed'. One failing/erroring criterion fails the whole change.
    for criterion_node_id in criterion_ids {
        let latest_state: Option<String> = sqlx::query_scalar(
            "SELECT state FROM forge.validation_runs \
             WHERE change_id = $1 AND criterion_node_id = $2 \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(change_id)
        .bind(criterion_node_id)
        .fetch_optional(pool)
        .await
        .map_err(map_db_err)?;

        if latest_state.as_deref() != Some("passed") {
            return Ok(false);
        }
    }

    Ok(true)
}

/// Transition a persisted change to `next`, enforcing the legal-transition
/// graph and the validation gate against the recorded validation runs.
///
/// Reads the change's current state, derives the `has_passing_validation` flag
/// from `forge.validation_runs`, applies [`ChangeState::transition`], and
/// persists the new state on success. Returns the new state.
///
/// # Errors
///
/// - [`ChangeError::NotFound`] — no change with that id.
/// - [`ChangeError::IllegalTransition`] — `current → next` is not legal.
/// - [`ChangeError::ValidationGate`] — `next` is `merged` but the change has no
///   recorded passing validation run.
pub async fn transition_change(
    pool: &PgPool,
    id: Uuid,
    next: ChangeState,
) -> Result<ChangeState, ChangeError> {
    let current = fetch_change(pool, id).await?.state;
    let passing = has_passing_validation(pool, id).await?;

    let new_state = current.transition(next, passing)?;

    sqlx::query("UPDATE forge.changes SET state = $1, updated_at = now() WHERE id = $2")
        .bind(new_state.as_str())
        .bind(id)
        .execute(pool)
        .await
        .map_err(map_db_err)?;

    Ok(new_state)
}

// ---------------------------------------------------------------------------
// Per-criterion verdict-row seam stub (dev-scout #869) — see the module doc
// comment "Per-criterion verdict-row seam" above for the full contract.
// ---------------------------------------------------------------------------

/// The key a per-criterion verdict row is written and read against: a
/// change plus the `AcceptanceCriterion` `nexum.project_nodes.id` it
/// verdicts.
///
/// This is the seam key #861 (writer, via the additive
/// `criterion_node_id` column on `forge.validation_runs`) and #862 (reader,
/// resolving the latest verdict per criterion) both build against. It is a
/// documentation-and-compile-time stub: no migration adds the backing
/// column yet, and nothing in this module persists or queries by this key —
/// #861 wires the write path, #862 the read path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CriterionVerdictKey {
    /// The change (`forge.changes.id`) the verdict belongs to.
    pub change_id: Uuid,
    /// The `AcceptanceCriterion` node (`nexum.project_nodes.id`) the verdict
    /// is for.
    pub criterion_node_id: Uuid,
}

impl CriterionVerdictKey {
    /// Construct a key for a change/criterion pair.
    pub fn new(change_id: Uuid, criterion_node_id: Uuid) -> Self {
        Self {
            change_id,
            criterion_node_id,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── Per-criterion verdict-row seam stub tests (dev-scout #869, no DB) ────

    /// [`CriterionVerdictKey`] compiles, constructs, and compares by value —
    /// the compile-time proof this dev-scout stub pins for #861/#862 to build
    /// against (see the module doc comment "Per-criterion verdict-row seam").
    #[test]
    fn criterion_verdict_key_constructs_and_compares() {
        let change_id = Uuid::new_v4();
        let criterion_node_id = Uuid::new_v4();

        let key = CriterionVerdictKey::new(change_id, criterion_node_id);
        assert_eq!(key.change_id, change_id);
        assert_eq!(key.criterion_node_id, criterion_node_id);

        let same = CriterionVerdictKey::new(change_id, criterion_node_id);
        assert_eq!(
            key, same,
            "keys built from the same pair must compare equal"
        );

        let different = CriterionVerdictKey::new(change_id, Uuid::new_v4());
        assert_ne!(
            key, different,
            "keys for different criteria on the same change must differ"
        );
    }

    // ── Pure state-machine tests (no database) ──────────────────────────────

    /// Acceptance criterion: every PRD §6 Change state exists and round-trips
    /// through its canonical string.
    #[test]
    fn all_prd_change_states_exist() {
        let expected = [
            "draft",
            "validating",
            "awaiting-approval",
            "merged",
            "rejected",
            "abandoned",
        ];
        let actual: Vec<&str> = ChangeState::ALL.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            actual, expected,
            "ChangeState::ALL must list exactly the PRD §6 states in lifecycle order"
        );

        for s in expected {
            let parsed = ChangeState::parse(s).expect("each PRD state must parse");
            assert_eq!(
                parsed.as_str(),
                s,
                "state must round-trip through its string"
            );
        }
    }

    /// Acceptance criterion: an illegal transition returns an error.
    #[test]
    fn illegal_transition_returns_error() {
        // draft → merged skips the whole lifecycle: illegal edge.
        let err = ChangeState::Draft
            .transition(ChangeState::Merged, true)
            .expect_err("draft → merged must be rejected as illegal");
        assert!(
            matches!(err, ChangeError::IllegalTransition { from, to }
                if from == ChangeState::Draft && to == ChangeState::Merged),
            "expected IllegalTransition, got {err:?}"
        );

        // Terminal states have no outgoing edges.
        for terminal in [
            ChangeState::Merged,
            ChangeState::Rejected,
            ChangeState::Abandoned,
        ] {
            assert!(terminal.is_terminal());
            let err = terminal
                .transition(ChangeState::Validating, true)
                .expect_err("terminal states must reject any transition");
            assert!(matches!(err, ChangeError::IllegalTransition { .. }));
        }
    }

    /// The legal happy-path lifecycle is accepted end-to-end (with a passing
    /// validation run on the final merge step).
    #[test]
    fn legal_lifecycle_is_accepted() {
        let s = ChangeState::Draft
            .transition(ChangeState::Validating, false)
            .expect("draft → validating is legal");
        let s = s
            .transition(ChangeState::AwaitingApproval, false)
            .expect("validating → awaiting-approval is legal");
        let s = s
            .transition(ChangeState::Merged, true)
            .expect("awaiting-approval → merged with passing validation is legal");
        assert_eq!(s, ChangeState::Merged);
    }

    /// Acceptance criterion: a change cannot be set to `merged` unless a passing
    /// validation run is recorded — enforced even on an otherwise-legal edge.
    #[test]
    fn merge_blocked_without_passing_validation() {
        let err = ChangeState::AwaitingApproval
            .transition(ChangeState::Merged, false)
            .expect_err("merge without passing validation must be rejected");
        assert!(
            matches!(err, ChangeError::ValidationGate),
            "expected ValidationGate, got {err:?}"
        );

        // The same edge succeeds once a passing validation run is present.
        let ok = ChangeState::AwaitingApproval.transition(ChangeState::Merged, true);
        assert_eq!(
            ok.expect("merge with passing validation must succeed"),
            ChangeState::Merged
        );
    }

    /// Validation-run states cover the full PRD §6 vocabulary and round-trip.
    #[test]
    fn validation_run_states_round_trip() {
        let expected = ["queued", "running", "passed", "failed"];
        let actual: Vec<&str> = ValidationRunState::ALL.iter().map(|s| s.as_str()).collect();
        assert_eq!(actual, expected);
        for s in expected {
            assert_eq!(ValidationRunState::parse(s).unwrap().as_str(), s);
        }
        assert!(ValidationRunState::parse("bogus").is_err());
    }

    // ── Integration tests (require DATABASE_URL) ────────────────────────────

    /// Integration test: a change persists in `draft`, and a transition to
    /// `merged` is blocked until a `passed` validation run is recorded, after
    /// which it succeeds.
    ///
    /// Requires `DATABASE_URL` + `WORKSPACE_ID` with sf-db migrations applied.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with sf-db migration 0004 applied"]
    async fn change_merge_requires_passing_validation_run() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");
        let workspace_id: Uuid = std::env::var("WORKSPACE_ID")
            .expect("WORKSPACE_ID must be set")
            .parse()
            .expect("WORKSPACE_ID must be a UUID");

        let id = insert_change(&pool, workspace_id, "Test change for merge gate")
            .await
            .expect("insert_change failed");

        let change = fetch_change(&pool, id).await.expect("fetch_change failed");
        assert_eq!(change.state, ChangeState::Draft);

        // Walk to awaiting-approval.
        transition_change(&pool, id, ChangeState::Validating)
            .await
            .expect("draft → validating failed");
        transition_change(&pool, id, ChangeState::AwaitingApproval)
            .await
            .expect("validating → awaiting-approval failed");

        // Merge is blocked: no passing validation run yet.
        let blocked = transition_change(&pool, id, ChangeState::Merged).await;
        assert!(
            matches!(blocked, Err(ChangeError::ValidationGate)),
            "merge must be blocked without a passing run, got {blocked:?}"
        );

        // Record a passing validation run, then merge succeeds.
        record_validation_run(&pool, id, ValidationRunState::Passed)
            .await
            .expect("record_validation_run failed");
        let merged = transition_change(&pool, id, ChangeState::Merged)
            .await
            .expect("merge with passing validation must succeed");
        assert_eq!(merged, ChangeState::Merged);

        // Cleanup.
        sqlx::query("DELETE FROM forge.validation_runs WHERE change_id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM forge.changes WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .ok();
    }
}

// ---------------------------------------------------------------------------
// Per-criterion verdict-row + validation-gate AND-aggregation tests
// (issue #861). Named `validation` (not nested under `mod tests`) so the
// full test path — `change::validation::<name>` — contains the literal
// `validation::` substring the issue's acceptance criteria name as the
// nextest selector.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod validation {
    use super::*;

    /// Integration test: per-criterion verdict rows round-trip through
    /// [`record_criterion_validation_run`] — one row per criterion, each
    /// carrying its own `criterion_node_id` and `state`, distinct from the
    /// change-level aggregate rows [`record_validation_run`] writes.
    ///
    /// Requires `DATABASE_URL` + `WORKSPACE_ID` with sf-db migrations 0004
    /// and 0006 applied.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with sf-db migration 0004+0006 applied"]
    async fn criterion_validation_run_round_trips() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");
        let workspace_id: Uuid = std::env::var("WORKSPACE_ID")
            .expect("WORKSPACE_ID must be set")
            .parse()
            .expect("WORKSPACE_ID must be a UUID");

        let change_id = insert_change(&pool, workspace_id, "Change for criterion round-trip test")
            .await
            .expect("insert_change failed");

        let criterion_a = Uuid::new_v4();
        let criterion_b = Uuid::new_v4();

        record_criterion_validation_run(&pool, change_id, criterion_a, ValidationRunState::Passed)
            .await
            .expect("record_criterion_validation_run (a) failed");
        record_criterion_validation_run(&pool, change_id, criterion_b, ValidationRunState::Failed)
            .await
            .expect("record_criterion_validation_run (b) failed");

        let rows: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT criterion_node_id, state FROM forge.validation_runs \
             WHERE change_id = $1 AND criterion_node_id IS NOT NULL \
             ORDER BY created_at ASC",
        )
        .bind(change_id)
        .fetch_all(&pool)
        .await
        .expect("select criterion rows failed");

        assert_eq!(rows.len(), 2, "expected exactly one row per criterion");
        assert_eq!(rows[0], (criterion_a, "passed".to_string()));
        assert_eq!(rows[1], (criterion_b, "failed".to_string()));

        // Cleanup.
        sqlx::query("DELETE FROM forge.validation_runs WHERE change_id = $1")
            .bind(change_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM forge.changes WHERE id = $1")
            .bind(change_id)
            .execute(&pool)
            .await
            .ok();
    }

    /// Acceptance criterion (#861): a mixed result — one passing and one
    /// failing criterion — leaves the change's validation gate failed:
    /// [`has_passing_validation`] returns `false` and
    /// [`ChangeState::transition`] (via [`transition_change`]) rejects the
    /// `awaiting-approval -> merged` edge with [`ChangeError::ValidationGate`],
    /// even though a change-level `passed` aggregate row is NOT present and
    /// even if one criterion did pass.
    ///
    /// Requires `DATABASE_URL` + `WORKSPACE_ID` with sf-db migrations 0004
    /// and 0006 applied.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with sf-db migration 0004+0006 applied"]
    async fn failing_criterion_blocks_merge_gate() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");
        let workspace_id: Uuid = std::env::var("WORKSPACE_ID")
            .expect("WORKSPACE_ID must be set")
            .parse()
            .expect("WORKSPACE_ID must be a UUID");

        let change_id = insert_change(&pool, workspace_id, "Change for mixed-criteria gate test")
            .await
            .expect("insert_change failed");

        // Walk to awaiting-approval (mirrors change_merge_requires_passing_validation_run).
        transition_change(&pool, change_id, ChangeState::Validating)
            .await
            .expect("draft → validating failed");
        transition_change(&pool, change_id, ChangeState::AwaitingApproval)
            .await
            .expect("validating → awaiting-approval failed");

        // One passing, one failing criterion.
        let passing_criterion = Uuid::new_v4();
        let failing_criterion = Uuid::new_v4();
        record_criterion_validation_run(
            &pool,
            change_id,
            passing_criterion,
            ValidationRunState::Passed,
        )
        .await
        .expect("record passing criterion failed");
        record_criterion_validation_run(
            &pool,
            change_id,
            failing_criterion,
            ValidationRunState::Failed,
        )
        .await
        .expect("record failing criterion failed");

        let passing = has_passing_validation(&pool, change_id)
            .await
            .expect("has_passing_validation failed");
        assert!(
            !passing,
            "one failing criterion must fail the whole change's validation gate"
        );

        let blocked = transition_change(&pool, change_id, ChangeState::Merged).await;
        assert!(
            matches!(blocked, Err(ChangeError::ValidationGate)),
            "merge must be blocked while any criterion is failing, got {blocked:?}"
        );

        // Now make the failing criterion pass (a later re-run superseding the
        // failed one) — the gate must open once every distinct criterion's
        // most recent row is 'passed'.
        record_criterion_validation_run(
            &pool,
            change_id,
            failing_criterion,
            ValidationRunState::Passed,
        )
        .await
        .expect("record corrected criterion failed");

        let now_passing = has_passing_validation(&pool, change_id)
            .await
            .expect("has_passing_validation failed");
        assert!(
            now_passing,
            "gate must open once every distinct criterion's latest row is passed"
        );
        let merged = transition_change(&pool, change_id, ChangeState::Merged)
            .await
            .expect("merge must succeed once every criterion passes");
        assert_eq!(merged, ChangeState::Merged);

        // Cleanup.
        sqlx::query("DELETE FROM forge.validation_runs WHERE change_id = $1")
            .bind(change_id)
            .execute(&pool)
            .await
            .ok();
        sqlx::query("DELETE FROM forge.changes WHERE id = $1")
            .bind(change_id)
            .execute(&pool)
            .await
            .ok();
    }
}
