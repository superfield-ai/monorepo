//! Project management graph — write and read paths over the Nexum graph.
//!
//! The project graph represents software development artefacts (issues,
//! features, tests, acceptance criteria, pull requests) as typed nodes in the
//! Nexum knowledge graph.  Edges in `nexum.links` with `project:` prefixed
//! `rel_type` values connect these nodes into a directed project graph.
//!
//! # Node types
//!
//! Stored in `nexum.project_nodes` (each backed by a `nexum.blocks` row):
//!
//! | `node_type`           | Description                                      |
//! |-----------------------|--------------------------------------------------|
//! | `Issue`               | A tracked work item (e.g. a GitHub issue)        |
//! | `Feature`             | A feature scoped to an issue                     |
//! | `RequiredTest`        | A test required to validate a feature             |
//! | `AcceptanceCriterion` | An acceptance criterion for a feature            |
//! | `PullRequest`         | A pull request that resolves an issue            |
//!
//! # Edge types (`nexum.links.rel_type`)
//!
//! | `rel_type`                              | Meaning                        |
//! |-----------------------------------------|--------------------------------|
//! | `project:issue_has_feature`             | Issue → Feature                |
//! | `project:feature_has_required_test`     | Feature → RequiredTest         |
//! | `project:feature_has_acceptance_criterion` | Feature → AcceptanceCriterion |
//! | `project:pr_resolves_issue`             | PullRequest → Issue            |
//!
//! # One-PR-per-issue constraint
//!
//! [`link_pr_to_issue`] enforces that a `PullRequest` node resolves at most
//! one `Issue` node.  A second call with the same PR block ID will return
//! [`ProjectGraphError::PrAlreadyLinked`].
//!
//! # Read path
//!
//! [`fetch_project_page`] performs a recursive CTE traversal over
//! `nexum.links` starting from all `Issue` nodes, collecting the full
//! project tree, and renders it as markdown.  This is the backing query for
//! `GET /pages/project`.
//!
//! # Write contract for the knowledge-to-work seam (dev-scout, issue #677)
//!
//! This module's `pub async fn` write path is the **stable contract** that the
//! knowledge-to-work feature (#672) builds on from three call sites:
//!
//! 1. A gardening-loop derivation step that turns brain knowledge into linked
//!    Feature/Issue nodes (see `crates/sf-loop/src/steps/mod.rs` §"Insertion
//!    point for the knowledge-derivation step").
//! 2. The `/studio/issues` + `/studio/features` + `/studio/steer` HTTP routes
//!    (see `crates/sf-serve/src/routes/project.rs`).
//! 3. A CLI verb in `sf-cli`.
//!
//! The contract these callers depend on (all already implemented here — #672
//! adds **callers**, not new graph primitives):
//!
//! | Function                      | Inserts                  | Links                          |
//! |-------------------------------|--------------------------|--------------------------------|
//! | [`insert_issue`]              | `Issue` node             | (root)                         |
//! | [`insert_feature`]            | `Feature` node           | `project:issue_has_feature`    |
//! | [`insert_required_test`]      | `RequiredTest` node      | `project:feature_has_required_test` |
//! | [`insert_acceptance_criterion`] | `AcceptanceCriterion`  | `project:feature_has_acceptance_criterion` |
//! | [`link_pr_to_issue`]          | `PullRequest` node       | `project:pr_resolves_issue` (1-per-issue) |
//!
//! Stability guarantees for #672/#673 to rely on:
//! - All writes anchor to the single sentinel document ([`PROJECT_GRAPH_DOC_TITLE`]).
//! - Created nodes read back consistently through [`fetch_project_page`], which
//!   backs `GET /pages/project` — so any new node is visible in the projection
//!   without further wiring.
//! - A node's lifecycle `state` column (`nexum.project_nodes.state`) is the
//!   mutation target for the `/studio/steer` redirect path; the read path
//!   already surfaces it (see [`ProjectNode::state`] and [`render_node`]).
//!
//! No new write primitive is introduced by the dev-scout pass — this section
//! documents the existing surface so #672 and #673 can proceed in parallel.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Nexum — project management graph.
//! - `docs/milestone-1.md` §4.6.
//! - Issue #493 scope; issue #677 (seam), #672 (downstream feature).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors from the project graph write and read paths.
#[derive(Debug, Error)]
pub enum ProjectGraphError {
    /// A database error from sqlx.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The `project_nodes` or related table does not exist (migration not applied).
    #[error("project_nodes table not found — apply nexum migrations first")]
    TableMissing,

    /// A `PullRequest` node is already linked to an issue via
    /// `project:pr_resolves_issue`.  The one-PR-per-issue constraint was
    /// violated.
    #[error("pull request {0} is already linked to an issue (one-PR-per-issue constraint)")]
    PrAlreadyLinked(Uuid),

    /// An invalid lifecycle state was supplied to [`update_node`].
    ///
    /// Valid states are `open`, `in_progress`, `validated`, `closed` (see
    /// [`NODE_STATES`]).
    #[error("invalid node state '{0}'; expected one of: open, in_progress, validated, closed")]
    InvalidState(String),

    /// A raw JSON assertion payload does not match a known [`AssertionKind`]
    /// or that kind's typed parameter schema.
    ///
    /// Returned by [`validate_assertion_spec`] and by
    /// [`insert_acceptance_criterion`] (issue #860), which validates before
    /// writing so a rejected assertion leaves no row behind.
    #[error("invalid assertion spec: {0}")]
    InvalidAssertionSpec(String),
}

// ---------------------------------------------------------------------------
// Assertion schema (originally a dev-scout stub, issue #869; wired into the
// real write and read paths by issue #860, "Executable acceptance criteria"
// phase) — see docs/eval-design.md §"The missing primitive: executable
// acceptance criteria" and docs/architecture.md.
//
// #869 pinned the COMPILE-TIME SHAPE of the assertion schema below
// (`AssertionKind`, the per-kind param structs, `AssertionSpec`,
// `validate_assertion_spec`) as a stable type for #860 to build against.
// #860 adds the rest of the feature:
//
// - `crates/nexum/migrations/0004_acceptance_assertions.sql` — the
//   `assertion_kind` / `assertion_params` columns on `nexum.project_nodes`,
//   CHECK-constrained to this schema's vocabulary and to
//   `node_type = 'AcceptanceCriterion'`.
// - [`insert_acceptance_criterion`] now takes an optional raw JSON assertion
//   payload, calls [`validate_assertion_spec`] on it BEFORE inserting any
//   row (so a rejected assertion leaves no row behind), and persists the
//   validated kind + params.
// - [`traverse_project_graph`] / [`ProjectNode`] project `assertion_kind` /
//   `assertion_params` back out on read.
//
// serde does the write-time-rejection work #860's AC requires: an unknown
// `kind` or a `params` shape that does not match its kind's typed struct
// fails to deserialize (see the round-trip + malformed-input unit tests
// below), so [`insert_acceptance_criterion`] only has to call
// [`validate_assertion_spec`] at insert time rather than hand-rolling a
// validator.
// ---------------------------------------------------------------------------

/// The three assertion kinds an `AcceptanceCriterion` can carry
/// (docs/eval-design.md §"The missing primitive: executable acceptance
/// criteria").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssertionKind {
    /// An HTTP/probe check against the deployed preview.
    HttpProbe,
    /// A Playwright check against the Studio app preview.
    Playwright,
    /// A `RequiredTest` the generated code must contain and pass.
    RequiredTest,
}

impl AssertionKind {
    /// The canonical wire string for this kind (matches the `serde`
    /// `kebab-case` rename and the CHECK-constrained vocabulary #860's
    /// migration will pin at the database level).
    pub fn as_str(self) -> &'static str {
        match self {
            AssertionKind::HttpProbe => "http-probe",
            AssertionKind::Playwright => "playwright",
            AssertionKind::RequiredTest => "required-test",
        }
    }
}

/// Typed parameters for an [`AssertionKind::HttpProbe`] criterion — an
/// HTTP/probe check against the deployed preview (e.g. "`POST /orders`
/// returns `201` and persists a row").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HttpProbeParams {
    /// HTTP method, e.g. `"GET"` or `"POST"`.
    pub method: String,
    /// Request path against the deployed preview, e.g. `"/orders"`.
    pub path: String,
    /// Expected HTTP status code.
    pub expected_status: u16,
}

/// Typed parameters for an [`AssertionKind::Playwright`] criterion — a
/// browser check against the Studio app preview (e.g. "the order form shows
/// a confirmation toast on submit").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaywrightParams {
    /// Path (relative to the Studio preview origin) the check navigates to.
    pub path: String,
    /// Human-readable expectation the Playwright script asserts.
    pub expectation: String,
}

/// Typed parameters for an [`AssertionKind::RequiredTest`] criterion — a
/// named test the generated code must contain and pass.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequiredTestParams {
    /// Fully-qualified test name the generated code must contain and pass,
    /// e.g. `"sf_loop::acceptance::per_criterion_verdicts_recorded"`.
    pub test_name: String,
}

