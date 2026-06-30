// manifest.rs — the substrate-agnostic CI job manifest schema.
//
// Canonical docs:
//   - docs/adr-ci-execution-manifest.md  (the manifest is the spec; FastENV is
//     the substrate; the gate is the enforcement boundary; GHA YAML is a
//     downstream emitter)
//   - docs/testing-invariants.md         (the four executed-coverage invariants
//     the `TestContract` type below makes representable)
//   - docs/prd.md
//
// STATUS (issue #821, phase: CI job manifests — substrate-agnostic,
// GHA-backward-compatible)
// =====================================================================
// This module is the FOUNDATIONAL contract of the phase: a versioned,
// declarative serde schema for a CI job graph — jobs, dependency ordering,
// gates, and an unambiguous typed representation of what "tested" means. Every
// other feature in the phase consumes these types:
//
//   - the EXECUTOR (issue #822, crate::ci_executor) runs the job graph;
//   - the GHA IMPORTER/ADAPTER (issue #823, crate::ci_import) round-trips
//     `.github/workflows/*.yml` <-> `CiManifest`;
//   - the VALIDATION/GATE hook (issue #824, crate::ci_gate) enforces the four
//     test-coverage invariants + the ci-taxonomy classification.
//
// Those three seams live in their own modules so the downstream features own
// DISJOINT file surfaces and can land in parallel against this stable schema.
//
// SUBSTRATE-AGNOSTIC BY CONSTRUCTION
// ==================================
// The schema models the SPEC half of a CI workflow, never GitHub's execution
// substrate. There are deliberately NO `runs-on` labels, marketplace actions,
// `permissions:` blocks, or GitHub contexts here — those are the GHA boundary's
// concern and belong only in the generated adapter (issue #823). A `Job`
// describes *what runs* as plain argv + env, *in what order* (`needs`), what it
// *gates* (`Gate`), and what it *tests* (`TestContract`). Nothing in this file
// knows the workload will ever touch GitHub.
//
// Distinct from `crate::deployment::FastenvManifest`: that type is the
// long-lived-workload deployment manifest (app + Postgres supervision). This is
// the CI job-graph manifest. They are unrelated schemas; the names are kept
// disjoint (`CiManifest` vs `FastenvManifest`) on purpose.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The schema version of a manifest document.
///
/// Versioned from day one so the executor / adapter / gate can refuse a
/// manifest they do not understand instead of silently mis-running it. New
/// variants are added as the schema evolves; deserializing an unknown version
/// string fails loudly (see `tests::unknown_version_rejected`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchemaVersion {
    /// The initial schema defined by issue #821.
    V1,
}

/// A versioned, declarative CI job graph.
///
/// This is the single source of truth the ADR moves "one layer down" from
/// GitHub's substrate: FastENV executes it natively (issue #822), the gate
/// validates it (issue #824), and GHA YAML — if the project keeps pushing to
/// GitHub — is emitted from it (issue #823).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CiManifest {
    /// Schema version. REQUIRED — a manifest with no declared version is
    /// rejected (see `tests::required_fields_rejected`).
    pub manifest_version: SchemaVersion,
    /// Human-readable name of this job graph (e.g. "monorepo-ci"). REQUIRED.
    pub name: String,
    /// The jobs in the graph, in no particular order; execution order is
    /// derived from each job's `needs` edges (a DAG). REQUIRED (may be empty).
    pub jobs: Vec<Job>,
}

/// A single node in the CI job graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Job {
    /// Stable identifier, unique within the manifest; referenced by other
    /// jobs' `needs`. REQUIRED.
    pub id: String,
    /// Optional human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Dependency edges: ids of jobs that must complete before this one. This
    /// is the ordering primitive — a DAG, not GitHub's `needs:` (no runner
    /// semantics attached).
    #[serde(default)]
    pub needs: Vec<String>,
    /// What the job runs: an ordered list of substrate-agnostic commands
    /// (program + args + env). No `runs-on`, no marketplace actions.
    #[serde(default)]
    pub commands: Vec<Command>,
    /// The unambiguous "tested" contract for this job. REQUIRED so that every
    /// job must state, in typed form, what it claims to cover — a job cannot be
    /// silently treated as coverage without declaring its contract.
    pub test_contract: TestContract,
    /// Whether this job is a GATE (its verdict gates the graph) and, if so, its
    /// ci-taxonomy class. `None` = an ordinary job, not a gate. The gate seam
    /// (issue #824) is what actually enforces classification rules; the schema
    /// only records the declared class.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
}

