# evals/

Evaluations of the Superfield **AI processes** — the autonomous gardening loop
that turns intent into software. This is the home of our equivalent of an
end-to-end test: the artifacts that confirm a user is getting what they expect
from running the appliance.

> **Specs here, code in `crates/sf-eval`.** This tree holds the scenario data
> and the markdown specs for each runner/grader; the Rust grader library + the
> `sf-eval` live-runner binary that execute them live in
> [`crates/sf-eval`](../crates/sf-eval/) (issue #748). Run outputs land in
> `results/` (gitignored). See [`docs/eval-design.md`](../docs/eval-design.md)
> for the full design and the Tier 0–3 pyramid.

## Three concepts (keep them separate)

| Concept      | Answers                                         | Lives in     | Example                                            |
| ------------ | ----------------------------------------------- | ------------ | -------------------------------------------------- |
| **Scenario** | _What are we testing, and what counts as pass?_ | `scenarios/` | `todo-app` — build a To Do app                     |
| **Runner**   | _How do we execute and measure?_                | `runners/`   | `live` — seed → serve → poll turns → grade         |
| **Grader**   | _How do we check one thing?_                    | `graders/`   | `project-graph` — does the graph describe the app? |

A scenario is **data** (inputs + acceptance bar). A runner is the **engine**
that drives any scenario. A grader is a **reusable check** a scenario's
acceptance bar is composed from. Adding a second scenario is then cheap: a new
`scenarios/<name>/` dir reusing the existing runners and graders unchanged.

## Layout

```
evals/
  README.md                   ← you are here
  scenarios/                  ← the fixtures (data only, one dir per case)
    todo-app/
      README.md               ← the scenario spec
      seed/todo-seed.md       ← intent gardened in at kickstart
      acceptance.md           ← the acceptance bar (rungs) for THIS scenario
      snapshot/               ← (future) frozen brain state to start from
  graders/                    ← reusable checks, referenced by scenarios
    project-graph.md
    compiling-candidate.md
    browser-smoke.md
  runners/                    ← the engines (specs now, code later)
    live.md                   ← Tier 2: live run, counts turns
    replay.md                 ← Tier 1: replay an episode trace
  results/                    ← run outputs (gitignored)
```

## Why scenario-first (not `tier1/`, `tier2/`)

Tiers are a property of the _runner_, not the test material, and one scenario is
exercised by multiple tiers (the same scenario's live trace is later replayed by
Tier-1 graders). Keeping the test material in one place per scenario means you
describe the To Do app once, not once per tier.

## Glossary

- **Turn** — one completed gardening step (the loop has 9 per pass). The headline
  cost metric every runner reports; not specific to any one scenario.
- **Acceptance bar** — the set of graders, with thresholds, that must pass for a
  scenario to count as "the user got what they expected."
- **Rung** — one grader in a scenario's acceptance bar.
