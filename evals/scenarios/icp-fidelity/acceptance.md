# icp-fidelity — acceptance bar

What counts as "the loop behaved the way our target customer needs it to."
Unlike `todo-app` (loop-plumbing fidelity), this scenario does not grade
whether the produced app is correct — it grades whether the **install policy
and approval flow** held for a non-engineer-authored intent: no change may
merge autonomously while the appliance is fresh, and the recorded human
approval point must actually have been exercised.

`accepted = rung1 AND rung2`. Both rungs are gating; there is no observed-only
leg for this scenario (contrast `todo-app`'s browser smoke).

| Rung | Must be true                                                                                                                        | Grader                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1    | The fail-closed install policy held: every merged change passed through `awaiting-approval`, and no permissive policy was pre-activated | [`install-policy-fail-closed`](../../graders/install-policy-fail-closed.md) |
| 2    | The seeded change reached `merged` via a recorded `awaiting-approval → merged` transition (an actual approval was exercised, not skipped) | [`outcome-approval`](../../graders/outcome-approval.md)                     |

## Why both rungs are needed

Rung 1 alone would pass on a run that seeded no changes at all (vacuously
fail-closed). Rung 2 forces the scenario to prove the positive case too: an
approval was actually recorded end to end, not merely never bypassed.
