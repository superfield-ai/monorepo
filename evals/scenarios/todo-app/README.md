# Scenario: todo-app

> **Documentation only.** This is the spec for the first scenario; no runner code
> exists yet. It is the concrete instance of the Tier-2 scenario eval in
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
browser smoke that confirms Studio renders the output.

## How it runs

This scenario is executed by the [`live` runner](../../runners/live.md), which
owns the seed → serve → poll-turns → grade loop and reports the headline **turns
to acceptable** metric. The scenario itself contains no execution logic — only
the intent and the acceptance bar.

## Output

The runner writes `evals/results/todo-app/<workspace-id>/` containing
`result.json` (turns, per-rung pass/fail, elapsed), the derived
`project-graph.md`, and a Studio screenshot. See the
[`live` runner](../../runners/live.md) for the result shape.
