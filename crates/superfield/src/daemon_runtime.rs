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

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use fastenv::deployment::{
    FastenvManifest, HealthProbe, HealthStatus, HostProcessLauncher, ManifestSupervisor, Workload,
};
use sf_db::provisioner::PostgresProvisioner;
use sf_loop::{
    AgentExecutor, FixtureAgentExecutor, GardeningLoop, LlmAgentExecutor, LlmCredentialState,
    LoopConfig,
};
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

/// Construct the [`AgentExecutor`] the gardening loop drives, selecting it from
/// the appliance's first-run LLM credential state (issue #714).
///
/// - [`LlmCredentialState::Configured`] (a non-empty `SF_LLM_API_KEY`) selects
///   the real [`LlmAgentExecutor`] so the loop and studio agent do real work.
/// - [`LlmCredentialState::Unconfigured`] (no key) selects the deterministic
///   [`FixtureAgentExecutor`] so the loop still ticks against the brain without
///   any network call — but this is a *degraded* first-run state the daemon
///   surfaces explicitly via [`report_credential_state`], not silently.
///
/// `SF_OTEL_DISABLED=1` (CI / offline) is handled inside the executors
/// themselves: the real [`LlmAgentExecutor`] short-circuits outbound HTTP and
/// returns a canned response, so selecting it is safe even when offline.
///
/// The selection is keyed purely on the credential *state*, never on the key
/// value, and this function logs nothing — the key is never printed (issue #714
/// acceptance: no key is logged or persisted). Use [`report_credential_state`]
/// to surface the (key-free) banner at boot.
pub fn build_executor(config: &LoopConfig) -> Arc<dyn AgentExecutor> {
    match select_executor_kind(config.credential_state()) {
        ExecutorKind::Fixture => Arc::new(FixtureAgentExecutor::default()),
        ExecutorKind::Llm => Arc::new(LlmAgentExecutor::new(
            config.llm_api_key.clone(),
            config.llm_endpoint.clone(),
            config.llm_model.clone(),
        )),
    }
}

/// Which concrete [`AgentExecutor`] the gardening loop drives.
///
/// Trait objects erase their concrete type, so this enum is the testable view
/// of [`build_executor`]'s selection (issue #714 acceptance: assert the loop
/// selects the real `LlmAgentExecutor`, not the fixture).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutorKind {
    /// The real [`LlmAgentExecutor`] — selected when a credential is configured.
    Llm,
    /// The deterministic [`FixtureAgentExecutor`] — the unconfigured fallback.
    Fixture,
}

/// Map the first-run credential state to the executor the loop will build.
///
/// [`LlmCredentialState::Configured`] → [`ExecutorKind::Llm`] (real work);
/// [`LlmCredentialState::Unconfigured`] → [`ExecutorKind::Fixture`].
pub fn select_executor_kind(state: LlmCredentialState) -> ExecutorKind {
    match state {
        LlmCredentialState::Configured => ExecutorKind::Llm,
        LlmCredentialState::Unconfigured => ExecutorKind::Fixture,
    }
}

