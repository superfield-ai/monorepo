# Grader: compiling-candidate

> Reusable check. Asks: **did the loop produce a code change that compiles?**
> Used by `todo-app` as rung 2.

## Background

The `CodeChangeProposal` gardening step asks the agent for a source diff scoped
to an open Issue/Feature, opens a Sharp episode, and runs semantic merge +
`cargo check` as the gate. A candidate is **stored only if it compiles** — a
`merge_result` event is appended *after* the gate passes; a failed proposal is
refused and never stored.

## Verdict

PASS when at least one `merge_result` exists in the Sharp episode store. Probe
both episode models, since the step may use either:

- generic model — a `merge_result` row in `sharp.episode_events` (`type`), or
- typed-artifact model — a `merge_result` row in `sharp.episode_typed_artifacts`
  (`kind`).

## Notes / rough edges

- **Scope.** Sharp episodes are keyed by **repo**, not workspace. On a shared DB
  this grader can see candidates from other runs — reset episodes or use a clean
  DB per run. Making it workspace-scoped is an open design item.
- This proves *compiles*, not *correct* — it does not assert the candidate
  actually implements the feature. That stronger check arrives with the deploy /
  behavioral rung.
