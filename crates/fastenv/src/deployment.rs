// deployment.rs — deployment-tier runtime for long-lived app + Postgres workloads.
//
// Canonical docs:
//   - crates/fastenv/docs/architecture.md §11
//   - docs/technical-requirements.md
//
// STATUS (issue #662, phase: fastenv-deployment-runtime)
// ======================================================
// This module promotes the dev-scout no-op seam (#663) into a REAL supervisor
// that starts, health-checks, supervises, and stops long-lived workloads
// described by a `FastenvManifest`. It runs the deployment tier WITHOUT
// kubectl, a Docker daemon, kube-proxy, or CoreDNS: workloads are launched as
// host-local processes through an injectable `WorkloadLauncher`, and an
// in-process registry tracks their lifecycle and exposes per-workload health
// for the `init -> deploy-env -> health gate` readiness path (unblocks #660
// criterion 4).
//
// The launcher is a trait so the supervisor is exercisable in `cargo test`
// without crun, KVM, root, or a real Postgres image: `RecordingLauncher`
// records every launch/stop/probe as a command trace and simulates a
// long-lived process. Production wiring backs the same trait with the real
// container runtime (see `crate::container_runtime`) / VM boundary
// (see `crate::boundary`).
//
// =====================================================================
// FastenvManifest CONSUMER CONTRACT
// =====================================================================
// The deployment tier consumes a `FastenvManifest`: the engine-agnostic
// workload spec emitted by the control-core translation layer
// (packages/control-core/fastenv-translate.ts — the translator from Kubernetes
// manifests / docker-compose). The Rust types below MUST be kept in sync with
// that TypeScript artifact field-for-field (the TS side is the wire-shape
// source of truth; both sides are exercised through JSON round-trip tests).
//
// The manifest is engine-agnostic by design. It replaces the following k8s/
// compose concepts with fastenv-native equivalents that the supervisor owns:
//
//   k8s / compose concept        →  fastenv deployment-tier equivalent
//   ---------------------------     -----------------------------------
//   Deployment / Pod / service     →  Workload (a long-lived process under
//                                      the manifest supervisor)
//   Service + cluster DNS          →  in-process service registry +
//                                      host-local addressing (NO kube-proxy,
//                                      NO CoreDNS)
//   readinessProbe / livenessProbe →  HealthProbe surface consumed by `doctor`
//   StatefulSet (Postgres)         →  stateful Workload started before, and
//                                      stopped after, dependent app workloads

use std::collections::BTreeMap;
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Engine-agnostic deployment-tier manifest consumed by the supervisor.
///
/// Mirrors the `FastenvManifest` emitted by
/// `packages/control-core/fastenv-translate.ts`. Keep field names in sync with
/// that translator; both sides are covered by JSON round-trip tests.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastenvManifest {
    /// Logical name of the deployment (e.g. "superfield").
    #[serde(default)]
    pub name: String,
    /// Long-lived workloads to supervise (app, Postgres, …).
    #[serde(default)]
    pub workloads: Vec<Workload>,
}

/// A single long-lived workload (app process, Postgres, sidecar, …).
///
/// Corresponds to one translated k8s Deployment/StatefulSet or one compose
/// service. Only the fields the supervisor must read are modeled.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workload {
    /// Stable workload identifier, unique within the manifest.
    #[serde(default)]
    pub name: String,
    /// Container image reference (OCI), e.g. "postgres:16".
    #[serde(default)]
    pub image: String,
    /// Entrypoint command + args. Empty means use the image default.
    #[serde(default)]
    pub command: Vec<String>,
    /// Environment variables for the workload process.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Whether this workload owns durable state (e.g. Postgres). Stateful
    /// workloads are started BEFORE, and stopped AFTER, stateless ones so a
    /// database is up before the app connects and is the last thing to go down.
    #[serde(default)]
    pub stateful: bool,
    /// Health probe the `doctor` surface queries to gate readiness.
    /// `None` means the workload is considered healthy once started.
    #[serde(default)]
    pub health: Option<HealthProbe>,
}

/// Readiness/liveness probe definition consumed by the `doctor` health surface.
///
/// The deployment-tier equivalent of a k8s readiness/liveness probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HealthProbe {
    /// TCP connect probe to a host-local port.
    Tcp { port: u16 },
    /// HTTP GET probe expecting a 2xx response.
    Http { port: u16, path: String },
    /// Exec a command inside the workload; exit 0 means healthy.
    Exec { command: Vec<String> },
}

