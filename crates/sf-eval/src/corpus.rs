//! Tier-2 corpus aggregate envelope + scenario-directory discovery (issue #870).
//!
//! Stub-only integration seams pinned by the dev-scout for the Tier-2 nightly
//! eval harness phase (`docs/eval-design.md` sequencing item 2), so the corpus
//! driver (#863), the nightly workflow (#864), and the ICP-fidelity scenario
//! (#865) build against one place instead of guessing at each other's shapes:
//!
//! - the **corpus aggregate envelope** ([`CorpusResult`]) layered *on top of*
//!   (never replacing) the per-scenario `result.json` convention (issue #780,
//!   [`crate::result::RunResult`]): one [`ScenarioVerdict`] per scenario, a
//!   `failing_stage` named on red, and a pure exit-code derivation (`0` iff
//!   every scenario is green).
//! - the **scenario-directory discovery contract** ([`discover_scenarios`]):
//!   what counts as a scenario under `evals/scenarios/` — a `seed/` intent, an
//!   `acceptance.md` rung table, and a `README.md` — mirroring the `todo-app`
//!   layout, so #863's driver and #865's `icp-fidelity` directory agree on the
//!   same enumeration rule without either owning the other.
//!
//! Real corpus execution against the live model (#863), the nightly workflow
//! (#864), and the ICP-fidelity scenario content (#865) are explicitly out of
//! scope here — this module only pins the shapes those features build
//! against. See the scout issue (#870) for the full scope.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};

/// One scenario's verdict inside a [`CorpusResult`].
///
/// Green scenarios carry no `failing_stage`; red scenarios must name the
/// stage that failed (e.g. `"deterministic_floor"`, `"rungs"`,
/// `"endpoint_unreachable"`) so a red corpus run is diagnosable from
/// `result.json` alone, without re-running it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScenarioVerdict {
    /// Scenario name — matches the per-scenario `result.json`'s `scenario`
    /// field and the discovered directory name under `evals/scenarios/`.
    pub scenario: String,
    /// Whether this scenario's run was accepted.
    pub green: bool,
    /// The stage that failed, present iff `green` is `false`.
    pub failing_stage: Option<String>,
}

impl ScenarioVerdict {
    /// A passing verdict.
    pub fn green(scenario: impl Into<String>) -> Self {
        Self {
            scenario: scenario.into(),
            green: true,
            failing_stage: None,
        }
    }

    /// A failing verdict, naming the stage that failed.
    pub fn red(scenario: impl Into<String>, failing_stage: impl Into<String>) -> Self {
        Self {
            scenario: scenario.into(),
            green: false,
            failing_stage: Some(failing_stage.into()),
        }
    }
}

/// The corpus-level aggregate `result.json` envelope — one [`ScenarioVerdict`]
/// per scenario the corpus run enumerated, layered on top of each scenario's
/// own #780 per-scenario `result.json` (this envelope does not replace those
/// artifacts; the driver writes both).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorpusResult {
    /// One verdict per scenario the corpus run enumerated, in enumeration
    /// order (see [`discover_scenarios`]).
    pub scenarios: Vec<ScenarioVerdict>,
}

impl CorpusResult {
    /// All enumerated scenarios passed.
    ///
    /// Vacuously `true` for an empty corpus — this stub owns only the
    /// verdict-rollup shape, not the "zero scenarios executed must fail"
    /// policy, which is #863's driver-level concern (its
    /// `corpus_enumeration_discovers_committed_scenarios` AC) layered on top
    /// of this envelope.
    pub fn all_green(&self) -> bool {
        self.scenarios.iter().all(|s| s.green)
    }

    /// The exit-code contract for the corpus harness: `0` iff every scenario
    /// is green, `1` otherwise.
    pub fn exit_code(&self) -> i32 {
        if self.all_green() {
            0
        } else {
            1
        }
    }

    /// Serialize to pretty JSON.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("CorpusResult serializes")
    }
}

/// A discovered scenario directory under `evals/scenarios/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScenarioDescriptor {
    /// The scenario's directory name (its `scenario` identifier).
    pub name: String,
    /// The scenario directory's path.
    pub path: PathBuf,
    /// The seed-intent markdown file(s) found under `<scenario>/seed/`.
    pub seed_files: Vec<PathBuf>,
}

