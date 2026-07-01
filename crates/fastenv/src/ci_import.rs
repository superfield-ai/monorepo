// ci_import.rs — the GitHub Actions IMPORTER/ADAPTER decoupling seam.
//
// Canonical docs:
//   - docs/adr-ci-execution-manifest.md  ("GHA YAML is a downstream emitter" —
//     a generated adapter at the GitHub boundary, an OUTPUT not the source of
//     truth; importing existing workflows is how a project adopts the manifest)
//   - docs/testing-invariants.md
//
// REAL IMPLEMENTATION (issue #823 — GHA backward-compat)
// =====================================================================
// This module round-trips between `.github/workflows/*.yml` and
// `crate::manifest::CiManifest`:
//
//   - `import`: parse a GitHub Actions workflow YAML into a substrate-agnostic
//     `CiManifest`. Substrate-only concepts the schema deliberately has no home
//     for (`on`, `runs-on`, `container`, `concurrency`, `permissions`) are
//     dropped — they don't change WHAT runs. Every construct that DOES carry
//     "what-runs"/expansion semantics (marketplace `uses:`, `strategy.matrix`,
//     reusable-workflow `uses:`, `if:`, `with:`, `services:`, `${{ }}` contexts,
//     scripted multi-command `run:`, and the execution-affecting keys
//     `working-directory`/`shell`/`continue-on-error` plus
//     `defaults.run.{shell,working-directory}`) FAILS LOUDLY naming the
//     construct — never silently dropped (testing-invariant 1).
//   - `emit`: generate a GHA workflow YAML FROM a `CiManifest`, re-attaching a
//     concrete substrate (a fixed `runs-on` and `on: [push, pull_request]`), so
//     a project that keeps pushing to GitHub stays backward-compatible. Emit is
//     a downstream adapter: an OUTPUT, never the source of truth.
//
// The legacy `UnimplementedGithubActionsAdapter` is retained UNCHANGED below so
// `manifest.rs::tests::seams_are_wired_and_compile_safe` keeps compiling; the
// real adapter is `DefaultGithubActionsAdapter`.
//
// SUPPORTED SUBSET -> CiManifest mapping
//   workflow `name`        -> CiManifest.name   (manifest_version synthesized V1)
//   jobs.<id>              -> Job { id=<key>, needs, commands }
//   step `run:`            -> Command { program, args } via a CONSERVATIVE
//                             shell-word splitter that fails loud on any shell
//                             metacharacter (a scripted `run:` is not argv).
//   env (workflow+job+step)-> Command.env (BTreeMap; deterministic; precedence
//                             step > job > workflow). A `${{ }}` value -> error.
//   test_contract          -> a fixed conservative default (GHA carries none).
//                             Importing CANNOT infer the contract; authoring it
//                             is downstream (issue #824). gate -> None.
//
// DISJOINT SURFACE: issue #823 owns THIS FILE. #822 owns ci_executor.rs and
// #824 owns ci_gate.rs; the three do not overlap, so they land in parallel.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::manifest::{
    CiManifest, Command, Job, MissingResourcePolicy, SchemaVersion, TestContract,
};

/// The fixed `runs-on` label re-attached on `emit`. Substrate detail: import
/// drops it, so it does not affect round-trip equality.
const DEFAULT_RUNS_ON: &str = "ubuntu-latest";

/// Round-trips between GitHub Actions workflow YAML and a `CiManifest`.
///
/// The round-trip is lossy by design in one direction — substrate concepts
/// (`runs-on`, `on`, `permissions:`, …) are discarded on `import` and
/// re-synthesised on `emit`. `import(emit(m)) == m` holds precisely for
/// manifests that already use the synthesised substrate: the conservative
/// default `TestContract`, no `gate`, no `description`, jobs sorted by `id`,
/// and commands whose args contain no whitespace/metacharacters.
pub trait GithubActionsAdapter {
    /// Import a GitHub Actions workflow YAML into a substrate-agnostic manifest.
    fn import(&self, workflow_yaml: &str) -> Result<CiManifest>;

    /// Emit a GitHub Actions workflow YAML from a manifest.
    fn emit(&self, manifest: &CiManifest) -> Result<String>;
}

/// The real GHA <-> manifest adapter (issue #823).
#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultGithubActionsAdapter;

