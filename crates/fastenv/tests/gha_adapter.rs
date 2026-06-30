// gha_adapter.rs — executed-in-CI acceptance tests for the GitHub Actions
// backward-compat adapter (issue #823, crate::ci_import).
//
// These run the REAL `DefaultGithubActionsAdapter` against:
//   - every actual `.github/workflows/*.yml` in the repo (no-silent-drop
//     contract), proving an unrepresentable construct fails CI rather than
//     being dropped;
//   - one-construct snippets that must each error loudly (invariant 1);
//   - committed golden fixtures (import/emit byte-stability);
//   - an in-code supported-subset manifest (round-trip property);
//   - the `import-workflow` / `emit-gha` CLI subcommands end-to-end.
//
// nextest reports these at `gha_adapter::tests::<name>`, matched by
// `cargo nextest run -p fastenv gha_adapter --no-tests=fail`.
//
// NOTE: no `#[cfg(test)]` — this is an integration-test crate (already compiled
// only under `--test`), where `cfg(test)` is NOT set, so gating the module on
// it would silently collect zero tests.

mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::process::Command as ProcCommand;

    use fastenv::ci_import::{DefaultGithubActionsAdapter, GithubActionsAdapter};
    use fastenv::manifest::{
        CiManifest, Command, Job, MissingResourcePolicy, SchemaVersion, TestContract,
    };

    fn adapter() -> DefaultGithubActionsAdapter {
        DefaultGithubActionsAdapter
    }

    fn workflows_dir() -> PathBuf {
        PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../.github/workflows"
        ))
    }

    /// AC: imports each real `.github/workflows/*.yml` and asserts semantic
    /// equivalence on re-emit. Because every real workflow uses constructs the
    /// substrate-agnostic manifest deliberately does not model (marketplace
    /// `uses:`, matrices, reusable workflows, `${{ }}` contexts), the assertion
    /// is the NO-SILENT-DROP contract: each file's import is EITHER Ok whose
    /// emit re-imports to an equal manifest, OR a loud Err naming the
    /// unsupported construct — never a silent partial. This guards that a real
    /// construct the adapter cannot represent fails CI instead of being dropped.
    #[test]
    fn roundtrip_repo_workflows() {
        let dir = workflows_dir();
        let mut count = 0usize;
        let entries = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("read workflows dir {}: {e}", dir.display()));

        for entry in entries {
            let path = entry.expect("dir entry").path();
            match path.extension().and_then(|s| s.to_str()) {
                Some("yml") | Some("yaml") => {}
                _ => continue,
            }
            count += 1;
            let yaml = std::fs::read_to_string(&path).expect("read workflow");
            let file = path.display();

            match adapter().import(&yaml) {
                Ok(manifest) => {
                    // Supported workflow: re-emit must round-trip exactly.
                    let emitted = adapter().emit(&manifest).expect("emit");
                    let reimported = adapter()
                        .import(&emitted)
                        .expect("re-import of emitted YAML");
                    assert_eq!(
                        manifest, reimported,
                        "{file}: import->emit->import is not semantically equivalent"
                    );
                }
                Err(err) => {
                    // Unsupported construct: the failure must be LOUD and name
                    // the construct — never a silent drop.
                    let msg = format!("{err:#}");
                    assert!(
                        msg.contains("unsupported GHA construct"),
                        "{file}: import failed but did not name an unsupported construct: {msg}"
                    );
                }
            }
        }

        assert!(
            count > 0,
            "no .github/workflows/*.yml found under {}; the round-trip test covered nothing",
            dir.display()
        );
    }

    /// AC (invariant 1): each one-construct snippet must return a clear Err that
    /// NAMES the construct; NONE may return Ok (a silent drop would be a false
    /// green).
    #[test]
    fn unsupported_construct_errors_loudly() {
        // (yaml, substring the error message must contain)
        let cases: &[(&str, &str)] = &[
            (
                "name: x\njobs:\n  build:\n    steps:\n    - uses: actions/checkout@v4\n",
                "actions/checkout@v4",
            ),
            (
                "name: x\njobs:\n  build:\n    strategy:\n      matrix:\n        rust: [stable, beta]\n    steps:\n    - run: cargo build\n",
                "strategy",
            ),
            (
                "name: x\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n",
                "reusable workflow",
            ),
            (
                "name: x\njobs:\n  build:\n    env:\n      TOKEN: ${{ secrets.X }}\n    steps:\n    - run: echo hi\n",
                "expression context",
            ),
            (
                "name: x\njobs:\n  build:\n    steps:\n    - run: make a && make b\n",
                "metacharacter",
            ),
        ];

        for (yaml, needle) in cases {
            let result = adapter().import(yaml);
            assert!(
                result.is_err(),
                "construct expected to fail loudly imported Ok (silent drop!): {yaml:?}"
            );
            let msg = format!("{:#}", result.unwrap_err());
            assert!(
                msg.contains("unsupported GHA construct"),
                "error did not flag an unsupported construct: {msg}"
            );
            assert!(
                msg.contains(needle),
                "error did not name the construct (expected substring {needle:?}): {msg}"
            );
        }
    }

    /// AC: import/emit match committed golden fixtures.
    #[test]
    fn golden_import_emit() {
        let golden_yml = include_str!("fixtures/gha/supported.yml");
        let golden_json = include_str!("fixtures/gha/supported.manifest.json");

        let golden_manifest: CiManifest =
            serde_json::from_str(golden_json).expect("golden manifest JSON parses");

        // import(yml) == golden manifest
        let imported = adapter().import(golden_yml).expect("import golden yml");
        assert_eq!(imported, golden_manifest, "import(yml) != golden manifest");

        // emit(golden manifest) == golden yml, byte-for-byte (deterministic)
        let emitted = adapter()
            .emit(&golden_manifest)
            .expect("emit golden manifest");
        assert_eq!(emitted, golden_yml, "emit(manifest) != golden yml");

        // import(emit(m)) == m on the supported subset
        let reimported = adapter().import(&emitted).expect("re-import");
        assert_eq!(reimported, golden_manifest, "import(emit(m)) != m");
    }

    /// Round-trip property proven on an in-code supported-subset manifest,
    /// independent of fixtures: default contract, no gate, jobs sorted by id,
    /// argv with no whitespace/metacharacters.
    #[test]
    fn roundtrip_supported_subset() {
        let default_contract = TestContract {
            min_executed_tests: 0,
            zero_tests_is_failure: false,
            on_missing_resource: MissingResourcePolicy::FailLoud,
            required_resources: vec![],
            asserts_runtime_behavior: false,
            languages: vec![],
        };
        let manifest = CiManifest {
            manifest_version: SchemaVersion::V1,
            name: "subset-ci".to_string(),
            jobs: vec![
                Job {
                    id: "alpha".to_string(),
                    description: None,
                    needs: vec![],
                    commands: vec![Command {
                        program: "echo".to_string(),
                        args: vec!["hello".to_string()],
                        env: BTreeMap::from([("FOO".to_string(), "bar".to_string())]),
                    }],
                    test_contract: default_contract.clone(),
                    gate: None,
                },
                Job {
                    id: "beta".to_string(),
                    description: None,
                    needs: vec!["alpha".to_string()],
                    commands: vec![Command {
                        program: "cargo".to_string(),
                        args: vec!["test".to_string(), "--workspace".to_string()],
                        env: BTreeMap::new(),
                    }],
                    test_contract: default_contract.clone(),
                    gate: None,
                },
            ],
        };

        let emitted = adapter().emit(&manifest).expect("emit");
        let reimported = adapter().import(&emitted).expect("import");
        assert_eq!(
            manifest, reimported,
            "import(emit(m)) != m on supported subset"
        );
    }

    /// CLI smoke: run the built binary's `emit-gha` then `import-workflow`
    /// end-to-end, asserting success and that the produced manifest matches the
    /// golden one. Exercises the new subcommands without touching main.rs tests.
    #[test]
    fn cli_emit_and_import_roundtrip() {
        let bin = env!("CARGO_BIN_EXE_fastenv");
        let tmp = tempfile::tempdir().expect("tempdir");
        let manifest_path = PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/gha/supported.manifest.json"
        ));
        let emitted_yml = tmp.path().join("out.yml");
        let reimported_json = tmp.path().join("out.json");

        let status = ProcCommand::new(bin)
            .args(["emit-gha", manifest_path.to_str().unwrap(), "--output"])
            .arg(&emitted_yml)
            .status()
            .expect("run emit-gha");
        assert!(status.success(), "emit-gha exited with failure");
        assert!(emitted_yml.exists(), "emit-gha produced no output file");

        let status = ProcCommand::new(bin)
            .args(["import-workflow", emitted_yml.to_str().unwrap(), "--output"])
            .arg(&reimported_json)
            .status()
            .expect("run import-workflow");
        assert!(status.success(), "import-workflow exited with failure");

        let produced: CiManifest = serde_json::from_str(
            &std::fs::read_to_string(&reimported_json).expect("read out.json"),
        )
        .expect("parse produced manifest");
        let golden: CiManifest =
            serde_json::from_str(include_str!("fixtures/gha/supported.manifest.json"))
                .expect("golden parses");
        assert_eq!(produced, golden, "CLI round-trip manifest != golden");
    }
}
