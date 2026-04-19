# Superfield Deploy: Feature Plan

## Goals

1. **Reliable initial deployments** — `superfield init` brings up a working
   environment from zero in one command, idempotently, with clear failure recovery.
2. **Predictable upgrades** — every rollout is gated by health checks, runs
   migrations in order, uses immutable image tags, and is reversible.
3. **Secure key handling** — secrets exist only as derivations of a user-held
   mnemonic; nothing sensitive is stored at rest by superfield.
4. **Simplicity** — one path for all environments, one path for all providers, one
   tool that owns the GitHub surface.

---

## Design Principles

- **Isomorphic environments**: demo, staging, and production are the same shape.
  An environment is `{ provider, vm, db_mode }`. There is no "local mode".
- **Isomorphic providers**: every vendor helper produces the same outputs (host,
  SSH keypair, optional managed `DATABASE_URL`). After provisioning, downstream
  steps are vendor-agnostic.
- **No source on the host**: the VM only runs containers from GHCR. No git, no
  bun, no compiler. The `kubectl` binary and k3s are the only host tooling.
- **Bun executables**: TypeScript packages compile to standalone native binaries
  via `bun build --compile`. Containers use a distroless/static base.
- **Mnemonic-derived secrets**: every secret comes from HKDF over a BIP-39
  mnemonic. The mnemonic is the single backup artifact.
- **Superfield owns the GitHub surface**: workflow YAML, deploy keys, and
  Actions secrets are all written by superfield and reproducible from the
  mnemonic + repo identity.
- **No external state store**: superfield reads ground truth from GitHub
  (releases, secrets metadata) and the VM (`kubectl get`). No terraform state,
  no DB. Re-running any command converges.

---

## Runtime Architecture

A single VM per environment running **k3s**. The VM:

- Pulls images from GHCR
- Exposes the k3s API only on `127.0.0.1`
- Accepts inbound SSH on a single port, with one authorized key (the derived
  deploy key), `PasswordAuthentication no`, root login disabled
- Runs nothing else: no source, no build tools, no developer accounts

GitHub Actions reaches the VM via SSH and pipes a short-lived `kubectl` command
through the tunnel. k3s does the rolling update.

### Database modes

| Mode | Use case | How |
|------|----------|-----|
| `local` | demo, staging, low-stakes environments | Postgres StatefulSet in k3s, named PVC on VM disk |
| `managed` | production | Caller supplies `DATABASE_URL` (AlloyDB, RDS, Neon, Supabase) |

**Local mode persistence**: the Postgres StatefulSet uses a named PVC
(`postgres-data-<env>`) bound to a hostPath volume on the VM. Data survives pod
restarts and k3s upgrades.

**Clean-room mode**: `superfield deploy --clean-room` creates a *new* PVC
(`postgres-data-<env>-<timestamp>`) seeded with fixture data and points the
StatefulSet at it. The old PVC is left intact on the VM — it is never deleted
automatically, so old data is recoverable. Clean-room is only valid for `local`
mode and is intended for resetting demo or staging environments.

`managed` mode has no clean-room option — data lifecycle is the caller's
responsibility. It is the recommended default for production.

### Out of scope for v1

To keep the surface small: no DNS automation, no TLS termination (assume a
provider-side load balancer or external proxy handles certs), no multi-VM HA, no
built-in observability stack. These are layered on top, not part of the core
deploy path.

---

## Provisioning (vendor helpers)

Provisioning is the only vendor-specific surface. Each helper is idempotent and
produces the same three outputs:

- **SSH host** (IP or hostname)
- **SSH deploy keypair** (derived from mnemonic, registered to VM `authorized_keys`)
- **DATABASE_URL** (only when `--managed-db` is requested; otherwise empty and
  the runtime uses the in-cluster postgres)

```
superfield provision gcp           [--managed-db]
superfield provision aws           [--managed-db]
superfield provision digitalocean  [--managed-db]
superfield provision vultr         [--managed-db]
```

