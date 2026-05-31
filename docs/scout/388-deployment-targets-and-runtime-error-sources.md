# Scout: Deployment Targets and Runtime-Error Sources for the Signal Loop

**Issue:** #388
**Phase:** Deploy and runtime-signal loop
**Feeds:** #380 (deploy + rollback), #381 (runtime signal capture), #382 (error-to-cause chain)

---

## Summary

This scout maps all existing deployment targets, their rollback mechanisms, and
the concrete sources from which runtime errors and behavioral signals must be
captured for the signal loop. The inventory is the basis against which issues
#380, #381, and #382 should be designed.

---

## Deployment Targets Inventory

### 1. k3d local cluster (`demo` / studio-local)

| Property              | Current state                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------ |
| **Target name**       | `demo` (also used by `superfield control` studio rebuild)                                  |
| **Provisioning**      | `k3d` — single-node local cluster; requires Docker + k3d + kubectl on the operator machine |
| **Registry**          | `localhost:5000` (local registry embedded in the k3d cluster)                              |
| **Deploy path**       | `runDeployCommand` (`packages/core/commands/deploy.ts`) → `runDemoDeploy`                  |
| **Manifest apply**    | `kubectl apply -f deploy/base/ -f deploy/env/local/`                                       |
| **Workloads waited**  | `api-server`, `static-web`, `worker`, `postgres` (via `kubectl wait --for=condition=ready`)|
| **Ingress URL**       | `http://${SUPERFIELD_DEMO_HOST}:${SUPERFIELD_DEMO_PORT:-58080}/`                           |
| **Rollback**          | Not implemented for `demo` target. Only `kubectl rollout undo` exists for remote envs.     |
| **Teardown**          | `runDemoTeardown` — calls `destroyCluster()` from `superfield-distribution` scripts        |
| **Studio path**       | `packages/control-core/local-deploy.ts::deployLocalCluster` — generic version              |
| **Studio rollback**   | `POST /studio/rollback` resets git HEAD to checkpoint (code rollback, not k8s image undo)  |

**Rollback gap:** The `demo` target has no image-level rollback. Studio's `POST /studio/rollback` does a `git reset --hard` on the session branch (source rollback), not a `kubectl rollout undo` (runtime rollback). These are different concepts; the demo target lacks runtime rollback entirely.

---

### 2. Remote VM — SSH + kubectl tunnel (cloud envs)

| Property              | Current state                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| **Target names**      | `demo`, `staging`, `prod` (env names; any string accepted by `superfield deploy-env`)                 |
| **Provisioning**      | `superfield init --provider <gcp|aws|digitalocean|vultr>` (step 1)                                   |
| **Deploy path**       | `deployEnv` (`packages/core/commands/deploy-env.ts`)                                                  |
| **Runtime**           | SSH tunnel to VM port 6443 → `kubectl` against the k3s in-cluster API                                |
| **Image source**      | GHCR (`ghcr.io/<owner>/<repo>`) — tag resolved to digest via Docker Hub v2 API before apply          |
| **Image apply**       | `kubectl set image deployment/<name> <name>=<digest>`; `kubectl rollout status --timeout=5m`          |
| **DB migration**      | Inline after image set — runs `db-migrate-<env>-<tag>` Job from `db-migrate-job.yaml.tpl`            |
| **Health check**      | `curl -fsS http://<app>.<ns>.svc.cluster.local<healthPath>` via `kubectl run --rm` probe pod         |
| **GitHub annotation** | `POST /repos/<repo>/deployments` + `POST …/statuses` — best-effort, does not gate rollout            |
| **Rollback**          | `rollbackEnv` (`packages/core/commands/rollback-env.ts`) — `kubectl rollout undo` + health check     |
| **Rollback health**   | On health failure after rollback: returns `{ healthy: false }`, does NOT roll forward; operator alert |
| **Providers**         | GCP, AWS, DigitalOcean, Vultr (`InitProvider` in `packages/core/commands/init.ts`)                   |

**Per-provider provisioning state:**

