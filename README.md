# Superfield

**Superfield is an Agent Integrated Development Environment (Agent IDE).**

Where a traditional IDE helps a human write code, Superfield runs a continuous autonomous loop — planning, coding, testing, reviewing, deploying — driven entirely by AI agents. The developer steers intent; agents do the work.

---

## Phase 1 — Agent Orchestration Platform

The current release gives you four integrated layers:

| Layer | What it does |
| --- | --- |
| **Orchestration** | Continuous dev loop: CI watchdog → issue audit → blueprint conformance → primary + speculative coding agents → doc sync |
| **Self-improvement** | Agents learn from their own run history. The planning loop audits past turns, detects drift from the blueprint, and tightens the rules curriculum over time (inspired by [Honcho](https://honcho.dev)) |
| **Blueprint (brain)** | A bundled knowledge graph of architectural rules, security threats, and design antipatterns. Agents receive a narrow rule slice on turn 1; deeper principles layer in as context expands. Every PR is self-audited before opening |
| **Deploy + Control** | One-command k3s deployment across GCP / DigitalOcean / AWS / Vultr, plus a browser console for watching agents work, steering them mid-turn, and triaging deployments |

## Phase 2 — Self-Improving App Platforms _(R&D)_

Phase 1 keeps Git and GitHub as the delivery plane. Phase 2 replaces them with infrastructure purpose-built for agent iteration speed:

| Component | Repo | Role |
| --- | --- | --- |
| **Sharp** | [`superfield-ai/sharp`](https://github.com/superfield-ai/sharp) | Agent-native VCS, backwards-compatible with Git. Branching-free change tracking at sub-second cadence |
| **Nexum** | [`superfield-ai/nexum`](https://github.com/superfield-ai/nexum) | Self-improving synthetic corpus — living curriculum that agents refine as they work, improving future runs |
| **FastEnv** | _(in design)_ | Ultrafast container forking for sub-second CI inner loops — a fresh isolated env per test run |

**The end goal: self-improving app platforms** — applications that continuously audit and improve themselves, with Superfield as the safe, observable, reversible runtime for autonomous self-modification.

---

## Requirements

- [Bun](https://bun.sh) v1.3+
- A GitHub App authorization for the target repo (orchestration commands)
- SSH access to a provisioned VPS (ops commands)

## Install

```bash
bun install
```

Build and install the CLI binary into `~/.bun/bin`:

```bash
bun run local-install
```

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

---

## Orchestration

GitOps autonomous development loop. Issues are the task queue; the Plan issue is orchestration state; PRs are change proposals.

```bash
superfield github add           # authenticate, install GitHub App, register repo
superfield github forget        # remove credentials and print the app uninstall link

superfield start [slotCount]    # begin the continuous development loop (foreground)
superfield plan                 # sync all open issues into the Plan tracking issue
superfield feature "<desc>"     # ticket a new feature issue and update the Plan
```

Config is saved to `~/.superfield/config.yaml`.

---

## Control Console

Browser UI for iterative development, UX design, agent monitoring, and deployment health.

```bash
superfield control [--port <n>] [--repo <path>] [--api-url <url>]
```

Opens at `http://127.0.0.1:7000`. Four panels: studio session (chat + iframe + fixtures), component preview, orchestrator dashboard, deployment health.

---

## Ops Commands

One-shot, idempotent deployment lifecycle commands.

```bash
superfield init <env>          # provision host, register GitHub secrets, deploy
superfield doctor <env>        # preflight: SSH, k3s, DB, secrets
superfield deploy-env <env>    # rolling update: build → push → apply → health gate
superfield rollback-env <env>  # roll back to the previous deployment
superfield destroy <env>       # tear down (prod requires confirmation)
superfield export-db <env>     # pg_dump for local postgres; snapshot for managed DB
```

### Cloud providers

| Provider     | VM  | Managed DB |
| ------------ | --- | ---------- |
| GCP          | ✅  | AlloyDB    |
| DigitalOcean | ✅  | Managed PG |
| AWS          | ✅  | RDS        |
| Vultr        | ✅  | —          |

---

## Development

```bash
bun run typecheck
bun --bun vitest run packages/*/tests/unit
bun --bun vitest run packages/*/tests/integration
bun run test
```

## Structure

```
packages/
  cli/           Commands — all CLI entry points
  core/          Dev loop, planning loop, doc loop, ops orchestration
  control/       Control webapp (Bun HTTP server + React UI)
  control-core/  Shared types and utilities for the control layer
  db/            Embedded database schema and migrations
  github/        Octokit wrapper (GitHub API client)
  git/           isomorphic-git wrapper (no git binary required)
docs/
  product.md       Product requirements and vision
  architecture.md  Technical design
  plan.md          Implementation state and known issues
  roadmap.md       Build order
```