/// A substrate-agnostic command: a program, its arguments, and environment.
///
/// This is the only "what runs" primitive. It is intentionally NOT a GitHub
/// "step" (no `uses:` marketplace action, no shell-injection of contexts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    /// Executable to run (e.g. "cargo").
    pub program: String,
    /// Arguments passed to the program.
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables for this command. A `BTreeMap` so serialization is
    /// deterministic (golden files are byte-stable).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// The unambiguous, typed representation of what "tested" means for a job.
///
/// Designed so all FOUR executed-coverage invariants from
/// `docs/testing-invariants.md` are EXPRESSIBLE as schema fields. The schema
/// only *represents* the contract — the forbidden states (e.g. a silent skip)
/// are representable on purpose so a non-compliant manifest can be described and
/// then REJECTED by the validation/gate seam (issue #824). Per the ADR, "the
/// gate is the enforcement boundary"; this type is not it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestContract {
    /// Invariant 2 ("exit 0 != tested"): the minimum number of tests that must
    /// be observed as EXECUTED for this job to count as coverage. The gate
    /// rejects a job that claims to test something with `0`.
    pub min_executed_tests: u32,
    /// Invariant 2: whether collecting zero tests is a HARD failure (the
    /// `--no-tests=fail` / `--passWithNoTests=false` / "collected 0 items is
    /// red" convention). A compliant test job sets this `true`.
    pub zero_tests_is_failure: bool,
    /// Invariant 1 ("loud-skip, never silent-skip"): what MUST happen when a
    /// declared external resource is absent. The gate rejects `SilentSkip`.
    pub on_missing_resource: MissingResourcePolicy,
    /// Invariants 1 & 3: the external resources this job's tests require (DB,
    /// model weights, network, API key). Empty = hermetic. If non-empty and
    /// `on_missing_resource` is `SilentSkip`, the gate flags a silent-skip hole.
    #[serde(default)]
    pub required_resources: Vec<ResourceRequirement>,
    /// Invariant 3 ("runtime behaviour needs an executed-in-CI assertion"):
    /// whether this job EXECUTES runtime behaviour and asserts on it, as
    /// opposed to only doc-grep / lint / type-check / compile. A job that
    /// introduces runtime behaviour must set this `true`.
    pub asserts_runtime_behavior: bool,
    /// Invariant 4 ("required checks must cover the languages present"): the
    /// languages whose tests this job actually executes. The gate cross-checks
    /// the union across all gating jobs against the languages present.
    #[serde(default)]
    pub languages: Vec<Language>,
}

/// What happens when an external resource a test needs is absent.
///
/// `SilentSkip` is representable so a non-compliant manifest can be DESCRIBED
/// (and then rejected by the gate). It is never a *recommended* value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissingResourcePolicy {
    /// Compliant: fail the job loudly (red) when the resource is missing.
    FailLoud,
    /// Forbidden by invariant 1: skip/no-op (false green). Representable only so
    /// the gate can reject it.
    SilentSkip,
}

/// An external resource a job's tests depend on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceRequirement {
    /// The kind of resource.
    pub kind: ResourceKind,
    /// A name/identifier for the resource (e.g. "DATABASE_URL", "nexum-weights").
    pub name: String,
}

/// The category of an external resource (the invariant-1 examples).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    /// A database (e.g. Postgres / pgvector).
    Database,
    /// Model weights / embeddings.
    ModelWeights,
    /// Network access to an external service.
    Network,
    /// A secret / API key.
    ApiKey,
    /// Any other external resource.
    Other,
}

/// A language whose tests a job executes (invariant 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Rust,
    TypeScript,
    JavaScript,
    Python,
    Go,
}

/// Marks a job as a GATE and records its ci-taxonomy class.
///
/// The class set mirrors the canonical CI taxonomy (`docs/CI-TAXONOMY.md`):
/// the six classes plus `ignore` for non-test plumbing. The gate seam
/// (issue #824) is what enforces the per-class rules; this only records the
/// declared class so the schema can carry it substrate-agnostically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Gate {
    /// The job's ci-taxonomy class.
    pub class: JobClass,
    /// Whether a failure of this gate BLOCKS the graph (a required context) or
    /// is advisory.
    pub blocking: bool,
}

