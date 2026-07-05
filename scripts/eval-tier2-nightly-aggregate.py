#!/usr/bin/env python3
"""eval-tier2-nightly-aggregate.py — corpus-envelope glue for issue #864.

Wraps ONE scenario's existing per-scenario `result.json` (the #780
`RunResult` shape `crates/sf-eval` already emits under
`evals/results/<scenario>/<workspace-id>/result.json`) into the corpus-level
`CorpusResult` aggregate envelope pinned by the dev-scout (issue #870,
`crates/sf-eval/src/corpus.rs`):

    {"scenarios": [{"scenario": "<name>", "green": <bool>,
                    "failing_stage": "<string-or-null>"}]}

— the shape `scripts/eval-tier2-nightly-gate.sh` consumes.

This is deliberately NOT the Tier-2 corpus driver (issue #863, out of scope
for #864): it does not enumerate scenarios, run them, or grade rungs — it only
re-shapes one already-produced `RunResult` into the aggregate envelope, adding
one classification `CorpusResult` does not model on its own: a scenario that
did not accept because it hit its turn or wall-clock budget is stamped
`failing_stage: "budget_exhausted"` (issue #864's budget-breach condition)
rather than the generic `"rungs"` miss, so the nightly gate can tell a budget
cap breach apart from an ordinary rung failure using only the envelope.

A missing/unreadable `RunResult` (e.g. the harness crashed before its first
flush) is not an error here — it maps to the empty-`scenarios` envelope, which
the gate script's "zero scenarios executed" condition catches loudly.

USAGE
    eval-tier2-nightly-aggregate.py <run-result.json> <turn_budget> \\
        <deadline_secs> <out.json>
"""

import json
import sys


def main() -> None:
    if len(sys.argv) != 5:
        print(
            "usage: eval-tier2-nightly-aggregate.py <run-result.json> "
            "<turn_budget> <deadline_secs> <out.json>",
            file=sys.stderr,
        )
        sys.exit(2)

    run_path, turn_budget_s, deadline_s, out_path = sys.argv[1:5]
    turn_budget = int(turn_budget_s)
    deadline_secs = int(deadline_s)

    try:
        with open(run_path) as f:
            run = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(
            f"aggregate: no readable per-scenario result at {run_path} ({e}); "
            "zero scenarios",
            file=sys.stderr,
        )
        with open(out_path, "w") as f:
            json.dump({"scenarios": []}, f, indent=2)
        return

    scenario = run.get("scenario", "todo-app")
    deterministic = run.get("deterministic") or {}
    floor_ok = (
        bool(deterministic.get("seed"))
        and bool(deterministic.get("ingest"))
        and bool(deterministic.get("semantic_search"))
    )
    accepted = bool(run.get("accepted"))
    turns_used = int(run.get("turns_used", 0))
    elapsed_seconds = int(run.get("elapsed_seconds", 0))

    if not floor_ok:
        failing_stage = "deterministic_floor"
    elif accepted:
        failing_stage = None
    elif turns_used >= turn_budget or elapsed_seconds >= deadline_secs:
        failing_stage = "budget_exhausted"
    else:
        failing_stage = "rungs"

    verdict = {
        "scenario": scenario,
        "green": failing_stage is None,
        "failing_stage": failing_stage,
    }
    with open(out_path, "w") as f:
        json.dump({"scenarios": [verdict]}, f, indent=2)
    print(f"aggregate: wrote {out_path}: {verdict}")


if __name__ == "__main__":
    main()