/// Why a candidate directory under `evals/scenarios/` did not qualify as a
/// discoverable scenario. Discovery fails loud and names the offending
/// scenario + missing piece rather than silently skipping a malformed
/// directory (test-coverage invariant 1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    /// `<scenario>/README.md` is missing.
    MissingReadme(String),
    /// `<scenario>/acceptance.md` is missing.
    MissingAcceptance(String),
    /// `<scenario>/acceptance.md` exists but has no rung table (no line
    /// starting with `|` mentioning "rung").
    AcceptanceMissingRungTable(String),
    /// `<scenario>/seed/` is missing or contains no `.md` seed-intent file.
    NoSeedIntent(String),
    /// `scenarios_root` itself could not be read.
    RootUnreadable(String),
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DiscoveryError::MissingReadme(name) => {
                write!(f, "scenario {name:?} is missing README.md")
            }
            DiscoveryError::MissingAcceptance(name) => {
                write!(f, "scenario {name:?} is missing acceptance.md")
            }
            DiscoveryError::AcceptanceMissingRungTable(name) => {
                write!(
                    f,
                    "scenario {name:?}'s acceptance.md has no rung table (no '|' row mentioning \"rung\")"
                )
            }
            DiscoveryError::NoSeedIntent(name) => {
                write!(
                    f,
                    "scenario {name:?} has no seed intent (no .md file under seed/)"
                )
            }
            DiscoveryError::RootUnreadable(msg) => {
                write!(f, "cannot read scenarios root: {msg}")
            }
        }
    }
}

impl std::error::Error for DiscoveryError {}

/// A line counts as (part of) a markdown rung table when it is a table row
/// (`starts_with('|')`) mentioning "rung" — the stub-level proxy for "has a
/// rung table" the `todo-app` and `icp-fidelity` `acceptance.md` files share.
fn has_rung_table(content: &str) -> bool {
    content
        .lines()
        .any(|l| l.trim_start().starts_with('|') && l.to_ascii_lowercase().contains("rung"))
}

