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

../.actrc                     ← act runner-label → ci-runner image mappings
../.github/workflows/eval-todo-app.yml  ← the eval workflow (single source of truth)
```

## Running an eval locally

The eval CI workflow has **one source of truth**:
[`.github/workflows/eval-todo-app.yml`](../.github/workflows/eval-todo-app.yml).
We run it locally with [`act`](https://github.com/nektos/act), which executes
that workflow **unmodified, in containers** — so a local run is the same run CI
performs, with no duplicate local script to drift out of sync and no pollution
of your dev environment (toolchain, Postgres, opencode all live in the
container).

Canonical command (run from the repo root):

```
act -W .github/workflows/eval-todo-app.yml workflow_dispatch \
  --input turn_budget=8 \
  --pull=false \
  --artifact-server-path /tmp/act-artifacts
```

The repo-root [`.actrc`](../.actrc) supplies the `-P` runner-label mappings
(`self-hosted`, `Linux`, `X64` → `ghcr.io/superfield-ai/ci-runner:latest`)
automatically, so the self-hosted job schedules against the local CI image.
`--pull=false` reuses that image from your local Docker without ghcr auth, and
`--artifact-server-path` is where `act` writes the uploaded artifact.

Prereqs:

- **Docker** running.
- The `ghcr.io/superfield-ai/ci-runner:latest` image present locally (so
  `--pull=false` works without ghcr authentication).
- `act` on your `PATH`.

Where the result lands: the job bind-mounts the workspace, so
`result.json` appears on the host at
`evals/results/todo-app/<workspace-id>/result.json` (gitignored). The same file
is also collected by the artifact step into your `--artifact-server-path`.

### Limitation: blocked at the first JavaScript action

Today `act` runs this workflow only **up to the first JavaScript action**, not
end to end. The job is pinned to `container: ghcr.io/superfield-ai/ci-runner:latest`,
and that image has no `node`. GitHub Actions injects a node runtime into
container jobs automatically; `act` does **not**
([nektos/act#107](https://github.com/nektos/act/issues/107)). So the workflow's
JS actions (`actions/cache@v4`, `actions/upload-artifact@v4`, `hashFiles`) fail
with `exec: "node": not found` (exit code `127`) at the first cache step
(`Cache Cargo registry + build`). `--container-options`
can't fix it either — its node bind-mount only reaches runner/service
containers, not a job's YAML-pinned `container:`.

What `act` **does** validate locally today, before that point:

- the `self-hosted` / `Linux` / `X64` runner-label → image mapping from `.actrc`,
- the `ci-runner` job container,
- the `pgvector` Postgres service container,
- checkout, the rustup toolchain install, and the apt C-toolchain step.

Full end-to-end local execution is blocked until `node` is added to the
`ci-runner` image (built in a separate repo) — tracked in
[#810](https://github.com/superfield-ai/monorepo/issues/810).

> **Caveat:** act's `-n` dry-run can't preview this workflow — it panics on jobs
> with service containers (the `pgvector` Postgres service here). Use `act -l` to
> validate parsing instead, and a real run to execute it.

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