/// Observed health of a workload, reported by the supervisor / doctor surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    /// Probe succeeded (or no probe defined and workload is running).
    Healthy,
    /// Workload is started but its probe has not yet passed.
    Starting,
    /// Probe failed or the workload exited unexpectedly.
    Unhealthy,
    /// Workload is not currently supervised.
    Stopped,
}

/// Manifest supervisor SEAM driven by the deployment-tier entrypoint
/// (`fastenv up`).
pub trait ManifestSupervisor {
    /// Start (or reconcile) all workloads described by the manifest.
    fn apply(&self, manifest: &FastenvManifest) -> Result<()>;

    /// Report the current health of a named workload.
    fn health(&self, workload_name: &str) -> Result<HealthStatus>;

    /// Stop and clean up all supervised workloads.
    fn down(&self) -> Result<()>;
}

/// No-op supervisor retained from the dev-scout seam (#663).
///
/// Every method is inert. It remains available for callers that only need to
/// prove the seam is wired (e.g. dry-run paths and parity tests). The real
/// runtime is `FastenvSupervisor`.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopSupervisor;

impl ManifestSupervisor for NoopSupervisor {
    fn apply(&self, manifest: &FastenvManifest) -> Result<()> {
        tracing::warn!(
            seam = "deployment::ManifestSupervisor",
            manifest = %manifest.name,
            workloads = manifest.workloads.len(),
            "NoopSupervisor: deployment-tier no-op (no workloads started)"
        );
        Ok(())
    }

    fn health(&self, workload_name: &str) -> Result<HealthStatus> {
        tracing::warn!(
            seam = "deployment::ManifestSupervisor",
            workload = %workload_name,
            "NoopSupervisor: deployment-tier health no-op"
        );
        Ok(HealthStatus::Stopped)
    }

    fn down(&self) -> Result<()> {
        tracing::warn!(
            seam = "deployment::ManifestSupervisor",
            "NoopSupervisor: deployment-tier down no-op"
        );
        Ok(())
    }
}

// ===========================================================================
// WorkloadLauncher — the host-process backend behind the supervisor.
// ===========================================================================

/// Opaque handle to a started long-lived workload process.
///
/// The supervisor stores this and passes it back to `stop`/`is_alive`/`probe`
/// so a launcher can carry whatever runtime identity it needs (PID, container
/// id, VM exec handle, …) without leaking those details into the supervisor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkloadHandle {
    /// Stable workload name this handle belongs to.
    pub workload: String,
    /// Launcher-defined runtime identifier (PID string, container id, …).
    pub runtime_id: String,
}

/// Launches and supervises long-lived workload processes.
///
/// This is the boundary that keeps `FastenvSupervisor` host-agnostic and
/// testable. Implementations MUST NOT shell out to kubectl, k3d, or a Docker
/// daemon — the whole point of the deployment tier is to run workloads on the
/// fastenv backend directly. Implementations are free to use the container
/// runtime (`crate::container_runtime`) or plain host processes.
pub trait WorkloadLauncher {
    /// Start `workload` as a long-lived process and return its handle.
    fn launch(&self, workload: &Workload) -> Result<WorkloadHandle>;

    /// Return true while the workload process is still running.
    fn is_alive(&self, handle: &WorkloadHandle) -> Result<bool>;

    /// Run the workload's exec probe (used by `HealthProbe::Exec`). Returns the
    /// command's exit code; 0 means healthy. Default launchers that cannot exec
    /// into a workload may return an error.
    fn probe_exec(&self, handle: &WorkloadHandle, command: &[String]) -> Result<i32>;

    /// Return true if a TCP connect to `port` (or an HTTP GET of `path`)
    /// succeeds. Host-local addressing only — no cluster DNS.
    fn probe_endpoint(&self, handle: &WorkloadHandle, probe: &HealthProbe) -> Result<bool>;

    /// Stop the workload process and release its resources.
    fn stop(&self, handle: &WorkloadHandle) -> Result<()>;
}

// ===========================================================================
// FastenvSupervisor — the real deployment-tier supervisor.
// ===========================================================================

/// State the supervisor tracks for a single running workload.
#[derive(Debug, Clone)]
struct RunningWorkload {
    spec: Workload,
    handle: WorkloadHandle,
}

