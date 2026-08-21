//! Acceptance-criterion executor (issue #861).
//!
//! docs/eval-design.md sequencing item 1 (plan of record, 2026-07-02) makes
//! executable acceptance criteria the binding gate before any outcome
//! guarantee is claimed. `AcceptanceCriterion` nodes exist in
//! `nexum.project_nodes` (see `sf_db::project_graph`) but until this module
//! nothing executed them and nothing recorded whether the user got what they
//! expected. This module:
//!
//! 1. Dispatches each attached criterion by its [`sf_db::AssertionKind`]
//!    (`http-probe`, `playwright`, `required-test`) — [`execute_criterion`].
//! 2. Records exactly one verdict row per criterion in
//!    `forge.validation_runs` via
//!    [`sf_db::record_criterion_validation_run`] — [`execute_and_record`].
//! 3. Never produces a "skipped" result: every criterion resolves to
//!    [`sf_db::ValidationRunState::Passed`] or
//!    [`sf_db::ValidationRunState::Failed`], including every execution error
//!    (test-coverage-policy invariant 1, "loud-skip, never silent-skip").
//!
//! # Fail-closed contract
//!
//! An executor that cannot run a criterion — an unreachable http-probe
//! target, a missing required-test binary/workspace, an unprovisioned
//! Playwright runtime — records a `failed` verdict carrying a human-readable
//! error detail. There is no "errored" or "skipped" [`sf_db::ValidationRunState`]
//! variant; a criterion that cannot be executed is a criterion that did not
//! demonstrate the user got what they expected, so it fails exactly like a
//! criterion that ran and produced the wrong answer.
//!
//! # http-probe target resolution — scoping decision (issue #861)
//!
//! `docs/eval-design.md` names "the deployed preview" as the http-probe
//! target, but dev-scout #869 confirmed there is **no preview-deployment or
//! URL-registry mechanism anywhere in this codebase** —
//! `crates/fastenv/src/deployment.rs` only does host-local
//! (`127.0.0.1:<port>`) addressing for workloads it supervises directly, and
//! the appliance's own `0.0.0.0:7000` bind is the Studio dashboard, not a
//! generated Feature's deployed app.
//!
//! Rather than block this issue on a not-yet-planned preview-deployment
//! feature, [`ExecutionContext::http_probe_base_url`] scopes the initial cut
//! to whatever host-local base URL the caller resolves for the change's
//! fastenv-provisioned workload (matching the `127.0.0.1:<port>` addressing
//! `crates/fastenv` already uses). When no base URL is configured, every
//! `http-probe` criterion fails closed with a "no probe target resolvable"
//! detail rather than silently skipping. Resolving a real routable preview
//! URL is tracked as follow-up work if/when a preview-deployment mechanism
//! is planned.
//!
//! # Playwright — fail-closed, no browser runtime (issue #861 / #810)
//!
//! Dev-scout #869 confirmed no browser/Node runtime is provisioned anywhere
//! in this stack (`ghcr.io/superfield-ai/ci-runner:latest` ships only
//! `python3` + `curl`; #810 deliberately omits Node from arbitrary `run:`
//! steps). Every `playwright` criterion therefore always records a `failed`
//! verdict with an explicit "playwright runtime not provisioned" detail —
//! never a skip or a synthetic pass. Provisioning a real headless browser is
//! out of scope here (track separately if/when needed).
//!
//! # Loop wiring
//!
//! [`execute_criteria_for_feature_change`] is the call site
//! `crate::steps::code_change_proposal` invokes once a code-change proposal
//! for a `Feature` node compiles and merges. [`resolve_attached_criteria`]
//! documents why it resolves to an empty list today: `nexum.project_nodes`
//! does not yet carry `assertion_kind`/`assertion_params` columns (that
//! migration belongs to the sibling assertion-schema feature, tracked as
//! issue #860, intaken in parallel and explicitly out of scope here per the
//! issue's Scope section). Until #860 ships, a Feature's attached
//! `AcceptanceCriterion` nodes carry no machine-readable spec to dispatch by
//! kind, so the honest behaviour is "no *resolvable* criteria" — the same
//! "no criteria, no synthetic pass" contract the executor already
//! guarantees, extended to cover the current schema gap. [`execute_and_record`]
//! and [`record_criterion_validation_run`](sf_db::record_criterion_validation_run)
//! need no changes once #860 lands a real resolver.
//!
//! # Canonical docs
//!
//! - `docs/eval-design.md` §"The missing primitive: executable acceptance
//!   criteria".
//! - `docs/architecture.md` §Change Lifecycle and Validation Gate.
//! - `crates/sf-db/src/change.rs` §"Per-criterion verdict-row seam".
//! - `crates/sf-db/src/project_graph.rs` §"Assertion schema stub".

