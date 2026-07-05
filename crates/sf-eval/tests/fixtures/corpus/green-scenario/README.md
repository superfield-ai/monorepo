# Fixture scenario: green-scenario

> **Test fixture, not a real scenario.** Committed for #864's nightly-workflow
> gate-script selftests and for exercising the corpus-level discovery contract
> ([`sf_eval::discover_scenarios`]) and aggregate envelope
> ([`sf_eval::CorpusResult`]) pinned by issue #870, mirroring the `todo-app`
> scenario layout (`evals/scenarios/todo-app/`).

This fixture represents a scenario whose run is expected to grade **green**
(all gating rungs pass) — the paired counterpart to
[`../red-scenario/`](../red-scenario/), which represents an expected **red**
verdict. Together they let a corpus-level gate script (#864) exercise both the
all-green and mixed-verdict paths without needing a live model.

See [`../result.green.json`](../result.green.json) and
[`../result.mixed.json`](../result.mixed.json) for the aggregate
`result.json` envelopes these two fixtures compose into.
