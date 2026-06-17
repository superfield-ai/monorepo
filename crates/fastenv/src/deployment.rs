// deployment.rs — deployment-tier runtime SEAM (dev-scout stub, no runtime behavior).
//
// Canonical docs:
//   - crates/fastenv/docs/architecture.md
//   - docs/technical-requirements.md
//
// SCOUT STATUS (issue #663, phase: fastenv-deployment-runtime)
// ============================================================
// This module is a COMPILE-SAFE, NO-OP SEAM. It defines the shape of the
// deployment-tier runtime that runs long-lived app + Postgres workloads from a
// manifest, but it implements NO real supervision behavior. The real
// implementation is tracked by issue #662 (feat: fastenv deployment-tier
// runtime — run app+Postgres from a FastenvManifest).
//
// DO NOT add real process spawning, health probing, or workload teardown here
// until #662. Every method on the stub supervisor returns immediately and
// changes nothing on the host. The stub exists only so that:
//   1. the `fastenv up` subcommand skeleton has a typed entrypoint to call,
//   2. the FastenvManifest → supervisor consumer contract is pinned in Rust,
//   3. downstream tests can assert the seam exists and is a no-op.
//
// =====================================================================
// FastenvManifest CONSUMER CONTRACT
// =====================================================================
// The deployment tier consumes a `FastenvManifest`: the engine-agnostic
// workload spec emitted by the control-core translation layer
// (packages/control-core/fastenv-translate.ts — the planned translation layer
// from Kubernetes manifests / docker-compose). That TypeScript artifact is the
// SOURCE OF TRUTH for the wire shape; the Rust types below MUST be kept in sync
// with it field-for-field when #662 implements deserialization.
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
//                                      NO CoreDNS) — see RISK: networking below
//   readinessProbe / livenessProbe →  HealthProbe surface consumed by `doctor`
//   StatefulSet (Postgres)         →  Workload with a persistent data volume
//                                      (RISK: Postgres supervision below)
//
// Because the TypeScript translator does not yet exist, the Rust types here are
// the SCOUT'S BEST-EFFORT contract sketch. They are intentionally minimal: only
// the fields the supervisor must read to start/health-check/stop a workload.
// #662 owns finalizing this shape against fastenv-translate.ts.

use std::collections::BTreeMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Engine-agnostic deployment-tier manifest consumed by the supervisor.
///
/// SCOUT CONTRACT: mirrors the planned `FastenvManifest` emitted by
/// `packages/control-core/fastenv-translate.ts`. Keep field names in sync with
/// that translator when #662 wires up real deserialization. Today this type is
/// only constructed in tests; nothing in the runtime path consumes it.
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
/// SCOUT CONTRACT: corresponds to one translated k8s Deployment/StatefulSet or
/// one compose service. Only the fields the supervisor must read are modeled.
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
    /// Health probe the `doctor` surface queries to gate readiness.
    /// `None` means the workload is considered healthy once started.
    #[serde(default)]
    pub health: Option<HealthProbe>,
}

/// Readiness/liveness probe definition consumed by the `doctor` health surface.
///
/// SCOUT CONTRACT: the deployment-tier equivalent of a k8s readiness/liveness
/// probe. The variants mirror the probe kinds the translator is expected to
/// emit. The `doctor` subcommand will report on these once #662 lands.
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

/// Manifest supervisor SEAM.
///
/// SCOUT CONTRACT: the long-lived workload supervisor that the deployment-tier
/// entrypoint (`fastenv up`) drives. The real implementation (issue #662) will:
///   - `apply`: start each workload as a long-lived process (app + Postgres),
///   - `health`: probe each workload via its `HealthProbe` for the `doctor`
///     readiness gate,
///   - `down`: stop and clean up all supervised workloads.
///
/// The trait is deliberately small and host-agnostic so that #662 can back it
/// with the existing container runtime (see `crate::container_runtime`) and the
/// host/guest boundary (see `crate::boundary`) without reshaping this seam.
pub trait ManifestSupervisor {
    /// Start (or reconcile) all workloads described by the manifest.
    ///
    /// STUB: no-op in the scout build — starts nothing.
    fn apply(&self, manifest: &FastenvManifest) -> Result<()>;

