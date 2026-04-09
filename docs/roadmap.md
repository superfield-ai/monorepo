# Superfield — Roadmap

Build order. For product scope see [`product.md`](./product.md); for implementation details see [`architecture.md`](./architecture.md).

| Phase | Scope                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Foundation: config, GitHub client, git client, MSW test harness, golden fixtures, `github add`, `github forget`                                   |
| 2     | Planning loop — CI watchdog: detect failed checks on `main`, create deduplicated `ci-failure` issues, insert at top of Plan                       |
| 3     | Planning loop — issue audit and Plan coverage: schema conformance scan, append missing issues to Plan                                             |
| 4     | Planning loop — blueprint conformance: load `blueprint/rules/graph.yaml`, evaluate open issues against active rules, post advisory comments       |
| 5     | Agent infrastructure: `claude` / `codex` CLI spawner, prompt builders (dev-scout, feature, ci-failure), forge-stored sessions with deadman switch |
| 6     | `plan` command — LLM-driven phase grouping, scout creation, Plan rendering with `<!-- superfield: -->` metadata                                   |
| 7     | Dev loop — primary agent only: select top of Plan, prep worktree, run agent through 7-stage lifecycle to merge                                    |
| 8     | Dev loop — speculative slots: scout-gated parallel feature work (slots 2..N)                                                                      |
| 9     | `feature` command — interactive issue creation with PRD/duplicate evaluation                                                                      |
| 10    | Documentation loop — coverage scan, canonical sync, consistency check, doc PR creation                                                            |

Phases describe build order. Each phase delivers a working slice and is testable in isolation.