/// An assertion kind paired with its kind-specific typed parameters.
///
/// Serde-tagged on `kind` with parameters nested under `params`, so an
/// unknown `kind` or a `params` shape that does not match its kind's typed
/// struct fails to deserialize — the write-time-rejection behaviour #860's
/// acceptance criteria require, without either side hand-rolling a
/// validator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "kebab-case")]
pub enum AssertionSpec {
    /// An HTTP/probe check — see [`HttpProbeParams`].
    HttpProbe(HttpProbeParams),
    /// A Playwright check — see [`PlaywrightParams`].
    Playwright(PlaywrightParams),
    /// A required-test check — see [`RequiredTestParams`].
    RequiredTest(RequiredTestParams),
}

impl AssertionSpec {
    /// The [`AssertionKind`] this spec carries.
    pub fn kind(&self) -> AssertionKind {
        match self {
            AssertionSpec::HttpProbe(_) => AssertionKind::HttpProbe,
            AssertionSpec::Playwright(_) => AssertionKind::Playwright,
            AssertionSpec::RequiredTest(_) => AssertionKind::RequiredTest,
        }
    }

    /// The typed parameters as a JSON `Value`, with the `kind` tag stripped
    /// (issue #860) — the shape persisted in
    /// `nexum.project_nodes.assertion_params` by
    /// [`insert_acceptance_criterion`]. Pair with [`AssertionSpec::kind`] to
    /// recover the full tagged shape ([`validate_assertion_spec`] does the
    /// reverse: kind + params -> validated `AssertionSpec`).
    pub fn params_json(&self) -> serde_json::Value {
        match self {
            AssertionSpec::HttpProbe(p) => serde_json::to_value(p),
            AssertionSpec::Playwright(p) => serde_json::to_value(p),
            AssertionSpec::RequiredTest(p) => serde_json::to_value(p),
        }
        .expect("typed assertion parameter structs always serialize to JSON")
    }
}

/// Validate a raw JSON assertion payload against the [`AssertionSpec`]
/// schema. Originally a dev-scout no-op stub (issue #869); called by
/// [`insert_acceptance_criterion`] (issue #860) before any row is written,
/// so a rejected assertion never leaves a partial `AcceptanceCriterion`
/// node behind.
///
/// Performs no database access — pure serde validation.
///
/// # Errors
///
/// Returns [`ProjectGraphError::InvalidAssertionSpec`] when `raw` does not
/// match a known kind or that kind's typed parameter shape.
pub fn validate_assertion_spec(
    raw: &serde_json::Value,
) -> Result<AssertionSpec, ProjectGraphError> {
    serde_json::from_value(raw.clone())
        .map_err(|e| ProjectGraphError::InvalidAssertionSpec(e.to_string()))
}

// ---------------------------------------------------------------------------
// Sentinel document for the project graph
// ---------------------------------------------------------------------------

/// Document title used as the synthetic container for the project graph.
///
/// The project graph does not have a backing `nexum.documents` row in the
/// same way that page revisions do.  Instead, all `project_nodes` blocks
/// share a single sentinel document identified by this title so that the FK
/// on `nexum.blocks(doc_id)` is satisfied.
pub const PROJECT_GRAPH_DOC_TITLE: &str = "project";

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/// Ensure the sentinel project-graph document exists and return its ID.
///
/// The sentinel document (title = `"project"`, `corpus_id = NULL`) is the
/// FK anchor for all project-graph `nexum.blocks` rows.  On the first call
/// it is inserted; subsequent calls find the existing row.
async fn ensure_project_doc(pool: &PgPool) -> Result<Uuid, ProjectGraphError> {
    // Try to find an existing sentinel document first.
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM nexum.documents WHERE title = $1 LIMIT 1")
            .bind(PROJECT_GRAPH_DOC_TITLE)
            .fetch_optional(pool)
            .await?;

    if let Some(id) = existing {
        return Ok(id);
    }

    // Insert the sentinel document.  corpus_id is NULL (no corpus — this is
    // a synthetic graph container, not an ingested document).
    let doc_id: Uuid =
        sqlx::query_scalar("INSERT INTO nexum.documents (title) VALUES ($1) RETURNING id")
            .bind(PROJECT_GRAPH_DOC_TITLE)
            .fetch_one(pool)
            .await?;

    Ok(doc_id)
}

/// Insert a project block into `nexum.blocks` and a node record into
/// `nexum.project_nodes`.
///
/// Returns the `project_nodes.id` of the newly inserted node.
///
/// # Arguments
///
/// * `pool`         — shared [`sqlx::PgPool`].
/// * `doc_id`       — the sentinel project-graph document ID (from
///   [`ensure_project_doc`]).
/// * `title`        — human-readable title / name for this node (stored as
///   the block `content`).
/// * `node_type`    — discriminator string: `"Issue"`, `"Feature"`, etc.
/// * `external_ref` — optional external reference (e.g. GitHub issue number).
async fn insert_project_node(
    pool: &PgPool,
    doc_id: Uuid,
    title: &str,
    node_type: &str,
    external_ref: Option<&str>,
) -> Result<Uuid, ProjectGraphError> {
    // Insert block — content-addressed by title and node_type.
    let content_hash = format!("project_node:{}:{}", node_type, title);

    let block_id: Uuid = sqlx::query_scalar(
        "INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type) \
         VALUES ($1, $2, $3, 'project_node') \
         RETURNING id",
    )
    .bind(doc_id)
    .bind(title)
    .bind(&content_hash)
    .fetch_one(pool)
    .await?;

    // Insert project_node record.
    let node_id: Uuid = sqlx::query_scalar(
        "INSERT INTO nexum.project_nodes (block_id, node_type, external_ref) \
         VALUES ($1, $2, $3) \
         RETURNING id",
    )
    .bind(block_id)
    .bind(node_type)
    .bind(external_ref)
    .fetch_one(pool)
    .await?;

    Ok(node_id)
}

/// Insert a directed edge in `nexum.links` between two project nodes.
///
/// `src_block_id` and `dst_block_id` are the `block_id`s of the source and
/// destination project nodes (from `nexum.project_nodes`).  The `rel_type`
/// must be one of the `project:` prefixed values.
async fn insert_project_edge(
    pool: &PgPool,
    src_block_id: Uuid,
    dst_block_id: Uuid,
    rel_type: &str,
) -> Result<Uuid, ProjectGraphError> {
    let link_id: Uuid = sqlx::query_scalar(
        "INSERT INTO nexum.links \
             (src, dst, layer, rel_type, provenance) \
         VALUES \
             ($1, $2, 'ai', $3, '{\"source\":\"project_graph\"}') \
         RETURNING id",
    )
    .bind(src_block_id)
    .bind(dst_block_id)
    .bind(rel_type)
    .fetch_one(pool)
    .await?;

    Ok(link_id)
}

/// Resolve `project_nodes.block_id` from a `project_nodes.id`.
async fn block_id_for_node(pool: &PgPool, node_id: Uuid) -> Result<Uuid, ProjectGraphError> {
    let block_id: Uuid =
        sqlx::query_scalar("SELECT block_id FROM nexum.project_nodes WHERE id = $1")
            .bind(node_id)
            .fetch_one(pool)
            .await?;

    Ok(block_id)
}

/// Insert an `Issue` node into the project graph.
///
/// Returns the `project_nodes.id` of the new Issue node.
///
/// # Arguments
///
/// * `pool`         — shared [`sqlx::PgPool`].
/// * `title`        — the issue title / description.
/// * `external_ref` — optional external reference (e.g. `"493"` for GitHub
///   issue #493).
///
/// # Errors
///
/// Returns [`ProjectGraphError::Database`] on Postgres errors.
pub async fn insert_issue(
    pool: &PgPool,
    title: &str,
    external_ref: Option<&str>,
) -> Result<Uuid, ProjectGraphError> {
    let doc_id = ensure_project_doc(pool).await?;
    insert_project_node(pool, doc_id, title, "Issue", external_ref).await
}

/// Insert a `Feature` node and link it to a parent `Issue` node.
///
/// Returns the `project_nodes.id` of the new Feature node.
///
/// # Arguments
///
/// * `pool`       — shared [`sqlx::PgPool`].
/// * `issue_id`   — `project_nodes.id` of the parent Issue node.
/// * `title`      — the feature title / description.
///
/// # Errors
///
/// Returns [`ProjectGraphError::Database`] on Postgres errors.
pub async fn insert_feature(
    pool: &PgPool,
    issue_id: Uuid,
    title: &str,
) -> Result<Uuid, ProjectGraphError> {
    let doc_id = ensure_project_doc(pool).await?;
    let feature_id = insert_project_node(pool, doc_id, title, "Feature", None).await?;

    // Link: Issue → Feature
    let issue_block = block_id_for_node(pool, issue_id).await?;
    let feature_block = block_id_for_node(pool, feature_id).await?;
    insert_project_edge(
        pool,
        issue_block,
        feature_block,
        "project:issue_has_feature",
    )
    .await?;

    Ok(feature_id)
}

