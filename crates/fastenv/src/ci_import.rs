// ci_import.rs — the GitHub Actions IMPORTER/ADAPTER decoupling seam.
//
// Canonical docs:
//   - docs/adr-ci-execution-manifest.md  ("GHA YAML is a downstream emitter" —
//     a generated adapter at the GitHub boundary, an OUTPUT not the source of
//     truth; importing existing workflows is how a project adopts the manifest)
//   - docs/testing-invariants.md
//
// STATUS (dev-scout seam for issue #823 — real impl lands there)
// =====================================================================
// This module is a COMPILE-SAFE STUB. It defines the boundary the GHA
// backward-compatibility feature (#823) will fill: a round-trip between
// `.github/workflows/*.yml` and `crate::manifest::CiManifest`.
//
//   - `import`: parse a GitHub Actions workflow YAML into a substrate-agnostic
//     `CiManifest`, dropping the substrate concepts the schema deliberately has
//     no home for (`runs-on`, marketplace actions, `permissions:`, contexts).
//   - `emit`: generate a GHA workflow YAML FROM a `CiManifest`, re-attaching a
//     concrete substrate, so a project that keeps pushing to GitHub stays
//     backward-compatible.
//
// The default `UnimplementedGithubActionsAdapter` does NOT change runtime
// behaviour: it is never invoked today and panics via `unimplemented!`. #821's
// test only proves the seam is referenceable as a trait object.
//
// DISJOINT SURFACE: issue #823 owns THIS FILE. #822 owns ci_executor.rs and
// #824 owns ci_gate.rs; the three do not overlap, so they land in parallel.

use anyhow::Result;

use crate::manifest::CiManifest;

/// Round-trips between GitHub Actions workflow YAML and a `CiManifest`.
///
/// Real implementation: issue #823. The round-trip is lossy by design in one
/// direction — substrate concepts (`runs-on`, marketplace actions,
/// `permissions:`) are discarded on `import` and re-synthesised on `emit` — so
/// implementors document their substrate-mapping policy.
pub trait GithubActionsAdapter {
    /// Import a GitHub Actions workflow YAML into a substrate-agnostic manifest.
    fn import(&self, workflow_yaml: &str) -> Result<CiManifest>;

    /// Emit a GitHub Actions workflow YAML from a manifest.
    fn emit(&self, manifest: &CiManifest) -> Result<String>;
}

/// Compile-safe no-op adapter. Exists only so the seam is referenceable and
/// link-checked; it performs no real parsing or emission.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnimplementedGithubActionsAdapter;

impl GithubActionsAdapter for UnimplementedGithubActionsAdapter {
    fn import(&self, _workflow_yaml: &str) -> Result<CiManifest> {
        // real impl: issue #823.
        unimplemented!("GHA workflow import is owned by issue #823 (crate::ci_import)")
    }

    fn emit(&self, _manifest: &CiManifest) -> Result<String> {
        // real impl: issue #823.
        unimplemented!("GHA workflow emission is owned by issue #823 (crate::ci_import)")
    }
}
