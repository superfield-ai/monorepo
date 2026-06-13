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
//! - [`page_revision::insert_page_revision`]: write entrypoint for the
//!   gardening loop page-revision path (issues #490, #491). Stub returns
//!   `Ok(())` until the real INSERT is implemented.
//! - [`page_query::fetch_page_content`]: read projection for the pages layer
//!   (issue #492). Queries the latest Nexum document_version for a named page
//!   and renders blocks as markdown.
//! - [`project_graph`]: project management graph write and read paths (issue
//!   #493). Typed nodes (Issue, Feature, RequiredTest, AcceptanceCriterion,
//!   PullRequest) stored in `nexum.project_nodes`; edges in `nexum.links`
//!   with `project:` prefixed `rel_type` values; recursive CTE traversal for
//!   the `GET /pages/project` read path.
//!
//! See `docs/architecture.md` §Single-Instance Database Schema Layout.

pub mod backup;
pub mod config;
pub mod page_query;
pub mod page_revision;
pub mod pool;
pub mod project_graph;
pub mod provisioner;

pub use backup::{
    pg_basebackup_args, wal_archive_command_template, BackupError, BackupEvent, BackupOutcome,
    NoopSubstrateBackup, PgBackup, SubstrateBackup,
};
pub use config::DbConfig;
pub use page_query::{fetch_page_content, PageQueryError, KNOWN_PAGES};
pub use page_revision::{insert_page_revision, PageRevisionError};
pub use pool::{acquire_with_workspace_id, acquire_workspace, connect};
pub use project_graph::{
    fetch_project_page, insert_acceptance_criterion, insert_feature, insert_issue,
    insert_required_test, link_pr_to_issue, traverse_project_graph, ProjectGraphError,
    ProjectNode, PROJECT_GRAPH_DOC_TITLE,
};
pub use provisioner::{PostgresProvisioner, ProvisionerError, TestProvisioner};
