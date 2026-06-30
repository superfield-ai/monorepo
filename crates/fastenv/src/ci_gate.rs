// ci_gate.rs — the manifest VALIDATION/GATE decoupling seam.
//
// Canonical docs:
//   - docs/adr-ci-execution-manifest.md  ("the gate is the enforcement
//     boundary" — `ci-taxonomy-audit` plus the four test-coverage invariants
//     apply directly to the persisted manifest)
//   - docs/testing-invariants.md         (the four invariants enforced here)
//
// WHAT THIS MODULE IS (issue #824)
// =====================================================================
// A STATIC gate: given a `crate::manifest::CiManifest`, reject any manifest
// that would produce a FALSE GREEN before it ever runs. It inspects the typed
// `TestContract`/`Gate` fields — it does NOT execute jobs (that is the executor
// seam, issue #822). The schema (issue #821) makes the forbidden states
// REPRESENTABLE (e.g. `MissingResourcePolicy::SilentSkip`,
// `min_executed_tests == 0`) precisely so THIS gate has something to reject.
// The schema represents; the gate enforces.
//
// THE RULES IT ENFORCES
// ---------------------
// The four executed-coverage invariants from docs/testing-invariants.md:
//   1. Loud-skip, never silent-skip — a job that declares external resources
//      must FAIL when they are absent (`FailLoud`), never `SilentSkip`.
//   2. Exit 0 != tested — a coverage job must require >0 executed tests AND
//      make a zero-collection run a hard failure (`--no-tests=fail`).
//   3. Runtime behaviour needs an executed-in-CI assertion — a coverage job
//      must actually assert on runtime behaviour, not only lint/compile/grep.
//   4. Required checks must cover the languages present — every language any
//      job declares must be covered by a BLOCKING coverage gate.
// Plus the ci-taxonomy class rule: a hygiene/doc gate may NOT masquerade as a
// test job (declaring runtime assertions or a >0 executed-test floor) — that is
// the statically-decidable slice of "the declared JobClass must be correct".
//
// COVERAGE CLASSES. Invariants 2/3/4 only bind jobs that CLAIM to be coverage,
// i.e. gates whose ci-taxonomy class is one of {feature-correctness,
// system-correctness, heavy}. Doc/hygiene/sanity/ignore gates and ungated jobs
// are plumbing, not coverage, and are exempt from 2/3 (but a doc/hygiene gate
// that pretends to test trips the class rule, and ALL jobs are subject to
// invariant 1 because any job can declare resources).
//
// DISJOINT SURFACE: issue #824 owns THIS FILE. #822 owns ci_executor.rs and
// #823 owns ci_import.rs; the three do not overlap, so they land in parallel.
// `UnimplementedManifestGate` is preserved alongside the real gate because
// manifest.rs's `seams_are_wired_and_compile_safe` test boxes it as a
// `dyn ManifestGate`; removing it would break that already-merged test.

use crate::manifest::{CiManifest, JobClass, Language, MissingResourcePolicy};

/// The specific rule a [`GateViolation`] reports. Machine-readable so tests and
/// callers can assert on the exact rule rather than a brittle message substring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateRule {
    /// Invariant 1: a job declares external resources but silently skips when
    /// they are absent (`MissingResourcePolicy::SilentSkip`) — a false green.
    LoudSkip,
    /// Invariant 2: a coverage gate does not require >0 executed tests with a
    /// zero-collection run treated as failure ("exit 0 != tested").
    ExitZeroNotTested,
    /// Invariant 3: a coverage gate does not assert on runtime behaviour.
    MissingRuntimeAssertion,
    /// Invariant 4: a language some job declares is not covered by any blocking
    /// coverage gate.
    LanguageNotCovered,
    /// ci-taxonomy: a doc/hygiene gate declares test-like coverage (runtime
    /// assertions or a >0 executed-test floor) — a test job hiding under a
    /// non-coverage label.
    Misclassified,
}

/// A single way a manifest violates an invariant or a taxonomy rule.
///
/// Carries both a machine field ([`rule`](Self::rule)) and a human-readable
/// [`message`](Self::message) with a remediation hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateViolation {
    /// Id of the offending job (empty for manifest-level violations).
    pub job_id: String,
    /// The specific invariant / taxonomy rule that was violated.
    pub rule: GateRule,
    /// Human-readable description of the violation, with a remediation hint.
    pub message: String,
}

/// Validates a `CiManifest` against the four executed-coverage invariants and
/// the ci-taxonomy classification rules.
///
/// Returns `Ok(())` for a compliant manifest, or the full list of violations
/// (it NEVER short-circuits on the first — a maintainer sees every problem in
/// one pass).
pub trait ManifestGate {
    /// Validate the manifest. `Err` carries every violation found.
    fn validate(&self, manifest: &CiManifest) -> Result<(), Vec<GateViolation>>;
}

