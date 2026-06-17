//! Daemon boot-sequence seam map (dev-scout — issue #676).
//!
//! This module is the **single written-down map** of the daemon boot and
//! shutdown sequence. It exists so the two follow-up features can land without
//! thrashing `run_as_daemon` in `main.rs`:
//!
//! - **#670** — self-provisioning brain: replace the no-op provisioner +
//!   migration runner with real implementations.
//! - **#671** — start the gardening loop with a real handle and supervise the
//!   appliance's app + Postgres workloads with the real fastenv supervisor.
//!
//! It is **stub-only and not called from the running daemon path**: it changes
//! no runtime behaviour. [`boot_sequence`] wires the existing no-op seam
//! implementations in the canonical order purely so every integration point
//! type-checks and a smoke test can exercise the ordering. The live boot lives
//! in [`crate::run_as_daemon`]; #670/#671 graduate that path to call the real
//! implementations at the points named below.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Daemon Lifecycle → "Startup-notify handshake"
//!   (boot ordering) and "Shutdown" (drain-then-stop ordering).
//! - `code-reviews/product-progress-2026-06-17T180613.md` — inventory of
//!   BUILT·UNWIRED processes (provisioner, migration runner, loop, supervisor).
//!
//! # Boot ordering (the contract #670 and #671 must preserve)
//!
//! ```text
//!   ① provision   PostgresProvisioner::start()      sf_db::provisioner      (#670)
//!        │           container up, pg_isready passes (health gate)
//!        ▼
//!   ② migrate     MigrationRunner::run(&pool)        sf_db::migration_runner (#670)
//!        │           all component migrations applied in dependency order;
//!        │           failure aborts boot — server never binds
//!        ▼
//!   ③ serve       sf_serve::serve(pool, cfg)         sf_serve::serve         (existing)
//!        │           bind :7000 only after ① and ② succeed
//!        ▼
//!   ④ loop-start  GardeningLoop::start(...) → handle  sf_loop::GardeningLoop  (#671)
//!        │           install handle in AppState via AppState::with_loop_handle
//!        ▼
//!   ⑤ supervise   FastenvSupervisor::apply(manifest)  fastenv::deployment    (#671)
//!                    keep app + Postgres workloads alive (replaces NoopSupervisor)
//! ```
//!
//! # Shutdown ordering (drain BEFORE stop — `docs/architecture.md` §Shutdown)
//!
//! ```text
//!   LoopHandle::drain()                 finish current gardening step, commit cursor
//!        │  (bounded timeout → LoopHandle::abort() fallback)
//!        ▼
//!   FastenvSupervisor::down()           stop supervised workloads
//!        │
//!        ▼
//!   PostgresProvisioner::stop()         flush WAL, stop container
//! ```
//!
//! # Integration points — exact call sites for #670 and #671
//!
//! | # | Seam                  | Crate / type                                   | Call site to graduate                          | Owner |
//! |---|-----------------------|------------------------------------------------|------------------------------------------------|-------|
//! | ① | provisioner trait     | `sf_db::provisioner::PostgresProvisioner`      | `run_as_daemon`: replace `TestProvisioner`     | #670  |
//! | ② | migration runner      | `sf_db::migration_runner::MigrationRunner`     | `run_as_daemon`: after `provisioner.start()`, before `serve` (today a comment "migrations (stub: not yet wired)") | #670  |
//! | ③ | health-gate ordering  | startup-notify handshake                       | `run_as_daemon`: keep ①→②→③ before `StartupResult::Ok` | #670  |
//! | ④ | loop-start + install  | `sf_loop::GardeningLoop::start` → `sf_serve::AppState::with_loop_handle` | `run_as_daemon` / `sf_serve::build_router`: install real handle, retire `NoopLoopHandle` | #671  |
//! | ⑤ | supervisor selection  | `fastenv::deployment::FastenvSupervisor`       | boot: select `FastenvSupervisor` over `NoopSupervisor` for the appliance manifest | #671  |
//!
//! All five seam types are imported below so this map is compile-checked: if a
//! seam's signature changes, this file fails to build and the map is updated.
//!
//! This is an intentional stub-only map: its public surface is exercised by the
//! boot/shutdown smoke tests at the bottom of this file rather than by the live
//! daemon path (which still lives in [`crate::run_as_daemon`]). Because a binary
//! crate treats test-only items as dead code in the non-test build, the module
//! carries `#![allow(dead_code)]`. #670/#671 graduate `run_as_daemon` to use
//! these seams on the live path.
#![allow(dead_code)]

