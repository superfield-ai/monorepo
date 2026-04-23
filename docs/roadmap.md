# Superfield — Roadmap

Two parallel delivery tracks. Track A is the orchestrator; Track B is the ops/deploy CLI. Both share the same monorepo and CLI binary.

---

## Track A — GitOps Orchestrator

| Phase | Scope                                                                                                                                             | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
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
| A-11  | Analytics & Steering API — in-process HTTP server for live telemetry and agent context injection                                                  | ⬜ Planned |

### Track A — Remaining cross-cutting work

- ⬜ Wire all three loops together inside `superfield start` (currently only the planning loop runs)
- ⬜ Integration test that exercises a full planning-loop tick end-to-end against MSW
- ⬜ Integration tests for dev-loop and doc-loop using recorded fixtures

---

## Track B — Ops / Deploy CLI

| Phase | Scope                                                                                     | Status           |
| ----- | ----------------------------------------------------------------------------------------- | ---------------- |
| B-0   | GitHub API client — deploy keys, secrets, PRs                                             | ✅ Done           |
| B-1   | Bootstrap: k3s install script + SSH hardening; TS orchestrator wires install.sh over SSH | ✅ Done           |
| B-2   | Cloud provider helpers: GCP, DigitalOcean, AWS, Vultr                                    | ✅ Done           |
| B-3   | GitHub setup: per-env deploy key registration, Actions secrets push, workflow sync PR     | ✅ Done           |
| B-4   | Kubernetes manifests: distroless containers, postgres StatefulSet, DB migration Job       | ✅ Done           |
| B-5   | `deploy-env` + `rollback-env`: rolling update, health gate, clean-room mode              | ✅ Done           |
| B-6   | Operator CLI: `doctor`, `init`, `destroy`, `export-db`                                   | 🟡 Partial — see known issues |

### Track B — Known issues (Phase 6)

These correctness gaps were identified in review and must be fixed before the operator CLI is production-usable.

**Critical**
- `doctor` hard-fails four checks when `opts.mnemonic` is missing, so `allOk` can never be `true` from the shipped CLI path. Four checks in `packages/core/commands/doctor.ts` (lines 288, 368, 429, 497) require the mnemonic, but the CLI never accepts or derives one.
- `doctor` fetches `DEPLOY_HOST_<ENV>` as a repo _variable_, but `setup-github` stores it as a _secret_ (`packages/core/commands/setup-github.ts:200`), so SSH/k3s/DB checks will never find the host.

**High**
- `init` step 6 ignores the deploy key derived in steps 1–5 and instead reads `DEPLOY_KEY` / `DEPLOY_KEY_FILE` from the ambient environment (`packages/core/commands/init.ts:253`). A fresh operator cannot complete `init` end-to-end without manual setup.
- `init --provider gcp` always throws unless an internal `provision` function is injected (`packages/core/commands/init.ts:335`). GCP support is not functional from the CLI.
- `export-db` AWS branch: `buildAwsAuthHeader()` emits `Signature=placeholder` — RDS snapshot calls will fail authentication (`packages/core/commands/export-db.ts:210`).
- `export-db` is not wired to the per-env secret/host conventions used by `setup-github`. It expects `DEPLOY_HOST` / `DEPLOY_KEY` (no env suffix); the rest of the system uses `DEPLOY_HOST_<ENV>` / `DEPLOY_KEY_<ENV>`.

**Medium**
- Environment/key/host resolution is reimplemented separately in `doctor`, `init`, `deploy-env`, `rollback-env`, and `export-db`. This duplication is the root cause of the contradictory host-name assumptions above.

### Track B — Remaining planned work

- ⬜ Fix Phase 6 known issues (see above)
- ⬜ Extract a shared `resolveEnvCredentials(env)` helper used by all ops commands
- ⬜ Integration tests for ops commands using a self-hosted runner as the deployment target (see GitHub issue)
- ⬜ AWS RDS snapshot: implement real SigV4 signing or delegate to the AWS CLI
- ⬜ GCP provision path wired through the CLI (currently requires injected deps)
