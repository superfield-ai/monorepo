# Fixture scenario: red-scenario

> **Test fixture, not a real scenario.** Committed for #864's nightly-workflow
> gate-script selftests and for exercising the corpus-level discovery contract
> ([`sf_eval::discover_scenarios`]) and aggregate envelope
> ([`sf_eval::CorpusResult`]) pinned by issue #870, mirroring the `todo-app`
> scenario layout (`evals/scenarios/todo-app/`).

This fixture represents a scenario whose run is expected to grade **red** (a
gating rung fails) — the paired counterpart to
[`../green-scenario/`](../green-scenario/). See
[`../result.mixed.json`](../result.mixed.json) for the aggregate
`result.json` envelope where this scenario's verdict is red with a
`failing_stage`.
