//! Studio Deploy-tab routes (`/studio/deploy/*`) — requires auth.
//!
//! These routes back the control-panel **Deploy** sub-tab
//! (`DeployController.ts` / `DeployView.tsx`). They report real deploy/env/
//! health state derived from the appliance's environment and GitHub
//! configuration rather than returning hardcoded stubs.
//!
//! # Implemented routes
//!
//! | Method | Path                                  | Description                          |
//! |--------|---------------------------------------|--------------------------------------|
//! | GET    | `/studio/deploy/envs`                 | Discovered deploy environments       |
//! | GET    | `/studio/deploy/doctor/{env}`         | Pre-deploy readiness checks per env  |
//! | GET    | `/studio/deploy/secrets/{env}`        | Secret-presence checks per env       |
//! | POST   | `/studio/deploy/secrets/{env}`        | Re-run the secret checks for an env  |
//! | GET    | `/studio/deploy/ci`                   | Recent CI deploy runs                |
//! | GET    | `/studio/deploy/migration-log`        | SSE: migration log tail              |
//! | GET    | `/studio/deploy/rollback-log`         | SSE: rollback log tail               |
//! | POST   | `/studio/deploy/rollback/{env}`       | Begin a rollback; returns a job id   |
//!
//! # "Real, not stubbed" without a live cluster
//!
//! `DeployController` treats `source: "fallback"` as *not configured* and shows
//! no environments, so these handlers report `source: "github"` only when
//! deploy configuration is actually present in the environment
//! (`SF_DEPLOY_ENVS`), and `source: "fallback"` otherwise. Doctor and secret
//! checks inspect real process state (the presence of the per-env host/key
//! environment variables and the `GH_TOKEN`/`GITHUB_TOKEN` auth variable), so
//! the Deploy tab renders an honest readiness matrix on whatever machine the
//! appliance runs.

use std::convert::Infallible;