Each provider has one default machine type — no sizing options. These are
chosen to be the smallest instance on each platform that runs k3s comfortably
with one app + one worker + postgres (when local):

| Provider | Default |
|----------|---------|
| GCP | `e2-small` (2 vCPU, 2 GB) |
| AWS | `t3.small` (2 vCPU, 2 GB) |
| DigitalOcean | `s-1vcpu-2gb` |
| Vultr | `vc2-1c-2gb` |

k3s is installed via **SSH bootstrap** after VM creation — no cloud-init. The
same script runs on every provider. Re-running converges to the desired state.

---

## Secret Derivation (Feature 1)

All secrets derive from a user-supplied **BIP-39 mnemonic** (recommended: 24
words, ~256 bits of entropy) using **HKDF-SHA256** with a versioned namespace.

```
derive(mnemonic, "v1/<env>/ssh-deploy-key")   → Ed25519 keypair
derive(mnemonic, "v1/<env>/db-password")      → 32 bytes hex
derive(mnemonic, "v1/<env>/webhook-secret")   → 32 bytes hex
derive(mnemonic, "v1/<env>/cookie-secret")    → 32 bytes hex
```

### Handling rules

- The mnemonic is **never written to disk** by superfield.
- Accepted via interactive prompt (default) or `SUPERFIELD_MNEMONIC` env var.
- Memory holding the mnemonic is zeroed after use.
- Derivation namespace is versioned (`v1/...`) so future scheme changes don't
  invalidate existing deployments.
- BIP-39 chosen over a free-form passphrase because the wordlist makes secure
  backup (paper, steel plate, password manager) far easier for humans.

### Recovery

Losing the mnemonic = losing the deployment. Recovery story is: re-run
`superfield init` with the same mnemonic against the same provider, which
re-derives every secret and re-pushes them to GitHub and the VM.

---

## GitHub Deploy Keys (Feature 2)

A per-repo SSH keypair registered under repo Settings → Deploy keys. This is the
**only credential needed** — no PAT required. The deploy key covers two roles:

- **GitHub Actions → VM**: the private key stored as a repo secret lets the CI
  workflow SSH into the VM to trigger rollouts
- **VM → GHCR/repo**: the same keypair (or a distinct derived one) lets the VM
  authenticate to pull images and manifests from the repo

Because the deploy key is the credential, superfield needs no GitHub PAT for the
deploy path. The one-time registration of the public key (`POST
/repos/{owner}/{repo}/keys`) uses whatever GitHub auth the user already has —
the `gh` CLI's existing authenticated session.

- Public key registered via `POST /repos/{owner}/{repo}/keys` using `gh auth token`
- Private key derived from the mnemonic, stored as repo Actions secret `DEPLOY_KEY_<ENV>`
- One deploy key per environment (not per repo) so keys can be rotated per env
- **Read-only** by default; write access never granted

`superfield setup-github --deploy-key --env <e>` is idempotent: checks for
matching public material and skips if present.

---

## GitHub Repository Secrets (Feature 3)

Secrets stored in repo Settings → Secrets → Actions, encrypted with the repo's
public key using libsodium sealed boxes before upload (`PUT
/repos/{owner}/{repo}/actions/secrets/{name}`).

| Secret | Per-env | Source |
|--------|---------|--------|
| `DEPLOY_HOST_<ENV>` | yes | provisioner output |
| `DEPLOY_KEY_<ENV>`  | yes | derived |
| `DATABASE_URL_<ENV>` | yes | provisioner output (managed) or k3s service URL (local) |
| `WEBHOOK_SECRET_<ENV>` | yes | derived |
| `GHCR_PULL_TOKEN` | no | derived from a single workspace-level GitHub token |

`superfield setup-github --secrets --env <e>` is idempotent. Existing secret
names are overwritten only when the derived value differs from the last
fingerprint (stored as a non-secret repo variable, e.g. `DEPLOY_KEY_<ENV>_FP`).

---