// ---------------------------------------------------------------------------
// Import-side serde shapes. No `deny_unknown_fields`: substrate-only keys we
// deliberately drop (`on`, `runs-on`, `container`, `concurrency`,
// `permissions`, step `id`/`name`/…) are silently ignored — they carry no
// "what runs" semantics. Constructs that DO carry semantics — including the
// execution-affecting `working-directory`/`shell`/`continue-on-error` keys and
// `defaults.run.{shell,working-directory}` — are captured into explicit fields
// below so `import` can reject them loudly.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GhaWorkflowIn {
    name: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, serde_yaml::Value>,
    #[serde(default)]
    jobs: BTreeMap<String, GhaJobIn>,
}

#[derive(Debug, Deserialize)]
struct GhaJobIn {
    #[serde(default)]
    needs: Option<StringOrVec>,
    #[serde(default)]
    env: BTreeMap<String, serde_yaml::Value>,
    #[serde(default)]
    steps: Vec<GhaStepIn>,
    // Loud-fail captures (carry what-runs / expansion semantics):
    uses: Option<serde_yaml::Value>,
    strategy: Option<serde_yaml::Value>,
    #[serde(rename = "if")]
    r#if: Option<serde_yaml::Value>,
    services: Option<serde_yaml::Value>,
    with: Option<serde_yaml::Value>,
    // Execution-affecting captures the manifest cannot represent. `defaults`
    // is substrate-only EXCEPT `defaults.run.{shell,working-directory}`, which
    // change the interpreter / cwd of every step — see `defaults_alters_run`.
    #[serde(rename = "continue-on-error")]
    continue_on_error: Option<serde_yaml::Value>,
    defaults: Option<serde_yaml::Value>,
}

#[derive(Debug, Deserialize)]
struct GhaStepIn {
    name: Option<String>,
    run: Option<String>,
    uses: Option<String>,
    #[serde(rename = "if")]
    r#if: Option<serde_yaml::Value>,
    with: Option<serde_yaml::Value>,
    #[serde(default)]
    env: BTreeMap<String, serde_yaml::Value>,
    // Execution-affecting captures the manifest cannot represent: `working-directory`
    // changes WHERE the command runs, `shell` changes the interpreter, and
    // `continue-on-error` changes pass/fail semantics. All fail loud (never dropped).
    #[serde(rename = "working-directory")]
    working_directory: Option<serde_yaml::Value>,
    shell: Option<serde_yaml::Value>,
    #[serde(rename = "continue-on-error")]
    continue_on_error: Option<serde_yaml::Value>,
}

/// GHA `needs:` is either a single id or a sequence of ids.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StringOrVec {
    One(String),
    Many(Vec<String>),
}

impl StringOrVec {
    fn into_vec(self) -> Vec<String> {
        match self {
            StringOrVec::One(s) => vec![s],
            StringOrVec::Many(v) => v,
        }
    }
}

// ---------------------------------------------------------------------------
// Emit-side serde shapes. Field declaration order == serialized order, so the
// emitted YAML is byte-stable (the golden fixture guards regressions).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct GhaWorkflowOut {
    name: String,
    #[serde(rename = "on")]
    on: Vec<String>,
    jobs: BTreeMap<String, GhaJobOut>,
}

#[derive(Debug, Serialize)]
struct GhaJobOut {
    #[serde(rename = "runs-on")]
    runs_on: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    needs: Vec<String>,
    steps: Vec<GhaStepOut>,
}

#[derive(Debug, Serialize)]
struct GhaStepOut {
    run: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
}

/// The conservative `TestContract` synthesised on import. GHA workflows carry
/// no typed coverage contract, so import cannot infer one — it stamps a
/// minimal, non-asserting default. Authoring the real contract is downstream
/// (the validation/gate seam, issue #824).
fn synthesized_test_contract() -> TestContract {
    TestContract {
        min_executed_tests: 0,
        zero_tests_is_failure: false,
        on_missing_resource: MissingResourcePolicy::FailLoud,
        required_resources: vec![],
        asserts_runtime_behavior: false,
        languages: vec![],
    }
}

/// Convert a YAML scalar env value to a string, failing loud on `${{ }}`
/// expression contexts (not modelled) and on non-scalar values.
fn env_value_to_string(key: &str, value: &serde_yaml::Value, location: &str) -> Result<String> {
    let s = match value {
        serde_yaml::Value::String(s) => s.clone(),
        serde_yaml::Value::Bool(b) => b.to_string(),
        serde_yaml::Value::Number(n) => n.to_string(),
        other => bail!(
            "unsupported GHA construct: env value for '{key}' in {location} is not a scalar \
             ({other:?}); the manifest only models string env values"
        ),
    };
    if s.contains("${{") {
        bail!(
            "unsupported GHA construct: `${{{{ }}}}` expression context in env value '{key}' \
             ({location}); GitHub contexts are not modelled by the manifest"
        );
    }
    Ok(s)
}