use std::path::PathBuf;
use std::time::Duration;

use sf_db::{AssertionKind, AssertionSpec, ChangeError, ProjectGraphError, ValidationRunState};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

/// An `AcceptanceCriterion` node paired with the [`AssertionSpec`] the
/// executor dispatches by kind.
///
/// The pairing is supplied by the caller rather than read from storage here:
/// today no write path populates a machine-readable spec on an
/// `AcceptanceCriterion` node (see the module doc comment's "Loop wiring"
/// section) — this type is the stable seam a future resolver (or a test)
/// builds against.
#[derive(Debug, Clone)]
pub struct AttachedCriterion {
    /// The `AcceptanceCriterion` node id (`nexum.project_nodes.id`) this
    /// criterion verdict is recorded against.
    pub criterion_node_id: Uuid,
    /// The assertion this criterion dispatches by kind.
    pub spec: AssertionSpec,
}

/// The outcome of executing one [`AttachedCriterion`].
#[derive(Debug, Clone)]
pub struct CriterionVerdict {
    /// The criterion this verdict is for.
    pub criterion_node_id: Uuid,
    /// The dispatched assertion kind.
    pub kind: AssertionKind,
    /// The terminal verdict state — always [`ValidationRunState::Passed`] or
    /// [`ValidationRunState::Failed`], never `Queued`/`Running` (fail-closed
    /// contract, see module doc comment).
    pub state: ValidationRunState,
    /// Human-readable detail, always present on a failed verdict (why it
    /// failed, or why it could not be executed). `None` on a pass.
    pub detail: Option<String>,
}

/// Runtime configuration the executor consults to resolve criterion targets.
///
/// Every field defaults to `None`, which fails every criterion of the
/// corresponding kind closed with an explicit "not resolvable"/"not
/// provisioned" detail rather than silently skipping it.
#[derive(Debug, Clone, Default)]
pub struct ExecutionContext {
    /// The host-local base URL (e.g. `"http://127.0.0.1:8080"`) of the
    /// fastenv-provisioned workload for this change, consulted by
    /// `http-probe` criteria. See the module doc comment's http-probe
    /// scoping-decision section.
    pub http_probe_base_url: Option<String>,
    /// The Cargo workspace root a `required-test` criterion's `cargo test`
    /// invocation runs against.
    pub required_test_workspace_root: Option<PathBuf>,
}