/// The canonical CI taxonomy classes (`docs/CI-TAXONOMY.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobClass {
    /// Doc/text correctness (e.g. doc-conformance).
    DocCorrectness,
    /// Lint / format / build hygiene.
    CodeHygiene,
    /// Scoped unit/component tests.
    FeatureCorrectness,
    /// Integration / e2e / cross-component tests.
    SystemCorrectness,
    /// Meta sanity checks (the CI configuration about itself).
    SanityMeta,
    /// Expensive nightly / long-running tests.
    Heavy,
    /// Non-test plumbing (not a coverage signal).
    Ignore,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fully-populated manifest exercising every typed field, used as the
    /// fixture for the round-trip and invariant tests.
    fn sample_manifest() -> CiManifest {
        CiManifest {
            manifest_version: SchemaVersion::V1,
            name: "monorepo-ci".to_string(),
            jobs: vec![
                Job {
                    id: "build".to_string(),
                    description: Some("compile the workspace".to_string()),
                    needs: vec![],
                    commands: vec![Command {
                        program: "cargo".to_string(),
                        args: vec!["build".to_string(), "--workspace".to_string()],
                        env: BTreeMap::from([(
                            "CARGO_TERM_COLOR".to_string(),
                            "always".to_string(),
                        )]),
                    }],
                    test_contract: TestContract {
                        min_executed_tests: 0,
                        zero_tests_is_failure: false,
                        on_missing_resource: MissingResourcePolicy::FailLoud,
                        required_resources: vec![],
                        asserts_runtime_behavior: false,
                        languages: vec![],
                    },
                    gate: Some(Gate {
                        class: JobClass::CodeHygiene,
                        blocking: true,
                    }),
                },
                Job {
                    id: "rust-tests".to_string(),
                    description: None,
                    needs: vec!["build".to_string()],
                    commands: vec![Command {
                        program: "cargo".to_string(),
                        args: vec![
                            "nextest".to_string(),
                            "run".to_string(),
                            "--workspace".to_string(),
                            "--no-tests=fail".to_string(),
                        ],
                        env: BTreeMap::new(),
                    }],
                    test_contract: TestContract {
                        min_executed_tests: 1,
                        zero_tests_is_failure: true,
                        on_missing_resource: MissingResourcePolicy::FailLoud,
                        required_resources: vec![ResourceRequirement {
                            kind: ResourceKind::Database,
                            name: "DATABASE_URL".to_string(),
                        }],
                        asserts_runtime_behavior: true,
                        languages: vec![Language::Rust],
                    },
                    gate: Some(Gate {
                        class: JobClass::SystemCorrectness,
                        blocking: true,
                    }),
                },
            ],
        }
    }

    /// AC: `manifest::tests::round_trip_serde` reparses a manifest to a
    /// structurally equal value.
    #[test]
    fn round_trip_serde() {
        let manifest = sample_manifest();
        let json = serde_json::to_string_pretty(&manifest).expect("serialize");
        let reparsed: CiManifest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(manifest, reparsed);
    }

    /// AC: `manifest::tests::required_fields_rejected` — a manifest missing a
    /// required field fails to deserialize.
    #[test]
    fn required_fields_rejected() {
        // Missing the required top-level `name`.
        let missing_name = r#"{ "manifest_version": "v1", "jobs": [] }"#;
        assert!(
            serde_json::from_str::<CiManifest>(missing_name).is_err(),
            "manifest with no `name` must be rejected"
        );

        // Missing the required per-job `test_contract`.
        let missing_contract = r#"{
            "manifest_version": "v1",
            "name": "x",
            "jobs": [ { "id": "j" } ]
        }"#;
        assert!(
            serde_json::from_str::<CiManifest>(missing_contract).is_err(),
            "job with no `test_contract` must be rejected"
        );

        // Missing the required per-job `id`.
        let missing_id = r#"{
            "manifest_version": "v1",
            "name": "x",
            "jobs": [ { "test_contract": {
                "min_executed_tests": 1,
                "zero_tests_is_failure": true,
                "on_missing_resource": "fail_loud",
                "asserts_runtime_behavior": true
            } } ]
        }"#;
        assert!(
            serde_json::from_str::<CiManifest>(missing_id).is_err(),
            "job with no `id` must be rejected"
        );
    }

    /// An unknown schema version fails loudly rather than parsing silently.
    #[test]
    fn unknown_version_rejected() {
        let unknown = r#"{ "manifest_version": "v999", "name": "x", "jobs": [] }"#;
        assert!(
            serde_json::from_str::<CiManifest>(unknown).is_err(),
            "unknown manifest_version must be rejected"
        );
    }

    /// An unknown field is rejected (`deny_unknown_fields`) — guards against a
    /// GitHub-substrate concept (e.g. `runs-on`) leaking into the schema.
    #[test]
    fn unknown_field_rejected() {
        let leaked = r#"{
            "manifest_version": "v1",
            "name": "x",
            "jobs": [],
            "runs-on": "ubuntu-latest"
        }"#;
        assert!(
            serde_json::from_str::<CiManifest>(leaked).is_err(),
            "substrate concepts (runs-on) must not be accepted"
        );
    }

    /// AC: `manifest::tests::invariants_representable` constructs a manifest
    /// exercising all four typed invariant fields from docs/testing-invariants.md
    /// and asserts they round-trip.
    #[test]
    fn invariants_representable() {
        let contract = TestContract {
            // Invariant 2: exit-0 != tested.
            min_executed_tests: 3,
            zero_tests_is_failure: true,
            // Invariant 1: loud-skip never silent-skip.
            on_missing_resource: MissingResourcePolicy::FailLoud,
            required_resources: vec![
                ResourceRequirement {
                    kind: ResourceKind::ModelWeights,
                    name: "nexum-weights".to_string(),
                },
                ResourceRequirement {
                    kind: ResourceKind::Database,
                    name: "DATABASE_URL".to_string(),
                },
            ],
            // Invariant 3: runtime behaviour asserted in CI.
            asserts_runtime_behavior: true,
            // Invariant 4: languages present are covered.
            languages: vec![Language::Rust, Language::TypeScript, Language::Python],
        };
        let manifest = CiManifest {
            manifest_version: SchemaVersion::V1,
            name: "all-invariants".to_string(),
            jobs: vec![Job {
                id: "covered".to_string(),
                description: None,
                needs: vec![],
                commands: vec![],
                test_contract: contract.clone(),
                gate: Some(Gate {
                    class: JobClass::SystemCorrectness,
                    blocking: true,
                }),
            }],
        };

        // Each invariant field is independently readable and meaningful.
        let c = &manifest.jobs[0].test_contract;
        assert!(c.min_executed_tests > 0); // inv 2
        assert!(c.zero_tests_is_failure); // inv 2
        assert_eq!(c.on_missing_resource, MissingResourcePolicy::FailLoud); // inv 1
        assert!(!c.required_resources.is_empty()); // inv 1
        assert!(c.asserts_runtime_behavior); // inv 3
        assert!(!c.languages.is_empty()); // inv 4

        // And the whole thing round-trips losslessly.
        let json = serde_json::to_string(&manifest).expect("serialize");
        let reparsed: CiManifest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(manifest, reparsed);
    }

    /// AC / test plan: a golden example manifest committed under
    /// `crates/fastenv/docs/examples` parses, so a malformed example fails CI.
    #[test]
    fn golden_example_parses() {
        let golden = include_str!("../docs/examples/monorepo-ci.manifest.json");
        let manifest: CiManifest =
            serde_json::from_str(golden).expect("golden example manifest must parse");
        assert_eq!(manifest.manifest_version, SchemaVersion::V1);
        assert!(!manifest.jobs.is_empty(), "golden example must have jobs");
        // It also re-serializes and re-parses identically (structural stability).
        let json = serde_json::to_string(&manifest).expect("serialize");
        let reparsed: CiManifest = serde_json::from_str(&json).expect("reparse");
        assert_eq!(manifest, reparsed);
    }

    /// Proves the three decoupling seams (issues #822/#823/#824) are WIRED and
    /// COMPILE-SAFE and usable as trait objects, WITHOUT asserting any real
    /// behaviour (calling them is the downstream issues' job — the stubs panic
    /// via `unimplemented!`). This is the disjoint-surface guard: each seam is
    /// referenceable from the schema crate.
    #[test]
    fn seams_are_wired_and_compile_safe() {
        let _executor: Box<dyn crate::ci_executor::CiExecutor> =
            Box::new(crate::ci_executor::UnimplementedExecutor);
        let _adapter: Box<dyn crate::ci_import::GithubActionsAdapter> =
            Box::new(crate::ci_import::UnimplementedGithubActionsAdapter);
        let _gate: Box<dyn crate::ci_gate::ManifestGate> =
            Box::new(crate::ci_gate::UnimplementedManifestGate);
        // Intentionally NOT calling execute/import/emit/validate: real behaviour
        // belongs to #822/#823/#824. We only prove the seams exist and link.
    }
}