| Provider     | VM type                     | Managed DB                  | Status in code          |
| ------------ | --------------------------- | --------------------------- | ----------------------- |
| GCP          | `e2-standard-4` GCE VM      | AlloyDB (Postgres 15)       | Implemented             |
| AWS          | EC2 (`t3.medium` default)   | RDS Postgres 16             | Implemented             |
| DigitalOcean | Droplet                     | None (SSH pg_dump fallback) | Implemented             |
| Vultr        | Cloud Compute instance      | None (SSH pg_dump fallback) | Implemented             |

---

### 3. GCP — direct GKE / Compute Engine deploy

| Property         | Current state                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| **Target name**  | GCP (via `superfield deploy gcp`)                                                               |
| **Deploy path**  | `runGcpDeployCommand` → `runGcpDeploy` (`packages/core/gcp/deploy.ts`)                         |
| **Rollback**     | `kubectl rollout undo` over SSH tunnel (same as remote VM path, embedded in `runGcpDeploy`)     |
| **Distinction**  | Uses GCP IAM + OAuth tokens; GCE VM (not GKE). Runs `deploy.sh` on the VM via SSH exec.        |

---

### 4. GitHub Actions workflow trigger

| Property         | Current state                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| **Template**     | `packages/core/templates/workflows/deploy.yml.tpl` — vendored via `superfield sync`             |
| **Trigger**      | `workflow_dispatch` with `image_tag` + `environment` inputs; or called from `release.yml`       |
| **Environments** | `demo`, `staging`, `prod`                                                                        |
| **Secrets used** | `DEPLOY_HOST_<ENV>`, `DEPLOY_KEY_<ENV>`, `DATABASE_URL_<ENV>`, `WEBHOOK_SECRET_<ENV>`          |
| **Rollback**     | Separate `rollback.yml.tpl` vendored workflow; calls `superfield rollback-env`                  |
| **Permissions**  | `deployments: write` (writes GitHub Deployment records)                                         |

---

## Rollback Expectations Summary

| Target          | Rollback mechanism                   | Implemented? | Health-gated? |
| --------------- | ------------------------------------ | ------------ | ------------- |
| `demo` (local)  | None at image level                  | No           | N/A           |
| Studio session  | `git reset --hard` to checkpoint SHA | Yes          | No            |
| Remote VM (SSH) | `kubectl rollout undo`               | Yes          | Yes           |
| GCP direct      | `kubectl rollout undo` over SSH      | Yes          | Yes           |
| GitHub Actions  | Vendored `rollback.yml` workflow     | Yes          | Delegated     |

**Gap:** The `demo` target has no image-level rollback. Issue #380 must decide whether to add `kubectl rollout undo` to the demo target or explicitly scope demo as rollback-exempt.

---

## Runtime Error and Behavior Signal Sources

### Source 1 — Application pod logs (primary runtime error source)

| Property        | Details                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| **Location**    | k8s pod logs: `kubectl logs -l app=<appName> -n <namespace>`                  |
| **Format**      | Unstructured (app-defined) — JSON structured logging is a convention, not enforced |
| **Errors**      | Uncaught exceptions, stack traces, HTTP 5xx, crash-loops, OOMKilled           |
| **Ingestion**   | No current ingestion path into Sharp/Nexum. Logs are not captured into episodes. |
| **Gap**         | No log-to-episode pipeline exists. Issue #381 must create it.                 |

### Source 2 — k8s events (cluster-level signals)

| Property        | Details                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| **Location**    | `kubectl get events -n <namespace>`                                           |
| **Signal types**| CrashLoopBackOff, OOMKilled, ImagePullBackOff, pod eviction, PVC failures     |
| **Ingestion**   | `cluster-status-sse.ts` (`packages/control/src/`) aggregates health for the UI, but does not write to the store |
| **Gap**         | Cluster events are UI-only. No event-to-episode bridge.                       |

### Source 3 — GitHub Actions CI check runs (deploy/validation failures)

| Property        | Details                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| **Location**    | GitHub Checks API (`GET /repos/<repo>/commits/<sha>/check-runs`)              |
| **Signal types**| Failed deploy workflow, failed test suite, image build failure                |
| **Current use** | Planning loop `ci-failure` issues are created from check runs on `main`       |
| **Gap**         | Deploy workflow failures are CI signals but not yet mapped to episodes. The `deployments` API write is best-effort and not read back by any signal loop. |

