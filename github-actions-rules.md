# GitHub Actions Rules

Conventions for all workflows in this repository. Every new workflow and every
change to an existing workflow must follow these rules.

---

## File layout

```
.github/
  actions/
    setup-bun/
      action.yml        # composite: checkout + bun install
  scripts/
    typecheck.sh        # tsc --noEmit across all tsconfig.json files
    test-unit.sh        # Layer 1a — server + core unit tests
    test-browser-unit.sh  # Layer 1b — browser controller unit tests
    test-component.sh   # Layer 2  — React component tests
    test-integration.sh # Layer 3  — server integration tests
    test-e2e.sh         # Layer 4  — Playwright E2E tests
  workflows/
    ci.yml              # push / PR / nightly: build, typecheck, Layer 1a
    ci-browser.yml      # push / PR / nightly: Layer 1b + Layer 2 (Chromium)
    ci-integration.yml  # push / PR: Layer 3 server integration (Postgres)
    ci-e2e.yml          # push to main / dispatch / nightly: Layer 3 full + Layer 4 (k3s)
```

---

## Pyramid → workflow mapping

| Layer | Description | Workflow | Runner | Infra |
|-------|-------------|----------|--------|-------|
| 1a | Server unit tests | `ci.yml` | ubuntu-latest | none |
| 1b | Browser controller unit tests | `ci-browser.yml` | ubuntu-latest | Chromium via Playwright |
| 2 | React component tests | `ci-browser.yml` | ubuntu-latest | Chromium via Playwright |
| 3a | Server integration tests | `ci-integration.yml` | ubuntu-latest | Postgres service container |
| 3b | Full cluster integration tests | `ci-e2e.yml` | self-hosted (k3s) | k3s cluster |
| 4 | Playwright E2E tests | `ci-e2e.yml` | self-hosted (k3s) | k3s cluster |

---

## Shared setup

- Extract `actions/checkout` + `oven-sh/setup-bun` + `bun install` into a
  **composite action** at `.github/actions/setup-bun/action.yml`.
- Every workflow job that calls the composite action **must** include an explicit
  `uses: actions/checkout@v4` step immediately before it. GitHub Actions cannot
  resolve a local action path (`./`) until the repository is already checked out.
  The checkout inside the composite does not satisfy this requirement — it runs
  too late.
- The canonical two-step pattern for any job using the composite:
  ```yaml
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/setup-bun
  ```
- No job duplicates the `bun install` sequence beyond what the composite provides.

---

## Shell scripts

- Any logic that spans more than a single command belongs in
  `.github/scripts/<name>.sh`, not in an inline `run:` block.
- All scripts use `#!/usr/bin/env bash` and `set -euo pipefail`.
- All scripts are committed with executable permissions (`chmod +x`).
- A YAML `run:` block that calls a script looks like:
  ```yaml
  - name: Run unit tests
    run: bash .github/scripts/test-unit.sh
  ```
- Never inline a `for` loop, conditional, or multi-command sequence in YAML.

---

## Job structure

- Each job has **one responsibility**: build, typecheck, test-unit, test-integration, etc.
- Jobs that can run in parallel do not declare `needs:`.
- Jobs that require a prior artifact (e.g. a build output) use `needs:`.
- Keep steps per job to **five or fewer**. If a job needs more, extract a script.
- Use `services:` blocks for Postgres — never start Docker containers in steps.

---

## Triggers

Nightly checks are schedule triggers on existing workflow files — there is no
separate `nightly.yml`. Each workflow defines only the triggers appropriate to
its cost and environment:

| Workflow | `pull_request` | `push` | `workflow_dispatch` | `schedule` (nightly UTC) |
|----------|:-:|:-:|:-:|:-:|
| `ci.yml` | ✓ | any branch | — | `0 2 * * *` |
| `ci-browser.yml` | ✓ | any branch | — | `0 2 * * *` |
| `ci-integration.yml` | ✓ | any branch | — | — |
| `ci-e2e.yml` | — | `main` only | ✓ | `0 3 * * *` |

Rules:
- Fast, no-infra workflows (`ci.yml`, `ci-browser.yml`) run on PR, push, and
  nightly — they are cheap enough to schedule.
- Infra-heavy, fast-enough workflows (`ci-integration.yml`) run on PR and push
  only — Postgres starts in seconds, no need to schedule separately.
- k3s-dependent workflows (`ci-e2e.yml`) run on push to `main`, on demand via
  `workflow_dispatch`, and nightly — never on every PR (too slow and expensive).
- Do not create a standalone `nightly.yml` — add a `schedule:` trigger to the
  appropriate workflow file instead.

---

## Runners

- `ubuntu-latest` for all jobs that do not require a running Kubernetes cluster.
- `self-hosted` with label `k3s` for any job that provisions or interacts with
  a k3s cluster (Layers 3b and 4). Label the runner at registration time.

---

## Naming

- **Workflow `name:`** — title-case, matches the pyramid layer(s) it covers:
  `Unit Tests`, `Browser Tests`, `Integration Tests`, `E2E Tests`, `Nightly`.
- **Job `name:` (or job key)** — kebab-case, single responsibility:
  `build`, `typecheck`, `test-unit`, `test-browser-unit`, `test-component`,
  `test-integration`, `test-e2e`.
- **Step `name:`** — imperative verb phrase: `Install Playwright browsers`,
  `Run component tests`.

---

## PR body rule

Every PR that touches `.github/` must include a brief note in the PR body
describing which workflow files were added or changed and which test layers
they cover.

---

## What not to do

- Do not write multi-line logic inline in `run:` blocks — use a script.
- Do not duplicate checkout + install steps across jobs in the same workflow —
  use the composite action.
- Do not run k3s-dependent tests on `ubuntu-latest` — use the `k3s` runner.
- Do not add a new workflow file without updating this rules file if the new
  workflow introduces a new pattern not covered here.
- Do not use `actions/cache` for `node_modules` or `bun` install without
  first confirming the cache key is stable across the relevant OS matrix.