/// Errors from the loop-wiring call site ([`execute_criteria_for_feature_change`]).
#[derive(Debug, Error)]
pub enum AcceptanceError {
    /// A project-graph read failed while resolving attached criteria.
    #[error("project graph error: {0}")]
    ProjectGraph(#[from] ProjectGraphError),
    /// A change-lifecycle/validation-run write failed.
    #[error("change lifecycle error: {0}")]
    Change(#[from] ChangeError),
}

// ---------------------------------------------------------------------------
// Per-kind execution
// ---------------------------------------------------------------------------

/// Build the `reqwest` client used for `http-probe` criteria: a short,
/// bounded timeout so an unreachable or hanging target fails the criterion
/// promptly instead of stalling the loop.
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn execute_http_probe(
    params: &sf_db::HttpProbeParams,
    ctx: &ExecutionContext,
) -> (ValidationRunState, Option<String>) {
    let Some(base) = ctx.http_probe_base_url.as_deref() else {
        return (
            ValidationRunState::Failed,
            Some(
                "http-probe: no probe target resolvable — no fastenv workload base URL \
                 configured for this change (see acceptance module doc comment's http-probe \
                 scoping decision)"
                    .to_string(),
            ),
        );
    };

    let url = format!("{}{}", base.trim_end_matches('/'), params.path);
    let method =
        reqwest::Method::from_bytes(params.method.as_bytes()).unwrap_or(reqwest::Method::GET);

    match http_client().request(method, &url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status == params.expected_status {
                (ValidationRunState::Passed, None)
            } else {
                (
                    ValidationRunState::Failed,
                    Some(format!(
                        "http-probe: {url} returned status {status}, expected {}",
                        params.expected_status
                    )),
                )
            }
        }
        Err(e) => (
            ValidationRunState::Failed,
            Some(format!("http-probe: request to {url} failed: {e}")),
        ),
    }
}

/// Playwright criteria always fail closed: no headless browser/Node runtime
/// is provisioned anywhere in this stack (dev-scout #869, issue #810). See
/// the module doc comment.
fn execute_playwright(params: &sf_db::PlaywrightParams) -> (ValidationRunState, Option<String>) {
    (
        ValidationRunState::Failed,
        Some(format!(
            "playwright: headless browser/Node runtime not provisioned in this execution \
             environment (issue #810 scope) — cannot check {:?} ({}), failing closed rather than \
             skipping",
            params.path, params.expectation
        )),
    )
}

async fn execute_required_test(
    params: &sf_db::RequiredTestParams,
    ctx: &ExecutionContext,
) -> (ValidationRunState, Option<String>) {
    let Some(root) = ctx.required_test_workspace_root.as_ref() else {
        return (
            ValidationRunState::Failed,
            Some(
                "required-test: no workspace root configured to run this test against".to_string(),
            ),
        );
    };

    let output = tokio::process::Command::new("cargo")
        .args(["test", "--quiet", &params.test_name])
        .current_dir(root)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            // Guard the "exit 0 != tested" false-green case (test-coverage
            // policy invariant 2): a name filter matching zero tests still
            // exits 0. Require evidence at least one test actually ran.
            let stdout = String::from_utf8_lossy(&out.stdout);
            let ran_something = stdout
                .lines()
                .any(|l| l.contains("test result: ok") && !l.contains("0 passed"));
            if ran_something {
                (ValidationRunState::Passed, None)
            } else {
                (
                    ValidationRunState::Failed,
                    Some(format!(
                        "required-test: '{}' matched zero executed tests — treated as failed, \
                         never a synthetic pass",
                        params.test_name
                    )),
                )
            }
        }
        Ok(out) => (
            ValidationRunState::Failed,
            Some(format!(
                "required-test: '{}' failed: {}",
                params.test_name,
                String::from_utf8_lossy(&out.stderr)
            )),
        ),
        Err(e) => (
            ValidationRunState::Failed,
            Some(format!(
                "required-test: execution error running '{}': {e}",
                params.test_name
            )),
        ),
    }
}

/// Dispatch one [`AssertionSpec`] by kind, returning its terminal verdict.
///
/// Never returns anything other than [`ValidationRunState::Passed`] or
/// [`ValidationRunState::Failed`] (see module doc comment's fail-closed
/// contract).
pub async fn execute_criterion(
    spec: &AssertionSpec,
    ctx: &ExecutionContext,
) -> (ValidationRunState, Option<String>) {
    match spec {
        AssertionSpec::HttpProbe(p) => execute_http_probe(p, ctx).await,
        AssertionSpec::Playwright(p) => execute_playwright(p),
        AssertionSpec::RequiredTest(p) => execute_required_test(p, ctx).await,
    }
}

// ---------------------------------------------------------------------------
// Executor + recording
// ---------------------------------------------------------------------------

/// Execute every attached criterion and record exactly one verdict row per
/// criterion in `forge.validation_runs`.
///
/// A Feature with zero attached criteria (`criteria.is_empty()`) never
/// touches the database — zero criterion verdict rows are written and no
/// synthetic pass is inserted.
///
/// # Errors
///
/// Propagates [`ChangeError`] if a verdict cannot be recorded (e.g. the
/// change does not exist).
pub async fn execute_and_record(
    pool: &PgPool,
    change_id: Uuid,
    criteria: &[AttachedCriterion],
    ctx: &ExecutionContext,
) -> Result<Vec<CriterionVerdict>, ChangeError> {
    let mut verdicts = Vec::with_capacity(criteria.len());

    for criterion in criteria {
        let (state, detail) = execute_criterion(&criterion.spec, ctx).await;

        sf_db::record_criterion_validation_run(pool, change_id, criterion.criterion_node_id, state)
            .await?;

        if let Some(d) = &detail {
            tracing::warn!(
                criterion_node_id = %criterion.criterion_node_id,
                kind = criterion.spec.kind().as_str(),
                detail = %d,
                "acceptance criterion did not pass"
            );
        }

        verdicts.push(CriterionVerdict {
            criterion_node_id: criterion.criterion_node_id,
            kind: criterion.spec.kind(),
            state,
            detail,
        });
    }

    Ok(verdicts)
}