/// Compile-safe no-op gate. Exists only so the seam is referenceable as a trait
/// object by `manifest::tests::seams_are_wired_and_compile_safe`; it performs no
/// real validation. The real gate is [`StaticManifestGate`].
#[derive(Debug, Clone, Copy, Default)]
pub struct UnimplementedManifestGate;

impl ManifestGate for UnimplementedManifestGate {
    fn validate(&self, _manifest: &CiManifest) -> Result<(), Vec<GateViolation>> {
        // Panics (rather than returning a fake-pass `Ok(())`) so a premature
        // call fails loudly, never a false green. The REAL gate is
        // `StaticManifestGate`.
        unimplemented!(
            "use StaticManifestGate; UnimplementedManifestGate is the compile-safe seam stub"
        )
    }
}

/// The real static gate (issue #824). Stateless — construct with `default()`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StaticManifestGate;

/// Is this ci-taxonomy class one that CLAIMS to be executed coverage?
///
/// Invariants 2/3/4 bind only these classes; doc/hygiene/sanity/ignore gates
/// are plumbing, not coverage.
fn is_coverage_class(class: JobClass) -> bool {
    matches!(
        class,
        JobClass::FeatureCorrectness | JobClass::SystemCorrectness | JobClass::Heavy
    )
}

/// Human-readable name for a language, used in violation messages.
fn language_name(language: Language) -> &'static str {
    match language {
        Language::Rust => "rust",
        Language::TypeScript => "typescript",
        Language::JavaScript => "javascript",
        Language::Python => "python",
        Language::Go => "go",
    }
}

impl ManifestGate for StaticManifestGate {
    fn validate(&self, manifest: &CiManifest) -> Result<(), Vec<GateViolation>> {
        let mut violations: Vec<GateViolation> = Vec::new();

        for job in &manifest.jobs {
            let tc = &job.test_contract;

            // ── Invariant 1 (ANY job): loud-skip, never silent-skip ──────────
            // A job that declares external resources but silently skips when
            // they are absent is counted as coverage yet never runs.
            if tc.on_missing_resource == MissingResourcePolicy::SilentSkip
                && !tc.required_resources.is_empty()
            {
                violations.push(GateViolation {
                    job_id: job.id.clone(),
                    rule: GateRule::LoudSkip,
                    message: format!(
                        "job '{}': on_missing_resource is silent_skip while {} external \
                         resource(s) are declared — set on_missing_resource=fail_loud so a \
                         missing resource fails the job loudly instead of producing a false green",
                        job.id,
                        tc.required_resources.len()
                    ),
                });
            }

            // The remaining per-job rules key off the gate's declared class.
            let Some(gate) = &job.gate else {
                continue;
            };

            if is_coverage_class(gate.class) {
                // ── Invariant 2 (coverage gate): exit 0 != tested ────────────
                if !(tc.min_executed_tests > 0 && tc.zero_tests_is_failure) {
                    violations.push(GateViolation {
                        job_id: job.id.clone(),
                        rule: GateRule::ExitZeroNotTested,
                        message: format!(
                            "job '{}' is a coverage gate ({:?}) but does not prove tests ran: \
                             require min_executed_tests>0 (got {}) AND zero_tests_is_failure=true \
                             (got {}) so a zero-collection run is red ('exit 0 != tested')",
                            job.id, gate.class, tc.min_executed_tests, tc.zero_tests_is_failure
                        ),
                    });
                }

                // ── Invariant 3 (coverage gate): runtime assertion ───────────
                if !tc.asserts_runtime_behavior {
                    violations.push(GateViolation {
                        job_id: job.id.clone(),
                        rule: GateRule::MissingRuntimeAssertion,
                        message: format!(
                            "job '{}' is a coverage gate ({:?}) but asserts_runtime_behavior=false: \
                             lint/compile/grep is not coverage — at least one check must execute the \
                             behaviour and assert on it",
                            job.id, gate.class
                        ),
                    });
                }
            } else {
                // ── ci-taxonomy class rule: a doc/hygiene gate may not pose as
                // a test job. Declaring runtime assertions or a >0 executed-test
                // floor under a non-coverage label is a false-green vector.
                if matches!(gate.class, JobClass::DocCorrectness | JobClass::CodeHygiene)
                    && (tc.asserts_runtime_behavior || tc.min_executed_tests > 0)
                {
                    violations.push(GateViolation {
                        job_id: job.id.clone(),
                        rule: GateRule::Misclassified,
                        message: format!(
                            "job '{}' is classed {:?} (non-coverage) but declares test coverage \
                             (asserts_runtime_behavior={}, min_executed_tests={}): reclassify it as \
                             feature-correctness/system-correctness, or drop the test claims",
                            job.id, gate.class, tc.asserts_runtime_behavior, tc.min_executed_tests
                        ),
                    });
                }
            }
        }

        // ── Invariant 4 (manifest-level): required checks cover the languages
        // present. "Present" = every language any job declares. "Covered" =
        // languages of BLOCKING gates of a coverage class (the schema's
        // `blocking` flag maps onto the invariant's "required branch-protection
        // contexts"). A language present but not covered is a hole.
        let mut present: Vec<Language> = Vec::new();
        let mut covered: Vec<Language> = Vec::new();
        for job in &manifest.jobs {
            for &lang in &job.test_contract.languages {
                if !present.contains(&lang) {
                    present.push(lang);
                }
            }
            if let Some(gate) = &job.gate {
                if gate.blocking && is_coverage_class(gate.class) {
                    for &lang in &job.test_contract.languages {
                        if !covered.contains(&lang) {
                            covered.push(lang);
                        }
                    }
                }
            }
        }
        for lang in present {
            if !covered.contains(&lang) {
                violations.push(GateViolation {
                    job_id: String::new(),
                    rule: GateRule::LanguageNotCovered,
                    message: format!(
                        "language '{}' is declared by a job but is not covered by any BLOCKING \
                         coverage gate (feature/system/heavy): add or mark blocking a test-executing \
                         gate for it, or 'compiles but never runs tests' is a coverage hole",
                        language_name(lang)
                    ),
                });
            }
        }

        if violations.is_empty() {
            Ok(())
        } else {
            Err(violations)
        }
    }
}