/// Whether a job-level `defaults:` block alters execution. `defaults.run.shell`
/// changes the interpreter and `defaults.run.working-directory` changes the cwd
/// of every step — both are "what-runs" semantics the manifest cannot represent,
/// so they must fail loud. Any other `defaults` content is substrate-only.
fn defaults_alters_run(defaults: &serde_yaml::Value) -> bool {
    defaults
        .get("run")
        .map(|run| run.get("shell").is_some() || run.get("working-directory").is_some())
        .unwrap_or(false)
}

/// Conservative shell-word splitter. A `run:` line is mapped to argv only when
/// it is a single simple command. ANY shell metacharacter (pipelines, logical
/// operators, redirection, command/var substitution, quoting, globbing,
/// comments, or a newline → a scripted multi-command block) fails loud: such a
/// `run:` cannot be faithfully represented as program+args, and silently
/// flattening it would be a false green.
fn split_run_to_argv(run: &str, location: &str) -> Result<(String, Vec<String>)> {
    const META: &[char] = &[
        '&', '|', ';', '<', '>', '$', '`', '"', '\'', '\\', '\n', '\r', '(', ')', '*', '?', '#',
        '!', '{', '}', '~', '[', ']',
    ];
    if let Some(c) = run.chars().find(|c| META.contains(c)) {
        let named = if c == '\n' || c == '\r' {
            "a scripted multi-command `run:` (contains a newline)".to_string()
        } else {
            format!("a shell metacharacter '{c}' in `run:`")
        };
        bail!(
            "unsupported GHA construct: {named} ({location}); a `run:` mapped to the manifest \
             must be a single simple command expressible as program + args"
        );
    }
    let mut words = run.split_whitespace();
    let program = words
        .next()
        .with_context(|| format!("empty `run:` ({location}); nothing to execute"))?
        .to_string();
    let args = words.map(str::to_string).collect();
    Ok((program, args))
}

impl GithubActionsAdapter for DefaultGithubActionsAdapter {
    fn import(&self, workflow_yaml: &str) -> Result<CiManifest> {
        let wf: GhaWorkflowIn =
            serde_yaml::from_str(workflow_yaml).context("parse GitHub Actions workflow YAML")?;

        let name = wf
            .name
            .context("workflow has no `name:`; the manifest requires a name")?;

        // Workflow-level env, converted once and reused as the base layer.
        let mut workflow_env: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in &wf.env {
            workflow_env.insert(k.clone(), env_value_to_string(k, v, "workflow env")?);
        }

        let mut jobs = Vec::with_capacity(wf.jobs.len());
        // BTreeMap iteration is sorted by job id → deterministic Job order.
        for (job_id, job) in wf.jobs {
            let loc = format!("job '{job_id}'");

            if job.uses.is_some() {
                bail!(
                    "unsupported GHA construct: job-level `uses:` (reusable workflow) in {loc}; \
                     reusable workflows expand to jobs the manifest cannot represent"
                );
            }
            if job.strategy.is_some() {
                bail!(
                    "unsupported GHA construct: `strategy`/`strategy.matrix` in {loc}; \
                     matrix expansion multiplies jobs the manifest does not model"
                );
            }
            if job.r#if.is_some() {
                bail!("unsupported GHA construct: job-level `if:` conditional in {loc}");
            }
            if job.services.is_some() {
                bail!("unsupported GHA construct: `services:` in {loc}");
            }
            if job.with.is_some() {
                bail!("unsupported GHA construct: `with:` inputs in {loc}");
            }
            if job.continue_on_error.is_some() {
                bail!(
                    "unsupported GHA construct: job-level `continue-on-error:` in {loc}; \
                     it changes pass/fail semantics the manifest cannot represent"
                );
            }
            if let Some(defaults) = &job.defaults {
                if defaults_alters_run(defaults) {
                    bail!(
                        "unsupported GHA construct: `defaults.run.{{shell,working-directory}}` in \
                         {loc}; they change the interpreter / working directory of every step, \
                         which the manifest cannot represent"
                    );
                }
            }

            let mut job_env = workflow_env.clone();
            for (k, v) in &job.env {
                job_env.insert(k.clone(), env_value_to_string(k, v, &format!("{loc} env"))?);
            }

            let mut commands = Vec::with_capacity(job.steps.len());
            for (idx, step) in job.steps.into_iter().enumerate() {
                let sloc = match &step.name {
                    Some(n) => format!("{loc}, step '{n}'"),
                    None => format!("{loc}, step #{idx}"),
                };

                if let Some(uses) = &step.uses {
                    bail!(
                        "unsupported GHA construct: step `uses: {uses}` ({sloc}); marketplace \
                         actions carry semantics the manifest does not model — author the \
                         equivalent `run:` command(s) instead"
                    );
                }
                if step.r#if.is_some() {
                    bail!("unsupported GHA construct: step-level `if:` conditional ({sloc})");
                }
                if step.with.is_some() {
                    bail!("unsupported GHA construct: step-level `with:` inputs ({sloc})");
                }
                if step.working_directory.is_some() {
                    bail!(
                        "unsupported GHA construct: step-level `working-directory:` ({sloc}); \
                         it changes WHERE the command runs, which the manifest cannot represent"
                    );
                }
                if step.shell.is_some() {
                    bail!(
                        "unsupported GHA construct: step-level `shell:` ({sloc}); it changes the \
                         command interpreter, which the manifest cannot represent"
                    );
                }
                if step.continue_on_error.is_some() {
                    bail!(
                        "unsupported GHA construct: step-level `continue-on-error:` ({sloc}); \
                         it changes pass/fail semantics the manifest cannot represent"
                    );
                }

                let run = step.run.with_context(|| {
                    format!(
                        "unsupported GHA construct: step has neither `run:` nor `uses:` ({sloc})"
                    )
                })?;

                let mut step_env = job_env.clone();
                for (k, v) in &step.env {
                    step_env.insert(
                        k.clone(),
                        env_value_to_string(k, v, &format!("{sloc} env"))?,
                    );
                }

                let (program, args) = split_run_to_argv(&run, &sloc)?;
                commands.push(Command {
                    program,
                    args,
                    env: step_env,
                });
            }

