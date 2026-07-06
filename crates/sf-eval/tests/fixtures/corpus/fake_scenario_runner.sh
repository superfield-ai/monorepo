#!/usr/bin/env bash
# Fixture scenario-runner for the Tier-2 corpus harness's hermetic subprocess
# tests (issue #863, `crates/sf-eval/tests/corpus_harness.rs`).
#
# Stands in for the production seed+run pipeline
# (`corpus_runner::default_seed_and_run`) so the aggregation / exit-code /
# failing-stage-naming behaviour is exercised without a live model or
# database: invoked as `<this> <scenario-dir> <workspace-id> <results-root>`,
# it prints a result.json-shaped payload to stdout and exits 0 (accepted) or
# non-zero (rungs failed), matching the `sf_eval::RunResult` shape the real
# `sf-eval run` subcommand emits. The verdict is keyed off the scenario
# directory's basename, matching the `green-scenario` / `red-scenario`
# fixtures committed by the dev-scout (issue #870) at
# `crates/sf-eval/tests/fixtures/corpus/`.
set -euo pipefail

scenario_dir="$1"
workspace_id="$2"
name="$(basename "$scenario_dir")"

case "$name" in
  green-scenario)
    cat <<JSON
{
  "scenario": "${name}",
  "workspace_id": "${workspace_id}",
  "accepted": true,
  "turns_to_acceptable": 3,
  "turns_used": 3,
  "turn_budget": 10,
  "page_revisions": 2,
  "rungs": { "project_graph": true, "compiling_candidate": true },
  "deterministic": { "seed": true, "ingest": true, "semantic_search": true },
  "elapsed_seconds": 1,
  "browser_smoke": "skipped"
}
JSON
    exit 0
    ;;
  red-scenario)
    cat <<JSON
{
  "scenario": "${name}",
  "workspace_id": "${workspace_id}",
  "accepted": false,
  "turns_to_acceptable": null,
  "turns_used": 10,
  "turn_budget": 10,
  "page_revisions": 1,
  "rungs": { "project_graph": false, "compiling_candidate": false },
  "deterministic": { "seed": true, "ingest": true, "semantic_search": true },
  "elapsed_seconds": 5,
  "browser_smoke": "skipped"
}
JSON
    exit 1
    ;;
  *)
    echo "fake_scenario_runner.sh: no fixture verdict for scenario '${name}'" >&2
    exit 2
    ;;
esac
