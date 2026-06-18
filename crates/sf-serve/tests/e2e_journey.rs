//! End-to-end acceptance-harness scaffolding — the five-step journey.
//!
//! # dev-scout seam (issue #678, downstream #675)
//!
//! This file scaffolds the **end-to-end acceptance harness** that drives Dana's
//! five-step first-run journey:
//!
//! ```text
//!   ① deploy the appliance
//!   ② open the control panel
//!   ③ describe TaskTrack into the brain
//!   ④ features become engineering tasks
//!   ⑤ watch the work queue build it
//! ```
//!
//! (See `code-reviews/product-progress-2026-06-17T180613.md` §"The journey at a
//! glance".)
//!
//! Today the harness runs an **empty walkthrough end to end**: each step is a
//! no-op [`JourneyStep`] that records it was reached and returns `Ok(())`. The
//! `empty_journey_runs_end_to_end` test executes all five steps with **no DB,
//! no network, and no behaviour change** — it proves the harness wiring runs so
//! #675 can fill each step with the real acceptance assertions (deploy probe,
//! sign-in, ingest, derive, monitor) without restructuring the runner.
//!
//! The single step that *can* be exercised without external dependencies today
//! — building the HTTP router and hitting the unauthenticated `GET /health`
//! liveness probe (the readiness gate the real journey waits on between ① and
//! ②) — is wired as a concrete check in `health_probe_is_reachable` to prove the
//! harness can drive the serving layer. Everything DB/agent-bound stays a no-op
//! stub.
//!
//! # Canonical docs
//!
//! - `code-reviews/product-progress-2026-06-17T180613.md` §First-run journey.
//! - `docs/architecture.md` §Control Webapp.
//! - Issue #678 (this scaffolding), #675 (the real acceptance walkthrough).

use std::fmt;

/// One step of the five-step acceptance journey.
///
/// **dev-scout:** the `run` closure is a no-op today. #675 replaces each step's
/// body with the real acceptance assertion for that stage while keeping this
/// shape, so the runner ([`run_journey`]) and its reporting stay unchanged.
struct JourneyStep {
    /// Stage marker (`①`..`⑤`) and short name, for harness output.
    label: &'static str,
    /// The step body. Returns `Err(reason)` to fail the walkthrough.
    run: fn() -> Result<(), String>,
}

impl fmt::Debug for JourneyStep {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JourneyStep({})", self.label)
    }
}

/// The five journey steps in order. Each body is a no-op stub for #675 to fill.
fn journey_steps() -> Vec<JourneyStep> {
    vec![
        JourneyStep {
            label: "① deploy the appliance",
            run: || Ok(()),
        },
        JourneyStep {
            label: "② open the control panel",
            run: || Ok(()),
        },
        JourneyStep {
            label: "③ describe TaskTrack into the brain",
            run: || Ok(()),
        },
        JourneyStep {
            label: "④ features become engineering tasks",
            run: || Ok(()),
        },
        JourneyStep {
            label: "⑤ watch the work queue build it",
            run: || Ok(()),
        },
    ]
}

/// Run the journey end to end, returning the ordered list of labels reached.
///
/// Stops at the first step that returns `Err`, propagating the reason. With the
/// no-op stub bodies this always reaches all five steps.
fn run_journey() -> Result<Vec<&'static str>, String> {
    let mut reached = Vec::new();
    for step in journey_steps() {
        (step.run)().map_err(|e| format!("{}: {e}", step.label))?;
        reached.push(step.label);
    }
    Ok(reached)
}

/// The empty five-step walkthrough runs end to end (no DB, no network).
///
/// Acceptance criterion (#678): "The e2e harness scaffolding executes a no-op
/// journey run." #675 fills each step with the real assertion.
#[test]
fn empty_journey_runs_end_to_end() {
    let reached = run_journey().expect("empty journey walkthrough must run end to end");
    assert_eq!(reached.len(), 5, "all five journey steps must be reached");
    assert_eq!(reached.first().copied(), Some("① deploy the appliance"));
    assert_eq!(
        reached.last().copied(),
        Some("⑤ watch the work queue build it")
    );
}

/// The harness can build the serving router and reach the `GET /health` probe.
///
/// This is the readiness gate the real journey waits on between steps ① and ②.
/// It needs no database session (the probe is unauthenticated), so it runs in
/// offline CI and proves the harness can drive the serving layer end to end.
#[tokio::test]
async fn health_probe_is_reachable() {
    use axum::body::Body;
    use http::{Request, StatusCode};
    use sf_serve::{build_router, ServeConfig};
    use tower::ServiceExt as _;

    // A lazy pool: `build_router` only needs the handle, not a live connection,
    // and the `/health` route never touches the database.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://invalid:invalid@127.0.0.1:1/none")
        .expect("lazy pool construction must not connect");

    let router = build_router(pool, &ServeConfig::default());

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .expect("request build"),
        )
        .await
        .expect("router must respond to /health");

    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "health probe must be 200 OK without auth or a DB connection"
    );
}
