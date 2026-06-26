# Runner: live (Tier 2)

> The engine that drives any scenario through the **real** appliance and a real
> model, counting turns. This is the e2e-equivalent runner. Spec only — code
> lands later in `crates/sf-eval`.

## What it does

Scenario-agnostic. Given a scenario dir, it:

1. **Reset** — clear the workspace (`gardening_cursor`, `page_revisions`,
   `project_nodes` for the workspace id).
2. **Seed** — `superfield garden <scenario>/seed/*.md --workspace-id <id>`.
3. **Boot** — `superfield serve` (auto-starts the gardening loop).
4. **Deterministic floor** — before observing any live turn, compute the rungs
   that do not depend on the live-LLM loop converging — `seed` (the seed corpus
   exists), `ingest` (embedded blocks were ingested), and `semantic_search` (the
   governed embedder retrieves a seeded block) — and flush `result.json`. A
   failed floor is a real broken resource: the runner records it and exits
   non-zero (loud), never a fake green.
5. **Poll & count turns** — poll `orchestrator.gardening_cursor`; increment the
   turn count each time the step advances; run the scenario's graders each poll;
   re-flush `result.json` each poll so the latest state is always durable.
6. **Stop** — on acceptance (all gating rungs pass), when `TURN_BUDGET` is
   exhausted, or when the wall-clock deadline (`SF_EVAL_DEADLINE_SECS`) is hit.
7. **Emit** — `result.json` under `results/<scenario>/<workspace-id>/` is written
   incrementally from step 4 on, so the artifact exists (with real, executed rung
   verdicts) even if the live loop never converges within the CI job wall.

## Turn = one completed gardening step

The loop has 9 steps per pass (`StrategyResearch → … → CodeChangeProposal`),
then a 60s sleep. Turns are counted by observing the cursor advance, corroborated
by the `nexum.page_revisions` row count.

## Result shape

```json
{
  "scenario": "todo-app",
  "workspace_id": "…",
  "accepted": true,
  "turns_to_acceptable": 14,
  "turns_used": 14,
  "turn_budget": 60,
  "elapsed_seconds": 920,
  "page_revisions": 6,
  "rungs": { "project_graph": true, "compiling_candidate": true },
  "deterministic": { "seed": true, "ingest": true, "semantic_search": true },
  "browser_smoke": "pass"
}
```

`rungs` are the live (gating) acceptance bar; `deterministic` is the offline
floor (seed/ingest/semantic-search) emitted up front. `accepted` depends only on
`rungs`; a budget- or deadline-stopped run still carries a passing `deterministic`
floor so the artifact stays meaningful (issue #780).

## Knobs

`WORKSPACE_ID`, `TURN_BUDGET`, `POLL_INTERVAL`, `STUDIO_URL`, `BIND`,
`SF_OPENCODE_SERVER`, and any grader-specific env (e.g. `SF_EVAL_JUDGE_CMD`).
Requires a **live** model, not the fixture executor. CI gets one keylessly:
`SF_LLM_PROVIDER=opencode-server` points the loop at a local `opencode serve`
that drives OpenCode's free Big Pickle (GLM-4.6) — a fresh install needs no API
key and no login.

## Rough edges to design around

- **Poll-based turn counting** — a step finishing faster than `POLL_INTERVAL`
  can be missed between polls; treat the count as a near-lower-bound and lean on
  `page_revisions` to corroborate.
- **Non-determinism** — for a real metric, run the scenario _k_ times and report
  the distribution of `turns_to_acceptable`, not a single number (see
  [`docs/eval-design.md`](../../docs/eval-design.md) §Handling non-determinism).