    /// Report the current health of a named workload.
    ///
    /// STUB: always reports `HealthStatus::Stopped` in the scout build.
    fn health(&self, workload_name: &str) -> Result<HealthStatus>;

    /// Stop and clean up all supervised workloads.
    ///
    /// STUB: no-op in the scout build — stops nothing.
    fn down(&self) -> Result<()>;
}

/// No-op supervisor used by the scout build.
///
/// Every method is intentionally inert: constructing or calling this struct
/// changes NOTHING on the host. It exists so the `fastenv up` skeleton compiles
/// against a real type and so tests can assert the seam is wired but no-op.
/// Issue #662 replaces this with a real supervisor backed by the container
/// runtime.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopSupervisor;

impl ManifestSupervisor for NoopSupervisor {
    fn apply(&self, manifest: &FastenvManifest) -> Result<()> {
        // SCOUT STUB: no workloads are started. Emit a trace so an operator can
        // see the deployment-tier seam was reached without any side effect.
        tracing::warn!(
            seam = "deployment::ManifestSupervisor",
            manifest = %manifest.name,
            workloads = manifest.workloads.len(),
            "deployment-tier supervisor is a scout no-op stub (issue #662); \
             no workloads started"
        );
        Ok(())
    }

    fn health(&self, workload_name: &str) -> Result<HealthStatus> {
        tracing::warn!(
            seam = "deployment::ManifestSupervisor",
            workload = %workload_name,
            "deployment-tier health is a scout no-op stub (issue #662)"
        );
        Ok(HealthStatus::Stopped)
    }

    fn down(&self) -> Result<()> {
        tracing::warn!(
            seam = "deployment::ManifestSupervisor",
            "deployment-tier down is a scout no-op stub (issue #662); \
             nothing to stop"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_supervisor_apply_is_inert() {
        // The seam must compile and be callable, and applying a manifest must
        // NOT change runtime behavior — it simply returns Ok.
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
        // Scout stub never supervises anything, so health is always Stopped.
        let sup = NoopSupervisor;
        assert_eq!(sup.health("app").unwrap(), HealthStatus::Stopped);
    }

    #[test]
    fn noop_supervisor_down_is_inert() {
        let sup = NoopSupervisor;
        assert!(sup.down().is_ok());
    }

    #[test]
    fn manifest_round_trips_through_json() {
        // The FastenvManifest contract must survive (de)serialization so the
        // translator (packages/control-core/fastenv-translate.ts) and the Rust
        // consumer agree on the wire shape.
        let manifest = FastenvManifest {
            name: "superfield".to_string(),
            workloads: vec![
                Workload {
                    name: "postgres".to_string(),
                    image: "postgres:16".to_string(),
                    command: vec![],
                    env: [("POSTGRES_DB".to_string(), "app".to_string())]
                        .into_iter()
                        .collect(),
                    health: Some(HealthProbe::Tcp { port: 5432 }),
                },
                Workload {
                    name: "app".to_string(),
                    image: "superfield:latest".to_string(),
                    command: vec!["serve".to_string()],
                    env: BTreeMap::new(),
                    health: Some(HealthProbe::Http {
                        port: 8080,
                        path: "/healthz".to_string(),
                    }),
                },
            ],
        };
        let json = serde_json::to_string(&manifest).expect("serialize");
        let back: FastenvManifest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(manifest, back);
    }

    #[test]
    fn manifest_defaults_are_empty() {
        // An empty manifest must parse (translator may emit zero workloads).
        let manifest: FastenvManifest = serde_json::from_str("{}").expect("empty manifest parses");
        assert!(manifest.workloads.is_empty());
    }
}