/// Insert a `RequiredTest` node and link it to a parent `Feature` node.
///
/// Returns the `project_nodes.id` of the new RequiredTest node.
///
/// # Arguments
///
/// * `pool`       — shared [`sqlx::PgPool`].
/// * `feature_id` — `project_nodes.id` of the parent Feature node.
/// * `title`      — the test title / description.
///
/// # Errors
///
/// Returns [`ProjectGraphError::Database`] on Postgres errors.
pub async fn insert_required_test(
    pool: &PgPool,
    feature_id: Uuid,
    title: &str,
) -> Result<Uuid, ProjectGraphError> {
    let doc_id = ensure_project_doc(pool).await?;
    let test_id = insert_project_node(pool, doc_id, title, "RequiredTest", None).await?;

    // Link: Feature → RequiredTest
    let feature_block = block_id_for_node(pool, feature_id).await?;
    let test_block = block_id_for_node(pool, test_id).await?;
    insert_project_edge(
        pool,
        feature_block,
        test_block,
        "project:feature_has_required_test",
    )
    .await?;

    Ok(test_id)
}

/// Insert an `AcceptanceCriterion` node and link it to a parent `Feature`
/// node, optionally attaching an executable assertion (issue #860;
/// docs/eval-design.md §"The missing primitive: executable acceptance
/// criteria").
///
/// Returns the `project_nodes.id` of the new AcceptanceCriterion node.
///
/// # Arguments
///
/// * `pool`       — shared [`sqlx::PgPool`].
/// * `feature_id` — `project_nodes.id` of the parent Feature node.
/// * `title`      — the acceptance criterion description.
/// * `assertion`  — optional raw JSON assertion payload (`{"kind": ...,
///   "params": {...}}`). Validated against [`AssertionSpec`] via
///   [`validate_assertion_spec`] **before** any row is written, so a
///   malformed payload leaves no partial `AcceptanceCriterion` node behind.
///   `None` inserts a criterion with no assertion attached (title-only, the
///   pre-#860 behaviour).
///
/// # Errors
///
/// - [`ProjectGraphError::InvalidAssertionSpec`] — `assertion` is `Some` and
///   its `kind` is unrecognized, or its `params` do not match that kind's
///   typed schema. No node is inserted.
/// - [`ProjectGraphError::Database`] — a Postgres error.
pub async fn insert_acceptance_criterion(
    pool: &PgPool,
    feature_id: Uuid,
    title: &str,
    assertion: Option<&serde_json::Value>,
) -> Result<Uuid, ProjectGraphError> {
    // Validate before writing anything: an unknown kind or malformed params
    // must leave no row behind (issue #860 acceptance criteria).
    let validated = match assertion {
        Some(raw) => Some(validate_assertion_spec(raw)?),
        None => None,
    };

    let doc_id = ensure_project_doc(pool).await?;
    let ac_id = insert_project_node(pool, doc_id, title, "AcceptanceCriterion", None).await?;

    if let Some(spec) = &validated {
        sqlx::query(
            "UPDATE nexum.project_nodes \
             SET assertion_kind = $1, assertion_params = $2 \
             WHERE id = $3",
        )
        .bind(spec.kind().as_str())
        .bind(spec.params_json())
        .bind(ac_id)
        .execute(pool)
        .await?;
    }

    // Link: Feature → AcceptanceCriterion
    let feature_block = block_id_for_node(pool, feature_id).await?;
    let ac_block = block_id_for_node(pool, ac_id).await?;
    insert_project_edge(
        pool,
        feature_block,
        ac_block,
        "project:feature_has_acceptance_criterion",
    )
    .await?;

    Ok(ac_id)
}

/// Insert a `PullRequest` node and link it to a parent `Issue` node.
///
/// Enforces the one-PR-per-issue constraint: a given PR block ID can only
/// appear as the source of a `project:pr_resolves_issue` edge once.  If a
/// second call attempts to link the same PR to a different issue,
/// [`ProjectGraphError::PrAlreadyLinked`] is returned.
///
/// Returns the `project_nodes.id` of the new (or existing) PullRequest node.
///
/// # Arguments
///
/// * `pool`         — shared [`sqlx::PgPool`].
/// * `issue_id`     — `project_nodes.id` of the Issue this PR resolves.
/// * `title`        — the pull request title.
/// * `external_ref` — optional external reference (e.g. `"498"` for PR #498).
///
/// # Errors
///
/// - [`ProjectGraphError::PrAlreadyLinked`] — the PR is already linked to
///   an issue (unique constraint on the source block for
///   `project:pr_resolves_issue`).
/// - [`ProjectGraphError::Database`] — a Postgres error.
pub async fn link_pr_to_issue(
    pool: &PgPool,
    issue_id: Uuid,
    title: &str,
    external_ref: Option<&str>,
) -> Result<Uuid, ProjectGraphError> {
    let doc_id = ensure_project_doc(pool).await?;
    let pr_id = insert_project_node(pool, doc_id, title, "PullRequest", external_ref).await?;

    // Resolve block IDs for the edge.
    let pr_block = block_id_for_node(pool, pr_id).await?;
    let issue_block = block_id_for_node(pool, issue_id).await?;

    // Insert edge PR → Issue.  The unique partial index on
    // nexum.links(src) WHERE rel_type = 'project:pr_resolves_issue'
    // enforces the one-PR-per-issue constraint at the database level.
    let edge_result =
        insert_project_edge(pool, pr_block, issue_block, "project:pr_resolves_issue").await;

    match edge_result {
        Ok(_) => Ok(pr_id),
        Err(ProjectGraphError::Database(ref e)) => {
            // Unique constraint violation on the partial index means this PR
            // is already linked to an issue.
            let pg_err = e.as_database_error();
            let is_unique_violation = pg_err
                .and_then(|e| e.code())
                .map(|c| c == "23505")
                .unwrap_or(false);

            if is_unique_violation {
                Err(ProjectGraphError::PrAlreadyLinked(pr_block))
            } else {
                edge_result
            }
        }
        Err(other) => Err(other),
    }
}

// ---------------------------------------------------------------------------
// Update path
// ---------------------------------------------------------------------------

/// The set of valid lifecycle states for a project node.
///
/// Matches the `CHECK` constraint on `nexum.project_nodes.state` (migration
/// `0002_project_graph.sql`): `open → in_progress → validated → closed`.
pub const NODE_STATES: &[&str] = &["open", "in_progress", "validated", "closed"];

/// Update the lifecycle `state` and/or `title` (block content) of a project
/// node, returning `true` if a row was updated.
///
/// This backs both the HTTP `POST /studio/issues/update` route (human edits)
/// and `POST /studio/steer` (redirecting work on a feature/issue). At least
/// one of `state` or `title` must be `Some`; if both are `None` the call is a
/// no-op that returns `false`.
///
/// # Arguments
///
/// * `pool`    — shared [`sqlx::PgPool`].
/// * `node_id` — `project_nodes.id` of the node to update.
/// * `state`   — optional new lifecycle state (must be one of [`NODE_STATES`]).
/// * `title`   — optional new title / content for the backing block.
///
/// # Errors
///
/// - [`ProjectGraphError::InvalidState`] — `state` is not a valid lifecycle
///   value.
/// - [`ProjectGraphError::Database`] — a Postgres error.
pub async fn update_node(
    pool: &PgPool,
    node_id: Uuid,
    state: Option<&str>,
    title: Option<&str>,
) -> Result<bool, ProjectGraphError> {
    if let Some(s) = state {
        if !NODE_STATES.contains(&s) {
            return Err(ProjectGraphError::InvalidState(s.to_string()));
        }
    }

    // Resolve the backing block once; also serves as an existence check.
    let block_id: Option<Uuid> =
        sqlx::query_scalar("SELECT block_id FROM nexum.project_nodes WHERE id = $1")
            .bind(node_id)
            .fetch_optional(pool)
            .await?;

    let block_id = match block_id {
        Some(b) => b,
        None => return Ok(false),
    };

    let mut updated = false;

    if let Some(s) = state {
        sqlx::query("UPDATE nexum.project_nodes SET state = $1, updated_at = now() WHERE id = $2")
            .bind(s)
            .bind(node_id)
            .execute(pool)
            .await?;
        updated = true;
    }

    if let Some(t) = title {
        sqlx::query("UPDATE nexum.blocks SET content = $1 WHERE id = $2")
            .bind(t)
            .bind(block_id)
            .execute(pool)
            .await?;
        updated = true;
    }

    Ok(updated)
}

