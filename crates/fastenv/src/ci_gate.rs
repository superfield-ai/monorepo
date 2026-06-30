// ci_gate.rs — the manifest VALIDATION/GATE decoupling seam.
//
// Canonical docs:
//   - docs/adr-ci-execution-manifest.md  ("the gate is the enforcement
//     boundary" — `ci-taxonomy-audit` plus the four test-coverage invariants
//     apply directly to the persisted manifest)
//   - docs/testing-invariants.md         (the four invariants enforced here)
//
// STATUS (dev-scout seam for issue #824 — real impl lands there)
// =====================================================================
// This module is a COMPILE-SAFE STUB. It defines the boundary the
// ci-taxonomy + test-coverage gate feature (#824) will fill: validate a
// `crate::manifest::CiManifest` against
//   - the FOUR executed-coverage invariants (loud-skip never silent-skip;
//     exit-0 != tested; runtime behaviour needs an executed-in-CI assertion;
//     required checks cover the languages present), and
//   - the ci-taxonomy classification rules (each gate job's declared
//     `JobClass` must be correct for what it does).
//
// The schema (issue #821) makes the forbidden states REPRESENTABLE (e.g.
// `MissingResourcePolicy::SilentSkip`, `min_executed_tests == 0`) precisely so
// THIS gate has something to reject. The schema represents; the gate enforces.
//
// The default `UnimplementedManifestGate` does NOT change runtime behaviour:
// it is never invoked today and panics via `unimplemented!`. #821's test only
// proves the seam is referenceable as a trait object.
//
// DISJOINT SURFACE: issue #824 owns THIS FILE. #822 owns ci_executor.rs and
// #823 owns ci_import.rs; the three do not overlap, so they land in parallel.

use crate::manifest::CiManifest;

/// A single way a manifest violates an invariant or a taxonomy rule.
///
/// Intentionally minimal in the stub — issue #824 expands this with the
/// specific invariant/rule, the offending job id, and a remediation hint. Kept
/// as a named type now so the trait signature is stable for downstream work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateViolation {
    /// Id of the offending job (empty for manifest-level violations).
    pub job_id: String,
    /// Human-readable description of the violation.
    pub message: String,
}

/// Validates a `CiManifest` against the four executed-coverage invariants and
/// the ci-taxonomy classification rules.
///
/// Real implementation: issue #824. Returns `Ok(())` for a compliant manifest,
/// or the full list of violations (never short-circuits on the first).
pub trait ManifestGate {
    /// Validate the manifest. `Err` carries every violation found.
    fn validate(&self, manifest: &CiManifest) -> Result<(), Vec<GateViolation>>;
}

/// Compile-safe no-op gate. Exists only so the seam is referenceable and
/// link-checked; it performs no real validation.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnimplementedManifestGate;

impl ManifestGate for UnimplementedManifestGate {
    fn validate(&self, _manifest: &CiManifest) -> Result<(), Vec<GateViolation>> {
        // real impl: issue #824. Panics (rather than returning a fake-pass
        // `Ok(())`) so a premature call fails loudly, never a false green.
        unimplemented!("manifest validation/gate is owned by issue #824 (crate::ci_gate)")
    }
}