// ---------------------------------------------------------------------------
// Loop wiring
// ---------------------------------------------------------------------------

/// Resolve the [`AttachedCriterion`]s for a `Feature` node from the project
/// graph, for the loop-wiring call site.
///
/// # Scope note (issue #861)
///
/// `nexum.project_nodes` does not yet carry `assertion_kind` /
/// `assertion_params` columns — the sibling assertion-schema feature (#860,
/// intaken in parallel, explicitly out of scope here) owns that migration
/// and the write path that populates it (see
/// `crates/sf-db/src/project_graph.rs`'s assertion-schema stub;
/// [`sf_db::insert_acceptance_criterion`] still stores only a title). Until
/// #860 ships, an `AcceptanceCriterion` node attached to a Feature carries no
/// machine-readable spec to dispatch by kind, so this resolver logs how many
/// `AcceptanceCriterion` children the Feature has (for operator visibility)
/// but returns an empty list rather than guessing at a kind. This is the same
/// "no criteria, no synthetic pass" contract [`execute_and_record`] already
/// guarantees, extended honestly to "no *resolvable* criteria". Swap this
/// resolver's body for a real query once assertion_kind/assertion_params
/// exist; [`execute_and_record`] needs no changes.
pub async fn resolve_attached_criteria(
    pool: &PgPool,
    feature_node_id: Uuid,
) -> Result<Vec<AttachedCriterion>, ProjectGraphError> {
    let nodes = sf_db::traverse_project_graph(pool).await?;

    let feature_block = nodes
        .iter()
        .find(|n| n.id == feature_node_id)
        .map(|n| n.block_id);

    let attached_count = feature_block
        .map(|fb| {
            nodes
                .iter()
                .filter(|n| n.node_type == "AcceptanceCriterion" && n.parent_block_id == Some(fb))
                .count()
        })
        .unwrap_or(0);

    if attached_count > 0 {
        tracing::warn!(
            feature_node_id = %feature_node_id,
            attached_count,
            "resolve_attached_criteria: {attached_count} AcceptanceCriterion node(s) attached, \
             but no assertion_kind/assertion_params column exists yet (issue #860 not shipped) — \
             executing zero criteria this pass, not a synthetic pass"
        );
    }

    Ok(Vec::new())
}

