# Superfield

Superfield is a CLI that owns the full lifecycle of a k3s-based application deployment — from zero-to-running on a fresh VPS through rolling updates, rollbacks, and database exports — while running an autonomous GitOps orchestration loop that drives issues to merged PRs.

## Requirements

- [Bun](https://bun.sh) v1.3+
- A GitHub App authorization for the target user (orchestration commands)
- SSH access to a provisioned VPS (ops commands)

## Install

```bash
bun install
```

Build and install the local CLI binary into `~/.bun/bin`:

```bash
bun run local-install
```

Make sure `~/.bun/bin` is on your `PATH`:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

---

## Ops Commands

Lifecycle commands for managing a k3s deployment on a VPS. These are one-shot, idempotent, and composable — `init` runs them all in sequence.

```bash
superfield init <env>          # provision host, register GitHub secrets, deploy
superfield doctor <env>        # preflight health check — SSH, k3s, DB, secrets
superfield deploy-env <env>    # rolling update: build → push → apply → health gate
superfield rollback-env <env>  # roll back to the previous deployment
superfield destroy <env>       # tear down the deployment (prod requires confirmation)
superfield export-db <env>     # dump the database (pg_dump for local, snapshot for managed)
```

Each command reads per-env secrets (`DEPLOY_HOST_<ENV>`, `DEPLOY_KEY_<ENV>`, `DATABASE_URL_<ENV>`) from the environment or from the repository's GitHub Actions secrets.

### Supported cloud providers

| Provider     | VM  | Managed DB    |
| ------------ | --- | ------------- |
| GCP          | ✅  | AlloyDB       |
| DigitalOcean | ✅  | Managed PG    |
| AWS          | ✅  | RDS (partial) |
| Vultr        | ✅  | —             |

---

## Orchestration Commands

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

## Development

```bash
# Typecheck
bun run typecheck

# Unit tests
bun --bun vitest run packages/*/tests/unit

# Integration tests
bun --bun vitest run packages/*/tests/integration

# All tests
bun run test
```

## Structure

```
packages/
  cli/           Commands: all CLI entry points
  core/          Config, outer loop, CI watchdog, ops orchestration
  control/       Control webapp (Bun HTTP server + React UI)
  control-core/  Shared types and utilities for the control layer
  db/            Database schema and migration helpers
  github/        Octokit wrapper (GitHub API client)
  git/           isomorphic-git wrapper (no git binary)
docs/
  product.md       Product requirements
  architecture.md  Technical design
  plan.md          Implementation plan and known issues
  roadmap.md       Build order
```