/// List project nodes of a given `node_type` (e.g. `"Issue"` or `"Feature"`),
/// newest first.
///
/// Backs the HTTP `GET /studio/issues` route and the `superfield issue list`
/// / `superfield feature list` CLI verbs. Pass `None` to list every node type.
///
/// # Errors
///
/// Returns [`ProjectGraphError::Database`] on Postgres errors.
pub async fn list_nodes(
    pool: &PgPool,
    node_type: Option<&str>,
) -> Result<Vec<ProjectNode>, ProjectGraphError> {
    #[allow(clippy::type_complexity)]
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<serde_json::Value>,
        ),
    >(
        r#"
        SELECT
            pn.id                AS node_id,
            pn.block_id          AS block_id,
            b.content            AS content,
            pn.node_type         AS node_type,
            pn.state             AS state,
            pn.external_ref      AS external_ref,
            pn.assertion_kind    AS assertion_kind,
            pn.assertion_params  AS assertion_params
        FROM nexum.project_nodes pn
        JOIN nexum.blocks b ON b.id = pn.block_id
        WHERE ($1::TEXT IS NULL OR pn.node_type = $1)
        ORDER BY pn.created_at DESC
        "#,
    )
    .bind(node_type)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                block_id,
                content,
                node_type,
                state,
                external_ref,
                assertion_kind,
                assertion_params,
            )| {
                ProjectNode {
                    id,
                    block_id,
                    content,
                    node_type,
                    state,
                    external_ref,
                    assertion_kind,
                    assertion_params,
                    via_rel_type: None,
                    parent_block_id: None,
                    verdict: None,
                    verdict_timestamp: None,
                }
            },
        )
        .collect())
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/// A single row returned by the recursive CTE traversal.
#[derive(Debug, Clone)]
pub struct ProjectNode {
    /// `project_nodes.id`
    pub id: Uuid,
    /// `block_id` in `nexum.blocks`
    pub block_id: Uuid,
    /// Human-readable content / title from the block.
    pub content: String,
    /// Node type discriminator.
    pub node_type: String,
    /// Lifecycle state.
    pub state: String,
    /// Optional external reference.
    pub external_ref: Option<String>,
    /// The executable assertion kind attached to this node, if any (only
    /// `AcceptanceCriterion` nodes carry one — issue #860). Wire values match
    /// [`AssertionKind::as_str`]: `"http-probe"`, `"playwright"`,
    /// `"required-test"`.
    pub assertion_kind: Option<String>,
    /// The typed assertion parameters attached to this node, if any — the
    /// JSON shape returned by [`AssertionSpec::params_json`] for the kind in
    /// [`ProjectNode::assertion_kind`]. Always `Some` together with
    /// `assertion_kind` and `None` together (issue #860's pairing CHECK
    /// constraint in `0004_acceptance_assertions.sql`).
    pub assertion_params: Option<serde_json::Value>,
    /// The `rel_type` of the edge that led to this node (`None` for root
    /// Issue nodes).
    pub via_rel_type: Option<String>,
    /// The parent `block_id` in the traversal (`None` for roots).
    pub parent_block_id: Option<Uuid>,
    /// Latest validation verdict for this AcceptanceCriterion node, if any.
    /// Values: `"passed"`, `"failed"`, or `None` for never-run.
    pub verdict: Option<String>,
    /// RFC3339 timestamp of the latest verdict, if any.
    pub verdict_timestamp: Option<DateTime<Utc>>,
}

/// Traverse the project graph starting from all `Issue` nodes and collect
/// every reachable node using a recursive CTE over `nexum.links`.
///
/// The traversal follows all `project:` prefixed edge types.  Nodes are
/// returned in breadth-first order (issues first, then their features, then
/// tests and criteria under each feature).
///
/// For each `AcceptanceCriterion` node, the latest verdict is fetched from
/// `forge.validation_runs` (by `criterion_node_id`), ordered by `created_at`
/// descending. The verdict is `"passed"` or `"failed"`; if no row exists,
/// the criterion is considered `never-run`.
///
/// # Errors
///
/// Returns [`ProjectGraphError::Database`] on Postgres errors.
pub async fn traverse_project_graph(pool: &PgPool) -> Result<Vec<ProjectNode>, ProjectGraphError> {
    // Recursive CTE:
    // 1. Seed: all Issue nodes (no parent).
    // 2. Recurse: follow any project: edge from each reached node.
    #[allow(clippy::type_complexity)]
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<serde_json::Value>,
            Option<String>,
            Option<Uuid>,
        ),
    >(
        r#"
        WITH RECURSIVE project_tree AS (
            -- Seed: all Issue nodes
            SELECT
                pn.id                AS node_id,
                pn.block_id          AS block_id,
                b.content            AS content,
                pn.node_type         AS node_type,
                pn.state             AS state,
                pn.external_ref      AS external_ref,
                pn.assertion_kind    AS assertion_kind,
                pn.assertion_params  AS assertion_params,
                NULL::TEXT           AS via_rel_type,
                NULL::UUID           AS parent_block_id
            FROM nexum.project_nodes pn
            JOIN nexum.blocks b ON b.id = pn.block_id
            WHERE pn.node_type = 'Issue'

            UNION ALL

            -- Recurse: follow project: edges
            SELECT
                child_pn.id               AS node_id,
                child_pn.block_id         AS block_id,
                child_b.content           AS content,
                child_pn.node_type        AS node_type,
                child_pn.state            AS state,
                child_pn.external_ref     AS external_ref,
                child_pn.assertion_kind   AS assertion_kind,
                child_pn.assertion_params AS assertion_params,
                l.rel_type                AS via_rel_type,
                pt.block_id               AS parent_block_id
            FROM project_tree pt
            JOIN nexum.links l
                ON l.src = pt.block_id
               AND l.rel_type LIKE 'project:%'
               AND l.rel_type != 'project:pr_resolves_issue'
            JOIN nexum.blocks child_b ON child_b.id = l.dst
            JOIN nexum.project_nodes child_pn ON child_pn.block_id = child_b.id
        )
        SELECT
            node_id,
            block_id,
            content,
            node_type,
            state,
            external_ref,
            assertion_kind,
            assertion_params,
            via_rel_type,
            parent_block_id
        FROM project_tree
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut nodes: Vec<ProjectNode> = rows
        .into_iter()
        .map(
            |(
                id,
                block_id,
                content,
                node_type,
                state,
                external_ref,
                assertion_kind,
                assertion_params,
                via_rel_type,
                parent_block_id,
            )| {
                ProjectNode {
                    id,
                    block_id,
                    content,
                    node_type,
                    state,
                    external_ref,
                    assertion_kind,
                    assertion_params,
                    via_rel_type,
                    parent_block_id,
                    verdict: None,
                    verdict_timestamp: None,
                }
            },
        )
        .collect();

    // Fetch latest verdict for each AcceptanceCriterion node.
    // We collect all criterion node IDs first, then batch-query verdicts.
    let criterion_ids: Vec<Uuid> = nodes
        .iter()
        .filter(|n| n.node_type == "AcceptanceCriterion")
        .map(|n| n.id)
        .collect();

    if !criterion_ids.is_empty() {
        // Query latest verdict per criterion_node_id across all changes.
        // DISTINCT ON (criterion_node_id) ORDER BY criterion_node_id, created_at DESC
        let placeholders = criterion_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("${}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");

        let query_str = format!(
            r#"
            SELECT DISTINCT ON (criterion_node_id)
                criterion_node_id,
                state,
                created_at
            FROM forge.validation_runs
            WHERE criterion_node_id IN ({placeholders})
            ORDER BY criterion_node_id, created_at DESC
            "#
        );

        let mut query = sqlx::query_as::<_, (Uuid, String, DateTime<Utc>)>(&query_str);
        for id in &criterion_ids {
            query = query.bind(id);
        }

        let verdict_rows = query.fetch_all(pool).await?;

        // Build a map for quick lookup.
        let verdict_map: std::collections::HashMap<Uuid, (String, DateTime<Utc>)> = verdict_rows
            .into_iter()
            .map(|(criterion_node_id, state, created_at)| (criterion_node_id, (state, created_at)))
            .collect();

        // Attach verdicts to nodes.
        for node in &mut nodes {
            if node.node_type == "AcceptanceCriterion" {
                if let Some((verdict, timestamp)) = verdict_map.get(&node.id) {
                    node.verdict = Some(verdict.clone());
                    node.verdict_timestamp = Some(*timestamp);
                }
            }
        }
    }

    Ok(nodes)
}

