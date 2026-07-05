//! Validates the committed fixture corpus under `tests/fixtures/corpus/`
//! (issue #870) against the discovery contract and the aggregate-envelope
//! type, so the fixtures #864's nightly-workflow gate-script development
//! relies on are proven to actually match the shapes `sf-eval` implements —
//! not just hand-authored JSON that happens to look right.

use sf_eval::{discover_scenarios, CorpusResult};
use std::path::Path;

fn fixture_corpus_root() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/corpus")
}

#[test]
fn fixture_corpus_scenarios_are_discoverable() {
    let root = fixture_corpus_root();
    let found = discover_scenarios(&root).expect("fixture corpus discovers cleanly");
    let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["green-scenario", "red-scenario"]);
    for scenario in &found {
        assert!(
            !scenario.seed_files.is_empty(),
            "{} must have at least one seed file",
            scenario.name
        );
    }
}

#[test]
fn fixture_all_green_result_parses_and_exits_zero() {
    let raw = std::fs::read_to_string(fixture_corpus_root().join("result.green.json"))
        .expect("read result.green.json");
    let parsed: CorpusResult = serde_json::from_str(&raw).expect("parses as CorpusResult");
    assert!(parsed.all_green());
    assert_eq!(parsed.exit_code(), 0);
    for verdict in &parsed.scenarios {
        assert!(verdict.failing_stage.is_none());
    }
}

#[test]
fn fixture_mixed_result_parses_and_exits_nonzero_naming_failing_stage() {
    let raw = std::fs::read_to_string(fixture_corpus_root().join("result.mixed.json"))
        .expect("read result.mixed.json");
    let parsed: CorpusResult = serde_json::from_str(&raw).expect("parses as CorpusResult");
    assert!(!parsed.all_green());
    assert_eq!(parsed.exit_code(), 1);

    let red = parsed
        .scenarios
        .iter()
        .find(|s| s.scenario == "red-scenario")
        .expect("red-scenario present");
    assert!(!red.green);
    assert_eq!(red.failing_stage.as_deref(), Some("rungs"));

    let green = parsed
        .scenarios
        .iter()
        .find(|s| s.scenario == "green-scenario")
        .expect("green-scenario present");
    assert!(green.green);
    assert!(green.failing_stage.is_none());
}
