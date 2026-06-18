//! Daemon boot/shutdown orchestration for the gardening loop and the appliance
//! workload supervisor.
//!
//! `run_as_daemon` (in `main.rs`) used to start only the HTTP serving layer and
//! never ran the autonomous gardening loop nor supervised the appliance's own
//! app + Postgres workloads — the loop engine ([`sf_loop::GardeningLoop`]) and
//! the real workload supervisor ([`fastenv::deployment::FastenvSupervisor`])
//! were fully built but unwired on the first-run path (issue #671).
//!
//! This module wires them in and, crucially, owns the **shutdown ordering**
//! contract the daemon must honour on `SIGTERM`:
//!
//! ```text
//!   SIGTERM
//!     │
//!     ├─ 1. drain the gardening loop   (LoopHandle::drain — finish current step)
//!     ├─ 2. take appliance down        (ManifestSupervisor::down — app, then Postgres)
//!     └─ 3. stop the Postgres provisioner (PostgresProvisioner::stop)
//! ```
//!
//! The loop is drained *before* the supervisor and provisioner go down so the
//! current gardening step finishes writing its page revision and committing its
//! cursor against a still-live database. On restart the loop resumes from that
//! persisted cursor rather than restarting the step sequence (see
//! [`sf_loop::load_cursor`]).
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle — drain/abort + stop ordering.
//! - `crates/sf-serve/src/loop_handle.rs` — the drain/abort seam contract.
//! - `crates/fastenv/src/deployment.rs` — the appliance workload supervisor.

use std::sync::Arc;

use fastenv::deployment::{
    FastenvManifest, HealthProbe, HostProcessLauncher, ManifestSupervisor, Workload,
};
use sf_db::provisioner::PostgresProvisioner;
use sf_loop::{AgentExecutor, FixtureAgentExecutor, GardeningLoop, LlmAgentExecutor, LoopConfig};
use sf_serve::LoopHandle;

/// Default bind port for the appliance app workload health probe.
const APP_HEALTH_PORT: u16 = 7000;
/// Default Postgres port for the appliance Postgres workload health probe.
const POSTGRES_PORT: u16 = 5432;

/// Build the [`FastenvManifest`] describing the appliance's own long-lived
/// workloads: the Superfield app and its Postgres database.
///
/// Postgres is marked `stateful` so the supervisor starts it before the app and
/// stops it after the app on teardown (so the app drains its connections before
/// the database shuts down). Both carry a TCP health probe so the supervisor can
/// report them `Healthy` once they accept connections.
///
/// `app_image` / `postgres_image` default to the dogfood images when empty.
pub fn appliance_manifest(app_image: &str, postgres_image: &str) -> FastenvManifest {
    let app_image = if app_image.is_empty() {
        "superfield/app:local"
    } else {
        app_image
    };
    let postgres_image = if postgres_image.is_empty() {
        "postgres:16"
    } else {
        postgres_image
    };

    FastenvManifest {
        name: "superfield".to_string(),
        workloads: vec![
            Workload {
                name: "postgres".to_string(),
                image: postgres_image.to_string(),
                command: Vec::new(),
                env: Default::default(),
                stateful: true,
                health: Some(HealthProbe::Tcp {
                    port: POSTGRES_PORT,
                }),
            },
            Workload {
                name: "app".to_string(),
                image: app_image.to_string(),
                command: Vec::new(),
                env: Default::default(),
                stateful: false,
                health: Some(HealthProbe::Tcp {
                    port: APP_HEALTH_PORT,
                }),
            },
        ],
    }
}

/// Construct the [`AgentExecutor`] the gardening loop drives.
///
/// When `SF_OTEL_DISABLED=1` is set (CI / offline) the real [`LlmAgentExecutor`]
/// already short-circuits outbound HTTP and returns a canned response, so it is
/// safe on the first-run path. When no LLM API key is configured we fall back to
/// the deterministic [`FixtureAgentExecutor`] so the loop still ticks against the
/// brain (writes page revisions + commits the cursor) without any network call.
pub fn build_executor(config: &LoopConfig) -> Arc<dyn AgentExecutor> {
    if config.llm_api_key.is_empty() {
        eprintln!(
            "superfield daemon: gardening loop has no SF_LLM_API_KEY; using fixture executor (no LLM calls)"
        );
        Arc::new(FixtureAgentExecutor::default())
    } else {
        Arc::new(LlmAgentExecutor::new(
            config.llm_api_key.clone(),
            config.llm_endpoint.clone(),
            config.llm_model.clone(),
        ))
    }
}

