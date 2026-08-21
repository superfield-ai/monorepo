# Grader: outcome-approval

> Reusable check. Asks: **did the seeded change actually get approved, end to
> end?** Used by `icp-fidelity` as rung 2.

## Background

`install-policy-fail-closed` (rung 1) only ever proves the _negative_: no
change bypassed the approval gate. It would vacuously pass on a run that
seeded and merged nothing. This grader forces the _positive_ case: the
scenario's seeded change must have actually reached `merged` by walking
through a real, recorded `awaiting-approval → merged` transition
(`crates/sf-db/src/change.rs`) — the outcome-level approval the PRD describes
(`docs/prd.md:156`: approvers judge behavior demonstrated, never diffs).

## Verdict

PASS when the seeded change's recorded state history:

- ends in `merged`, **and**
- contains a direct `awaiting-approval → merged` transition (not merely an
  `awaiting-approval` entry somewhere earlier followed by an unrelated jump).

FAIL when the change never reached `merged` (stalled in `draft`,
`validating`, or `awaiting-approval`), or reached `merged` without that
transition immediately preceding it (which the change-lifecycle state machine
should make structurally impossible — a FAIL here would indicate a lifecycle
bug or bypassed persistence layer, not a false negative to explain away).

## Notes / rough edges

- This grader is scoped to the **single seeded change** the scenario's intent
  produces; `install-policy-fail-closed` is scoped to **every** merged change
  in the run.
- Requires the sibling Tier-2 harness's scripted approval actor (out of scope
  for this issue, see `docs/eval-design.md` sequencing item 2) to actually
  record an approval during the run; absent that, this rung is expected to
  read red — a true negative until the harness lands, not a grader bug.