/// Surface the first-run LLM credential state explicitly at boot.
///
/// On an [`LlmCredentialState::Unconfigured`] appliance this publishes a clear
/// banner to the orchestrator log stream (so the control panel shows the
/// unconfigured state) and prints it to stderr; on a configured appliance it
/// confirms the real LLM is in use. The published/printed text is the
/// credential state's [`boot_message`](LlmCredentialState::boot_message), which
/// contains only the configured/unconfigured *state* and never the key value
/// (issue #714 acceptance: no key is logged or persisted).
///
/// Returns the resolved [`LlmCredentialState`] so the caller can record it.
pub fn report_credential_state(
    config: &LoopConfig,
    orchestrator: &sf_serve::OrchestratorState,
) -> LlmCredentialState {
    let state = config.credential_state();
    orchestrator.publish_log(format!("orchestrator: {}", state.boot_message()));
    if state.is_unconfigured() {
        eprintln!("superfield daemon: {}", state.boot_message());
    }
    state
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
/// nothing — the stream only ever carries real transitions. This seeds the
/// initial status at boot; [`run_cluster_status_poller`] then keeps publishing
/// across the daemon's lifetime so a restart-to-healthy flip mid-session drives
/// the preview reload (issue #715).
pub fn seed_cluster_status(
    supervisor: &dyn ManifestSupervisor,
    orchestrator: &sf_serve::OrchestratorState,
) {
    let health = supervisor
        .health(PREVIEW_WORKLOAD)
        .unwrap_or(fastenv::deployment::HealthStatus::Stopped);
    orchestrator.set_cluster_status(cluster_status_from_health(health));
}

/// Default interval between live-preview health observations.
///
/// The poller observes the preview workload's health on this cadence and only
/// publishes a `cluster-status` transition when the mapped status actually
/// changes (see [`OrchestratorState::set_cluster_status`](sf_serve::OrchestratorState::set_cluster_status)).
/// It is deliberately bounded (never a busy loop): two seconds is brisk enough
/// that a `restarting → healthy` flip after a rebuild reaches the control panel
/// promptly without hammering the supervisor's probes.
pub const DEFAULT_CLUSTER_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// A source of the live preview workload's current [`HealthStatus`].
///
/// This is the one observation the cluster-status poller makes per tick. In
/// production it wraps the appliance [`ManifestSupervisor`] and reads
/// [`PREVIEW_WORKLOAD`]; tests substitute a fake that walks a scripted
/// `healthy → restarting → healthy` sequence so the poller's transition and
/// de-duplication behaviour can be asserted without a real supervisor.
pub trait HealthSource: Send + Sync {
    /// Observe the preview workload's current health.
    fn current_health(&self) -> HealthStatus;
}

/// Production [`HealthSource`]: read the preview workload's health off the live
/// appliance supervisor, defaulting to `Stopped` when the supervisor cannot
/// report (so a transient probe error maps to `Unknown` rather than panicking
/// the poller).
pub struct SupervisorHealthSource {
    supervisor: Arc<dyn ManifestSupervisor + Send + Sync>,
}

impl SupervisorHealthSource {
    /// Wrap a shared supervisor as a preview-workload health source.
    pub fn new(supervisor: Arc<dyn ManifestSupervisor + Send + Sync>) -> Self {
        Self { supervisor }
    }
}

impl HealthSource for SupervisorHealthSource {
    fn current_health(&self) -> HealthStatus {
        self.supervisor
            .health(PREVIEW_WORKLOAD)
            .unwrap_or(HealthStatus::Stopped)
    }
}

/// Take one health observation and publish the mapped cluster status.
///
/// Returns the number of `/studio/cluster/events` subscribers the transition
/// reached: `0` when the status was unchanged since the last observation (the
/// de-dup in `set_cluster_status`) or when no one is listening, and a positive
/// count when a real transition was broadcast. Splitting a single poll out of
/// the loop lets tests assert transition vs. de-duplication behaviour without
/// driving the timer.
pub fn poll_cluster_status_once(
    source: &dyn HealthSource,
    orchestrator: &sf_serve::OrchestratorState,
) -> usize {
    orchestrator.set_cluster_status(cluster_status_from_health(source.current_health()))
}

/// Run the bounded periodic cluster-status health poller until `shutdown`
/// resolves.
///
/// On each `interval` tick it takes one observation via [`poll_cluster_status_once`],
/// so `/studio/cluster/events` carries every real `restarting → healthy`
/// transition across the daemon's lifetime — the control panel's `IframePanel`
/// reloads the preview on that transition without a manual refresh. The loop is
/// bounded by `interval` (a `tokio::time::interval`, never a busy spin) and
/// exits promptly when the `shutdown` future resolves so daemon teardown is not
/// blocked.
///
/// The first `interval` tick fires immediately, so the poller publishes the
/// current status once at start (idempotent with [`seed_cluster_status`] via the
/// stream's de-dup) before settling into its cadence.
pub async fn run_cluster_status_poller<F>(
    source: Arc<dyn HealthSource>,
    orchestrator: sf_serve::OrchestratorState,
    interval: Duration,
    shutdown: F,
) where
    F: Future<Output = ()>,
{
    let mut ticker = tokio::time::interval(interval);
    // If a poll ever outlasts the interval, skip missed ticks rather than
    // bursting — keeps the observation cadence bounded under back-pressure.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                poll_cluster_status_once(source.as_ref(), &orchestrator);
            }
            _ = &mut shutdown => break,
        }
    }
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

    // -----------------------------------------------------------------------
    // First-run LLM credential configuration (issue #714)
    // -----------------------------------------------------------------------

    /// A secret-looking key value used by the no-leak assertion. If this exact
    /// string ever appears in an emitted log or status payload the test fails.
    const SECRET_KEY: &str = "sk-ant-SECRET-do-not-log-9f3a2b";

    fn config_with_key(api_key: &str) -> LoopConfig {
        LoopConfig {
            workspace_id: uuid::Uuid::nil(),
            blueprint_path: std::path::PathBuf::from("blueprint/rules/graph.yaml"),
            llm_api_key: api_key.to_string(),
            llm_endpoint: "https://api.anthropic.com/v1/messages".to_string(),
            llm_model: "claude-haiku-4-5-20251001".to_string(),
        }
    }

    /// With SF_LLM_API_KEY set, the loop selects the REAL `LlmAgentExecutor`
    /// (not the fixture) — issue #714 acceptance criterion 1.
    #[test]
    fn configured_key_selects_real_llm_executor() {
        let cfg = config_with_key(SECRET_KEY);
        assert_eq!(cfg.credential_state(), LlmCredentialState::Configured);
        assert_eq!(
            select_executor_kind(cfg.credential_state()),
            ExecutorKind::Llm,
            "a configured key must select the real LlmAgentExecutor, not the fixture"
        );
        // build_executor must produce a usable trait object for the same config.
        let _exec: Arc<dyn AgentExecutor> = build_executor(&cfg);
    }

    /// With no key, the loop falls back to the deterministic fixture executor
    /// and the credential state is Unconfigured.
    #[test]
    fn unconfigured_key_selects_fixture_executor() {
        let cfg = config_with_key("");
        assert_eq!(cfg.credential_state(), LlmCredentialState::Unconfigured);
        assert_eq!(
            select_executor_kind(cfg.credential_state()),
            ExecutorKind::Fixture,
            "an empty key must select the fixture executor"
        );
        let _exec: Arc<dyn AgentExecutor> = build_executor(&cfg);

        // A whitespace-only key is also treated as unconfigured.
        assert_eq!(
            select_executor_kind(config_with_key("   ").credential_state()),
            ExecutorKind::Fixture,
        );
    }

    /// The daemon reports an explicit unconfigured-LLM state at boot when the
    /// key is empty — issue #714 acceptance criterion 2. The banner is published
    /// to the orchestrator log stream a subscriber can observe.
    #[test]
    fn boot_reports_explicit_unconfigured_state_when_key_empty() {
        let orchestrator = sf_serve::OrchestratorState::new();
        let mut logs = orchestrator.subscribe_logs();

        let state = report_credential_state(&config_with_key(""), &orchestrator);
        assert_eq!(state, LlmCredentialState::Unconfigured);

        let line = logs
            .try_recv()
            .expect("an unconfigured banner must be published");
        assert!(
            line.contains("unconfigured"),
            "boot banner must name the unconfigured state, got: {line}"
        );
        assert!(
            line.contains("SF_LLM_API_KEY"),
            "boot banner must point at the credential to set, got: {line}"
        );
    }

    /// A configured appliance reports the configured state at boot (no degraded
    /// banner), confirming the two states are distinguishable.
    #[test]
    fn boot_reports_configured_state_when_key_present() {
        let orchestrator = sf_serve::OrchestratorState::new();
        let mut logs = orchestrator.subscribe_logs();

        let state = report_credential_state(&config_with_key(SECRET_KEY), &orchestrator);
        assert_eq!(state, LlmCredentialState::Configured);

        let line = logs
            .try_recv()
            .expect("a configured banner must be published");
        assert!(
            line.contains("configured"),
            "boot banner must name the configured state, got: {line}"
        );
    }

    /// The API key value is NEVER logged or embedded in any status payload —
    /// issue #714 acceptance criterion 3. Scans every banner string the daemon
    /// emits for either credential state for the secret value.
    #[test]
    fn key_value_is_never_logged_or_reported() {
        let orchestrator = sf_serve::OrchestratorState::new();
        let mut logs = orchestrator.subscribe_logs();

        // Report with a secret key present.
        let configured = config_with_key(SECRET_KEY);
        report_credential_state(&configured, &orchestrator);

        // Drain every published log line and assert none contains the key.
        let mut emitted = Vec::new();
        while let Ok(line) = logs.try_recv() {
            emitted.push(line);
        }
        assert!(!emitted.is_empty(), "at least one banner must be emitted");
        for line in &emitted {
            assert!(
                !line.contains(SECRET_KEY),
                "the key value must never appear in an emitted log line: {line}"
            );
        }

        // The state's own surfaces are key-free by construction.
        assert!(!configured.credential_state().as_str().contains(SECRET_KEY));
        assert!(!configured
            .credential_state()
            .boot_message()
            .contains(SECRET_KEY));
    }

    // -----------------------------------------------------------------------
    // Continuous cluster-status health poller (issue #715)
    // -----------------------------------------------------------------------

    /// A scripted [`HealthSource`] that returns successive observations from a
    /// queue (repeating the last value once the queue is drained), so a test can
    /// drive the poller through a `healthy → restarting → healthy` sequence.
    struct ScriptedHealth(Mutex<std::collections::VecDeque<fastenv::deployment::HealthStatus>>);

    impl ScriptedHealth {
        fn new(seq: impl IntoIterator<Item = fastenv::deployment::HealthStatus>) -> Arc<Self> {
            Arc::new(Self(Mutex::new(seq.into_iter().collect())))
        }
    }

    impl HealthSource for ScriptedHealth {
        fn current_health(&self) -> fastenv::deployment::HealthStatus {
            let mut q = self.0.lock().unwrap();
            if q.len() > 1 {
                q.pop_front().unwrap()
            } else {
                // Hold (and keep returning) the final scripted value.
                *q.front()
                    .expect("scripted health sequence must be non-empty")
            }
        }
    }

    /// Driving the poll-once seam through healthy → restarting → healthy
    /// publishes exactly two transitions on the cluster stream (the steady-state
    /// healthy seed is the starting point, then restarting, then healthy again).
    #[tokio::test]
    async fn poller_emits_transitions_on_health_change() {
        use fastenv::deployment::HealthStatus;
        let source = ScriptedHealth::new([
            HealthStatus::Healthy,
            HealthStatus::Starting, // → Restarting
            HealthStatus::Healthy,  // → Healthy
        ]);
        let orchestrator = sf_serve::OrchestratorState::new();
        let mut rx = orchestrator.subscribe_cluster();

        // First poll: Unknown → Healthy (a transition off the initial Unknown).
        assert_eq!(poll_cluster_status_once(source.as_ref(), &orchestrator), 1);
        // Second poll: Healthy → Restarting.
        assert_eq!(poll_cluster_status_once(source.as_ref(), &orchestrator), 1);
        // Third poll: Restarting → Healthy (the reload-driving transition).
        assert_eq!(poll_cluster_status_once(source.as_ref(), &orchestrator), 1);

        assert_eq!(rx.recv().await.unwrap(), sf_serve::ClusterStatus::Healthy);
        assert_eq!(
            rx.recv().await.unwrap(),
            sf_serve::ClusterStatus::Restarting
        );
        assert_eq!(rx.recv().await.unwrap(), sf_serve::ClusterStatus::Healthy);
    }

    /// Unchanged health across two consecutive polls broadcasts nothing — the
    /// stream only ever carries real transitions, never repeated observations.
    #[tokio::test]
    async fn poller_dedupes_unchanged_health() {
        use fastenv::deployment::HealthStatus;
        let source = ScriptedHealth::new([HealthStatus::Healthy]);
        let orchestrator = sf_serve::OrchestratorState::new();
        // Hold a live subscriber so the broadcast count reflects whether a
        // transition was published (1) vs. de-duped away (0), not merely whether
        // anyone is listening.
        let _rx = orchestrator.subscribe_cluster();

        // First poll transitions Unknown → Healthy and broadcasts.
        assert_eq!(poll_cluster_status_once(source.as_ref(), &orchestrator), 1);
        // Second identical observation broadcasts nothing.
        assert_eq!(poll_cluster_status_once(source.as_ref(), &orchestrator), 0);
        assert_eq!(
            orchestrator.cluster_status(),
            sf_serve::ClusterStatus::Healthy
        );
    }

    /// The production [`SupervisorHealthSource`] reads the preview workload's
    /// health off the shared supervisor (and the default interval is bounded).
    #[test]
    fn supervisor_health_source_reads_preview_workload() {
        let log = OrderLog::default();
        let supervisor: Arc<dyn ManifestSupervisor + Send + Sync> =
            Arc::new(RecordingSupervisor(log));
        let source = SupervisorHealthSource::new(supervisor);
        // RecordingSupervisor reports every workload Healthy.
        assert_eq!(source.current_health(), HealthStatus::Healthy);
        // The default cadence is bounded (never zero → never a busy loop).
        assert!(DEFAULT_CLUSTER_POLL_INTERVAL > Duration::ZERO);
    }

    /// The running poller is bounded by its interval (no busy loop): with paused
    /// time, ticks only fire as the clock is advanced past each interval, and the
    /// poller exits promptly when its shutdown future resolves.
    #[tokio::test(start_paused = true)]
    async fn poller_is_bounded_by_interval_and_stops_on_shutdown() {
        use fastenv::deployment::HealthStatus;
        // Healthy, then Starting forever: the first tick seeds Healthy, a later
        // tick flips to Restarting — proving ticks are paced, not spun.
        let source = ScriptedHealth::new([HealthStatus::Healthy, HealthStatus::Starting]);
        let orchestrator = sf_serve::OrchestratorState::new();
        let interval = Duration::from_secs(2);

        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let poller = tokio::spawn(run_cluster_status_poller(
            source.clone(),
            orchestrator.clone(),
            interval,
            async {
                let _ = stop_rx.await;
            },
        ));

        // The immediate first tick seeds Healthy.
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(
            orchestrator.cluster_status(),
            sf_serve::ClusterStatus::Healthy,
            "first tick must publish the initial observation"
        );

        // Before a full interval elapses, no further tick has fired (bounded).
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(
            orchestrator.cluster_status(),
            sf_serve::ClusterStatus::Healthy,
            "no tick may fire before the interval elapses (not a busy loop)"
        );

        // Crossing the interval fires the next tick → Restarting.
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(
            orchestrator.cluster_status(),
            sf_serve::ClusterStatus::Restarting,
            "the next tick fires once the interval elapses"
        );

        // Shutdown resolves → the poller exits promptly.
        stop_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), poller)
            .await
            .expect("poller must stop promptly on shutdown")
            .expect("poller task must not panic");
    }
}
