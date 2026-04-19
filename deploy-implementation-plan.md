# Superfield Deploy: Implementation Plan

Sequenced work items for delivering the features in `deploy-features.md`. Each
item is sized to be one issue / one PR. Items are ordered by dependency; later
phases assume earlier phases are merged.

---

## Phase 0 — Foundations

### 0.1 Secret derivation library
- BIP-39 mnemonic input (interactive prompt + `SUPERFIELD_MNEMONIC` env var)
- HKDF-SHA256 over the mnemonic seed with versioned namespace (`v1/<env>/<purpose>`)
- Derivers: `deriveEd25519Key`, `derivePassword`, `deriveHmacToken`
- Mnemonic memory is zeroed after use; never written to disk
- Unit tests: known-answer vectors per derivation purpose

### 0.2 SSH client wrapper
- Thin wrapper over `ssh`/`scp` with strict host key checking via known_hosts file
- Supports running scripts and piping output
- Used by every later component (bootstrap, deploy, doctor)
- Integration test against a local container running sshd

### 0.3 GitHub API client
- Wraps `gh auth token` for credential acquisition (no PAT plumbing)
- Methods: `registerDeployKey`, `putRepoSecret` (sealed-box encrypted),
  `getRepoSecretFingerprint`, `openPullRequest`
- Unit tests with recorded HTTP fixtures (MSW)

---

## Phase 1 — VM Bootstrap

### 1.1 SSH bootstrap script
- Single shell script vendored in `packages/core/bootstrap/install.sh`
- Installs k3s, configures it to bind only to `127.0.0.1`
- Hardens sshd: no password auth, no root login, single authorized key
- Idempotent: re-running converges
- Tested against a Multipass/Lima Ubuntu VM in CI

### 1.2 Bootstrap orchestrator
- TS function that uploads the script via scp, runs it over SSH with the
  derived deploy key already installed in `authorized_keys`
- Verifies k3s health at the end
- Used by every provider helper

---

## Phase 2 — Provider Helpers

Each provider gets its own package/module producing the same output shape:
`{ host, sshPrivateKeyPem, databaseUrl? }`. Order reflects implementation
priority.

### 2.1 GCP provider helper
- Port the existing `scripts/gcp/provision.ts` logic into
  `packages/core/providers/gcp/`
- Single default machine type (`e2-small`)
- Optional `--managed-db` provisions AlloyDB
- Idempotent: re-running converges to desired state
- Smoke test against a real GCP project (gated behind env var)

### 2.2 DigitalOcean provider helper
- Uses DO API with token from `DIGITALOCEAN_TOKEN`
- Default droplet `s-1vcpu-2gb`
- `--managed-db` provisions DO Managed Postgres

### 2.3 AWS provider helper
- `t3.small` EC2 in default VPC
- `--managed-db` provisions RDS Postgres `db.t3.micro`

### 2.4 Vultr provider helper
- `vc2-1c-2gb` instance
- `--managed-db` provisions Vultr Managed Postgres

---

## Phase 3 — GitHub Surface

### 3.1 Deploy key registration
- `superfield setup-github --deploy-key --env <e>`
- Derives keypair, registers public key on the repo via GitHub API
- Stores private key as `DEPLOY_KEY_<ENV>` repo secret (sealed-box encrypted)
- Idempotent: skips if existing key with matching public material

### 3.2 Repo secrets push
- `superfield setup-github --secrets --env <e>`
- Pushes `DEPLOY_HOST_<ENV>`, `DATABASE_URL_<ENV>`, `WEBHOOK_SECRET_<ENV>`,
  `COOKIE_SECRET_<ENV>`
- Stores fingerprint in matching `_FP` repo variable; only re-pushes when changed

### 3.3 Workflow YAML templates
- Vendored templates: `release.yml`, `deploy.yml`, `rollback.yml`
- Renderer fills in repo/image/env values
- `superfield sync` writes templates into a branch and opens a PR via
  `openPullRequest` (does not commit to default branch)

---

## Phase 4 — Application Container Changes (calypso-starter-ts)