/// Thin entry point so `main.rs` stays a wrapper and the real logic lives here.
/// Validates `manifest` with [`StaticManifestGate`].
pub fn run_lint(manifest: &CiManifest) -> Result<(), Vec<GateViolation>> {
    StaticManifestGate.validate(manifest)
}

#[cfg(test)]
mod manifest_lint {
    #[cfg(test)]
    mod tests {
        use crate::ci_gate::{run_lint, GateRule, ManifestGate, StaticManifestGate};
        use crate::manifest::{
            CiManifest, Command, Gate, Job, JobClass, Language, MissingResourcePolicy,
            ResourceKind, ResourceRequirement, SchemaVersion, TestContract,
        };
        use std::collections::BTreeMap;

        /// A fully-compliant 2-job manifest: a CodeHygiene gate (no test claims)
        /// and a SystemCorrectness gate (DB-gated, fail-loud, >0 tests, asserts
        /// runtime, Rust). Used as the base for the per-invariant rejection tests.
        fn compliant_manifest() -> CiManifest {
            CiManifest {
                manifest_version: SchemaVersion::V1,
                name: "compliant".to_string(),
                jobs: vec![
                    Job {
                        id: "hygiene".to_string(),
                        description: None,
                        needs: vec![],
                        commands: vec![Command {
                            program: "cargo".to_string(),
                            args: vec!["clippy".to_string()],
                            env: BTreeMap::new(),
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
                        needs: vec!["hygiene".to_string()],
                        commands: vec![Command {
                            program: "cargo".to_string(),
                            args: vec!["nextest".to_string(), "run".to_string()],
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

        /// The `rust-tests` job, mutated in place by the rejection tests.
        fn rust_job(m: &mut CiManifest) -> &mut Job {
            m.jobs
                .iter_mut()
                .find(|j| j.id == "rust-tests")
                .expect("fixture has a rust-tests job")
        }

        #[test]
        fn accepts_compliant_manifest() {
            let m = compliant_manifest();
            assert!(
                StaticManifestGate.validate(&m).is_ok(),
                "a fully compliant manifest must pass the gate"
            );
            // run_lint is the thin wrapper main.rs calls; it agrees.
            assert!(run_lint(&m).is_ok());
        }

        #[test]
        fn rejects_loud_skip_violation() {
            let mut m = compliant_manifest();
            // Resources still declared, but now it silently skips them.
            rust_job(&mut m).test_contract.on_missing_resource = MissingResourcePolicy::SilentSkip;
            let violations = StaticManifestGate
                .validate(&m)
                .expect_err("a silent-skip with declared resources must be rejected");
            assert!(
                violations
                    .iter()
                    .any(|v| v.rule == GateRule::LoudSkip && v.job_id == "rust-tests"),
                "expected a LoudSkip violation on rust-tests, got {violations:?}"
            );
        }

        #[test]
        fn rejects_exit0_not_tested() {
            let mut m = compliant_manifest();
            rust_job(&mut m).test_contract.min_executed_tests = 0;
            rust_job(&mut m).test_contract.zero_tests_is_failure = false;
            let violations = StaticManifestGate
                .validate(&m)
                .expect_err("a coverage gate that does not require >0 tests must be rejected");
            assert!(
                violations
                    .iter()
                    .any(|v| v.rule == GateRule::ExitZeroNotTested && v.job_id == "rust-tests"),
                "expected an ExitZeroNotTested violation on rust-tests, got {violations:?}"
            );
        }

        #[test]
        fn rejects_missing_runtime_assertion() {
            let mut m = compliant_manifest();
            rust_job(&mut m).test_contract.asserts_runtime_behavior = false;
            let violations = StaticManifestGate
                .validate(&m)
                .expect_err("a coverage gate that asserts no runtime behaviour must be rejected");
            assert!(
                violations.iter().any(
                    |v| v.rule == GateRule::MissingRuntimeAssertion && v.job_id == "rust-tests"
                ),
                "expected a MissingRuntimeAssertion violation on rust-tests, got {violations:?}"
            );
        }

        /// A TypeScript-declaring job that is otherwise invariant-2/3-clean but
        /// only ADVISORY (blocking=false) leaves TS uncovered; flipping it to
        /// blocking covers it. Proves invariant 4 keys on `blocking`.
        fn ts_job(blocking: bool) -> Job {
            Job {
                id: "ts-tests".to_string(),
                description: None,
                needs: vec![],
                commands: vec![],
                test_contract: TestContract {
                    min_executed_tests: 1,
                    zero_tests_is_failure: true,
                    on_missing_resource: MissingResourcePolicy::FailLoud,
                    required_resources: vec![],
                    asserts_runtime_behavior: true,
                    languages: vec![Language::TypeScript],
                },
                gate: Some(Gate {
                    class: JobClass::FeatureCorrectness,
                    blocking,
                }),
            }
        }

        #[test]
        fn rejects_languages_not_covered() {
            // Advisory (non-blocking) TS gate: TypeScript present but uncovered.
            let mut m = compliant_manifest();
            m.jobs.push(ts_job(false));
            let violations = StaticManifestGate
                .validate(&m)
                .expect_err("a language with no blocking coverage gate must be rejected");
            assert!(
                violations
                    .iter()
                    .any(|v| v.rule == GateRule::LanguageNotCovered
                        && v.message.contains("typescript")),
                "expected a LanguageNotCovered violation naming typescript, got {violations:?}"
            );

            // Sibling: the SAME job marked blocking now covers TypeScript.
            let mut covered = compliant_manifest();
            covered.jobs.push(ts_job(true));
            assert!(
                StaticManifestGate.validate(&covered).is_ok(),
                "marking the TS gate blocking should cover the language and pass"
            );
        }

        /// The committed golden example manifest must PASS the gate, so a future
        /// non-compliant committed example goes red in this required test job.
        #[test]
        fn golden_example_passes_gate() {
            let golden = include_str!("../docs/examples/monorepo-ci.manifest.json");
            let m: CiManifest =
                serde_json::from_str(golden).expect("golden example manifest must parse");
            assert!(
                StaticManifestGate.validate(&m).is_ok(),
                "the committed golden example manifest must pass the gate"
            );
        }

        /// AC4 structural check: the manifest-lint gate workflow exists, runs the
        /// `lint-manifest` binary, and its stable job name is registered as a
        /// required context. Reads via CARGO_MANIFEST_DIR (compile-time absolute)
        /// so it is CWD-independent; a missing file FAILS loudly (never skips).
        #[test]
        fn manifest_lint_gate_job_is_present_and_required() {
            // The stable job name == the registered required-context identity.
            const JOB_NAME: &str = "Manifest gate (lint-manifest)";

            let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..");
            let workflow = repo_root.join(".github/workflows/manifest-lint.yml");
            let contexts = repo_root.join("scripts/required-status-contexts.txt");

            let wf = std::fs::read_to_string(&workflow).unwrap_or_else(|e| {
                panic!("manifest-lint workflow must exist at {workflow:?}: {e}")
            });
            assert!(
                wf.contains("lint-manifest"),
                "manifest-lint.yml must invoke `lint-manifest`"
            );
            assert!(
                wf.contains(JOB_NAME),
                "manifest-lint.yml must declare the stable job name '{JOB_NAME}'"
            );

            let ctx = std::fs::read_to_string(&contexts).unwrap_or_else(|e| {
                panic!("required-status-contexts.txt must exist at {contexts:?}: {e}")
            });
            assert!(
                ctx.lines().any(|l| l.trim() == JOB_NAME),
                "required-status-contexts.txt must list the gate job name '{JOB_NAME}'"
            );
        }
    }
}