/// Start the appliance workload supervisor and bring its workloads up.
///
/// Returns the constructed supervisor (already `apply`-ed) so the daemon can
/// hold it for the lifetime of the process and call [`ManifestSupervisor::down`]
/// during shutdown. Production uses the host-process launcher; the manifest
/// describes the app + Postgres workloads.
///
/// # Errors
///
/// Propagates any error from [`ManifestSupervisor::apply`] (e.g. a workload
/// failing to launch).
pub fn boot_supervisor(
    manifest: &FastenvManifest,
) -> anyhow::Result<fastenv::deployment::FastenvSupervisor<HostProcessLauncher>> {
    let supervisor = fastenv::deployment::FastenvSupervisor::new(HostProcessLauncher::new());
    supervisor.apply(manifest)?;
    Ok(supervisor)
}

/// The appliance workload whose health drives the control-panel live preview.
///
/// The control panel's `IframePanel` previews the `app` workload (the deployed
/// Superfield app the user is building), so its health is the cluster status the
/// preview reload keys off — not Postgres.
pub const PREVIEW_WORKLOAD: &str = "app";

/// Map a supervisor [`HealthStatus`] to the control-panel
/// [`ClusterStatus`](sf_serve::ClusterStatus) the live-preview stream emits.
///
/// - `Healthy`   → `Healthy`    (probe passed; preview is serving)
/// - `Starting`  → `Restarting` (workload up, probe pending — the hot-swap
///   reload state the `IframePanel` overlays)
/// - `Unhealthy` → `Degraded`   (probe failed / process exited)
/// - `Stopped`   → `Unknown`    (not supervised / no observation)
pub fn cluster_status_from_health(
    health: fastenv::deployment::HealthStatus,
) -> sf_serve::ClusterStatus {
    use fastenv::deployment::HealthStatus;
    use sf_serve::ClusterStatus;
    match health {
        HealthStatus::Healthy => ClusterStatus::Healthy,
        HealthStatus::Starting => ClusterStatus::Restarting,
        HealthStatus::Unhealthy => ClusterStatus::Degraded,
        HealthStatus::Stopped => ClusterStatus::Unknown,
    }
}

/// Seed the orchestrator's cluster status from the live appliance-preview
/// workload health, publishing the mapped [`ClusterStatus`](sf_serve::ClusterStatus)
/// so `/studio/cluster/events` reports a real, supervisor-derived status to
/// every subscriber (including late ones via the stream's snapshot) rather than
/// a hardcoded constant.
///
/// `set_cluster_status` de-dupes, so repeated identical observations broadcast
/// nothing — the stream only ever carries real transitions. A periodic poller
/// that keeps publishing across the daemon's lifetime (so a restart-to-healthy
/// flip mid-session drives the preview reload) is the natural follow-up; this
/// seed wires the producer at boot without restructuring supervisor ownership /
/// the strict shutdown sequence.
pub fn seed_cluster_status(
    supervisor: &dyn ManifestSupervisor,
    orchestrator: &sf_serve::OrchestratorState,
) {
    let health = supervisor
        .health(PREVIEW_WORKLOAD)
        .unwrap_or(fastenv::deployment::HealthStatus::Stopped);
    orchestrator.set_cluster_status(cluster_status_from_health(health));
}

/// Start the gardening loop and return its **real** drain/abort handle.
///
/// This retires [`sf_serve::NoopLoopHandle`] on the running path: the daemon
/// stores the returned [`LoopHandle`] and drains it on shutdown. The loop
/// resumes from its persisted cursor (it loads `orchestrator.gardening_cursor`
/// on its first pass).
pub fn boot_loop(
    pool: sqlx::PgPool,
    config: LoopConfig,
    executor: Arc<dyn AgentExecutor>,
    observer: Option<sf_serve::OrchestratorState>,
) -> Arc<dyn LoopHandle> {
    Arc::new(GardeningLoop::start_observed(
        pool, config, executor, observer,
    ))
}