### Source 4 — GitHub Deployment status (deploy lifecycle)

| Property        | Details                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| **Location**    | GitHub Deployments API — `POST /repos/<repo>/deployments` + `/statuses`             |
| **Signal types**| `in_progress`, `success`, `failure` states written by `deployEnv` and `rollbackEnv` |
| **Current use** | Written best-effort; never read back by the orchestrator                             |
| **Gap**         | No reconciliation loop reads deployment status to drive episode creation.            |

### Source 5 — Application `/healthz` (in-cluster health probe)

| Property        | Details                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| **Location**    | `http://<app>.<ns>.svc.cluster.local/healthz` via `kubectl run` probe pod     |
| **Signal types**| HTTP 200 = healthy; non-200 or timeout = unhealthy                            |
| **Current use** | Polled during `deployEnv` and `rollbackEnv` health gates only                 |
| **Gap**         | Health probe is point-in-time only. No continuous health monitoring writes signal to the store. |

### Source 6 — Sharp episodes schema (the target store)

| Property        | Details                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| **Location**    | `sharp.episodes`, `sharp.episode_artifacts`, `sharp.episode_links` (migration `0005__episodes.sql`) |
| **Schema owner**| Sharp (`superfield-ai/sharp`) — Rust rewrite target                                       |
| **CLI link**    | Architecture §Single-Instance Database defines `episodes` schema in the `episodes` PostgreSQL schema — separate from `sharp.episodes` in Sharp's own migrations |
| **Conflict**    | Sharp's migration `0005__episodes.sql` puts episodes in the `sharp` schema. Architecture §7 gap #5 says `episodes` schema is not yet defined under the orchestrator. These are two different episode tables. |
| **Gap (critical)**| The episode schema location is ambiguous: Sharp's current Rust codebase puts episode tables in the `sharp` schema; the architecture doc plans a separate `episodes` schema owned by the orchestrator. Issue #381 must resolve which schema owns runtime signal capture before writing a single line. |

---

## Episode Mapping Notes

