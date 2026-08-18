# Scenario: todo-app

> **Implemented.** The scenario is specified here and executed by the
> [`live` runner](../../runners/live.md) from the [`sf-eval`](../../../crates/sf-eval)
> crate. The CI job in `.github/workflows/eval-todo-app.yml` builds and runs it
> end to end. It is the concrete instance of the Tier-2 scenario eval in
> [`docs/eval-design.md`](../../../docs/eval-design.md).

## Goal

Kickstart a fresh Superfield project from a one-paragraph **To Do** intent, run
the gardening loop, and measure **how many turns** it takes to reach an
_acceptable_ result.

## Inputs

- **Seed intent** — [`seed/todo-seed.md`](./seed/todo-seed.md), gardened in at
  kickstart.
- **Snapshot** _(future)_ — `snapshot/`, a frozen brain state to start from for
  reproducibility. Empty for now; the scenario starts from a clean workspace.

## Acceptance bar

Defined in [`acceptance.md`](./acceptance.md). In short, scoped to what the loop
can reach today: `rung1 (project graph) AND rung2 (compiling candidate)`, with a
browser smoke that confirms the placeholder Studio surface renders.

## How it runs

This scenario is executed by the [`live` runner](../../runners/live.md), which
owns the seed → serve → poll-turns → grade loop and reports the headline **turns
to acceptable** metric. The scenario itself contains no execution logic — only
the intent and the acceptance bar.

## Output

The runner writes `evals/results/todo-app/<workspace-id>/` containing:

- `result.json` — turns, per-rung pass/fail, deterministic floor, elapsed.
- `project-graph.md` — the derived project graph the rung-1 grader reads
  (refreshed every poll; an explicit marker when no graph has been derived yet).
- `candidate-<seq>.json` — the rung-2 `merge_result` evidence (the merge
  summary: repo, merged files, compile gate), one per compiling candidate.
  Legitimately **absent** when the loop produced no compiling candidate.
- `turns.json` — the agent's per-turn `page_revisions` (each gardening step's
  produced content + provenance), so turns are inspectable.

The CI workflow uploads `_logs/` next to these — the captured `appliance.log`
(with `RUST_LOG`-raised gardening-loop + LLM-call traces), `opencode-server.log`,
and `scenario.log` — and retains the whole `evals/results/todo-app/**` tree for
30 days. A Studio screenshot is captured (`studio-smoke.png`). The image is the
unauthenticated `GET /` placeholder surface, not the authenticated Studio UI:
`/studio/*` returns 401 and no `CONTROL_ASSETS_DIR` is set in the eval job, so no
built Studio UI exists to render. An executed `pass`/`fail` verdict is written to
`browser_smoke`; `skipped` means the verdict never reached the observer.
See the [`live` runner](../../runners/live.md) for the result shape.
