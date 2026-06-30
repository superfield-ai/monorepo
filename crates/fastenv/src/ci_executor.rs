// ci_executor.rs — the manifest EXECUTOR decoupling seam.
//
// Canonical docs:
//   - docs/adr-ci-execution-manifest.md  ("FastENV is the substrate" — it runs
//     the manifest natively, NOT via an ACT-style GitHub-runner emulator)
//   - docs/testing-invariants.md
//
// STATUS (dev-scout seam for issue #822 — real impl lands there)
// =====================================================================
// This module is a COMPILE-SAFE STUB. It defines the boundary the executor
// feature (#822) will fill: take a `crate::manifest::CiManifest`, resolve its
// `needs` DAG into an execution order, run each job's commands on the FastENV
// substrate, and report per-job + per-test outcomes (so the gate, #824, can
// assert the four executed-coverage invariants against what ACTUALLY ran).
//
// The default `UnimplementedExecutor` does NOT change runtime behaviour: it is
// never invoked by any current code path; its `execute` panics via
// `unimplemented!` so that a premature wiring fails loudly rather than silently
// no-opping. #821's test only proves the seam is referenceable as a trait
// object — it never calls `execute`.
//
// DISJOINT SURFACE: issue #822 owns THIS FILE. #823 owns ci_import.rs and #824
// owns ci_gate.rs; none of the three overlap, so they can land in parallel.

use anyhow::Result;

use crate::manifest::CiManifest;

/// The outcome of executing a manifest's job graph.
///
/// Intentionally minimal in the stub — issue #822 expands this with per-job and
/// per-test results (e.g. executed-test counts the gate consumes). Kept as a
/// named type now so the trait signature is stable for downstream features.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecutionReport {
    /// Ids of jobs that ran, in the order they were executed. Empty in the stub.
    pub executed_jobs: Vec<String>,
}

/// Runs a `CiManifest`'s job graph natively on the FastENV substrate.
///
/// Real implementation: issue #822. Implementors resolve the `needs` DAG,
/// execute each job's `commands`, and surface per-job/per-test results for the
/// validation gate.
pub trait CiExecutor {
    /// Execute the manifest's job graph and report what ran.
    fn execute(&self, manifest: &CiManifest) -> Result<ExecutionReport>;
}

/// Compile-safe no-op executor. Exists only so the seam is referenceable and
/// link-checked; it implements no real execution.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnimplementedExecutor;

impl CiExecutor for UnimplementedExecutor {
    fn execute(&self, _manifest: &CiManifest) -> Result<ExecutionReport> {
        // real impl: issue #822. Panics (rather than returning a fake-success
        // empty report) so a premature call fails loudly, never a false green.
        unimplemented!("CI manifest execution is owned by issue #822 (crate::ci_executor)")
    }
}