The signal loop requires linking runtime signals to episodes. The causal chain
(per PRD §5 "Deploying and learning" and issue #382) is:

```
runtime error → session → affected users → requirement → current code
```

Current gaps at each hop:

| Hop                        | Source to write from               | Target schema       | Bridge exists? |
| -------------------------- | ---------------------------------- | ------------------- | -------------- |
| runtime error → episode    | app pod logs / `/healthz` failures | `episodes` schema   | No             |
| episode → session          | studio session JSONL logs          | `episodes.episode_events` | No       |
| episode → deployment       | GitHub Deployments API             | `episodes` / `sharp.episodes` | No   |
| deployment → change (PR)   | GitHub PR + Deployment link        | Sharp VCS           | No             |
| change → requirement       | issue body / PRD cross-ref         | Nexum corpus        | No             |

No bridge exists for any of these hops. All five must be built as part of
issues #380, #381, and #382.

---

## Integration Points Discovered

| Integration point                                    | Risk    | Details                                                                                                                      |
| ---------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Episode schema ownership conflict**                | Critical| Sharp `0005__episodes.sql` (in `sharp` schema) vs architecture target `episodes` schema under orchestrator. Must be resolved before #381 writes. |
| **No log-scraping seam**                             | High    | No interface between k8s pod logs and the store. `SshKubeRunner.exec()` can run `kubectl logs` but no pipeline consumes it. |
| **GitHub Deployment records are best-effort write-only** | High | `createDeploymentStatus` is fire-and-forget; failures are logged and swallowed. No reader queries the Deployments API.    |
| **`demo` target lacks runtime rollback**             | Medium  | Only `kubectl rollout undo` on remote envs; demo has no rollback surface at all.                                            |
| **Deploy state is not persisted locally**            | Medium  | No local record of "what image is live in env X". Rollback derives prior image from `kubectl` — requires cluster access at rollback time. |
| **Rust deploy tooling (issue #379) not yet wired**   | Medium  | Issue #379 is "feat(deploy): Rust deploy tooling" — the Rust rewrite of deploy is a separate issue in the same phase. Today's deploy code is TypeScript. Scout cannot know what the Rust interface will look like until #379 ships. |
| **eBPF host-side monitoring stub**                   | Medium  | `src/host_ebpf.rs:38` is not wired (per agent warnings). eBPF could be a runtime signal source but is currently a stub.     |
| **Studio session JSONL logs not linked to deployments** | Low  | `<CONTROL_LOG_DIR>/YYYY-MM-DD.jsonl` records studio turns but has no deployment ID field.                                  |

---

## Architecture §7 Gaps to Record

Two new gaps found during this scout:

| #   | Gap                                           | Target state                                                                             | Tracking |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| 7   | `episodes` schema ownership is ambiguous      | Resolve whether episodes live in `sharp` schema (Sharp migration) or `episodes` schema (orchestrator target) before #381 writes | Open — #381 must decide |
| 8   | No runtime-error-to-episode ingestion seam    | A `LogIngestor` interface (or equivalent) must exist before any runtime signal capture   | Open — #381 |

---

## Downstream Issues: Findings Handoff

### #380 — feat(deploy): deploy a merged, validated change to a target with rollback

**Stubs and seams to build against:**

- The `deployEnv` function (`packages/core/commands/deploy-env.ts`) is the main
  deploy seam. It accepts `DeployEnvOptions` and returns `DeployEnvResult`.
- The `KubeRunner` interface is the injection point for kubectl execution.
  `SshKubeRunner` is the production implementation.
- GitHub Deployment record creation is already in `deployEnv` and `rollbackEnv`
  but is best-effort. #380 should decide whether to make it blocking.
- **Gap to address:** `demo` target has no image-level rollback. #380 must
  either add `kubectl rollout undo` to `runDemoDeploy` or explicitly scope demo
  as rollback-exempt and document the decision.
- Deploy state (what image is live) is not locally persisted — rollback always
  requires live cluster access.

### #381 — feat: capture production runtime errors and behavior as signal into Sharp episodes

**Stubs and seams to build against:**

- **Critical prerequisite:** Resolve the `episodes` schema conflict (gap #7)
  before writing any episode capture code.
- The `SshKubeRunner.exec()` is the only existing interface to run `kubectl logs`
  remotely. A `LogIngestor` or equivalent must wrap this.
- The cluster health SSE path (`cluster-status-sse.ts`) aggregates pod health but
  discards it after UI delivery — this is the closest existing source but writes
  nowhere.
- Sharp's episode tables (`sharp.episodes`, `sharp.episode_artifacts`) exist in
  `apps/server/migrations/0005__episodes.sql`. Their Rust API must be known
  before TypeScript or Rust capture code can write to them.

### #382 — feat: surface the error-to-cause chain for agent diagnosis

**Stubs and seams to build against:**

- None of the five causal-chain hops (error → session → user → requirement → code)
  have a data bridge today. All five must be created by #381 before #382 can
  query them.
- The cross-component join pattern is described in `docs/architecture.md`
  §Cross-component joins. The target query will join `episodes.episode_events`
  to `nexum.documents` to `sharp.commit_paths` in a single statement.
- `SshKubeRunner` is a stable interface #382 can depend on for any runtime
  data access.

---

## Canonical Docs References

- `docs/architecture.md` — §Deploying and learning, §Single-Instance Database,
  §Control Webapp routes, §7 Current Gaps
- `docs/prd.md` §5 — "Deploying and learning" user story
- `packages/core/commands/deploy.ts` — demo deploy target + `DeployTargetModel`
- `packages/core/commands/deploy-env.ts` — remote VM deploy seam (`deployEnv`, `KubeRunner`)
- `packages/core/commands/rollback-env.ts` — rollback seam (`rollbackEnv`)
- `packages/core/commands/init.ts` — provider enum (`InitProvider`: gcp, aws, digitalocean, vultr)
- `packages/core/templates/workflows/deploy.yml.tpl` — GitHub Actions deploy workflow
- `packages/control/src/cluster-status-sse.ts` — existing (UI-only) health aggregator
- `packages/control-core/checkpoint-manager.ts` — studio session rollback (code, not image)
- `superfield-ai/sharp` `apps/server/migrations/0005__episodes.sql` — episode tables (Rust target)