            let needs = job.needs.map(StringOrVec::into_vec).unwrap_or_default();

            jobs.push(Job {
                id: job_id,
                description: None,
                needs,
                commands,
                test_contract: synthesized_test_contract(),
                gate: None,
            });
        }

        Ok(CiManifest {
            manifest_version: SchemaVersion::V1,
            name,
            jobs,
        })
    }

    fn emit(&self, manifest: &CiManifest) -> Result<String> {
        let mut jobs = BTreeMap::new();
        for job in &manifest.jobs {
            let steps = job
                .commands
                .iter()
                .map(|cmd| GhaStepOut {
                    run: std::iter::once(cmd.program.clone())
                        .chain(cmd.args.iter().cloned())
                        .collect::<Vec<_>>()
                        .join(" "),
                    env: cmd.env.clone(),
                })
                .collect();
            jobs.insert(
                job.id.clone(),
                GhaJobOut {
                    runs_on: DEFAULT_RUNS_ON.to_string(),
                    needs: job.needs.clone(),
                    steps,
                },
            );
        }

        let out = GhaWorkflowOut {
            name: manifest.name.clone(),
            on: vec!["push".to_string(), "pull_request".to_string()],
            jobs,
        };
        serde_yaml::to_string(&out).context("serialize manifest to GitHub Actions YAML")
    }
}

/// CLI wrapper: import a workflow file into a manifest, writing pretty JSON to
/// `output` (or stdout). Logic lives here so the shared `main.rs` diff is one
/// thin delegating match arm.
pub fn run_import_workflow(workflow: &Path, output: Option<&Path>) -> Result<()> {
    let yaml = std::fs::read_to_string(workflow)
        .with_context(|| format!("read workflow: {}", workflow.display()))?;
    let manifest = DefaultGithubActionsAdapter.import(&yaml)?;
    let json = serde_json::to_string_pretty(&manifest).context("serialize manifest to JSON")?;
    match output {
        Some(path) => std::fs::write(path, format!("{json}\n"))
            .with_context(|| format!("write manifest: {}", path.display()))?,
        None => println!("{json}"),
    }
    Ok(())
}

/// CLI wrapper: emit a GHA workflow YAML from a manifest file, writing to
/// `output` (or stdout).
pub fn run_emit_gha(manifest_path: &Path, output: Option<&Path>) -> Result<()> {
    let raw = std::fs::read_to_string(manifest_path)
        .with_context(|| format!("read manifest: {}", manifest_path.display()))?;
    let manifest: CiManifest = serde_json::from_str(&raw).context("parse CiManifest from JSON")?;
    let yaml = DefaultGithubActionsAdapter.emit(&manifest)?;
    match output {
        Some(path) => std::fs::write(path, &yaml)
            .with_context(|| format!("write workflow: {}", path.display()))?,
        None => print!("{yaml}"),
    }
    Ok(())
}