/// Drain the gardening loop, take the appliance down, and stop the Postgres
/// provisioner — in that strict order.
///
/// This is the single shutdown sequence the daemon runs on `SIGTERM`. The
/// ordering is load-bearing:
///
/// 1. **drain the loop** so the in-flight gardening step finishes against a live
///    database and commits its cursor (enabling clean resume on restart);
/// 2. **supervisor down** so the app stops before Postgres (the supervisor
///    teardown order), draining the app's connections;
/// 3. **provisioner stop** so the daemon-owned Postgres container halts last.
///
/// Each step is best-effort: a failure is logged and the remaining steps still
/// run, so a stuck loop or supervisor never wedges the provisioner shutdown.
pub async fn shutdown(
    loop_handle: &dyn LoopHandle,
    supervisor: &dyn ManifestSupervisor,
    provisioner: &dyn PostgresProvisioner,
) {
    // 1. Drain the gardening loop (finish current step, then stop).
    if let Err(e) = loop_handle.drain().await {
        eprintln!("superfield daemon shutdown: loop drain failed: {}", e);
        // Hard-stop fallback so the loop task cannot wedge teardown.
        if let Err(e) = loop_handle.abort().await {
            eprintln!("superfield daemon shutdown: loop abort failed: {}", e);
        }
    }

    // 2. Take the appliance workloads down (app before Postgres).
    if let Err(e) = supervisor.down() {
        eprintln!("superfield daemon shutdown: supervisor down failed: {}", e);
    }

    // 3. Stop the Postgres provisioner last.
    if let Err(e) = provisioner.stop().await {
        eprintln!("superfield daemon shutdown: provisioner stop failed: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records the order in which shutdown steps run so tests can assert the
    /// drain → down → stop sequence deterministically.
    #[derive(Clone, Default)]
    struct OrderLog(Arc<Mutex<Vec<&'static str>>>);

    impl OrderLog {
        fn push(&self, ev: &'static str) {
            self.0.lock().unwrap().push(ev);
        }
        fn events(&self) -> Vec<&'static str> {
            self.0.lock().unwrap().clone()
        }
    }

    struct RecordingLoop(OrderLog);
    impl LoopHandle for RecordingLoop {
        fn drain(
            &self,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<(), sf_serve::LoopHandleError>> + Send + '_,
            >,
        > {
            let log = self.0.clone();
            Box::pin(async move {
                log.push("drain");
                Ok(())
            })
        }
        fn abort(
            &self,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<(), sf_serve::LoopHandleError>> + Send + '_,
            >,
        > {
            let log = self.0.clone();
            Box::pin(async move {
                log.push("abort");
                Ok(())
            })
        }
    }

    struct RecordingSupervisor(OrderLog);
    impl ManifestSupervisor for RecordingSupervisor {
        fn apply(&self, _m: &FastenvManifest) -> anyhow::Result<()> {
            Ok(())
        }
        fn health(&self, _w: &str) -> anyhow::Result<fastenv::deployment::HealthStatus> {
            Ok(fastenv::deployment::HealthStatus::Healthy)
        }
        fn down(&self) -> anyhow::Result<()> {
            self.0.push("down");
            Ok(())
        }
    }

    struct RecordingProvisioner(OrderLog);
    impl PostgresProvisioner for RecordingProvisioner {
        fn start(
            &self,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<(), sf_db::provisioner::ProvisionerError>>
                    + Send
                    + '_,
            >,
        > {
            Box::pin(async { Ok(()) })
        }
        fn stop(
            &self,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<(), sf_db::provisioner::ProvisionerError>>
                    + Send
                    + '_,
            >,
        > {
            let log = self.0.clone();
            Box::pin(async move {
                log.push("stop");
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn shutdown_drains_then_downs_then_stops_in_order() {
        let log = OrderLog::default();
        let lh = RecordingLoop(log.clone());
        let sup = RecordingSupervisor(log.clone());
        let prov = RecordingProvisioner(log.clone());

        shutdown(&lh, &sup, &prov).await;

        assert_eq!(
            log.events(),
            vec!["drain", "down", "stop"],
            "shutdown must drain the loop, then take the appliance down, then stop the provisioner"
        );
    }

    /// If draining the loop fails, the daemon must fall back to abort and still
    /// run the remaining teardown steps in order.
    #[tokio::test]
    async fn shutdown_aborts_when_drain_fails_then_continues() {
        let log = OrderLog::default();

        struct FailingDrainLoop(OrderLog);
        impl LoopHandle for FailingDrainLoop {
            fn drain(
                &self,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<Output = Result<(), sf_serve::LoopHandleError>>
                        + Send
                        + '_,
                >,
            > {
                let log = self.0.clone();
                Box::pin(async move {
                    log.push("drain");
                    Err(sf_serve::LoopHandleError::DrainChannelClosed)
                })
            }
            fn abort(
                &self,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<Output = Result<(), sf_serve::LoopHandleError>>
                        + Send
                        + '_,
                >,
            > {
                let log = self.0.clone();
                Box::pin(async move {
                    log.push("abort");
                    Ok(())
                })
            }
        }

        let lh = FailingDrainLoop(log.clone());
        let sup = RecordingSupervisor(log.clone());
        let prov = RecordingProvisioner(log.clone());

        shutdown(&lh, &sup, &prov).await;

        assert_eq!(
            log.events(),
            vec!["drain", "abort", "down", "stop"],
            "a failed drain must fall back to abort, then continue the teardown"
        );
    }

    #[test]
    fn appliance_manifest_starts_postgres_before_app() {
        let m = appliance_manifest("", "");
        assert_eq!(m.name, "superfield");
        // Postgres is stateful so the supervisor starts it first / stops it last.
        let pg = m
            .workloads
            .iter()
            .find(|w| w.name == "postgres")
            .expect("postgres workload");
        let app = m
            .workloads
            .iter()
            .find(|w| w.name == "app")
            .expect("app workload");
        assert!(pg.stateful, "postgres must be stateful");
        assert!(!app.stateful, "app must not be stateful");
        assert!(pg.health.is_some(), "postgres must carry a health probe");
        assert!(app.health.is_some(), "app must carry a health probe");
    }

    #[test]
    fn appliance_manifest_honours_image_overrides() {
        let m = appliance_manifest("myorg/app:v2", "postgres:15");
        let pg = m.workloads.iter().find(|w| w.name == "postgres").unwrap();
        let app = m.workloads.iter().find(|w| w.name == "app").unwrap();
        assert_eq!(pg.image, "postgres:15");
        assert_eq!(app.image, "myorg/app:v2");
    }

    /// The real supervisor must launch and health-track the appliance workloads:
    /// after boot both report `Healthy` and are recorded as running.
    #[test]
    fn boot_supervisor_health_tracks_appliance_workloads() {
        // A long-lived no-op command stands in for the real images so the test
        // needs no Docker / Postgres. `sleep` keeps the process alive; the TCP
        // probes are replaced with a no-probe manifest so liveness alone gates
        // health (a live process with no probe is Healthy).
        let manifest = FastenvManifest {
            name: "superfield".to_string(),
            workloads: vec![
                Workload {
                    name: "postgres".to_string(),
                    image: "scratch".to_string(),
                    command: vec!["sleep".to_string(), "30".to_string()],
                    env: Default::default(),
                    stateful: true,
                    health: None,
                },
                Workload {
                    name: "app".to_string(),
                    image: "scratch".to_string(),
                    command: vec!["sleep".to_string(), "30".to_string()],
                    env: Default::default(),
                    stateful: false,
                    health: None,
                },
            ],
        };

        let supervisor = boot_supervisor(&manifest).expect("supervisor must boot");

        // Postgres (stateful) is started before app.
        assert_eq!(
            supervisor.running_workloads(),
            vec!["postgres".to_string(), "app".to_string()],
        );

        for w in &manifest.workloads {
            assert_eq!(
                supervisor.health(&w.name).expect("health query"),
                fastenv::deployment::HealthStatus::Healthy,
                "workload '{}' must be healthy under the real supervisor",
                w.name
            );
        }

        supervisor.down().expect("teardown");
    }

    /// The supervisor-health → cluster-status mapping the live preview keys off.
    #[test]
    fn cluster_status_maps_each_health_state() {
        use fastenv::deployment::HealthStatus;
        use sf_serve::ClusterStatus;
        assert_eq!(
            cluster_status_from_health(HealthStatus::Healthy),
            ClusterStatus::Healthy
        );
        assert_eq!(
            cluster_status_from_health(HealthStatus::Starting),
            ClusterStatus::Restarting
        );
        assert_eq!(
            cluster_status_from_health(HealthStatus::Unhealthy),
            ClusterStatus::Degraded
        );
        assert_eq!(
            cluster_status_from_health(HealthStatus::Stopped),
            ClusterStatus::Unknown
        );
    }

    /// Seeding from a live appliance workload publishes the real, mapped status
    /// onto the orchestrator's cluster stream.
    #[test]
    fn seed_cluster_status_publishes_live_health() {
        let manifest = FastenvManifest {
            name: "superfield".to_string(),
            workloads: vec![Workload {
                name: "app".to_string(),
                image: "scratch".to_string(),
                command: vec!["sleep".to_string(), "30".to_string()],
                env: Default::default(),
                stateful: false,
                health: None,
            }],
        };
        let supervisor = boot_supervisor(&manifest).expect("supervisor must boot");
        let orchestrator = sf_serve::OrchestratorState::new();
        assert_eq!(
            orchestrator.cluster_status(),
            sf_serve::ClusterStatus::Unknown
        );

        seed_cluster_status(&supervisor, &orchestrator);
        // A live, probe-less `app` workload is Healthy → cluster Healthy.
        assert_eq!(
            orchestrator.cluster_status(),
            sf_serve::ClusterStatus::Healthy
        );

        supervisor.down().expect("teardown");
    }
}