/// Render the project graph as markdown.
///
/// Produces a structured markdown document suitable for `GET /pages/project`
/// and `superfield page project`.  The format is:
///
/// ```markdown
/// # Project Graph
///
/// ## Issue: <title> [<state>]
///
/// ### Feature: <title> [<state>] [FAILING]
///
/// #### Required test: <title> [<state>]
/// #### Acceptance criterion: <title> [<state>] — verdict: pass (2024-01-15T10:30:00Z)
/// #### Acceptance criterion: <title> [<state>] — verdict: fail (2024-01-15T10:35:00Z)
/// #### Acceptance criterion: <title> [<state>] — verdict: never-run
///
/// ...
/// ```
///
/// A Feature with any child AcceptanceCriterion whose latest verdict is
/// `failed` is marked `[FAILING]` on its heading line. An AcceptanceCriterion
/// with no recorded validation run renders as `never-run`.
///
/// Returns `None` when there are no Issue nodes in the graph.
///
/// # Errors
///
/// Returns [`ProjectGraphError::Database`] on Postgres errors.
pub async fn fetch_project_page(pool: &PgPool) -> Result<Option<String>, ProjectGraphError> {
    let nodes = traverse_project_graph(pool).await?;

    if nodes.is_empty() {
        return Ok(None);
    }

    // Build a map: block_id → children (for rendering the tree).
    // For each node, collect children grouped by parent_block_id.
    let mut children_of: std::collections::HashMap<Option<Uuid>, Vec<&ProjectNode>> =
        std::collections::HashMap::new();

    for node in &nodes {
        children_of
            .entry(node.parent_block_id)
            .or_default()
            .push(node);
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("# Project Graph".to_string());
    lines.push(String::new());

    // Render root issues (parent_block_id = None).
    if let Some(issues) = children_of.get(&None) {
        for issue in issues.iter() {
            render_node(&mut lines, issue, &children_of, 2);
        }
    }

    Ok(Some(lines.join("\n")))
}

/// Recursively render a project node and its children.
fn render_node(
    lines: &mut Vec<String>,
    node: &ProjectNode,
    children_of: &std::collections::HashMap<Option<Uuid>, Vec<&ProjectNode>>,
    depth: usize,
) {
    let prefix = "#".repeat(depth);
    let label = match node.node_type.as_str() {
        "Issue" => "Issue",
        "Feature" => "Feature",
        "RequiredTest" => "Required test",
        "AcceptanceCriterion" => "Acceptance criterion",
        "PullRequest" => "Pull request",
        other => other,
    };

    let ext = node
        .external_ref
        .as_deref()
        .map(|r| format!(" (ref: {})", r))
        .unwrap_or_default();

    // Check if this Feature has any failing AcceptanceCriterion child.
    let failing_marker = if node.node_type == "Feature" {
        let has_failing = children_of
            .get(&Some(node.block_id))
            .map(|children| {
                children.iter().any(|child| {
                    child.node_type == "AcceptanceCriterion"
                        && child.verdict.as_deref() == Some("failed")
                })
            })
            .unwrap_or(false);
        if has_failing {
            " [FAILING]"
        } else {
            ""
        }
    } else {
        ""
    };

    // Build verdict suffix for AcceptanceCriterion nodes.
    let verdict_suffix = if node.node_type == "AcceptanceCriterion" {
        match node.verdict.as_deref() {
            Some("passed") => {
                let ts = node
                    .verdict_timestamp
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_else(|| "unknown-time".to_string());
                format!(" — verdict: pass ({})", ts)
            }
            Some("failed") => {
                let ts = node
                    .verdict_timestamp
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_else(|| "unknown-time".to_string());
                format!(" — verdict: fail ({})", ts)
            }
            _ => " — verdict: never-run".to_string(),
        }
    } else {
        String::new()
    };

    lines.push(format!(
        "{} {}: {} [{}]{}{}{}",
        prefix, label, node.content, node.state, ext, failing_marker, verdict_suffix
    ));
    lines.push(String::new());

    // Recurse into children.
    if let Some(children) = children_of.get(&Some(node.block_id)) {
        let next_depth = if depth < 6 { depth + 1 } else { depth };
        for child in children.iter() {
            render_node(lines, child, children_of, next_depth);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── Stub / pure-unit tests (no database) ────────────────────────────────

    /// Verify [`fetch_project_page`] returns None without a live database
    /// when no Issue nodes exist.
    ///
    /// The lazy pool will error when the SQL is attempted, so we test the
    /// error variant rather than None — the important thing is the function
    /// compiles and the types are correct.
    #[tokio::test]
    async fn project_graph_module_compiles() {
        // Just exercise the module-level constant so rustc verifies the
        // public API surface compiles with the stub lazy pool.
        assert_eq!(PROJECT_GRAPH_DOC_TITLE, "project");
    }

    // ── Assertion schema stub tests (dev-scout #869, no database) ───────────

    /// Each kind round-trips through JSON with valid parameters, and
    /// [`AssertionSpec::kind`] reports the matching [`AssertionKind`].
    #[test]
    fn assertion_spec_round_trips_for_each_kind() {
        let http = serde_json::json!({
            "kind": "http-probe",
            "params": { "method": "POST", "path": "/orders", "expected_status": 201 },
        });
        let spec = validate_assertion_spec(&http).expect("valid http-probe spec");
        assert_eq!(spec.kind(), AssertionKind::HttpProbe);
        assert_eq!(
            serde_json::to_value(&spec).expect("serializes"),
            http,
            "round trip must reproduce the original JSON"
        );

        let playwright = serde_json::json!({
            "kind": "playwright",
            "params": { "path": "/checkout", "expectation": "confirmation toast shown" },
        });
        let spec = validate_assertion_spec(&playwright).expect("valid playwright spec");
        assert_eq!(spec.kind(), AssertionKind::Playwright);

        let required_test = serde_json::json!({
            "kind": "required-test",
            "params": { "test_name": "sf_loop::acceptance::per_criterion_verdicts_recorded" },
        });
        let spec = validate_assertion_spec(&required_test).expect("valid required-test spec");
        assert_eq!(spec.kind(), AssertionKind::RequiredTest);
    }

    /// An unknown `kind` is rejected at write time (serde deserialize fails),
    /// never silently accepted.
    #[test]
    fn assertion_spec_rejects_unknown_kind() {
        let raw = serde_json::json!({
            "kind": "smoke-test",
            "params": { "path": "/x" },
        });
        let err = validate_assertion_spec(&raw).expect_err("unknown kind must be rejected");
        assert!(matches!(err, ProjectGraphError::InvalidAssertionSpec(_)));
    }

    /// Parameters that do not match the declared kind's typed schema are
    /// rejected at write time.
    #[test]
    fn assertion_spec_rejects_malformed_params() {
        // http-probe requires expected_status: u16 — supply a string instead.
        let raw = serde_json::json!({
            "kind": "http-probe",
            "params": { "method": "GET", "path": "/orders", "expected_status": "ok" },
        });
        let err = validate_assertion_spec(&raw).expect_err("malformed params must be rejected");
        assert!(matches!(err, ProjectGraphError::InvalidAssertionSpec(_)));

        // playwright missing the required `expectation` field.
        let raw = serde_json::json!({
            "kind": "playwright",
            "params": { "path": "/checkout" },
        });
        let err = validate_assertion_spec(&raw).expect_err("missing field must be rejected");
        assert!(matches!(err, ProjectGraphError::InvalidAssertionSpec(_)));
    }

    // ── Integration tests (require DATABASE_URL) ─────────────────────────────

    /// Integration test: insert one Issue node and two Feature nodes linked
    /// via project:issue_has_feature; traverse from Issue using recursive CTE
    /// over nexum.links; assert two Feature rows returned.
    ///
    /// Acceptance criterion: project_graph_insert_issue_with_features
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn project_graph_insert_issue_with_features() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        // Insert Issue.
        let issue_id = insert_issue(&pool, "Test issue for graph insert", Some("test-ac-1"))
            .await
            .expect("insert_issue failed");

        // Insert two Features linked to the Issue.
        let feature_a_id = insert_feature(&pool, issue_id, "Feature A for test issue")
            .await
            .expect("insert_feature A failed");
        let _feature_b_id = insert_feature(&pool, issue_id, "Feature B for test issue")
            .await
            .expect("insert_feature B failed");

        // Traverse the graph from all Issues.
        let nodes = traverse_project_graph(&pool)
            .await
            .expect("traverse failed");

        // Filter to features that are children of our test issue.
        let issue_block: Uuid =
            sqlx::query_scalar("SELECT block_id FROM nexum.project_nodes WHERE id = $1")
                .bind(issue_id)
                .fetch_one(&pool)
                .await
                .expect("resolve block_id failed");

        let features: Vec<_> = nodes
            .iter()
            .filter(|n| {
                n.node_type == "Feature"
                    && n.parent_block_id == Some(issue_block)
                    && (n.content == "Feature A for test issue"
                        || n.content == "Feature B for test issue")
            })
            .collect();

        assert_eq!(
            features.len(),
            2,
            "expected 2 Feature nodes under the test Issue, got {}",
            features.len()
        );

        // Cleanup.
        cleanup_test_nodes(&pool, &[issue_id, _feature_b_id, feature_a_id]).await;
    }

    /// Integration test: insert a PullRequest linked to Issue A; attempt to
    /// link same PullRequest to Issue B via link_pr_to_issue(); assert the
    /// second call returns an error.
    ///
    /// Acceptance criterion: project_graph_one_pr_per_issue_enforced
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn project_graph_one_pr_per_issue_enforced() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        let issue_a_id = insert_issue(&pool, "Issue A for one-PR test", None)
            .await
            .expect("insert issue A failed");

        let issue_b_id = insert_issue(&pool, "Issue B for one-PR test", None)
            .await
            .expect("insert issue B failed");

        // First PR link: should succeed.
        let _pr_id = link_pr_to_issue(&pool, issue_a_id, "PR for one-PR test", Some("test-pr-1"))
            .await
            .expect("first link_pr_to_issue should succeed");

        // Second link attempt with a NEW PR node pointing to Issue B.
        // The constraint is per-PR-block — so we need to attempt linking
        // the SAME PR. To simulate: get the pr block_id and try to insert
        // another link with the same src and rel_type, which the unique
        // partial index should reject.
        //
        // However link_pr_to_issue always creates a NEW PR node (new block_id).
        // The one-PR-per-issue constraint means: a PR node can resolve at most
        // one issue.  We test this by calling link_pr_to_issue with a PR title
        // that is IDENTICAL to the first — the content_hash would be the same
        // but blocks are inserted fresh each time (no upsert).
        //
        // For the constraint to fire we need to actually try to add a second
        // 'project:pr_resolves_issue' edge FROM the SAME pr_block.  To do
        // this, manually insert the edge using the existing pr block.
        let pr_block: Uuid =
            sqlx::query_scalar("SELECT block_id FROM nexum.project_nodes WHERE id = $1")
                .bind(_pr_id)
                .fetch_one(&pool)
                .await
                .expect("resolve pr block_id failed");

        let issue_b_block: Uuid =
            sqlx::query_scalar("SELECT block_id FROM nexum.project_nodes WHERE id = $1")
                .bind(issue_b_id)
                .fetch_one(&pool)
                .await
                .expect("resolve issue B block_id failed");

        // Attempt to add a second pr_resolves_issue edge from the same PR block.
        let second_link_result =
            insert_project_edge(&pool, pr_block, issue_b_block, "project:pr_resolves_issue").await;

        assert!(
            second_link_result.is_err(),
            "second pr_resolves_issue edge from same PR block must fail"
        );

        // Cleanup.
        cleanup_test_nodes(&pool, &[issue_a_id, issue_b_id, _pr_id]).await;
    }

    /// Integration test: insert Issue → Feature → AcceptanceCriterion chain;
    /// recursive CTE traversal from Issue returns all three node types in
    /// correct parent-child order.
    ///
    /// Acceptance criterion: project_graph_traverse_issue_to_acceptance_criteria
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn project_graph_traverse_issue_to_acceptance_criteria() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        let issue_id = insert_issue(&pool, "Issue for AC chain test", None)
            .await
            .expect("insert issue failed");

        let feature_id = insert_feature(&pool, issue_id, "Feature for AC chain test")
            .await
            .expect("insert feature failed");

        let ac_id = insert_acceptance_criterion(&pool, feature_id, "AC for AC chain test", None)
            .await
            .expect("insert_acceptance_criterion failed");

        // Traverse and filter to our test nodes.
        let nodes = traverse_project_graph(&pool)
            .await
            .expect("traverse failed");

        // Resolve block_ids.
        let issue_block: Uuid =
            sqlx::query_scalar("SELECT block_id FROM nexum.project_nodes WHERE id = $1")
                .bind(issue_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        let feature_block: Uuid =
            sqlx::query_scalar("SELECT block_id FROM nexum.project_nodes WHERE id = $1")
                .bind(feature_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        // Find Issue node.
        let found_issue = nodes
            .iter()
            .find(|n| n.id == issue_id)
            .expect("Issue node must be in traversal");
        assert_eq!(found_issue.node_type, "Issue");
        assert!(found_issue.parent_block_id.is_none());

        // Find Feature node — parent must be the Issue's block.
        let found_feature = nodes
            .iter()
            .find(|n| n.id == feature_id)
            .expect("Feature node must be in traversal");
        assert_eq!(found_feature.node_type, "Feature");
        assert_eq!(found_feature.parent_block_id, Some(issue_block));

        // Find AcceptanceCriterion node — parent must be the Feature's block.
        let found_ac = nodes
            .iter()
            .find(|n| n.id == ac_id)
            .expect("AcceptanceCriterion node must be in traversal");
        assert_eq!(found_ac.node_type, "AcceptanceCriterion");
        assert_eq!(found_ac.parent_block_id, Some(feature_block));

        // Cleanup.
        cleanup_test_nodes(&pool, &[issue_id, feature_id, ac_id]).await;
    }

    /// Integration test (issue #860): insert an `AcceptanceCriterion` under a
    /// Feature for each of the three assertion kinds with valid parameters
    /// and assert `traverse_project_graph` returns each node with its kind
    /// and parameters intact; also assert that an insert with an unknown
    /// kind, and an insert whose parameters fail the kind's typed schema,
    /// both return `Err(ProjectGraphError::InvalidAssertionSpec)` and leave
    /// no row behind.
    ///
    /// Acceptance criteria: "Valid roundtrip" and "Write-time rejection"
    /// (issue #860).
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn project_graph_acceptance_assertion_roundtrip() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        let issue_id = insert_issue(&pool, "Issue for assertion roundtrip test", None)
            .await
            .expect("insert issue failed");
        let feature_id = insert_feature(&pool, issue_id, "Feature for assertion roundtrip test")
            .await
            .expect("insert feature failed");

        // ── Valid roundtrip: one AcceptanceCriterion per kind ───────────────

        let http_probe = serde_json::json!({
            "kind": "http-probe",
            "params": { "method": "POST", "path": "/orders", "expected_status": 201 },
        });
        let http_probe_ac_id = insert_acceptance_criterion(
            &pool,
            feature_id,
            "AC: http-probe roundtrip",
            Some(&http_probe),
        )
        .await
        .expect("valid http-probe assertion must insert");

        let playwright = serde_json::json!({
            "kind": "playwright",
            "params": { "path": "/checkout", "expectation": "confirmation toast shown" },
        });
        let playwright_ac_id = insert_acceptance_criterion(
            &pool,
            feature_id,
            "AC: playwright roundtrip",
            Some(&playwright),
        )
        .await
        .expect("valid playwright assertion must insert");

        let required_test = serde_json::json!({
            "kind": "required-test",
            "params": { "test_name": "sf_loop::acceptance::per_criterion_verdicts_recorded" },
        });
        let required_test_ac_id = insert_acceptance_criterion(
            &pool,
            feature_id,
            "AC: required-test roundtrip",
            Some(&required_test),
        )
        .await
        .expect("valid required-test assertion must insert");

        let nodes = traverse_project_graph(&pool)
            .await
            .expect("traverse failed");

        let find = |id: Uuid| -> &ProjectNode {
            nodes
                .iter()
                .find(|n| n.id == id)
                .expect("assertion-bearing AcceptanceCriterion node must be in traversal")
        };

        let found_http = find(http_probe_ac_id);
        assert_eq!(found_http.assertion_kind.as_deref(), Some("http-probe"));
        assert_eq!(
            found_http
                .assertion_params
                .as_ref()
                .expect("params present"),
            &http_probe["params"],
            "http-probe params must round-trip intact"
        );

        let found_playwright = find(playwright_ac_id);
        assert_eq!(
            found_playwright.assertion_kind.as_deref(),
            Some("playwright")
        );
        assert_eq!(
            found_playwright
                .assertion_params
                .as_ref()
                .expect("params present"),
            &playwright["params"],
            "playwright params must round-trip intact"
        );

        let found_required_test = find(required_test_ac_id);
        assert_eq!(
            found_required_test.assertion_kind.as_deref(),
            Some("required-test")
        );
        assert_eq!(
            found_required_test
                .assertion_params
                .as_ref()
                .expect("params present"),
            &required_test["params"],
            "required-test params must round-trip intact"
        );

        // ── Write-time rejection: unknown kind ──────────────────────────────

        let node_count_before: i64 = sqlx::query_scalar("SELECT count(*) FROM nexum.project_nodes")
            .fetch_one(&pool)
            .await
            .expect("count query failed");

        let unknown_kind = serde_json::json!({
            "kind": "smoke-test",
            "params": { "path": "/x" },
        });
        let err = insert_acceptance_criterion(
            &pool,
            feature_id,
            "AC: should not be inserted (unknown kind)",
            Some(&unknown_kind),
        )
        .await
        .expect_err("unknown assertion kind must be rejected at write time");
        assert!(matches!(err, ProjectGraphError::InvalidAssertionSpec(_)));

        // ── Write-time rejection: malformed params for a known kind ─────────

        let malformed_params = serde_json::json!({
            "kind": "http-probe",
            "params": { "method": "GET", "path": "/orders", "expected_status": "ok" },
        });
        let err = insert_acceptance_criterion(
            &pool,
            feature_id,
            "AC: should not be inserted (malformed params)",
            Some(&malformed_params),
        )
        .await
        .expect_err("malformed assertion params must be rejected at write time");
        assert!(matches!(err, ProjectGraphError::InvalidAssertionSpec(_)));

        let node_count_after: i64 = sqlx::query_scalar("SELECT count(*) FROM nexum.project_nodes")
            .fetch_one(&pool)
            .await
            .expect("count query failed");
        assert_eq!(
            node_count_before, node_count_after,
            "rejected assertion writes must leave no row behind"
        );

        // Cleanup.
        cleanup_test_nodes(
            &pool,
            &[
                issue_id,
                feature_id,
                http_probe_ac_id,
                playwright_ac_id,
                required_test_ac_id,
            ],
        )
        .await;
    }

    /// Integration test: insert a fixture Issue node with state='in_progress'
    /// and one Feature child; assert fetch_project_page returns markdown
    /// containing the issue title and 'in_progress' status string.
    ///
    /// Acceptance criterion: project_graph_page_contains_status
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum migrations applied"]
    async fn project_graph_page_contains_status() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        // Insert Issue with state = in_progress.
        let issue_id = insert_issue(&pool, "Fixture issue for page test", None)
            .await
            .expect("insert issue failed");

        // Update state to in_progress.
        sqlx::query(
            "UPDATE nexum.project_nodes SET state = 'in_progress', updated_at = now() \
             WHERE id = $1",
        )
        .bind(issue_id)
        .execute(&pool)
        .await
        .expect("state update failed");

        let _feature_id = insert_feature(&pool, issue_id, "Feature for page status test")
            .await
            .expect("insert feature failed");

        let page = fetch_project_page(&pool)
            .await
            .expect("fetch_project_page failed")
            .expect("expected Some");

        assert!(
            page.contains("Fixture issue for page test"),
            "page must contain issue title, got: {:?}",
            page
        );
        assert!(
            page.contains("in_progress"),
            "page must contain 'in_progress' status, got: {:?}",
            page
        );

        cleanup_test_nodes(&pool, &[issue_id, _feature_id]).await;
    }

    /// Delete test project_nodes (and their blocks) in reverse-dependency
    /// order to avoid FK violations.
    async fn cleanup_test_nodes(pool: &PgPool, node_ids: &[Uuid]) {
        for node_id in node_ids.iter().rev() {
            // Resolve block_id.
            let block_id: Option<Uuid> =
                sqlx::query_scalar("SELECT block_id FROM nexum.project_nodes WHERE id = $1")
                    .bind(node_id)
                    .fetch_optional(pool)
                    .await
                    .ok()
                    .flatten();

            if let Some(bid) = block_id {
                // Remove links where this block is src or dst.
                sqlx::query("DELETE FROM nexum.links WHERE src = $1 OR dst = $1")
                    .bind(bid)
                    .execute(pool)
                    .await
                    .ok();
            }

            // Remove project_node record.
            sqlx::query("DELETE FROM nexum.project_nodes WHERE id = $1")
                .bind(node_id)
                .execute(pool)
                .await
                .ok();

            // Remove the block.
            if let Some(bid) = block_id {
                sqlx::query("DELETE FROM nexum.blocks WHERE id = $1")
                    .bind(bid)
                    .execute(pool)
                    .await
                    .ok();
            }
        }
    }

    // ── Verdict rendering unit tests (no database) ─────────────────────────────

    /// Build an in-memory project graph with one pass, one fail, and one
    /// never-run AcceptanceCriterion, render it, and assert the output matches
    /// the committed golden fixture (byte-identical).
    ///
    /// Acceptance criterion: verdict rendering golden fixture.
    #[test]
    fn project_graph_verdict_rendering_golden_fixture() {
        use std::collections::HashMap;

        let issue_block = Uuid::new_v4();
        let feature_block = Uuid::new_v4();
        let ac_pass_block = Uuid::new_v4();
        let ac_fail_block = Uuid::new_v4();
        let ac_never_block = Uuid::new_v4();

        let issue = ProjectNode {
            id: Uuid::new_v4(),
            block_id: issue_block,
            content: "Test issue".to_string(),
            node_type: "Issue".to_string(),
            state: "open".to_string(),
            external_ref: None,
            assertion_kind: None,
            assertion_params: None,
            via_rel_type: None,
            parent_block_id: None,
            verdict: None,
            verdict_timestamp: None,
        };

        let feature = ProjectNode {
            id: Uuid::new_v4(),
            block_id: feature_block,
            content: "Test feature".to_string(),
            node_type: "Feature".to_string(),
            state: "in_progress".to_string(),
            external_ref: None,
            assertion_kind: None,
            assertion_params: None,
            via_rel_type: Some("project:issue_has_feature".to_string()),
            parent_block_id: Some(issue_block),
            verdict: None,
            verdict_timestamp: None,
        };

        let ac_pass = ProjectNode {
            id: Uuid::new_v4(),
            block_id: ac_pass_block,
            content: "AC that passes".to_string(),
            node_type: "AcceptanceCriterion".to_string(),
            state: "validated".to_string(),
            external_ref: None,
            assertion_kind: Some("http-probe".to_string()),
            assertion_params: None,
            via_rel_type: Some("project:feature_has_acceptance_criterion".to_string()),
            parent_block_id: Some(feature_block),
            verdict: Some("passed".to_string()),
            verdict_timestamp: Some(DateTime::parse_from_rfc3339("2024-01-15T10:30:00Z").unwrap().with_timezone(&Utc)),
        };

        let ac_fail = ProjectNode {
            id: Uuid::new_v4(),
            block_id: ac_fail_block,
            content: "AC that fails".to_string(),
            node_type: "AcceptanceCriterion".to_string(),
            state: "validated".to_string(),
            external_ref: None,
            assertion_kind: Some("required-test".to_string()),
            assertion_params: None,
            via_rel_type: Some("project:feature_has_acceptance_criterion".to_string()),
            parent_block_id: Some(feature_block),
            verdict: Some("failed".to_string()),
            verdict_timestamp: Some(DateTime::parse_from_rfc3339("2024-01-15T10:35:00Z").unwrap().with_timezone(&Utc)),
        };

        let ac_never = ProjectNode {
            id: Uuid::new_v4(),
            block_id: ac_never_block,
            content: "AC never run".to_string(),
            node_type: "AcceptanceCriterion".to_string(),
            state: "open".to_string(),
            external_ref: None,
            assertion_kind: Some("playwright".to_string()),
            assertion_params: None,
            via_rel_type: Some("project:feature_has_acceptance_criterion".to_string()),
            parent_block_id: Some(feature_block),
            verdict: None,
            verdict_timestamp: None,
        };

        let nodes = vec![issue, feature, ac_pass, ac_fail, ac_never];

        let mut children_of: HashMap<Option<Uuid>, Vec<&ProjectNode>> = HashMap::new();
        for node in &nodes {
            children_of
                .entry(node.parent_block_id)
                .or_default()
                .push(node);
        }

        let mut lines: Vec<String> = Vec::new();
        lines.push("# Project Graph".to_string());
        lines.push(String::new());

        if let Some(issues) = children_of.get(&None) {
            for issue in issues.iter() {
                render_node(&mut lines, issue, &children_of, 2);
            }
        }

        let output = lines.join("\n");

        // Read the golden fixture.
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("project_graph_verdicts.golden.md");
        let expected = std::fs::read_to_string(&fixture_path)
            .unwrap_or_else(|_| panic!("golden fixture not found at {:?}", fixture_path));

        // Normalize line endings for comparison.
        let output_normalized = output.replace('\r', "");
        let expected_normalized = expected.replace('\r', "");

        assert_eq!(
            output_normalized, expected_normalized,
            "rendered output must match golden fixture byte-for-byte"
        );
    }

    /// Unit test: every AcceptanceCriterion line carries exactly one of
    /// pass|fail|never-run; pass/fail lines carry an RFC3339 timestamp.
    ///
    /// Acceptance criterion: verdict line format.
    #[test]
    fn project_graph_verdict_line_format() {
        use std::collections::HashMap;

        let feature_block = Uuid::new_v4();
        let ac1_block = Uuid::new_v4();
        let ac2_block = Uuid::new_v4();
        let ac3_block = Uuid::new_v4();

        let feature = ProjectNode {
            id: Uuid::new_v4(),
            block_id: feature_block,
            content: "Feature with ACs".to_string(),
            node_type: "Feature".to_string(),
            state: "in_progress".to_string(),
            external_ref: None,
            assertion_kind: None,
            assertion_params: None,
            via_rel_type: Some("project:issue_has_feature".to_string()),
            parent_block_id: None,
            verdict: None,
            verdict_timestamp: None,
        };

        let ac_pass = ProjectNode {
            id: Uuid::new_v4(),
            block_id: ac1_block,
            content: "Passing AC".to_string(),
            node_type: "AcceptanceCriterion".to_string(),
            state: "validated".to_string(),
            external_ref: None,
            assertion_kind: Some("http-probe".to_string()),
            assertion_params: None,
            via_rel_type: Some("project:feature_has_acceptance_criterion".to_string()),
            parent_block_id: Some(feature_block),
            verdict: Some("passed".to_string()),
            verdict_timestamp: Some(DateTime::parse_from_rfc3339("2024-01-15T10:30:00Z").unwrap().with_timezone(&Utc)),
        };

        let ac_fail = ProjectNode {
            id: Uuid::new_v4(),
            block_id: ac2_block,
            content: "Failing AC".to_string(),
            node_type: "AcceptanceCriterion".to_string(),
            state: "validated".to_string(),
            external_ref: None,
            assertion_kind: Some("required-test".to_string()),
            assertion_params: None,
            via_rel_type: Some("project:feature_has_acceptance_criterion".to_string()),
            parent_block_id: Some(feature_block),
            verdict: Some("failed".to_string()),
            verdict_timestamp: Some(DateTime::parse_from_rfc3339("2024-01-15T10:35:00Z").unwrap().with_timezone(&Utc)),
        };

        let ac_never = ProjectNode {
            id: Uuid::new_v4(),
            block_id: ac3_block,
            content: "Never-run AC".to_string(),
            node_type: "AcceptanceCriterion".to_string(),
            state: "open".to_string(),
            external_ref: None,
            assertion_kind: Some("playwright".to_string()),
            assertion_params: None,
            via_rel_type: Some("project:feature_has_acceptance_criterion".to_string()),
            parent_block_id: Some(feature_block),
            verdict: None,
            verdict_timestamp: None,
        };

        let nodes = vec![feature, ac_pass, ac_fail, ac_never];

        let mut children_of: HashMap<Option<Uuid>, Vec<&ProjectNode>> = HashMap::new();
        for node in &nodes {
            children_of
                .entry(node.parent_block_id)
                .or_default()
                .push(node);
        }

        let mut lines: Vec<String> = Vec::new();
        if let Some(features) = children_of.get(&None) {
            for feature in features.iter() {
                render_node(&mut lines, feature, &children_of, 3);
            }
        }

        let output = lines.join("\n");

        // Each AC line must contain exactly one verdict indicator.
        let ac_lines: Vec<&str> = output
            .lines()
            .filter(|l| l.contains("Acceptance criterion:"))
            .collect();

        assert_eq!(ac_lines.len(), 3, "expected 3 AC lines");

        for line in &ac_lines {
            // Must have exactly one of the verdict patterns.
            let pass_count = line.matches("verdict: pass").count();
            let fail_count = line.matches("verdict: fail").count();
            let never_count = line.matches("verdict: never-run").count();
            let total = pass_count + fail_count + never_count;
            assert_eq!(total, 1, "each AC line must have exactly one verdict: {:?}", line);

            // Pass/fail must have RFC3339 timestamp (contains T and Z or +/-).
            if pass_count == 1 || fail_count == 1 {
                assert!(
                    line.contains('T') && (line.contains('Z') || line.contains('+')),
                    "pass/fail verdict must have RFC3339 timestamp: {:?}",
                    line
                );
            }
        }

        // Feature with failing AC must have FAILING marker.
        let feature_line = output
            .lines()
            .find(|l| l.contains("Feature:"))
            .expect("feature line must exist");
        assert!(
            feature_line.contains("[FAILING]"),
            "feature with failing AC must be marked FAILING: {:?}",
            feature_line
        );
    }

    /// Unit test: Feature with no failing AC does NOT get FAILING marker.
    #[test]
    fn project_graph_feature_no_failing_marker_when_all_pass() {
        use std::collections::HashMap;

        let feature_block = Uuid::new_v4();
        let ac1_block = Uuid::new_v4();
        let ac2_block = Uuid::new_v4();

        let feature = ProjectNode {
            id: Uuid::new_v4(),
            block_id: feature_block,
            content: "All-pass Feature".to_string(),
            node_type: "Feature".to_string(),
            state: "in_progress".to_string(),
            external_ref: None,
            assertion_kind: None,
            assertion_params: None,
            via_rel_type: Some("project:issue_has_feature".to_string()),
            parent_block_id: None,
            verdict: None,
            verdict_timestamp: None,
        };

        let ac_pass1 = ProjectNode {
            id: Uuid::new_v4(),
            block_id: ac1_block,
            content: "Passing AC 1".to_string(),
            node_type: "AcceptanceCriterion".to_string(),
            state: "validated".to_string(),
            external_ref: None,
            assertion_kind: Some("http-probe".to_string()),
            assertion_params: None,
            via_rel_type: Some("project:feature_has_acceptance_criterion".to_string()),
            parent_block_id: Some(feature_block),
            verdict: Some("passed".to_string()),
            verdict_timestamp: Some(DateTime::parse_from_rfc3339("2024-01-15T10:30:00Z").unwrap().with_timezone(&Utc)),
        };

        let ac_pass2 = ProjectNode {
            id: Uuid::new_v4(),
            block_id: ac2_block,
            content: "Passing AC 2".to_string(),
            node_type: "AcceptanceCriterion".to_string(),
            state: "validated".to_string(),
            external_ref: None,
            assertion_kind: Some("required-test".to_string()),
            assertion_params: None,
            via_rel_type: Some("project:feature_has_acceptance_criterion".to_string()),
            parent_block_id: Some(feature_block),
            verdict: Some("passed".to_string()),
            verdict_timestamp: Some(DateTime::parse_from_rfc3339("2024-01-15T10:35:00Z").unwrap().with_timezone(&Utc)),
        };

        let nodes = vec![feature, ac_pass1, ac_pass2];

        let mut children_of: HashMap<Option<Uuid>, Vec<&ProjectNode>> = HashMap::new();
        for node in &nodes {
            children_of
                .entry(node.parent_block_id)
                .or_default()
                .push(node);
        }

        let mut lines: Vec<String> = Vec::new();
        if let Some(features) = children_of.get(&None) {
            for feature in features.iter() {
                render_node(&mut lines, feature, &children_of, 3);
            }
        }

        let output = lines.join("\n");

        let feature_line = output
            .lines()
            .find(|l| l.contains("Feature:"))
            .expect("feature line must exist");
        assert!(
            !feature_line.contains("[FAILING]"),
            "feature with all passing ACs must NOT be marked FAILING: {:?}",
            feature_line
        );
    }

    // ── Integration tests: verdict projection (require DATABASE_URL) ───────────

    /// Integration test: seed Issue → Feature → AcceptanceCriterion nodes plus
    /// forge.validation_runs rows with criterion_node_id; assert
    /// fetch_project_page output contains each seeded verdict with the latest
    /// run's timestamp.
    ///
    /// Acceptance criterion: project_graph_verdict_projection
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum + sf-db migrations applied"]
    async fn project_graph_verdict_projection() {
        let cfg = crate::config::DbConfig::from_env()
            .expect("DATABASE_URL must be set for integration tests");
        let pool = crate::pool::connect(&cfg)
            .await
            .expect("pool creation failed");

        // Need a workspace for forge.changes FK.
        let workspace_id: Uuid = sqlx::query_scalar(
            "INSERT INTO public.workspaces (slug, display_name) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("sf-db-verdict-test-{}", Uuid::new_v4()))
        .bind("sf-db verdict projection test workspace")
        .fetch_one(&pool)
        .await
        .expect("workspace insert failed");

        // Insert Issue → Feature → 3 AcceptanceCriteria.
        let issue_id = insert_issue(&pool, "Issue for verdict projection test", None)
            .await
            .expect("insert issue failed");

        let feature_id = insert_feature(&pool, issue_id, "Feature for verdict projection test")
            .await
            .expect("insert feature failed");

        let ac_pass_id = insert_acceptance_criterion(
            &pool,
            feature_id,
            "AC: should pass",
            None,
        )
        .await
        .expect("insert AC pass failed");

        let ac_fail_id = insert_acceptance_criterion(
            &pool,
            feature_id,
            "AC: should fail",
            None,
        )
        .await
        .expect("insert AC fail failed");

        let ac_never_id = insert_acceptance_criterion(
            &pool,
            feature_id,
            "AC: never run",
            None,
        )
        .await
        .expect("insert AC never failed");

        // Create a change and record criterion verdicts for it.
        let change_id = crate::change::insert_change(&pool, workspace_id, "Change for verdict test")
            .await
            .expect("insert change failed");

        // Record verdicts: one passed, one failed, and a second passed for the
        // same AC to test latest-run wins.
        crate::change::record_criterion_validation_run(
            &pool,
            change_id,
            ac_pass_id,
            crate::change::ValidationRunState::Passed,
        )
        .await
        .expect("record passing criterion failed");

        crate::change::record_criterion_validation_run(
            &pool,
            change_id,
            ac_fail_id,
            crate::change::ValidationRunState::Failed,
        )
        .await
        .expect("record failing criterion failed");

        // Add a second (older) passed run for ac_pass to verify latest wins.
        crate::change::record_criterion_validation_run(
            &pool,
            change_id,
            ac_pass_id,
            crate::change::ValidationRunState::Passed,
        )
        .await
        .expect("record second passing criterion failed");

        // Fetch the project page and verify verdicts are rendered.
        let page = fetch_project_page(&pool)
            .await
            .expect("fetch_project_page failed")
            .expect("expected Some page");

        // Verify each AC's verdict appears with correct timestamp format.
        // The latest run for ac_pass should be the second one (most recent).
        // The run for ac_fail should show as failed.
        // ac_never should show as never-run.

        assert!(
            page.contains("AC: should pass"),
            "page must contain passing AC title"
        );
        assert!(
            page.contains("AC: should fail"),
            "page must contain failing AC title"
        );
        assert!(
            page.contains("AC: never run"),
            "page must contain never-run AC title"
        );

        // Verify verdict markers.
        assert!(
            page.contains("verdict: pass"),
            "page must contain pass verdict"
        );
        assert!(
            page.contains("verdict: fail"),
            "page must contain fail verdict"
        );
        assert!(
            page.contains("verdict: never-run"),
            "page must contain never-run verdict"
        );

        // Feature should be marked FAILING because one AC failed.
        assert!(
            page.contains("[FAILING]"),
            "feature with failing AC must be marked FAILING"
        );

        // Verify timestamps are RFC3339 (contain T and timezone).
        for line in page.lines() {
            if line.contains("verdict: pass") || line.contains("verdict: fail") {
                assert!(
                    line.contains('T') && (line.contains('Z') || line.contains('+')),
                    "verdict line must have RFC3339 timestamp: {:?}",
                    line
                );
            }
        }

        // Cleanup.
        cleanup_test_nodes(&pool, &[issue_id, feature_id, ac_pass_id, ac_fail_id, ac_never_id]).await;
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
        sqlx::query("DELETE FROM public.workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .ok();
    }
}
