// main.rs (tests/) — subprocess CLI acceptance tests for the `run-manifest`
// and `lint-manifest` fastenv subcommands (issue #843, gap 2).
//
// `crates/fastenv/tests/gha_adapter.rs` already proves `import-workflow` /
// `emit-gha` as real binary invocations (see its `cli_emit_and_import_roundtrip`
// test); `run-manifest` (issue #822) and `lint-manifest` (issue #824) had no
// equivalent — their exit-code contracts were only exercised through in-process
// library calls (`ci_executor::run_manifest`, `ci_gate::run_lint`), never through
// the compiled `fastenv` binary itself. A regression that made `main()` swallow
// an `Err` (e.g. logging it instead of propagating it, or omitting the
// `std::process::exit(1)` on the lint violation path) would pass every existing
// test yet silently exit 0 in real CI usage.
//
// These tests invoke the actual `CARGO_BIN_EXE_fastenv` binary as a
// subprocess (not a library call) against a manifest engineered to make the
// underlying operation fail, and assert the PROCESS exit code is non-zero.
//
// NOTE: like `gha_adapter.rs`, this file lives in `mod main { mod tests { … } }`
// (no `#[cfg(test)]` — integration-test crates do not set `cfg(test)`) so
// nextest reports these at the exact AC path `main::tests::<name>`, and
// `cargo test -p fastenv main::tests::<name>` (a substring filter on the test
// NAME) selects them.

mod main {
    mod tests {
        use std::collections::BTreeMap;
        use std::process::Command as ProcCommand;

        use fastenv::manifest::{
            CiManifest, Command, Gate, Job, JobClass, MissingResourcePolicy, ResourceKind,
            ResourceRequirement, SchemaVersion, TestContract,
        };

        fn bin() -> &'static str {
            env!("CARGO_BIN_EXE_fastenv")
        }

        fn hermetic_contract() -> TestContract {
            TestContract {
                min_executed_tests: 0,
                zero_tests_is_failure: false,
                on_missing_resource: MissingResourcePolicy::FailLoud,
                required_resources: vec![],
                asserts_runtime_behavior: false,
                languages: vec![],
            }
        }

        /// `fastenv run-manifest` against a manifest whose only job `needs` a
        /// job id that does not exist in the graph. This is a genuine failure
        /// of the production `ci_executor::run_manifest` path — the graph can
        /// never be ordered, so the job can never run — reached WITHOUT
        /// requiring `CAP_SYS_ADMIN` (an overlayfs mount, which the production
        /// `ForkWorkspaceManager` needs for a job that actually starts, and
        /// which `crates/fastenv/src/fork.rs`'s own tests deliberately avoid
        /// exercising for the same reason). It proves the SAME thing a passing
        /// job would: that a real `Err` returned by
        /// `fastenv::ci_executor::run_manifest` inside `main()` reaches the
        /// operating system as a non-zero process exit code, not just an
        /// in-process `Result`.
        #[test]
        fn run_manifest_cli_nonzero_on_failed_job() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let manifest = CiManifest {
                manifest_version: SchemaVersion::V1,
                name: "cli-failing-job".to_string(),
                jobs: vec![Job {
                    id: "orphan".to_string(),
                    description: None,
                    needs: vec!["does-not-exist".to_string()],
                    commands: vec![Command {
                        program: "/bin/true".to_string(),
                        args: vec![],
                        env: BTreeMap::new(),
                    }],
                    test_contract: hermetic_contract(),
                    gate: None,
                }],
            };
            let manifest_path = tmp.path().join("failing.manifest.json");
            std::fs::write(
                &manifest_path,
                serde_json::to_vec_pretty(&manifest).expect("serialize manifest"),
            )
            .expect("write manifest");

            let root = tmp.path().join("fastenv-root");
            std::fs::create_dir_all(&root).expect("create root");

            let output = ProcCommand::new(bin())
                .args(["--root"])
                .arg(&root)
                .args(["run-manifest", "--manifest"])
                .arg(&manifest_path)
                .args(["--base", "unused-base"])
                .output()
                .expect("run fastenv run-manifest");

            assert!(
                !output.status.success(),
                "run-manifest must exit non-zero for a job graph that can never execute \
                 (dangling 'needs' edge); stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let code = output.status.code();
            assert_ne!(
                code,
                Some(0),
                "process exit code must not be 0; stderr={}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains("needs unknown job id") || stderr.contains("dangling"),
                "stderr should name the dangling dependency edge, got: {stderr}"
            );
        }

        /// `fastenv lint-manifest` against a manifest that violates
        /// executed-coverage invariant 1 (loud-skip, never silent-skip): a job
        /// declares an external resource requirement but sets
        /// `on_missing_resource = silent_skip`. This drives the REAL
        /// `ci_gate::run_lint` -> `std::process::exit(1)` path in `main()` as a
        /// subprocess, proving the CLI actually surfaces a non-zero exit code
        /// for a rejected manifest rather than only returning `Err(..)` from
        /// the library call.
        #[test]
        fn lint_manifest_cli_nonzero_on_violation() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let manifest = CiManifest {
                manifest_version: SchemaVersion::V1,
                name: "cli-lint-violation".to_string(),
                jobs: vec![Job {
                    id: "silently-skips".to_string(),
                    description: None,
                    needs: vec![],
                    commands: vec![Command {
                        program: "cargo".to_string(),
                        args: vec!["test".to_string()],
                        env: BTreeMap::new(),
                    }],
                    test_contract: TestContract {
                        min_executed_tests: 1,
                        zero_tests_is_failure: true,
                        // The violation: resources are declared but a missing
                        // one is silently skipped instead of failing loudly.
                        on_missing_resource: MissingResourcePolicy::SilentSkip,
                        required_resources: vec![ResourceRequirement {
                            kind: ResourceKind::Database,
                            name: "DATABASE_URL".to_string(),
                        }],
                        asserts_runtime_behavior: true,
                        languages: vec![],
                    },
                    gate: Some(Gate {
                        class: JobClass::SystemCorrectness,
                        blocking: true,
                    }),
                }],
            };
            let manifest_path = tmp.path().join("violating.manifest.json");
            std::fs::write(
                &manifest_path,
                serde_json::to_vec_pretty(&manifest).expect("serialize manifest"),
            )
            .expect("write manifest");

            let output = ProcCommand::new(bin())
                .args(["lint-manifest"])
                .arg(&manifest_path)
                .output()
                .expect("run fastenv lint-manifest");

            assert!(
                !output.status.success(),
                "lint-manifest must exit non-zero for an invariant-violating manifest; \
                 stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                output.status.code(),
                Some(1),
                "lint-manifest's documented contract is exit code 1 on rejection"
            );
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains("REJECTED") && stderr.contains("silently-skips"),
                "stderr should name the offending job and REJECTED verdict, got: {stderr}"
            );
        }
    }
}