### 4.1 Bun-compiled executables
- Replace `oven/bun` runtime base with distroless/static
- `bun build --compile` per binary package in CI
- `Dockerfile.release` becomes a minimal `COPY` of the static binary
- Verify image runs end-to-end in k3s

### 4.2 Postgres StatefulSet manifest
- Update `k8s/postgres.yaml` to use a named PVC (`postgres-data-<env>`) with
  hostPath storage class
- Confirm data survives pod restarts and StatefulSet updates

### 4.3 Migration Job manifest
- `k8s/db-migrate.yaml` template: one-shot Job that runs `migrate.ts` against
  the configured `DATABASE_URL`
- Used by deploy.yml as the migrations gate

---

## Phase 5 — Deploy Path

### 5.1 Core deploy command
- `superfield deploy --env <e> --tag <t>`
- Resolves `<t>` to a digest via GHCR API (fail if missing)
- SSHes to host, applies migration Job, waits for `Complete`
- `kubectl set image` for app + each worker, waits on `rollout status` with timeout
- Health gate via `GET /healthz` through the SSH tunnel
- On failure: `kubectl rollout undo`, exit non-zero
- Annotates GitHub deployment with digest + outcome

### 5.2 Clean-room mode
- `superfield deploy --clean-room` (only valid for `local` DB)
- Creates new PVC `postgres-data-<env>-<timestamp>` with seed data
- Patches StatefulSet to use new PVC
- Old PVC remains; logged for the user

### 5.3 Rollback command
- `superfield rollback --env <e>`
- `kubectl rollout undo` for each managed deployment
- Same health gate as forward deploy

---

## Phase 6 — Operational Surface

### 6.1 Doctor command
- `superfield doctor --env <e>` — preflight checks:
  - GHCR auth works
  - SSH host reachable, deploy key accepted
  - k3s healthy via SSH tunnel
  - DB reachable
  - Repo secrets present and fingerprint matches derivation
- Same checks `init` and `deploy` use internally

### 6.2 Init command (one-shot)
- `superfield init --env <e> --provider <p> [--managed-db]`
- Composes: provision → setup-github (deploy-key + secrets) → sync → first deploy
- Resumable: each phase is idempotent so re-running picks up where it left off

### 6.3 Destroy command
- `superfield destroy --env <e>`
- Tears down VM and managed resources via the provider helper
- Removes repo secrets for the env (deploy key remains for audit; user can
  delete manually)
- Refuses to run on `prod` without `--yes-i-really-mean-it`

### 6.4 Export-db command
- `superfield export-db --env <e> --out <path>`
- Runs `pg_dump` over the SSH tunnel for `local` DB mode
- For `managed` mode, uses provider snapshot API where available, else `pg_dump`

---

## Phase 7 — Documentation

### 7.1 Quickstart
- "Five-minute init" walkthrough using DigitalOcean (cheapest, fastest)
- Mnemonic generation, env setup, first deploy

### 7.2 Provider guide per cloud
- Credentials setup, gotchas, cost estimate per provider

### 7.3 Operations guide
- Rotating the mnemonic
- Migrating local → managed DB
- Recovering from lost secrets / re-running init
- Manual rollback procedures

---

## Cross-Cutting

- Every command honors `--dry-run` (prints intended actions without executing)
- Every command emits structured JSON when `--json` is set, for CI consumption
- Telemetry: opt-in only; no telemetry by default
- All HTTP calls to provider/GitHub APIs use recorded fixtures in tests; no live
  calls in unit tests

---

## Suggested PR Sequencing

1. Phase 0 in parallel (3 independent PRs)
2. Phase 1 (depends on 0.2)
3. Phase 2.1 GCP (depends on Phase 1)
4. Phase 3.1 + 3.2 in parallel (depends on Phase 0.3)
5. Phase 4 in calypso-starter-ts in parallel with Phase 3
6. Phase 3.3 templates (depends on Phase 4 image shape being settled)
7. Phase 5.1 deploy (depends on Phase 1 + Phase 4)
8. Phase 5.2, 5.3 in parallel
9. Phase 6.1 doctor → 6.2 init → 6.3 destroy → 6.4 export-db
10. Phase 2.2–2.4 additional providers (can land any time after Phase 2.1)
11. Phase 7 documentation (last, after surface is stable)
