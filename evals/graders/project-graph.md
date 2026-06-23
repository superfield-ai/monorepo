# Grader: project-graph

> Reusable check. Asks: **does the derived project graph describe the app the
> seed intent asked for?** Used by `todo-app` as rung 1.

## Input

The project graph the loop derived, rendered as markdown via
`superfield page project` (sourced from `nexum.project_nodes`).

## Verdict

Two modes, in priority order:

1. **LLM judge** (preferred) — if `SF_EVAL_JUDGE_CMD` is set, pipe the graph
   markdown to it; it returns `PASS`/`FAIL` to the question _"does this graph
   describe a working <app>?"_. Gives a real semantic judgement.
2. **Structural fallback** — when no judge is configured, a coarse keyword check.
   For `todo-app`: the graph must mention a task/todo **and** all three verbs
   (add, list, complete). Cheap, deterministic, easy to fool — fine for a first
   signal, not a gate.

## Notes / rough edges

- The keyword set is scenario-specific; a generic grader takes the expected
  terms as parameters rather than hardcoding To Do verbs.
- Prefer the judge for anything beyond smoke-level confidence.
