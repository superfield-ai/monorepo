# todo-app — acceptance bar

What counts as "the user got what they expected." Scoped to what the loop can
reach **today**: it gardens knowledge, derives a project graph, and proposes
**compile-validated** code candidates — but it does not yet auto-commit, build,
or deploy a runnable app. So acceptance sits at the highest rung the loop
actually reaches.

`accepted = rung1 AND rung2`. The browser smoke is observed but not part of the
accept/fail gate today.

| Rung  | Must be true                                                        | Grader                                                        |
| ----- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1     | The project graph describes **add / list / complete a task**        | [`project-graph`](../../graders/project-graph.md)             |
| 2     | A **compiling** code candidate exists (`CodeChangeProposal` passed) | [`compiling-candidate`](../../graders/compiling-candidate.md) |
| smoke | Studio **renders** the plan + issue rail                            | [`browser-smoke`](../../graders/browser-smoke.md)             |

## When deploy lands

Once the loop can auto-commit → build → deploy a generated app, the browser
smoke is **promoted** from an observed render check to the true acceptance rung:
drive the deployed app — add a task, see it listed, complete it — and only then
is the scenario accepted. At that point this file gains a `rung3` and the
accept rule becomes `rung1 AND rung2 AND rung3`.