/// Real deployment-tier supervisor.
///
/// `apply` starts every workload in dependency order (stateful workloads —
/// Postgres — before stateless app workloads), records each as running, and
/// leaves them supervised. `health` probes a named workload through its
/// `HealthProbe`. `down` stops every workload in reverse order (app before
/// Postgres) and clears state.
///
/// The supervisor never invokes kubectl/docker/k3d: all process work goes
/// through the injected `WorkloadLauncher`.
pub struct FastenvSupervisor<L: WorkloadLauncher> {
    launcher: L,
    running: Mutex<Vec<RunningWorkload>>,
}

impl<L: WorkloadLauncher> FastenvSupervisor<L> {
    /// Build a supervisor backed by `launcher`.
    pub fn new(launcher: L) -> Self {
        FastenvSupervisor {
            launcher,
            running: Mutex::new(Vec::new()),
        }
    }

    /// Borrow the underlying launcher (e.g. to read a recorded command trace).
    pub fn launcher(&self) -> &L {
        &self.launcher
    }

    /// Names of the currently supervised workloads, in start order.
    pub fn running_workloads(&self) -> Vec<String> {
        self.running
            .lock()
            .expect("supervisor state poisoned")
            .iter()
            .map(|r| r.spec.name.clone())
            .collect()
    }

    /// Order workloads for startup: stateful (Postgres) first, preserving the
    /// manifest order within each group. Teardown walks this in reverse.
    fn start_order(manifest: &FastenvManifest) -> Vec<&Workload> {
        let mut ordered: Vec<&Workload> =
            manifest.workloads.iter().filter(|w| w.stateful).collect();
        ordered.extend(manifest.workloads.iter().filter(|w| !w.stateful));
        ordered
    }
}

impl<L: WorkloadLauncher> ManifestSupervisor for FastenvSupervisor<L> {
    fn apply(&self, manifest: &FastenvManifest) -> Result<()> {
        // Validate the manifest before starting anything so a malformed
        // workload fails fast without leaving a half-started deployment.
        let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
        for w in &manifest.workloads {
            if w.name.is_empty() {
                bail!(
                    "manifest '{}' has a workload with an empty name",
                    manifest.name
                );
            }
            if w.image.is_empty() {
                bail!(
                    "workload '{}' in manifest '{}' has no image",
                    w.name,
                    manifest.name
                );
            }
            if !seen.insert(w.name.as_str()) {
                bail!(
                    "manifest '{}' has duplicate workload name '{}'",
                    manifest.name,
                    w.name
                );
            }
        }

        for workload in Self::start_order(manifest) {
            // Idempotent reconcile: skip workloads already running.
            {
                let running = self.running.lock().expect("supervisor state poisoned");
                if running.iter().any(|r| r.spec.name == workload.name) {
                    continue;
                }
            }

            let handle = self
                .launcher
                .launch(workload)
                .with_context(|| format!("launch workload '{}'", workload.name))?;

            tracing::info!(
                supervisor = "deployment::FastenvSupervisor",
                workload = %workload.name,
                image = %workload.image,
                stateful = workload.stateful,
                runtime_id = %handle.runtime_id,
                "started long-lived workload"
            );

            self.running
                .lock()
                .expect("supervisor state poisoned")
                .push(RunningWorkload {
                    spec: workload.clone(),
                    handle,
                });
        }

        Ok(())
    }

    fn health(&self, workload_name: &str) -> Result<HealthStatus> {
        let running = self.running.lock().expect("supervisor state poisoned");
        let Some(rw) = running.iter().find(|r| r.spec.name == workload_name) else {
            return Ok(HealthStatus::Stopped);
        };

        // A workload whose process has exited is Unhealthy, regardless of probe.
        if !self
            .launcher
            .is_alive(&rw.handle)
            .with_context(|| format!("liveness check for workload '{}'", workload_name))?
        {
            return Ok(HealthStatus::Unhealthy);
        }

        // No probe defined: a live process is considered healthy.
        let Some(probe) = &rw.spec.health else {
            return Ok(HealthStatus::Healthy);
        };

        let passed = match probe {
            HealthProbe::Exec { command } => {
                self.launcher
                    .probe_exec(&rw.handle, command)
                    .with_context(|| format!("exec probe for workload '{}'", workload_name))?
                    == 0
            }
            HealthProbe::Tcp { .. } | HealthProbe::Http { .. } => self
                .launcher
                .probe_endpoint(&rw.handle, probe)
                .with_context(|| format!("endpoint probe for workload '{}'", workload_name))?,
        };

        Ok(if passed {
            HealthStatus::Healthy
        } else {
            HealthStatus::Starting
        })
    }