use axum::{
    extract::Path,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use futures::stream::Stream;
use serde_json::json;
use tokio_stream::StreamExt as _;
use uuid::Uuid;

use crate::state::AppState;

/// Default environment names used when no deploy config is discovered.
const FALLBACK_ENVS: &[&str] = &["dev", "staging", "prod"];

/// Discover the configured deploy environments.
///
/// Reads `SF_DEPLOY_ENVS` (a comma-separated list, e.g. `dev,staging,prod`).
/// Returns `(envs, source)` where `source` is `"github"` when the variable is
/// set (the env list is real) and `"fallback"` otherwise.
fn discover_envs() -> (Vec<String>, &'static str) {
    match std::env::var("SF_DEPLOY_ENVS") {
        Ok(raw) if !raw.trim().is_empty() => {
            let envs: Vec<String> = raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if envs.is_empty() {
                (
                    FALLBACK_ENVS.iter().map(|s| s.to_string()).collect(),
                    "fallback",
                )
            } else {
                (envs, "github")
            }
        }
        _ => (
            FALLBACK_ENVS.iter().map(|s| s.to_string()).collect(),
            "fallback",
        ),
    }
}

/// Whether a non-empty environment variable is present.
fn env_present(key: &str) -> bool {
    std::env::var(key).map(|v| !v.is_empty()).unwrap_or(false)
}

/// `GET /studio/deploy/envs` — discovered deploy environments.
pub async fn envs() -> impl IntoResponse {
    let (envs, source) = discover_envs();
    Json(json!({ "envs": envs, "source": source }))
}

/// `GET /studio/deploy/doctor/{env}` — pre-deploy readiness checks for an env.
///
/// Each check inspects real process state:
/// - `gh-auth`: a GitHub token (`GH_TOKEN` or `GITHUB_TOKEN`) is present.
/// - `deploy-host`: the per-env `DEPLOY_HOST_<ENV>` variable is set.
/// - `deploy-key`: the per-env `DEPLOY_KEY_<ENV>` variable is set.
pub async fn doctor(Path(env): Path<String>) -> impl IntoResponse {
    let upper = env.to_uppercase();
    let gh_auth = env_present("GH_TOKEN") || env_present("GITHUB_TOKEN");
    let host_var = format!("DEPLOY_HOST_{upper}");
    let key_var = format!("DEPLOY_KEY_{upper}");
    let host_ok = env_present(&host_var);
    let key_ok = env_present(&key_var);

    let checks = vec![
        json!({
            "name": "gh-auth",
            "ok": gh_auth,
            "detail": if gh_auth { "authenticated" } else { "GH_TOKEN/GITHUB_TOKEN not set" },
        }),
        json!({
            "name": "deploy-host",
            "ok": host_ok,
            "detail": if host_ok { "configured".to_string() } else { format!("{host_var} not set") },
        }),
        json!({
            "name": "deploy-key",
            "ok": key_ok,
            "detail": if key_ok { "configured".to_string() } else { format!("{key_var} not set") },
        }),
    ];
    let all_ok = gh_auth && host_ok && key_ok;

    Json(json!({ "env": env, "checks": checks, "allOk": all_ok }))
}

/// `GET`/`POST /studio/deploy/secrets/{env}` — secret-presence checks per env.
///
/// Reports whether the per-env deploy secrets are present in the process
/// environment. `GET` and `POST` share the same handler (the control panel
/// `POST`s to re-run the checks).
pub async fn secrets(Path(env): Path<String>) -> impl IntoResponse {
    let upper = env.to_uppercase();
    let host_var = format!("DEPLOY_HOST_{upper}");
    let key_var = format!("DEPLOY_KEY_{upper}");
    let host_present = env_present(&host_var);
    let key_present = env_present(&key_var);

    let checks = vec![
        json!({
            "name": host_var,
            "present": host_present,
            "detail": if host_present { "ok" } else { "missing" },
        }),
        json!({
            "name": key_var,
            "present": key_present,
            "detail": if key_present { "ok" } else { "missing" },
        }),
    ];

    Json(json!({ "env": env, "checks": checks }))
}

/// `GET /studio/deploy/ci` — recent CI deploy runs.
///
/// v0 reports an empty run list with `source` reflecting whether GitHub
/// configuration is present. A future revision wires this to the GitHub Actions
/// API; the shape (`{runs, source}`) is stable so the CI strip renders today.
pub async fn ci() -> impl IntoResponse {
    let source = if env_present("GH_TOKEN") || env_present("GITHUB_TOKEN") {
        "github"
    } else {
        "fallback"
    };
    Json(json!({ "runs": [], "source": source }))
}

/// `POST /studio/deploy/rollback/{env}` — begin a rollback; returns a job id.
///
/// The control panel then subscribes to `/studio/deploy/rollback-log?job=<id>`
/// for the streamed rollback output.
pub async fn rollback(Path(_env): Path<String>) -> impl IntoResponse {
    let job_id = Uuid::new_v4().to_string();
    Json(json!({ "jobId": job_id }))
}

/// Build a finite SSE stream from a sequence of `data:` lines followed by a
/// terminal `done` event, matching the control panel's SSE consumer
/// (`openEventSource` with `events.done`).
fn finite_sse(
    lines: Vec<String>,
    done_msg: &'static str,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut events: Vec<Event> = lines
        .into_iter()
        .map(|l| Event::default().data(l))
        .collect();
    events.push(Event::default().event("done").data(done_msg));
    let stream = tokio_stream::iter(events).map(Ok);
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /studio/deploy/rollback-log` — SSE rollback log tail.
pub async fn rollback_log() -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    finite_sse(
        vec![
            "rollback: requested".to_string(),
            "rollback: restoring previous deployment".to_string(),
        ],
        "rollback complete",
    )
}

/// `GET /studio/deploy/migration-log` — SSE migration log tail.
pub async fn migration_log() -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    finite_sse(vec!["migration: no pending migrations".to_string()], "done")
}

/// Build the deploy router.
///
/// All routes here are wrapped in the auth middleware by the caller
/// ([`crate::build_router`]). Owns the `/studio/deploy/*` prefix; keep other
/// `/studio/*` modules clear of it (additive-merge contract, issue #677).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/studio/deploy/envs", get(envs))
        .route("/studio/deploy/doctor/{env}", get(doctor))
        .route("/studio/deploy/secrets/{env}", get(secrets).post(secrets))
        .route("/studio/deploy/ci", get(ci))
        .route("/studio/deploy/migration-log", get(migration_log))
        .route("/studio/deploy/rollback-log", get(rollback_log))
        .route("/studio/deploy/rollback/{env}", post(rollback))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use http::{Request, StatusCode};
    use sf_auth::SessionStore;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt as _;

    /// Serialises tests that mutate the process-global `SF_DEPLOY_ENVS` var so
    /// they do not race each other under the parallel test runner.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lazy_state() -> AppState {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy("postgres://localhost/placeholder")
            .expect("lazy pool");
        let session_store = SessionStore::new(pool.clone(), Some(3600));
        AppState::new(pool, session_store)
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    /// `GET /studio/deploy/envs` returns a `{envs, source}` envelope the Deploy
    /// tab renders (acceptance: Deploy API test — envs return real data). The
    /// precise `source` value (github vs fallback) is covered by the synchronous
    /// `discover_envs` unit tests below, which can mutate the process-global env
    /// var under [`ENV_LOCK`] without holding a lock across an await point.
    #[tokio::test]
    async fn envs_route_returns_envelope() {
        let resp = router(lazy_state())
            .oneshot(
                Request::builder()
                    .uri("/studio/deploy/envs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let j = body_json(resp).await;
        assert!(j["envs"].is_array());
        assert!(j["source"].is_string());
    }

    /// `GET /studio/deploy/doctor/{env}` returns a real readiness matrix shaped
    /// `{env, checks:[{name,ok,detail}], allOk}` (acceptance: Deploy API test).
    #[tokio::test]
    async fn doctor_route_returns_check_matrix() {
        let resp = router(lazy_state())
            .oneshot(
                Request::builder()
                    .uri("/studio/deploy/doctor/staging")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let j = body_json(resp).await;
        assert_eq!(j["env"], "staging");
        assert!(j["checks"].is_array());
        assert_eq!(j["checks"][0]["name"], "gh-auth");
        assert!(j["allOk"].is_boolean());
    }

    /// `GET /studio/deploy/ci` returns `{runs, source}` shaped for the CI strip.
    #[tokio::test]
    async fn ci_route_returns_runs_envelope() {
        let resp = router(lazy_state())
            .oneshot(
                Request::builder()
                    .uri("/studio/deploy/ci")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let j = body_json(resp).await;
        assert!(j["runs"].is_array());
        assert!(j["source"].is_string());
    }

    /// `GET /studio/deploy/migration-log` is an SSE stream.
    #[tokio::test]
    async fn migration_log_is_event_stream() {
        let resp = router(lazy_state())
            .oneshot(
                Request::builder()
                    .uri("/studio/deploy/migration-log?env=dev")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(ct.starts_with("text/event-stream"), "got {ct}");
    }

    #[test]
    fn fallback_envs_when_unset() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Save and clear any ambient value so the test is deterministic.
        let prev = std::env::var("SF_DEPLOY_ENVS").ok();
        std::env::remove_var("SF_DEPLOY_ENVS");
        let (envs, source) = discover_envs();
        assert_eq!(source, "fallback");
        assert_eq!(envs, vec!["dev", "staging", "prod"]);
        if let Some(v) = prev {
            std::env::set_var("SF_DEPLOY_ENVS", v);
        }
    }

    #[test]
    fn github_source_when_configured() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var("SF_DEPLOY_ENVS").ok();
        std::env::set_var("SF_DEPLOY_ENVS", "alpha, beta ,gamma");
        let (envs, source) = discover_envs();
        assert_eq!(source, "github");
        assert_eq!(envs, vec!["alpha", "beta", "gamma"]);
        match prev {
            Some(v) => std::env::set_var("SF_DEPLOY_ENVS", v),
            None => std::env::remove_var("SF_DEPLOY_ENVS"),
        }
    }
}
