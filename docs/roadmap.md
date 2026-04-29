# Superfield — Roadmap

Two parallel delivery tracks. Track A is the orchestrator; Track B is the ops/deploy CLI. Both share the same monorepo and CLI binary.

---

## Track A — GitOps Orchestrator

| Phase | Scope                                                                                                                                             | Status  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A-1   | Foundation: config, GitHub client, git client, MSW test harness, golden fixtures, `github add`, `github forget`                                   | ✅ Done |
| A-2   | Planning loop — CI watchdog: detect failed checks on `main`, create deduplicated `ci-failure` issues, insert at top of Plan                       | ✅ Done |
| A-3   | Planning loop — issue audit and Plan coverage: schema conformance scan, append missing issues to Plan                                             | ✅ Done |
| A-4   | Planning loop — blueprint conformance: load `blueprint/rules/graph.yaml`, evaluate open issues against active rules, post advisory comments       | ✅ Done |
| A-5   | Agent infrastructure: `claude` / `codex` CLI spawner, prompt builders (dev-scout, feature, ci-failure), forge-stored sessions with deadman switch | ✅ Done |
| A-6   | `plan` command — LLM-driven phase grouping, scout creation, Plan rendering with `<!-- superfield: -->` metadata                                   | ✅ Done |
| A-7   | Dev loop — primary agent only: select top of Plan, prep worktree, run agent through 7-stage lifecycle to merge                                    | ✅ Done |
| A-8   | Dev loop — speculative slots: scout-gated parallel feature work (slots 2..N)                                                                      | ✅ Done |
| A-9   | `feature` command — interactive issue creation with PRD/duplicate evaluation                                                                      | ✅ Done |
| A-10  | Documentation loop — coverage scan, canonical sync, consistency check, doc PR creation                                                            | ✅ Done |
| A-11  | Analytics & Steering API — in-process HTTP server for live telemetry and agent context injection                                                  | ✅ Done |

### Track A — Remaining cross-cutting work

- ⬜ Integration test that exercises a full planning-loop tick end-to-end against MSW
- ⬜ Integration tests for dev-loop and doc-loop using recorded fixtures

---

## Track B — Ops / Deploy CLI

| Phase | Scope                                                                                    | Status                        |
| ----- | ---------------------------------------------------------------------------------------- | ----------------------------- |
| B-0   | GitHub API client — deploy keys, secrets, PRs                                            | ✅ Done                       |
| B-1   | Bootstrap: k3s install script + SSH hardening; TS orchestrator wires install.sh over SSH | ✅ Done                       |
| B-2   | Cloud provider helpers: GCP, DigitalOcean, AWS, Vultr                                    | ✅ Done                       |
| B-3   | GitHub setup: per-env deploy key registration, Actions secrets push, workflow sync PR    | ✅ Done                       |
| B-4   | Kubernetes manifests: distroless containers, postgres StatefulSet, DB migration Job      | ✅ Done                       |
| B-5   | `deploy-env` + `rollback-env`: rolling update, health gate, clean-room mode              | ✅ Done                       |
| B-6   | Operator CLI: `doctor`, `init`, `destroy`, `export-db`                                   | 🟡 Partial — see known issues |

### Track B — Remaining planned work

- ✅ Extract shared `resolveEnvCredentials(env)` — landed in PR #208
- ✅ AWS RDS snapshot: real SigV4 signing — landed in PR #202
- ⬜ Integration tests for ops commands using a self-hosted runner as the deployment target (see GitHub issue)
- ⬜ GCP provision path wired through the CLI (currently requires injected deps)

---

## Track C — Control Webapp

| Phase | Scope                                                                                                                | Status                       |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| C-1   | Move studio source into `cli/packages/control/`; tests pass with DI                                                  | ✅ Done (cli-migration)      |
| C-2   | `superfield control` subcommand — `--port`, `--repo`, `--api-url`; `startControl(opts?)` exported                    | ✅ Done (cli-migration)      |
| C-3   | `POST /studio/run` SSE on superfield API; `runAgent`/`streamTurn` switched to `fetch`                                | ✅ Done (cli-migration)      |
| C-4   | WebSocket handler (`/studio/ws`) + REST steer fallback (`/studio/steer`)                                             | ✅ Done (cli-migration)      |
| C-5   | Orchestrator: `dev-loop-process.ts`, `/orchestrator/*` endpoints, `OrchestratorView.tsx`, ControlPanel tab           | ✅ Done (cli-migration)      |
| C-6   | Studio preview (`/studio/preview`) + kitchen-sink split (template + control)                                         | ✅ Done (cli-migration)      |
| C-7   | CI workflow `ci-control.yml` (build + unit + in-process integration)                                                 | ✅ Done (cli-migration)      |
| C-8   | Retire standalone `control/` repo (deprecation banner, workflows disabled)                                           | ✅ Done                      |
| C-9   | Demo-readiness extensions: route map, design tokens, viewport, deploy view, turn timeline, blueprint feed, seed-demo | ⬜ In progress (T-48h, demo) |

PR #204 (`cli-migration`) merged 2026-04-26.

### Track C — Cross-cutting

- ✅ Merge PR #204 to main
- ⬜ Archive `superfield-studio` GitHub repo after PR #73 merges
- Post-demo backlog: screenshots, visual diff, cost charts, log search, fixture switcher