    fn down(&self) -> Result<()> {
        let mut running = self.running.lock().expect("supervisor state poisoned");
        // Reverse start order: stateless app workloads stop before stateful
        // Postgres, so the app drains its connections before the DB shuts down.
        let mut first_error: Option<anyhow::Error> = None;
        while let Some(rw) = running.pop() {
            if let Err(err) = self
                .launcher
                .stop(&rw.handle)
                .with_context(|| format!("stop workload '{}'", rw.spec.name))
            {
                tracing::error!(
                    supervisor = "deployment::FastenvSupervisor",
                    workload = %rw.spec.name,
                    error = %err,
                    "failed to stop workload; continuing teardown"
                );
                if first_error.is_none() {
                    first_error = Some(err);
                }
            } else {
                tracing::info!(
                    supervisor = "deployment::FastenvSupervisor",
                    workload = %rw.spec.name,
                    "stopped workload"
                );
            }
        }
        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }
}

/// Block until every workload in `manifest` reports `Healthy`, or fail after
/// `timeout`.
///
/// This is the readiness gate the `init -> deploy-env -> health gate` flow
/// drives on the fastenv backend (issue #660 criterion 4). It polls each
/// workload's `HealthStatus` via the supervisor — the same surface `doctor`
/// reports on — and returns `Ok(())` only once all workloads are `Healthy`. A
/// workload that reports `Unhealthy` (its process exited) fails the gate
/// immediately rather than waiting out the timeout.
pub fn wait_until_healthy<S: ManifestSupervisor>(
    supervisor: &S,
    manifest: &FastenvManifest,
    timeout: std::time::Duration,
) -> Result<()> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let mut all_healthy = true;
        for w in &manifest.workloads {
            match supervisor.health(&w.name)? {
                HealthStatus::Healthy => {}
                HealthStatus::Unhealthy => {
                    bail!(
                        "workload '{}' became Unhealthy during the health gate",
                        w.name
                    );
                }
                HealthStatus::Starting | HealthStatus::Stopped => {
                    all_healthy = false;
                }
            }
        }
        if all_healthy {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            bail!(
                "health gate timed out after {:?} waiting for all workloads to be Healthy",
                timeout
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

// ===========================================================================
// HostProcessLauncher — default production launcher backed by host processes.
// ===========================================================================

/// Default `WorkloadLauncher` that runs each workload as a host child process.
///
/// This is the simplest backend that satisfies the deployment-tier contract
/// WITHOUT kubectl/docker/k3d: it spawns the workload's `command` directly
/// (with its `env`) and supervises the resulting PID. Probes use host-local
/// addressing (TCP connect / blocking HTTP via a TCP connect heuristic) and a
/// best-effort exec of the probe command.
///
/// Richer backends (container runtime / VM boundary) implement the same trait;
/// see `crate::container_runtime`. The host-process launcher is the safe
/// default for deployments whose images are already materialized on the host.
#[derive(Default)]
pub struct HostProcessLauncher {
    children: Mutex<BTreeMap<String, std::process::Child>>,
}

impl HostProcessLauncher {
    /// Build an empty host-process launcher.
    pub fn new() -> Self {
        HostProcessLauncher {
            children: Mutex::new(BTreeMap::new()),
        }
    }
}

impl WorkloadLauncher for HostProcessLauncher {
    fn launch(&self, workload: &Workload) -> Result<WorkloadHandle> {
        let program = workload
            .command
            .first()
            .with_context(|| {
                format!(
                    "workload '{}' has no command; the host-process launcher \
                     requires an explicit command (image default execution is \
                     only available through a container-runtime launcher)",
                    workload.name
                )
            })?
            .clone();

        let mut cmd = std::process::Command::new(&program);
        cmd.args(&workload.command[1..]);
        cmd.envs(&workload.env);

        let child = cmd
            .spawn()
            .with_context(|| format!("spawn workload '{}' ({})", workload.name, program))?;
        let pid = child.id();
        self.children
            .lock()
            .expect("launcher state poisoned")
            .insert(workload.name.clone(), child);

        Ok(WorkloadHandle {
            workload: workload.name.clone(),
            runtime_id: pid.to_string(),
        })
    }

    fn is_alive(&self, handle: &WorkloadHandle) -> Result<bool> {
        let mut children = self.children.lock().expect("launcher state poisoned");
        let Some(child) = children.get_mut(&handle.workload) else {
            return Ok(false);
        };
        match child.try_wait().context("poll workload process")? {
            Some(_status) => Ok(false), // exited
            None => Ok(true),           // still running
        }
    }

    fn probe_exec(&self, _handle: &WorkloadHandle, command: &[String]) -> Result<i32> {
        let program = command.first().context("exec probe has an empty command")?;
        let status = std::process::Command::new(program)
            .args(&command[1..])
            .status()
            .with_context(|| format!("run exec probe '{}'", program))?;
        Ok(status.code().unwrap_or(1))
    }

    fn probe_endpoint(&self, _handle: &WorkloadHandle, probe: &HealthProbe) -> Result<bool> {
        use std::net::TcpStream;
        use std::time::Duration;
        let port = match probe {
            HealthProbe::Tcp { port } => *port,
            HealthProbe::Http { port, .. } => *port,
            HealthProbe::Exec { .. } => {
                bail!("probe_endpoint called with an exec probe");
            }
        };
        let addr = format!("127.0.0.1:{port}");
        let parsed = addr.parse().with_context(|| format!("parse {addr}"))?;
        // Host-local connect; a refused connection means "not ready yet".
        Ok(TcpStream::connect_timeout(&parsed, Duration::from_millis(500)).is_ok())
    }

    fn stop(&self, handle: &WorkloadHandle) -> Result<()> {
        let mut children = self.children.lock().expect("launcher state poisoned");
        if let Some(mut child) = children.remove(&handle.workload) {
            // Best-effort terminate; ignore "already exited" errors.
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // ---- Test launcher --------------------------------------------------

    /// A trace event recorded by `RecordingLauncher`.
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Event {
        Launch(String),
        Stop(String),
        ProbeExec(String),
        ProbeEndpoint(String),
    }

    /// In-memory launcher that simulates long-lived processes and records every
    /// action as a command trace. It NEVER touches the host and NEVER invokes
    /// kubectl/docker/k3d, so it runs in the PR-tier harness without root/KVM.
    #[derive(Clone, Default)]
    struct RecordingLauncher {
        trace: Arc<Mutex<Vec<Event>>>,
        /// Workload names whose process should report "exited" on is_alive.
        dead: Arc<Mutex<std::collections::BTreeSet<String>>>,
        /// Workload names whose probe should FAIL (return not-ready).
        probe_fails: Arc<Mutex<std::collections::BTreeSet<String>>>,
        /// If set, launch() fails for this workload name.
        launch_fails: Arc<Mutex<Option<String>>>,
    }

    impl RecordingLauncher {
        fn trace(&self) -> Vec<Event> {
            self.trace.lock().unwrap().clone()
        }
        fn kill(&self, name: &str) {
            self.dead.lock().unwrap().insert(name.to_string());
        }
        fn fail_probe(&self, name: &str) {
            self.probe_fails.lock().unwrap().insert(name.to_string());
        }
        fn fail_launch(&self, name: &str) {
            *self.launch_fails.lock().unwrap() = Some(name.to_string());
        }
    }

    impl WorkloadLauncher for RecordingLauncher {
        fn launch(&self, workload: &Workload) -> Result<WorkloadHandle> {
            if self.launch_fails.lock().unwrap().as_deref() == Some(workload.name.as_str()) {
                bail!("simulated launch failure for '{}'", workload.name);
            }
            self.trace
                .lock()
                .unwrap()
                .push(Event::Launch(workload.name.clone()));
            Ok(WorkloadHandle {
                workload: workload.name.clone(),
                runtime_id: format!("pid-{}", workload.name),
            })
        }

        fn is_alive(&self, handle: &WorkloadHandle) -> Result<bool> {
            Ok(!self.dead.lock().unwrap().contains(&handle.workload))
        }

        fn probe_exec(&self, handle: &WorkloadHandle, _command: &[String]) -> Result<i32> {
            self.trace
                .lock()
                .unwrap()
                .push(Event::ProbeExec(handle.workload.clone()));
            Ok(
                if self.probe_fails.lock().unwrap().contains(&handle.workload) {
                    1
                } else {
                    0
                },
            )
        }

        fn probe_endpoint(&self, handle: &WorkloadHandle, _probe: &HealthProbe) -> Result<bool> {
            self.trace
                .lock()
                .unwrap()
                .push(Event::ProbeEndpoint(handle.workload.clone()));
            Ok(!self.probe_fails.lock().unwrap().contains(&handle.workload))
        }

        fn stop(&self, handle: &WorkloadHandle) -> Result<()> {
            self.trace
                .lock()
                .unwrap()
                .push(Event::Stop(handle.workload.clone()));
            Ok(())
        }
    }

    fn superfield_manifest() -> FastenvManifest {
        FastenvManifest {
            name: "superfield".to_string(),
            workloads: vec![
                Workload {
                    name: "superfield-api".to_string(),
                    image: "superfield:latest".to_string(),
                    command: vec!["serve".to_string()],
                    env: BTreeMap::new(),
                    stateful: false,
                    health: Some(HealthProbe::Http {
                        port: 8080,
                        path: "/healthz".to_string(),
                    }),
                },
                Workload {
                    name: "superfield-postgres".to_string(),
                    image: "postgres:16".to_string(),
                    command: vec![],
                    env: [("POSTGRES_DB".to_string(), "app".to_string())]
                        .into_iter()
                        .collect(),
                    stateful: true,
                    health: Some(HealthProbe::Tcp { port: 5432 }),
                },
            ],
        }
    }

    // ---- Acceptance criterion 1: start + stop a long-lived workload -----

    #[test]
    fn supervisor_starts_and_stops_stub_workload() {
        let launcher = RecordingLauncher::default();
        let sup = FastenvSupervisor::new(launcher);

        let manifest = FastenvManifest {
            name: "stub".to_string(),
            workloads: vec![Workload {
                name: "app".to_string(),
                image: "example:latest".to_string(),
                ..Default::default()
            }],
        };

        sup.apply(&manifest).expect("apply starts the workload");
        assert_eq!(sup.running_workloads(), vec!["app".to_string()]);
        // A started, probe-less, live workload is Healthy.
        assert_eq!(sup.health("app").unwrap(), HealthStatus::Healthy);

        sup.down().expect("down stops the workload");
        assert!(sup.running_workloads().is_empty());
        assert_eq!(sup.health("app").unwrap(), HealthStatus::Stopped);

        assert_eq!(
            sup.launcher().trace(),
            vec![Event::Launch("app".into()), Event::Stop("app".into())]
        );
    }

    #[test]
    fn apply_starts_postgres_before_app_and_down_reverses() {
        let sup = FastenvSupervisor::new(RecordingLauncher::default());
        sup.apply(&superfield_manifest()).unwrap();

        // Stateful Postgres starts first even though it is listed second.
        assert_eq!(
            sup.running_workloads(),
            vec![
                "superfield-postgres".to_string(),
                "superfield-api".to_string()
            ]
        );

        sup.down().unwrap();

        // App stops before Postgres (reverse of start order).
        let trace = sup.launcher().trace();
        let api_stop = trace
            .iter()
            .position(|e| *e == Event::Stop("superfield-api".into()))
            .unwrap();
        let pg_stop = trace
            .iter()
            .position(|e| *e == Event::Stop("superfield-postgres".into()))
            .unwrap();
        assert!(api_stop < pg_stop, "app must stop before postgres");
    }

    #[test]
    fn health_reflects_probe_and_liveness() {
        let launcher = RecordingLauncher::default();
        let sup = FastenvSupervisor::new(launcher.clone());
        sup.apply(&superfield_manifest()).unwrap();

        // Both probes pass → Healthy.
        assert_eq!(
            sup.health("superfield-postgres").unwrap(),
            HealthStatus::Healthy
        );
        assert_eq!(sup.health("superfield-api").unwrap(), HealthStatus::Healthy);

        // Probe fails → Starting (process alive but not ready yet).
        launcher.fail_probe("superfield-api");
        assert_eq!(
            sup.health("superfield-api").unwrap(),
            HealthStatus::Starting
        );

        // Process exits → Unhealthy regardless of probe.
        launcher.kill("superfield-postgres");
        assert_eq!(
            sup.health("superfield-postgres").unwrap(),
            HealthStatus::Unhealthy
        );
    }

    #[test]
    fn health_of_unknown_workload_is_stopped() {
        let sup = FastenvSupervisor::new(RecordingLauncher::default());
        sup.apply(&superfield_manifest()).unwrap();
        assert_eq!(sup.health("does-not-exist").unwrap(), HealthStatus::Stopped);
    }

    #[test]
    fn exec_probe_drives_probe_exec() {
        let manifest = FastenvManifest {
            name: "exec-probe".to_string(),
            workloads: vec![Workload {
                name: "db".to_string(),
                image: "postgres:16".to_string(),
                stateful: true,
                health: Some(HealthProbe::Exec {
                    command: vec!["pg_isready".to_string()],
                }),
                ..Default::default()
            }],
        };
        let sup = FastenvSupervisor::new(RecordingLauncher::default());
        sup.apply(&manifest).unwrap();
        assert_eq!(sup.health("db").unwrap(), HealthStatus::Healthy);
        assert!(sup
            .launcher()
            .trace()
            .contains(&Event::ProbeExec("db".into())));
    }

    #[test]
    fn apply_is_idempotent() {
        let sup = FastenvSupervisor::new(RecordingLauncher::default());
        sup.apply(&superfield_manifest()).unwrap();
        sup.apply(&superfield_manifest()).unwrap();
        // No double-launch: still exactly two workloads, two launches.
        assert_eq!(sup.running_workloads().len(), 2);
        let launches = sup
            .launcher()
            .trace()
            .into_iter()
            .filter(|e| matches!(e, Event::Launch(_)))
            .count();
        assert_eq!(launches, 2);
    }

    // ---- Failure / validation paths -------------------------------------

    #[test]
    fn apply_rejects_workload_without_image() {
        let manifest = FastenvManifest {
            name: "bad".to_string(),
            workloads: vec![Workload {
                name: "app".to_string(),
                image: String::new(),
                ..Default::default()
            }],
        };
        let sup = FastenvSupervisor::new(RecordingLauncher::default());
        let err = sup.apply(&manifest).unwrap_err();
        assert!(err.to_string().contains("no image"));
        // Nothing was started.
        assert!(sup.running_workloads().is_empty());
        assert!(sup.launcher().trace().is_empty());
    }

    #[test]
    fn apply_rejects_duplicate_workload_names() {
        let manifest = FastenvManifest {
            name: "dup".to_string(),
            workloads: vec![
                Workload {
                    name: "app".to_string(),
                    image: "a:1".to_string(),
                    ..Default::default()
                },
                Workload {
                    name: "app".to_string(),
                    image: "a:2".to_string(),
                    ..Default::default()
                },
            ],
        };
        let sup = FastenvSupervisor::new(RecordingLauncher::default());
        let err = sup.apply(&manifest).unwrap_err();
        assert!(err.to_string().contains("duplicate"));
    }

    #[test]
    fn apply_propagates_launch_failure() {
        let launcher = RecordingLauncher::default();
        launcher.fail_launch("superfield-api");
        let sup = FastenvSupervisor::new(launcher);
        let err = sup.apply(&superfield_manifest()).unwrap_err();
        assert!(err.to_string().contains("launch workload 'superfield-api'"));
        // Postgres (started first) is up; the failing app is not recorded.
        assert_eq!(
            sup.running_workloads(),
            vec!["superfield-postgres".to_string()]
        );
    }

    // ---- Health gate (init -> deploy-env -> health gate) ----------------

    #[test]
    fn wait_until_healthy_passes_when_all_workloads_ready() {
        let sup = FastenvSupervisor::new(RecordingLauncher::default());
        let manifest = superfield_manifest();
        sup.apply(&manifest).unwrap();
        wait_until_healthy(&sup, &manifest, std::time::Duration::from_secs(1))
            .expect("all workloads healthy → gate passes");
    }

    #[test]
    fn wait_until_healthy_fails_fast_on_unhealthy_workload() {
        let launcher = RecordingLauncher::default();
        let sup = FastenvSupervisor::new(launcher.clone());
        let manifest = superfield_manifest();
        sup.apply(&manifest).unwrap();
        launcher.kill("superfield-api");
        let err = wait_until_healthy(&sup, &manifest, std::time::Duration::from_secs(5))
            .expect_err("an Unhealthy workload must fail the gate");
        assert!(err.to_string().contains("Unhealthy"));
    }

    #[test]
    fn wait_until_healthy_times_out_when_probe_never_passes() {
        let launcher = RecordingLauncher::default();
        let sup = FastenvSupervisor::new(launcher.clone());
        let manifest = superfield_manifest();
        sup.apply(&manifest).unwrap();
        // Probe never passes → workload stays Starting → gate times out.
        launcher.fail_probe("superfield-api");
        let err = wait_until_healthy(&sup, &manifest, std::time::Duration::from_millis(150))
            .expect_err("gate must time out");
        assert!(err.to_string().contains("timed out"));
    }

    // ---- NoopSupervisor retained behavior -------------------------------

    #[test]
    fn noop_supervisor_apply_is_inert() {
        let sup = NoopSupervisor;
        let manifest = FastenvManifest {
            name: "scout".to_string(),
            workloads: vec![Workload {
                name: "app".to_string(),
                image: "example:latest".to_string(),
                ..Default::default()
            }],
        };
        assert!(sup.apply(&manifest).is_ok());
    }

    #[test]
    fn noop_supervisor_health_reports_stopped() {
        let sup = NoopSupervisor;
        assert_eq!(sup.health("app").unwrap(), HealthStatus::Stopped);
    }

    #[test]
    fn noop_supervisor_down_is_inert() {
        let sup = NoopSupervisor;
        assert!(sup.down().is_ok());
    }

    // ---- Wire-shape contract --------------------------------------------

    #[test]
    fn manifest_round_trips_through_json() {
        let manifest = superfield_manifest();
        let json = serde_json::to_string(&manifest).expect("serialize");
        let back: FastenvManifest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(manifest, back);
    }

    #[test]
    fn manifest_defaults_are_empty() {
        let manifest: FastenvManifest = serde_json::from_str("{}").expect("empty manifest parses");
        assert!(manifest.workloads.is_empty());
    }

    // ---- HostProcessLauncher (default production backend) ---------------

    #[test]
    fn host_process_launcher_supervises_a_real_long_lived_process() {
        // Drive the REAL host-process launcher (not the recording stub) end to
        // end: start a genuine long-lived child, observe it live, then stop it.
        // Uses `sleep`, available on the Linux PR-tier harness; no kubectl/
        // docker/crun/KVM involved.
        let manifest = FastenvManifest {
            name: "host".to_string(),
            workloads: vec![Workload {
                name: "sleeper".to_string(),
                image: "coreutils:host".to_string(),
                command: vec!["sleep".to_string(), "30".to_string()],
                ..Default::default()
            }],
        };
        let sup = FastenvSupervisor::new(HostProcessLauncher::new());
        sup.apply(&manifest).expect("apply spawns the real process");
        // No probe defined and the process is alive → Healthy.
        assert_eq!(sup.health("sleeper").unwrap(), HealthStatus::Healthy);

        sup.down().expect("down kills the real process");
        assert_eq!(sup.health("sleeper").unwrap(), HealthStatus::Stopped);
    }

    #[test]
    fn host_process_launcher_reports_unhealthy_after_process_exits() {
        let manifest = FastenvManifest {
            name: "host".to_string(),
            workloads: vec![Workload {
                name: "quick".to_string(),
                image: "coreutils:host".to_string(),
                command: vec!["true".to_string()],
                ..Default::default()
            }],
        };
        let sup = FastenvSupervisor::new(HostProcessLauncher::new());
        sup.apply(&manifest).unwrap();
        // `true` exits immediately; give it a moment, then health must reflect
        // the exit as Unhealthy (process not alive).
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(sup.health("quick").unwrap(), HealthStatus::Unhealthy);
        sup.down().unwrap();
    }

    #[test]
    fn host_process_launcher_requires_a_command() {
        let manifest = FastenvManifest {
            name: "host".to_string(),
            workloads: vec![Workload {
                name: "noimage-cmd".to_string(),
                image: "x:1".to_string(),
                command: vec![],
                ..Default::default()
            }],
        };
        let sup = FastenvSupervisor::new(HostProcessLauncher::new());
        let err = sup.apply(&manifest).unwrap_err();
        // The root cause ("has no command") is wrapped by the supervisor's
        // "launch workload '…'" context, so inspect the whole error chain.
        let chain = format!("{err:#}");
        assert!(chain.contains("no command"), "unexpected error: {chain}");
    }

    #[test]
    fn workload_stateful_defaults_false_for_back_compat() {
        // A manifest emitted before the `stateful` field existed must still
        // parse (translator may omit it).
        let w: Workload = serde_json::from_str(r#"{"name":"app","image":"a:1"}"#).unwrap();
        assert!(!w.stateful);
    }
}
