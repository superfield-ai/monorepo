//! Shared Postgres connection pool and typed config for Superfield component crates.
//!
//! All component crates (Sharp, Nexum, auth, etc.) acquire database connections
//! through this crate. One pool, one Postgres instance — components do not
//! provision their own database access.
//!
//! # Architecture
//!
//! - [`DbConfig`]: typed configuration loaded once from the environment.
//! - [`connect`]: builds a `sqlx::PgPool` from a [`DbConfig`].
//! - [`acquire_workspace`]: acquires a pooled connection and sets
//!   `app.current_principal_id` via `SET LOCAL` so that per-schema RLS
//!   policies can reference it via `current_setting('app.current_principal_id')`.
//! - [`acquire_with_workspace_id`]: preferred helper for issue #429 callers —
//!   sets both `app.workspace_id` and `app.current_principal_id` from a typed
//!   [`uuid::Uuid`].
//! - [`backup::SubstrateBackup`]: seam interface for recording backup events.
//!   RPO ≤ 5 min, RTO ≤ 15 min — see `docs/architecture.md` §Substrate Reliability.
//! - [`provisioner::PostgresProvisioner`]: seam interface for starting and
//!   stopping the local Postgres container (daemon lifecycle — issue #489).
//!   No-op stub: [`provisioner::TestProvisioner`].
//! - [`migrate::run_migrations`]: in-process migration runner that applies all
//!   component schemas in dependency order against the live instance — called
//!   after the Postgres health gate passes and before the HTTP server binds
//!   (issue #670). Mirrors `packages/db/migrator.ts` so both runners are
//!   interchangeable against the same database.
//! - [`change`]: the Change lifecycle and validation-gate state machine (issue
//!   #707). [`change::ChangeState`] models the PRD §6 lifecycle
//!   (`draft → validating → awaiting-approval → merged | rejected | abandoned`)
//!   with a pure legal-transition table, and [`change::transition_change`]
//!   enforces the validation gate (a change cannot reach `merged` without a
//!   recorded passing `forge.validation_runs` row). Backed by
//!   `crates/sf-db/migrations/0004_change_lifecycle.sql` (`forge` schema).
//!   [`change::CriterionVerdictKey`] is a dev-scout stub (issue #869) pinning
//!   the additive per-criterion verdict-row seam #861 (writer) and #862
//!   (reader) build against — documentation and a compile-time key only, no
//!   migration or behavior change yet.
//! - [`policy`]: the policy engine for autonomous-versus-approval governance
//!   (issue #716). [`policy::PolicyState`] models the PRD §6 policy lifecycle
//!   (`drafted → active → revised → retired`) with a pure legal-transition
//!   table, and [`policy::evaluate_change_against_active_policy`] is the merge
//!   gate: it consults the workspace's single `active` policy and decides
//!   autonomous-ship versus approval-required for a change's risk (PRD US4,
//!   Constraint §9). Backed by `crates/sf-db/migrations/0005_policy_engine.sql`
//!   (`forge` schema).
//! - [`page_revision::insert_page_revision`]: write entrypoint for the
//!   gardening loop page-revision path (issues #490, #491). Inserts a row
//!   into `nexum.page_revisions` with the rendered content and provenance tag.
//! - [`page_query::fetch_page_content`]: read projection for the pages layer
//!   (issue #492). Queries the latest Nexum document_version for a named page
//!   and renders blocks as markdown.
//! - [`project_graph`]: project management graph write and read paths (issue
//!   #493). Typed nodes (Issue, Feature, RequiredTest, AcceptanceCriterion,
//!   PullRequest) stored in `nexum.project_nodes`; edges in `nexum.links`
//!   with `project:` prefixed `rel_type` values; recursive CTE traversal for
//!   the `GET /pages/project` read path. [`project_graph::AssertionKind`] /
//!   [`project_graph::AssertionSpec`] are a dev-scout stub (issue #869) pinning
//!   the executable-acceptance-criteria assertion schema shape (docs/eval-design.md)
//!   for #860 to wire into a real write path and migration; no-op today —
//!   [`project_graph::insert_acceptance_criterion`] is unchanged.
//! - [`runtime_signal::fetch_recent_runtime_signals`]: read projection over
//!   `sharp.runtime_signals` (issue #709). Lets the gardening loop's
//!   intent-to-spec inference step consume behavioral traces without depending
//!   on the `sharp` crate. Returns an empty vector when the signals table is
//!   absent so the step cleanly no-ops on a pre-signals substrate.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

pub mod backup;
pub mod change;
pub mod config;
pub mod migrate;
pub mod page_query;
pub mod page_revision;
pub mod policy;
pub mod pool;
pub mod project_graph;
pub mod provisioner;
pub mod runtime_signal;

pub use backup::{
    pg_basebackup_args, wal_archive_command_template, BackupError, BackupEvent, BackupOutcome,
    NoopSubstrateBackup, PgBackup, SubstrateBackup,
};
pub use change::{
    fetch_change, has_passing_validation, insert_change, record_validation_run, transition_change,
    Change, ChangeError, ChangeState, CriterionVerdictKey, ValidationRunState,
};
pub use config::DbConfig;
pub use migrate::{
    apply_migrations, discover_migrations, repo_root, run_migrations, Migration, MigrationError,
};
pub use page_query::{fetch_page_content, PageQueryError, KNOWN_PAGES};
pub use page_revision::{insert_page_revision, PageRevisionError};
pub use policy::{
    evaluate_change_against_active_policy, fetch_active_policy, fetch_policy, insert_policy,
    transition_policy, MergeDecision, Policy, PolicyError, PolicyState, RiskLevel,
};
pub use pool::{acquire_with_workspace_id, acquire_workspace, connect};
pub use project_graph::{
    fetch_project_page, insert_acceptance_criterion, insert_feature, insert_issue,
    insert_required_test, link_pr_to_issue, list_nodes, traverse_project_graph, update_node,
    validate_assertion_spec, AssertionKind, AssertionSpec, HttpProbeParams, PlaywrightParams,
    ProjectGraphError, ProjectNode, RequiredTestParams, NODE_STATES, PROJECT_GRAPH_DOC_TITLE,
};
pub use provisioner::{
    FailingProvisioner, LocalPostgresProvisioner, PostgresProvisioner, ProvisionerError,
    TestProvisioner,
};
pub use runtime_signal::{fetch_recent_runtime_signals, RuntimeSignalError, RuntimeSignalSummary};