/// Compile-safe no-op adapter. Retained UNCHANGED from the #821 scout seam so
/// `manifest.rs::tests::seams_are_wired_and_compile_safe` keeps compiling; the
/// real implementation is `DefaultGithubActionsAdapter`.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnimplementedGithubActionsAdapter;

impl GithubActionsAdapter for UnimplementedGithubActionsAdapter {
    fn import(&self, _workflow_yaml: &str) -> Result<CiManifest> {
        // real impl: DefaultGithubActionsAdapter (issue #823).
        unimplemented!("use DefaultGithubActionsAdapter (issue #823, crate::ci_import)")
    }

    fn emit(&self, _manifest: &CiManifest) -> Result<String> {
        // real impl: DefaultGithubActionsAdapter (issue #823).
        unimplemented!("use DefaultGithubActionsAdapter (issue #823, crate::ci_import)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_run_rejects_metacharacters() {
        for bad in [
            "cargo build && cargo test",
            "echo hi | grep h",
            "ls; pwd",
            "cat < in",
            "echo $HOME",
            "echo \"quoted\"",
            "make all\nmake test",
        ] {
            assert!(
                split_run_to_argv(bad, "t").is_err(),
                "expected loud failure for scripted run: {bad:?}"
            );
        }
    }

    #[test]
    fn split_run_accepts_simple_command() {
        let (program, args) = split_run_to_argv("cargo nextest run --workspace", "t").unwrap();
        assert_eq!(program, "cargo");
        assert_eq!(args, vec!["nextest", "run", "--workspace"]);
    }

    #[test]
    fn env_value_rejects_expression_context() {
        let v = serde_yaml::Value::String("${{ secrets.TOKEN }}".to_string());
        assert!(env_value_to_string("TOKEN", &v, "t").is_err());
    }

    /// Build a one-job, one-step workflow injecting `step_extra` into the step
    /// mapping (e.g. `"working-directory: subdir"`).
    fn workflow_with_step_extra(step_extra: &str) -> String {
        format!(
            "name: wf\njobs:\n  build:\n    steps:\n      - run: cargo build\n        {step_extra}\n"
        )
    }

    fn assert_unsupported(err: anyhow::Error) {
        let msg = err.to_string();
        assert!(
            msg.contains("unsupported GHA construct"),
            "expected a loud 'unsupported GHA construct' error, got: {msg}"
        );
    }

    #[test]
    fn import_rejects_step_working_directory() {
        let yaml = workflow_with_step_extra("working-directory: subdir");
        let err = DefaultGithubActionsAdapter.import(&yaml).unwrap_err();
        assert_unsupported(err);
    }

    #[test]
    fn import_rejects_step_shell() {
        let yaml = workflow_with_step_extra("shell: bash");
        let err = DefaultGithubActionsAdapter.import(&yaml).unwrap_err();
        assert_unsupported(err);
    }

    #[test]
    fn import_rejects_step_continue_on_error() {
        let yaml = workflow_with_step_extra("continue-on-error: true");
        let err = DefaultGithubActionsAdapter.import(&yaml).unwrap_err();
        assert_unsupported(err);
    }

    #[test]
    fn import_rejects_job_continue_on_error() {
        let yaml = "name: wf\njobs:\n  build:\n    continue-on-error: true\n    steps:\n      - run: cargo build\n";
        let err = DefaultGithubActionsAdapter.import(yaml).unwrap_err();
        assert_unsupported(err);
    }

    #[test]
    fn import_rejects_job_defaults_run_shell() {
        let yaml = "name: wf\njobs:\n  build:\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - run: cargo build\n";
        let err = DefaultGithubActionsAdapter.import(yaml).unwrap_err();
        assert_unsupported(err);
    }

    #[test]
    fn import_rejects_job_defaults_run_working_directory() {
        let yaml = "name: wf\njobs:\n  build:\n    defaults:\n      run:\n        working-directory: subdir\n    steps:\n      - run: cargo build\n";
        let err = DefaultGithubActionsAdapter.import(yaml).unwrap_err();
        assert_unsupported(err);
    }

    #[test]
    fn import_accepts_simple_workflow_without_execution_keys() {
        let yaml = "name: wf\njobs:\n  build:\n    steps:\n      - run: cargo build\n";
        let manifest = DefaultGithubActionsAdapter.import(yaml).unwrap();
        assert_eq!(manifest.jobs.len(), 1);
        assert_eq!(manifest.jobs[0].commands.len(), 1);
    }
}