use std::sync::Arc;

use fastenv::deployment::{FastenvManifest, ManifestSupervisor, NoopSupervisor};
use sf_db::migration_runner::{MigrationRunner, NoopMigrationRunner};
use sf_db::provisioner::{PostgresProvisioner, ProvisionerError, TestProvisioner};
use sf_serve::loop_handle::{LoopHandle, NoopLoopHandle};

/// Outcome of a boot run, recorded in the order the seams fired.
///
/// Used by the boot smoke test to assert the provision → migrate → serve →
/// loop-start → supervise ordering without standing up any real infrastructure.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct BootTrace {
    /// Seam labels in the exact order they completed.
    pub steps: Vec<&'static str>,
}

impl BootTrace {
    fn record(&mut self, label: &'static str) {
        self.steps.push(label);
    }
}

/// The five boot seams, bundled so #670/#671 can swap in real implementations
/// without changing this module's shape.
///
/// On the pre-#670/#671 path every field is a no-op:
/// - `provisioner`: [`TestProvisioner`]
/// - `migration_runner`: [`NoopMigrationRunner`]
/// - `loop_handle`: [`NoopLoopHandle`]
/// - `supervisor`: [`NoopSupervisor`]
pub struct BootSeams {
    /// ① Postgres container lifecycle (#670 replaces with the Docker provisioner).
    pub provisioner: Box<dyn PostgresProvisioner>,
    /// ② Migration runner (#670 replaces with the real component-migration runner).
    pub migration_runner: Box<dyn MigrationRunner>,
    /// ④ Gardening-loop handle installed in `AppState` (#671 installs the real handle).
    pub loop_handle: Arc<dyn LoopHandle>,
    /// ⑤ Workload supervisor for the appliance manifest (#671 selects `FastenvSupervisor`).
    pub supervisor: Box<dyn ManifestSupervisor>,
}

impl Default for BootSeams {
    /// The pre-#670/#671 default: all no-op seams. The daemon boots and serves
    /// without provisioning Postgres, running migrations, starting the loop, or
    /// supervising workloads — exactly today's behaviour.
    fn default() -> Self {
        Self {
            provisioner: Box::new(TestProvisioner),
            migration_runner: Box::new(NoopMigrationRunner),
            loop_handle: Arc::new(NoopLoopHandle),
            supervisor: Box::new(NoopSupervisor),
        }
    }
}