/// The scenario-directory discovery contract: enumerate every immediate
/// subdirectory of `scenarios_root` and validate it against the layout
/// `todo-app` established (mirrored by #865's `icp-fidelity`):
///
/// - a `README.md` file at the scenario root,
/// - an `acceptance.md` file at the scenario root containing a rung table,
/// - a `seed/` subdirectory containing at least one `.md` file (the seed
///   intent).
///
/// Returns one [`ScenarioDescriptor`] per valid scenario directory, sorted by
/// name for a deterministic corpus enumeration order (the order #863's driver
/// reports scenarios in). The first directory that fails validation returns
/// an `Err` naming the scenario and the missing piece — a malformed directory
/// is never silently skipped.
pub fn discover_scenarios(
    scenarios_root: &Path,
) -> Result<Vec<ScenarioDescriptor>, DiscoveryError> {
    let read_dir = std::fs::read_dir(scenarios_root).map_err(|e| {
        DiscoveryError::RootUnreadable(format!("{}: {e}", scenarios_root.display()))
    })?;

    let mut dirs: Vec<PathBuf> = read_dir
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();

    let mut out = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let name = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();

        if !dir.join("README.md").is_file() {
            return Err(DiscoveryError::MissingReadme(name));
        }

        let acceptance_path = dir.join("acceptance.md");
        let acceptance_content = std::fs::read_to_string(&acceptance_path)
            .map_err(|_| DiscoveryError::MissingAcceptance(name.clone()))?;
        if !has_rung_table(&acceptance_content) {
            return Err(DiscoveryError::AcceptanceMissingRungTable(name));
        }

        let seed_dir = dir.join("seed");
        let mut seed_files: Vec<PathBuf> = std::fs::read_dir(&seed_dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
            .collect();
        seed_files.sort();
        if seed_files.is_empty() {
            return Err(DiscoveryError::NoSeedIntent(name));
        }

        out.push(ScenarioDescriptor {
            name,
            path: dir,
            seed_files,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── CorpusResult envelope ────────────────────────────────────────────────

    #[test]
    fn corpus_envelope_roundtrip() {
        let result = CorpusResult {
            scenarios: vec![
                ScenarioVerdict::green("todo-app"),
                ScenarioVerdict::red("icp-fidelity", "rungs"),
            ],
        };

        let json = result.to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid json");
        assert_eq!(parsed["scenarios"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["scenarios"][0]["scenario"], "todo-app");
        assert_eq!(parsed["scenarios"][0]["green"], true);
        assert!(parsed["scenarios"][0]["failing_stage"].is_null());
        assert_eq!(parsed["scenarios"][1]["scenario"], "icp-fidelity");
        assert_eq!(parsed["scenarios"][1]["green"], false);
        assert_eq!(parsed["scenarios"][1]["failing_stage"], "rungs");

        let typed: CorpusResult = serde_json::from_str(&json).expect("round-trips");
        assert_eq!(typed, result);
        assert!(!typed.all_green());
        assert_eq!(typed.exit_code(), 1);
    }

    #[test]
    fn corpus_envelope_all_green_exits_zero() {
        let result = CorpusResult {
            scenarios: vec![
                ScenarioVerdict::green("todo-app"),
                ScenarioVerdict::green("icp-fidelity"),
            ],
        };
        assert!(result.all_green());
        assert_eq!(result.exit_code(), 0);
        for verdict in &result.scenarios {
            assert!(verdict.failing_stage.is_none());
        }
    }

    #[test]
    fn corpus_envelope_empty_corpus_is_vacuously_green() {
        // This stub owns only the rollup shape; the "zero scenarios must fail"
        // policy is #863's driver-level concern layered on top.
        let result = CorpusResult { scenarios: vec![] };
        assert!(result.all_green());
        assert_eq!(result.exit_code(), 0);
    }

    // ── discover_scenarios ───────────────────────────────────────────────────

    fn write_scenario(root: &Path, name: &str, seed_body: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(dir.join("seed")).unwrap();
        std::fs::write(dir.join("README.md"), format!("# Scenario: {name}\n")).unwrap();
        std::fs::write(
            dir.join("acceptance.md"),
            "| Rung | Must be true | Grader |\n| --- | --- | --- |\n| 1 | thing | grader |\n",
        )
        .unwrap();
        std::fs::write(dir.join("seed").join("seed.md"), seed_body).unwrap();
    }

    #[test]
    fn discover_scenarios_finds_valid_scenario_dirs_sorted_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        write_scenario(tmp.path(), "zeta-scenario", "seed intent z");
        write_scenario(tmp.path(), "alpha-scenario", "seed intent a");

        let found = discover_scenarios(tmp.path()).expect("discovery succeeds");
        let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha-scenario", "zeta-scenario"]);
        assert_eq!(found[0].seed_files.len(), 1);
    }

    #[test]
    fn discover_scenarios_errors_on_missing_readme() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("broken-scenario");
        std::fs::create_dir_all(dir.join("seed")).unwrap();
        std::fs::write(dir.join("acceptance.md"), "| Rung | ok |\n").unwrap();
        std::fs::write(dir.join("seed").join("seed.md"), "intent").unwrap();

        let err = discover_scenarios(tmp.path()).unwrap_err();
        assert_eq!(err, DiscoveryError::MissingReadme("broken-scenario".into()));
    }

    #[test]
    fn discover_scenarios_errors_on_acceptance_without_rung_table() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("broken-scenario");
        std::fs::create_dir_all(dir.join("seed")).unwrap();
        std::fs::write(dir.join("README.md"), "# broken-scenario\n").unwrap();
        std::fs::write(dir.join("acceptance.md"), "no table here, just prose\n").unwrap();
        std::fs::write(dir.join("seed").join("seed.md"), "intent").unwrap();

        let err = discover_scenarios(tmp.path()).unwrap_err();
        assert_eq!(
            err,
            DiscoveryError::AcceptanceMissingRungTable("broken-scenario".into())
        );
    }

    #[test]
    fn discover_scenarios_errors_on_empty_seed_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("broken-scenario");
        std::fs::create_dir_all(dir.join("seed")).unwrap();
        std::fs::write(dir.join("README.md"), "# broken-scenario\n").unwrap();
        std::fs::write(dir.join("acceptance.md"), "| Rung | ok |\n").unwrap();
        // No .md file under seed/.

        let err = discover_scenarios(tmp.path()).unwrap_err();
        assert_eq!(err, DiscoveryError::NoSeedIntent("broken-scenario".into()));
    }

    #[test]
    fn discover_scenarios_validates_the_real_todo_app_layout() {
        // Proves the discovery contract agrees with the committed evals/scenarios/
        // tree (the layout icp-fidelity, #865, must mirror), not just synthetic
        // fixtures.
        let scenarios_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../evals/scenarios");
        let found = discover_scenarios(&scenarios_root).expect("real evals/scenarios/ discovers");
        assert!(
            found.iter().any(|s| s.name == "todo-app"),
            "expected todo-app among discovered scenarios: {found:?}"
        );
    }
}