/// Loop-wiring entry point: execute a Feature's attached acceptance criteria
/// once its code-change proposal compiles and merges, recording one verdict
/// per criterion against a freshly-inserted [`sf_db::Change`].
///
/// No-ops (inserts no `forge.changes` row, records no verdicts) when
/// [`resolve_attached_criteria`] resolves zero criteria for `feature` — see
/// its doc comment for why that is the honest answer until issue #860 ships
/// the assertion-schema migration.
///
/// # Errors
///
/// Propagates [`AcceptanceError`] from either the project-graph read or the
/// change/verdict writes.
pub async fn execute_criteria_for_feature_change(
    pool: &PgPool,
    workspace_id: Uuid,
    feature: &sf_db::ProjectNode,
    change_title: &str,
) -> Result<Vec<CriterionVerdict>, AcceptanceError> {
    let criteria = resolve_attached_criteria(pool, feature.id).await?;
    if criteria.is_empty() {
        return Ok(Vec::new());
    }

    let change_id = sf_db::insert_change(pool, workspace_id, change_title).await?;
    let ctx = ExecutionContext::default();
    let verdicts = execute_and_record(pool, change_id, &criteria, &ctx).await?;
    Ok(verdicts)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// The three DB-gated tests below are deliberately NOT nested under a `mod
// tests` submodule: the issue's acceptance criteria name them by the literal
// nextest selector `cargo nextest -p sf-loop acceptance::<test_name>`, which
// requires the full test path to read `acceptance::<test_name>` with no
// intervening `tests::` segment.

#[cfg(test)]
mod support {
    //! Test-only fixtures shared by the acceptance-executor tests: an
    //! ephemeral axum/hyper HTTP server for `http-probe` criteria, and a
    //! throwaway Cargo crate for `required-test` criteria.

    use std::net::SocketAddr;

    /// Start a minimal axum server on an ephemeral loopback port that always
    /// responds `200 OK` to `GET /health`. Returns its base URL
    /// (`"http://127.0.0.1:<port>"`).
    pub async fn spawn_health_server() -> String {
        let app = axum::Router::new().route(
            "/health",
            axum::routing::get(|| async { (axum::http::StatusCode::OK, "ok") }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let addr: SocketAddr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        format!("http://{addr}")
    }

    /// Write a minimal, dependency-free Cargo crate with one passing test
    /// named `check` into a fresh tempdir. Returns the tempdir (kept alive by
    /// the caller) and its path.
    pub fn fixture_crate_with_passing_test() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().expect("tempdir");
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"criterion-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("write Cargo.toml");
        std::fs::create_dir_all(dir.path().join("src")).expect("mkdir src");
        std::fs::write(
            dir.path().join("src/lib.rs"),
            "#[test]\nfn check() { assert!(true); }\n",
        )
        .expect("write src/lib.rs");
        dir
    }

    /// Insert a fresh `public.workspaces` row and return its id.
    ///
    /// `forge.changes.workspace_id` carries a NOT-NULL FK to
    /// `public.workspaces(id)` (migration 0004), so every DB-gated test here
    /// needs a real tenant row. Seeding one per test — rather than reading a
    /// `WORKSPACE_ID` env var — keeps these tests self-provisioning, so they
    /// execute in any job that supplies only `DATABASE_URL` (the
    /// `rust-test-seam` job does exactly that). Mirrors the idiom already
    /// used by the nexum/sharp/sf-serve DB tests.
    pub async fn seed_workspace(pool: &sqlx::PgPool) -> uuid::Uuid {
        sqlx::query_scalar(
            "INSERT INTO public.workspaces (slug, display_name) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("sf-loop-acceptance-{}", uuid::Uuid::new_v4()))
        .bind("sf-loop acceptance-criteria test workspace")
        .fetch_one(pool)
        .await
        .expect("workspace insert failed")
    }

    /// Delete the change, its validation runs, and the seeded workspace row.
    pub async fn cleanup(pool: &sqlx::PgPool, change_id: uuid::Uuid, workspace_id: uuid::Uuid) {
        sqlx::query("DELETE FROM forge.validation_runs WHERE change_id = $1")
            .bind(change_id)
            .execute(pool)
            .await
            .ok();
        sqlx::query("DELETE FROM forge.changes WHERE id = $1")
            .bind(change_id)
            .execute(pool)
            .await
            .ok();
        sqlx::query("DELETE FROM public.workspaces WHERE id = $1")
            .bind(workspace_id)
            .execute(pool)
            .await
            .ok();
    }
}

#[cfg(test)]
use support::*;

#[cfg(test)]
use sf_db::{HttpProbeParams, PlaywrightParams, RequiredTestParams};

/// Acceptance criterion (#861): a change for a Feature with two attached
/// criteria (one http-probe, one required-test) ends with exactly two
/// verdict rows in `forge.validation_runs`, one per criterion, each carrying
/// kind and verdict.
///
/// Requires `DATABASE_URL` with sf-db migrations 0004+0006 applied, and
/// `cargo` on `PATH` (for the required-test fixture crate). The tenant row is
/// seeded by the test itself via [`support::seed_workspace`].
#[cfg(test)]
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL (sf-db migrations 0004+0006) and cargo on PATH"]
async fn per_criterion_verdicts_recorded() {
    let cfg = sf_db::DbConfig::from_env().expect("DATABASE_URL must be set for integration tests");
    let pool = sf_db::connect(&cfg).await.expect("pool creation failed");
    let workspace_id: Uuid = seed_workspace(&pool).await;

    let change_id = sf_db::insert_change(&pool, workspace_id, "Change for per-criterion verdicts")
        .await
        .expect("insert_change failed");

    let base_url = spawn_health_server().await;
    let fixture = fixture_crate_with_passing_test();

    let criteria = vec![
        AttachedCriterion {
            criterion_node_id: Uuid::new_v4(),
            spec: AssertionSpec::HttpProbe(HttpProbeParams {
                method: "GET".to_string(),
                path: "/health".to_string(),
                expected_status: 200,
            }),
        },
        AttachedCriterion {
            criterion_node_id: Uuid::new_v4(),
            spec: AssertionSpec::RequiredTest(RequiredTestParams {
                test_name: "check".to_string(),
            }),
        },
    ];

    let ctx = ExecutionContext {
        http_probe_base_url: Some(base_url),
        required_test_workspace_root: Some(fixture.path().to_path_buf()),
    };

    let verdicts = execute_and_record(&pool, change_id, &criteria, &ctx)
        .await
        .expect("execute_and_record failed");

    assert_eq!(verdicts.len(), 2, "expected one verdict per criterion");
    assert_eq!(verdicts[0].kind, AssertionKind::HttpProbe);
    assert_eq!(verdicts[0].state, ValidationRunState::Passed);
    assert_eq!(verdicts[1].kind, AssertionKind::RequiredTest);
    assert_eq!(verdicts[1].state, ValidationRunState::Passed);

    let row_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM forge.validation_runs \
         WHERE change_id = $1 AND criterion_node_id IS NOT NULL",
    )
    .bind(change_id)
    .fetch_one(&pool)
    .await
    .expect("count criterion rows failed");
    assert_eq!(row_count, 2, "expected exactly two verdict rows in the DB");

    cleanup(&pool, change_id, workspace_id).await;
}

/// Acceptance criterion (#861): a criterion whose execution errors
/// (unreachable http-probe target, missing required-test workspace,
/// unprovisioned playwright runtime) records a failed verdict with an error
/// detail — never a skip or a pass.
///
/// Requires `DATABASE_URL` with sf-db migrations 0004+0006 applied. The
/// tenant row is seeded by the test itself via [`support::seed_workspace`].
#[cfg(test)]
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL with sf-db migrations 0004+0006 applied"]
async fn execution_error_fails_closed() {
    let cfg = sf_db::DbConfig::from_env().expect("DATABASE_URL must be set for integration tests");
    let pool = sf_db::connect(&cfg).await.expect("pool creation failed");
    let workspace_id: Uuid = seed_workspace(&pool).await;

    let change_id = sf_db::insert_change(&pool, workspace_id, "Change for fail-closed test")
        .await
        .expect("insert_change failed");

    let criteria = vec![
        // Unreachable http-probe target: no listener on this loopback port.
        AttachedCriterion {
            criterion_node_id: Uuid::new_v4(),
            spec: AssertionSpec::HttpProbe(HttpProbeParams {
                method: "GET".to_string(),
                path: "/health".to_string(),
                expected_status: 200,
            }),
        },
        // Missing required-test workspace (no workspace root configured).
        AttachedCriterion {
            criterion_node_id: Uuid::new_v4(),
            spec: AssertionSpec::RequiredTest(RequiredTestParams {
                test_name: "nonexistent".to_string(),
            }),
        },
        // Playwright: always fails closed (no browser runtime provisioned).
        AttachedCriterion {
            criterion_node_id: Uuid::new_v4(),
            spec: AssertionSpec::Playwright(PlaywrightParams {
                path: "/checkout".to_string(),
                expectation: "confirmation toast shown".to_string(),
            }),
        },
    ];

    // No http_probe_base_url and no required_test_workspace_root configured —
    // every criterion above must fail closed with a detail, never a skip.
    let ctx = ExecutionContext::default();

    let verdicts = execute_and_record(&pool, change_id, &criteria, &ctx)
        .await
        .expect("execute_and_record failed");

    assert_eq!(verdicts.len(), 3);
    for verdict in &verdicts {
        assert_eq!(
            verdict.state,
            ValidationRunState::Failed,
            "every execution-error criterion must fail closed, got {:?}",
            verdict
        );
        assert!(
            verdict.detail.as_ref().is_some_and(|d| !d.is_empty()),
            "a failed verdict must carry a non-empty error detail, got {:?}",
            verdict
        );
    }

    let row_states: Vec<String> = sqlx::query_scalar(
        "SELECT state FROM forge.validation_runs \
         WHERE change_id = $1 AND criterion_node_id IS NOT NULL",
    )
    .bind(change_id)
    .fetch_all(&pool)
    .await
    .expect("select criterion states failed");
    assert_eq!(row_states.len(), 3);
    assert!(
        row_states.iter().all(|s| s == "failed"),
        "every recorded row must be 'failed', never a skip or a pass, got {row_states:?}"
    );

    cleanup(&pool, change_id, workspace_id).await;
}

/// Acceptance criterion (#861): a Feature with zero attached criteria
/// produces zero criterion verdict rows — no synthetic passes are inserted
/// and existing run-level behaviour ([`sf_db::has_passing_validation`])
/// is unchanged.
///
/// Requires `DATABASE_URL` with sf-db migrations 0004+0006 applied. The
/// tenant row is seeded by the test itself via [`support::seed_workspace`].
#[cfg(test)]
#[tokio::test]
#[ignore = "integration: requires DATABASE_URL with sf-db migrations 0004+0006 applied"]
async fn no_criteria_no_synthetic_passes() {
    let cfg = sf_db::DbConfig::from_env().expect("DATABASE_URL must be set for integration tests");
    let pool = sf_db::connect(&cfg).await.expect("pool creation failed");
    let workspace_id: Uuid = seed_workspace(&pool).await;

    let change_id = sf_db::insert_change(&pool, workspace_id, "Change with zero criteria")
        .await
        .expect("insert_change failed");

    let ctx = ExecutionContext::default();
    let verdicts = execute_and_record(&pool, change_id, &[], &ctx)
        .await
        .expect("execute_and_record failed");

    assert!(
        verdicts.is_empty(),
        "zero attached criteria must produce zero verdicts, got {verdicts:?}"
    );

    let row_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM forge.validation_runs WHERE change_id = $1")
            .bind(change_id)
            .fetch_one(&pool)
            .await
            .expect("count rows failed");
    assert_eq!(
        row_count, 0,
        "zero criteria must write zero validation_runs rows — no synthetic pass"
    );

    let passing = sf_db::has_passing_validation(&pool, change_id)
        .await
        .expect("has_passing_validation failed");
    assert!(
        !passing,
        "a change with no recorded runs at all must not report a passing validation \
         (unchanged pre-#861 behaviour)"
    );

    cleanup(&pool, change_id, workspace_id).await;
}

/// Pure unit test (no DB): [`execute_playwright`] always fails closed,
/// regardless of parameters.
#[cfg(test)]
#[tokio::test]
async fn playwright_always_fails_closed_no_db() {
    let params = sf_db::PlaywrightParams {
        path: "/x".to_string(),
        expectation: "y".to_string(),
    };
    let (state, detail) = execute_playwright(&params);
    assert_eq!(state, ValidationRunState::Failed);
    assert!(detail.is_some_and(|d| d.contains("not provisioned")));
}

/// Pure unit test (no DB): an http-probe with no configured base URL fails
/// closed with a "not resolvable" detail rather than panicking or hanging.
#[cfg(test)]
#[tokio::test]
async fn http_probe_without_target_fails_closed_no_db() {
    let params = sf_db::HttpProbeParams {
        method: "GET".to_string(),
        path: "/x".to_string(),
        expected_status: 200,
    };
    let ctx = ExecutionContext::default();
    let (state, detail) = execute_http_probe(&params, &ctx).await;
    assert_eq!(state, ValidationRunState::Failed);
    assert!(detail.is_some_and(|d| d.contains("no probe target resolvable")));
}

/// Pure unit test (no DB): a required-test with no configured workspace root
/// fails closed with a "no workspace root" detail.
#[cfg(test)]
#[tokio::test]
async fn required_test_without_workspace_fails_closed_no_db() {
    let params = sf_db::RequiredTestParams {
        test_name: "whatever".to_string(),
    };
    let ctx = ExecutionContext::default();
    let (state, detail) = execute_required_test(&params, &ctx).await;
    assert_eq!(state, ValidationRunState::Failed);
    assert!(detail.is_some_and(|d| d.contains("no workspace root")));
}

/// Pure unit test (no DB): executing zero criteria never touches the pool —
/// asserted by using a lazily-connecting invalid pool that would error on
/// first real query, proving no query was attempted.
#[cfg(test)]
#[tokio::test]
async fn execute_and_record_empty_criteria_never_touches_pool_no_db() {
    // An unreachable connect string; `PgPoolOptions::connect_lazy` never
    // dials until a query runs, so this proves execute_and_record with an
    // empty slice performs no database I/O at all.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://sf_test:sf_test@127.0.0.1:1/sf_test_unreachable")
        .expect("lazy pool construction must not dial");

    let ctx = ExecutionContext::default();
    let verdicts = execute_and_record(&pool, Uuid::new_v4(), &[], &ctx)
        .await
        .expect("empty criteria must succeed without touching the DB");
    assert!(verdicts.is_empty());
}