## GitHub Actions YAML Templates (Feature 4)

Superfield emits `.github/workflows/*.yml` into the app repo. Templates are
vendored inside superfield and re-rendered on `superfield sync`.

**Recommendation**: `superfield sync` opens a **pull request** (does not commit
to default branch directly). Workflow changes are security-sensitive and should
have human review and CI signal before merging.

### `release.yml` (generated)

Trigger: semver tag push (`v*`).

1. Run tests
2. `bun build --compile` per binary package → static native binary
3. Build container image: distroless/static base, `COPY` binary, no Bun runtime
4. Push to GHCR with two tags: the semver tag and `sha-<commit>`
5. Create a GitHub Release with the image digest in the body

Image tags are **immutable** — `latest` is never published.

### `deploy.yml` (generated)

Trigger: `workflow_dispatch` with inputs `image_tag` (required) and
`environment` (required, enum demo|staging|prod).

1. Resolve `image_tag` to a digest (fail if tag doesn't exist in GHCR)
2. SSH to `DEPLOY_HOST_<ENV>` using `DEPLOY_KEY_<ENV>`
3. **Migrations**: `kubectl apply` a one-shot migration Job; wait for `Complete`.
   Abort the rollout on failure.
4. **App rollout**: `kubectl set image deployment/<name> ...=<digest>`; wait on
   `kubectl rollout status` with a timeout
5. **Workers**: same pattern, per worker deployment
6. **Health gate**: `GET /healthz` against the in-cluster service through the SSH
   tunnel. On failure, `kubectl rollout undo` and exit non-zero.
7. Annotate the GitHub deployment with the digest and rollout outcome

### `rollback.yml` (generated)

Trigger: `workflow_dispatch` with `environment`. Calls `kubectl rollout undo`
for each managed deployment. Always available; no special path.

---

## Lifecycle Commands

```
superfield init        --env <e> --provider <p> [--managed-db]
                       # one-shot: provision + setup-github + sync + first deploy
superfield provision   <provider> [--managed-db]   # vendor helper
superfield setup-github --deploy-key
superfield setup-github --secrets --env <e>
superfield sync        # render workflow YAML, open PR in app repo
superfield deploy      --env <e> --tag <t>   # also called by CI
superfield rollback    --env <e>
superfield doctor      --env <e>             # preflight: GHCR auth, SSH reachability,
                                             # k3s healthy, DB reachable, secrets fresh
superfield destroy     --env <e>             # tear down VM + managed resources
```

`init` is the one-shot path. The individual commands exist for re-running
specific steps and for CI to call.

---

## Reliability Story

- Every command is idempotent. Re-running converges; partial failures resume.
- `doctor` runs the same checks as `init` and `deploy` use internally; it's the
  diagnostic counterpart to a successful path.
- No external state. Ground truth = (mnemonic) + (GitHub repo state) + (VM
  state). Loss of any superfield-side cache is recoverable.
- Migrations always precede app rollout and gate it.
- Health checks always gate success; failure rolls back automatically.

## Security Story

- Mnemonic is the only sensitive material the user holds; everything else is
  derived.
- Mnemonic never touches disk in plaintext anywhere superfield controls.
- Repo secrets are sealed-box encrypted before upload to GitHub.
- VM SSH: single derived key, no passwords, no root login, restricted to the
  GitHub Actions runner egress range when the provider supports it.
- k3s API not exposed publicly; reached only over the SSH tunnel.
- Image tags are immutable and pinned to digest at deploy time.

---

## Decisions Record

| Question | Decision |
|----------|----------|
| GitHub auth for setup | No PAT. Use `gh auth token` for one-time deploy key registration. SSH deploy key is the only runtime credential. |
| VM bootstrap method | Always SSH. Same script on every provider. No cloud-init. |
| Instance sizing | One opinionated default per provider. No sizing flags. |
| Local DB persistence | Named PVC, survives restarts. `--clean-room` creates a new PVC with seed data; old PVC is never auto-deleted. |
