//! Enforce the `eval-todo-app.yml` browser-smoke step ordering invariant
//! (issue #907).
//!
//! Canonical policy: `docs/testing-invariants.md` invariant 1 — loud-skip, never
//! silent-skip. The browser-smoke verdict reaches `sf-eval` through a
//! `$GITHUB_ENV` write from the workflow's chromium capture step, and
//! `$GITHUB_ENV` is only visible to *subsequent* steps within the *same* job.
//! Reordering, deleting, or splitting those steps across jobs would make
//! `sf-eval` observe the default `"skipped"` value and `result.json` would
//! silently record a skip. This test parses the real workflow and committed
//! negative fixtures to make that regression fail loudly in the required Rust
//! test context.

use std::path::PathBuf;

/// Path to the real workflow under test.
const WORKFLOW_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../.github/workflows/eval-todo-app.yml"
);

/// Directory holding deliberately-invalid workflow fixtures.
const FIXTURES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/browser_smoke");

/// Location of a step inside a job.
#[derive(Debug)]
struct StepLocation {
    job: String,
    index: usize,
}

/// Load a workflow YAML from disk.
fn load_yaml(path: &PathBuf) -> serde_yaml::Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_yaml::from_str(&text)
        .unwrap_or_else(|e| panic!("{} is not valid YAML: {e}", path.display()))
}

/// The shell script body of a step, if it has one.
fn step_run(step: &serde_yaml::Value) -> Option<&str> {
    step.get("run").and_then(|v| v.as_str())
}

/// True when a step writes the `SF_EVAL_BROWSER_SMOKE` verdict to `$GITHUB_ENV`.
fn is_producer(step: &serde_yaml::Value) -> bool {
    step_run(step)
        .is_some_and(|run| run.contains("SF_EVAL_BROWSER_SMOKE") && run.contains("GITHUB_ENV"))
}

/// True when a step invokes `cargo run -p sf-eval --bin sf-eval -- run` (the
/// consumer that reads the verdict from the environment at observer start).
fn is_consumer(step: &serde_yaml::Value) -> bool {
    step_run(step).is_some_and(|run| run.contains("cargo run -p sf-eval --bin sf-eval --"))
}

/// Verify that the producer step strictly precedes the consumer step in the
/// same job. Returns distinct error messages for each failure mode so the
/// negative fixtures cannot be accepted by a checker that always returns Ok.
fn check_browser_smoke_step_order(path: &PathBuf) -> Result<(), String> {
    let yaml = load_yaml(path);
    let jobs = yaml
        .get("jobs")
        .and_then(|v| v.as_mapping())
        .ok_or("workflow has no jobs mapping")?;

    let mut producer: Option<StepLocation> = None;
    let mut consumer: Option<StepLocation> = None;

    for (job_key, job_value) in jobs {
        let job = job_key
            .as_str()
            .ok_or("job key is not a string")?
            .to_string();
        let steps = job_value
            .get("steps")
            .and_then(|v| v.as_sequence())
            .ok_or_else(|| format!("job '{job}' has no steps sequence"))?;

        for (index, step) in steps.iter().enumerate() {
            if is_producer(step) && producer.is_none() {
                producer = Some(StepLocation {
                    job: job.clone(),
                    index,
                });
            }
            if is_consumer(step) && consumer.is_none() {
                consumer = Some(StepLocation {
                    job: job.clone(),
                    index,
                });
            }
        }
    }

    let producer = producer.ok_or("no step writes SF_EVAL_BROWSER_SMOKE to $GITHUB_ENV")?;
    let consumer = consumer.ok_or("no step invokes sf-eval ... run")?;

    if producer.job != consumer.job {
        return Err(format!(
            "producer step is in job '{}' but consumer step is in job '{}'; \
             $GITHUB_ENV does not cross jobs",
            producer.job, consumer.job
        ));
    }

    if producer.index >= consumer.index {
        return Err(format!(
            "producer step (index {}) must strictly precede consumer step (index {}) \
             in job '{}'",
            producer.index, consumer.index, producer.job
        ));
    }

    Ok(())
}

mod browser_smoke_step_order {
    mod tests {
        use super::super::*;

        #[test]
        fn browser_smoke_step_order_real_workflow_is_valid() {
            let path = PathBuf::from(WORKFLOW_PATH);
            check_browser_smoke_step_order(&path).expect(
                "the real eval-todo-app.yml must satisfy the browser-smoke step ordering contract",
            );
        }

        #[test]
        fn browser_smoke_step_order_swapped_steps_fails() {
            let path = PathBuf::from(FIXTURES_DIR).join("swapped.yml");
            let err = check_browser_smoke_step_order(&path)
                .expect_err("swapped producer/consumer steps must fail");
            assert!(
                err.contains("must strictly precede"),
                "unexpected error for swapped steps: {err}"
            );
        }

        #[test]
        fn browser_smoke_step_order_missing_producer_fails() {
            let path = PathBuf::from(FIXTURES_DIR).join("producer_deleted.yml");
            let err = check_browser_smoke_step_order(&path)
                .expect_err("a missing producer step must fail");
            assert!(
                err.contains("no step writes SF_EVAL_BROWSER_SMOKE"),
                "unexpected error for missing producer: {err}"
            );
        }

        #[test]
        fn browser_smoke_step_order_cross_job_fails() {
            let path = PathBuf::from(FIXTURES_DIR).join("producer_second_job.yml");
            let err = check_browser_smoke_step_order(&path)
                .expect_err("producer and consumer in different jobs must fail");
            assert!(
                err.contains("does not cross jobs"),
                "unexpected error for cross-job fixture: {err}"
            );
        }
    }
}
