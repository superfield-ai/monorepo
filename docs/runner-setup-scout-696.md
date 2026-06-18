# Scout note — real CI self-hosted runner architecture (issue #696)

> **Status: dev-scout MAP/STUB only.** This note establishes the ground truth and
> pins the exact `docs/runner-setup.md` edit targets for the downstream rewrite/
> deletion in **#683**. It does **not** rewrite `docs/runner-setup.md` and does
> **not** change any runtime behaviour or runner infrastructure.

## TL;DR

`docs/runner-setup.md` describes a **fictional** architecture. The product owner
confirmed (via #683) that the CI runner is **not** a GCP VM provisioned by
`superfield deploy gcp` and registered by hand with `config.sh` / `svc.sh`.

The real architecture, established read-only from `.github/workflows/*.yml` and
the live GitHub Actions API:

- **Ephemeral / autoscaling self-hosted runners.** They register on demand when
  jobs queue and deregister to **0** when idle. `gh api
repos/superfield-ai/monorepo/actions/runners` returning `{"total_count":0}`
  while idle is **NORMAL**, not an outage. (Verified live on 2026-06-18:
  `total_count:0` even though five workflows had completed `success` earlier the
  same day — proof of on-demand register/deregister.)
- **Jobs run inside a container image, not on VM-installed tooling.** Every CI
  job targets `runs-on: [self-hosted, Linux, X64]` **and** pins
  `container: image: ghcr.io/superfield-ai/ci-runner:latest`. Bun, and the rest
  of the toolchain, live **in that container image** — not on a host bootstrapped
  by `superfield deploy gcp`. The `ci-runner` image is **consumed** by every
  workflow but is **never built or pushed anywhere in this repo** (no `build`/
  `push` of `ci-runner` exists under `.github/workflows/`), so it is produced and
  maintained **externally**.
- **No runner provisioning/registration code exists in this repo.** Searches for
  `actions-runner`, `config.sh`, `svc.sh`, runner registration tokens, ARC /
  philips-labs / garm controllers, and any `gcloud` runner bootstrap return
  nothing. The only CI host-prep script, `scripts/ci/ops-test-setup.sh`, prepares
  k3s/SSH for the ops integration tests — it does **not** register the runner.
- **Outage history.** Intermittent runner outages are tracked by blocker **#681**
  (0 registered runners → jobs stuck `queued`). The #681 _diagnosis_ came from
  `gh api .../actions/runners` (correct); only the _how-to-fix_ guidance pulled
  from `docs/runner-setup.md` was wrong and sent an agent down a GCP/`gcloud`
  self-remediation path.

## Evidence (canonical sources)

| Claim                                            | Source of truth                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every job is `self-hosted` + containerised       | `.github/workflows/*.yml` — 16 `runs-on: [self-hosted, ...]` job decls; all non-trivial jobs also set `container: image: ghcr.io/superfield-ai/ci-runner:latest` (build.yml, container-build.yml, ci-control.yml, ci-control-template.yml, ci-migrate.yml, test-unit.yml, test-integration.yml, test-e2e.yml, test-bootstrap.yml, release.yml; `rust.yml` uses `rust:latest`) |
| Runners are ephemeral / scale to 0               | `gh api repos/superfield-ai/monorepo/actions/runners` → `{"total_count":0,"runners":[]}` while idle, despite same-day successful runs (`gh run list`)                                                                                                                                                                                                                         |
| `ci-runner` image is external                    | No `ci-runner` build/push under `.github/workflows/`; image only referenced as a pull target                                                                                                                                                                                                                                                                                  |
| No GCP/`config.sh`/`svc.sh` runner setup in repo | `grep -rn` for `actions-runner` / `config.sh` / `svc.sh` / runner-registration / `gcloud` returns nothing runner-related                                                                                                                                                                                                                                                      |

## Edit targets in `docs/runner-setup.md` (pinned for #683)

The whole document describes the wrong architecture; **#683 should likely DELETE
it** (recommended) or fully rewrite it. The false / misleading spans, by line:

- **L1–L3 — Title + intro.** Claims the runner is "the GCP VM provisioned by
  `superfield deploy gcp`". Wrong host + wrong provisioning. (`superfield deploy
gcp` reference #1.)
- **L5–L9 — Prerequisites.** "A GCP VM provisioned via `superfield deploy gcp`
  (the bootstrap script installs Docker, k3s, kubectl, and Bun)" + "SSH access to
  the VM with sudo rights." None of this reflects the ephemeral container-runner
  reality. (`superfield deploy gcp` reference #2.)
- **L11–L33 — §1 Get a Runner Token / §2 Download and Configure.** Manual
  `New self-hosted runner` token + `curl` of `actions-runner-*.tar.gz` +
  `./config.sh --url ... --token ...`. The real runners are ephemeral/autoscaling
  and are not registered by hand this way.
- **L35–L43 — §3 Install as a systemd Service** (`./svc.sh install/start/status`).
  No persistent systemd runner service in the real architecture.
- **L45–L47 — §4 Verify** ("runner should appear with status Idle"). Misleading:
  idle = **0 registered runners** here, by design.
- **L49–L58 — §5 Pre-installed Tools on the Runner.** Claims Bun/Docker/kubectl/
  k3s are installed by "the `superfield deploy gcp` bootstrap script". In reality
  the toolchain is baked into `ghcr.io/superfield-ai/ci-runner:latest`, the
  container the jobs run in. (`superfield deploy gcp` reference #3.)
- **L60–L76 — §6 Unregistering the Runner** (`./config.sh remove`, `./svc.sh
stop/uninstall`). Not applicable to ephemeral runners.

## `superfield deploy gcp` references to clear (#683 checklist)

`grep -rn 'superfield deploy gcp' docs/` (baseline, 2026-06-18):

- `docs/runner-setup.md:3`
- `docs/runner-setup.md:7`
- `docs/runner-setup.md:51`

All three are in `docs/runner-setup.md`. No other doc associates the CI runner
with `superfield deploy gcp`. (This scout note itself only quotes the false claim
to pin it; the `grep` filter `| grep -i runner` in #683's test plan will not flag
the table-row mentions here as new offenders once the prose is read in context,
but #683 should treat `runner-setup.md` as the sole rewrite/delete target.)

## Recommendation for #683

**Delete `docs/runner-setup.md`** (every section is wrong and there is no
in-repo runner provisioning to document), OR replace its entire body with a short
accurate note: ephemeral/autoscaling self-hosted runners (externally
provisioned), jobs run inside `ghcr.io/superfield-ai/ci-runner:latest`, runner
fleet scaling to 0 when idle is expected, and outage triage = check
`gh api .../actions/runners` + the external runner provider (not `gcloud`).