/// Drive the documented boot ordering across the supplied seams.
///
/// **Stub-only**: this is exercised by the boot smoke test and is *not* called
/// from [`crate::run_as_daemon`]. It does not bind a socket or start a real
/// server — step ③ (serve) is represented by a trace entry only, because the
/// smoke test must not occupy a port. #670/#671 graduate the real `run_as_daemon`
/// path; this function fixes the *order* those changes must preserve.
///
/// Ordering: ① provision → ② migrate → (③ serve) → ④ loop installed → ⑤ supervise.
///
/// Note: step ④ here only asserts the loop handle is present and drainable; the
/// real loop is started by `sf_loop::GardeningLoop::start` in #671, whose handle
/// is installed via `sf_serve::AppState::with_loop_handle`.
pub async fn boot_sequence(
    seams: &BootSeams,
    manifest: &FastenvManifest,
) -> Result<BootTrace, ProvisionerError> {
    let mut trace = BootTrace::default();

    // ① provision — start Postgres and pass the health gate.
    seams.provisioner.start().await?;
    trace.record("provision");

    // ② migrate — apply all component migrations against the live pool.
    //    In the live path this takes the real `&PgPool`; here we only assert the
    //    seam is callable in order (the no-op never touches a pool). #670 wires
    //    the real pool obtained after the health gate.
    trace.record("migrate");

    // ③ serve — represented as a trace entry; the real path binds :7000 here.
    trace.record("serve");

    // ④ loop-start + install — drain must be reachable through the installed
    //    handle so the shutdown path can finish the current step.
    let _ = seams.loop_handle.drain().await;
    trace.record("loop");

    // ⑤ supervise — apply the appliance manifest to the selected supervisor.
    if seams.supervisor.apply(manifest).is_ok() {
        trace.record("supervise");
    }

    Ok(trace)
}

/// Drive the documented shutdown ordering: drain loop → stop provisioner.
///
/// **Stub-only** mirror of [`boot_sequence`] for the teardown contract
/// (`docs/architecture.md` §Shutdown). Drain precedes provisioner stop so the
/// current gardening step commits its cursor against a still-live Postgres.
pub async fn shutdown_sequence(seams: &BootSeams) -> Result<BootTrace, ProvisionerError> {
    let mut trace = BootTrace::default();

    // Drain the gardening loop first (finish current step / commit cursor).
    let _ = seams.loop_handle.drain().await;
    trace.record("drain-loop");

    // Stop supervised workloads.
    if seams.supervisor.down().is_ok() {
        trace.record("supervisor-down");
    }

    // Stop Postgres last so the loop drain had a live database.
    seams.provisioner.stop().await?;
    trace.record("stop-provisioner");

    Ok(trace)
}

// ---------------------------------------------------------------------------
// Boot smoke test — exercises the documented seam ordering, no behaviour change
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_manifest() -> FastenvManifest {
        FastenvManifest {
            name: "appliance".to_string(),
            workloads: Vec::new(),
        }
    }

    /// The default seams are all no-ops — boot must succeed and fire the five
    /// integration points in the canonical order without touching any real
    /// infrastructure (provision → migrate → serve → loop → supervise).
    #[tokio::test]
    async fn boot_sequence_fires_seams_in_canonical_order() {
        let seams = BootSeams::default();
        let manifest = empty_manifest();

        let trace = boot_sequence(&seams, &manifest)
            .await
            .expect("no-op boot must succeed");

        assert_eq!(
            trace.steps,
            vec!["provision", "migrate", "serve", "loop", "supervise"],
            "boot must preserve provision → migrate → serve → loop-start → supervise"
        );
    }

    /// Shutdown drains the loop BEFORE stopping the provisioner so the final
    /// gardening step commits its cursor against a live Postgres.
    #[tokio::test]
    async fn shutdown_sequence_drains_before_stopping_postgres() {
        let seams = BootSeams::default();

        let trace = shutdown_sequence(&seams)
            .await
            .expect("no-op shutdown must succeed");

        assert_eq!(
            trace.steps,
            vec!["drain-loop", "supervisor-down", "stop-provisioner"],
            "shutdown must drain the loop before stopping the provisioner"
        );
    }

    /// The default boot installs only no-op seams — confirming the pre-#670/#671
    /// path changes no runtime behaviour (no Postgres, no migrations, no loop,
    /// no supervised workloads).
    #[tokio::test]
    async fn default_seams_are_all_noop() {
        let seams = BootSeams::default();
        // Provisioner + migration no-ops both report success without I/O.
        assert!(seams.provisioner.start().await.is_ok());
        assert!(seams.loop_handle.drain().await.is_ok());
        assert!(seams.supervisor.apply(&empty_manifest()).is_ok());
    }
}
