# Scout: FastEnv Host Control Plane and Substrate Reliability Requirements

**Issue:** #389
**Phase:** Federated compute and reliability
**Feeds:** #384 (eBPF monitoring and real crun), #385 (substrate replication and backup/recovery)

---

## Summary

This scout maps the current FastEnv host control plane surface, the status of
eBPF monitoring and crun integration, and the reliability expectations for the
single Postgres substrate. It forms the baseline that issues #384 and #385 must
be designed against before building multi-host scheduling or backup/restore.

---

## Host Control Plane — Current State

FastEnv's host-side control plane is implemented across three packages:

### 1. `packages/firecracker/` — Firecracker microVM lifecycle

| File            | Responsibility                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `provision.ts`  | Downloads and caches the Firecracker binary (`v1.12.0`) and guest kernel into `~/.superfield/`       |
| `api.ts`        | HTTP-over-Unix-socket client for the Firecracker management API (boot source, drives, snapshot, etc) |
| `vm.ts`         | `buildVmSnapshot()` and `restoreVm()` — full VM lifecycle from boot through snapshot restore         |
| `virtiofsd.ts`  | Spawns `virtiofsd` for host-guest filesystem sharing via virtio-fs                                   |

**Firecracker process model today (single-host only):**

```
superfield ci run --vm
  │
  ├── provisionFirecracker()     — download/cache binary + kernel
  ├── startFirecrackerProcess()  — spawn firecracker --api-sock <path>
  ├── FirecrackerApi             — configure over Unix socket
  │     putBootSource / putDrive / putMachineConfig / startInstance
  ├── buildVmSnapshot()          — pause VM → snapshot to .vmstate + .mem files
  └── restoreVm()                — load snapshot + optionally start virtiofsd
```

Each VM instance is identified by its Unix socket path (auto-generated:
`/tmp/superfield-fc-<timestamp>.sock`). There is no persistent VM registry —
each `restoreVm()` call spawns a fresh Firecracker process and restores the
snapshot. `kill()` sends SIGTERM to the process.

**No multi-host scheduling exists today.** The control plane is entirely
single-host: spawn a process, talk to it on a local Unix socket. There is no
daemon, no job queue, no inter-host routing, and no VM-ID registry.

### 2. `packages/cli/lib/fastenv.ts` — containerd workspace forking shim

| Function          | Responsibility                                                    |
| ----------------- | ----------------------------------------------------------------- |
| `forkWorkspace()` | `fastenv fork --base <image> --name <id>` — COW overlayfs fork   |
| `getForkMountPath()` | `fastenv mount-path <id>` — returns host overlayfs merged path |
| `discardFork()`   | `fastenv discard <id>` — best-effort cleanup; never throws        |

The shim delegates entirely to the `fastenv` binary
([superfield-ai/fastenv](https://github.com/superfield-ai/fastenv)). The CLI
has no visibility into containerd internals — it issues subcommands and reads
stdout. This means:

- There is no daemon-level control plane from the CLI side. fastenv manages the
  containerd snapshot lifecycle internally.
- The fork identity (`forkId`) is chosen by the caller (a random hex string in
  `ci.ts`). fastenv owns the namespace for fork IDs.
- There is no registry of active forks. If the caller exits without calling
  `discardFork()`, the overlayfs layer persists until manual cleanup or fastenv
  garbage collection.

### 3. `packages/cli/commands/ci.ts` — `superfield ci` command

The `ci` command is the current user-facing surface for FastEnv. It wires
`forkWorkspace` / `getForkMountPath` / `discardFork` together with
`restoreVm` for snapshot-based CI runs. The workspace forking path is
**staged**: the code exists and the flag is accepted, but the comment in
`ciCommand` marks it as pending the fastenv binary shipping:

```typescript
// prepareFastenvWorkspace + restoreVm integration wired in once
// the workflow parser (#241) is available and the fastenv binary ships.
console.log(`[ci] workspace forking via fastenv is staged — binary not yet available`);
```

---

## eBPF Monitoring and crun — Current Status

**eBPF monitoring: not yet implemented.**

A search of all TypeScript source files, documentation, and configuration in
this repository finds zero references to eBPF, `bpf`, or crun. The architecture
document does not specify an eBPF monitoring surface. Issue #384 is the planned
implementation work.

**crun: not present.**

There are no crun references in the repository. The Firecracker integration uses
the standard Firecracker process model (kernel + rootfs + snapshot), not OCI
container runtimes. The fastenv shim talks to containerd via the `fastenv` binary,
not via a crun binary directly.

**What exists instead:**

- Firecracker provides VM-level isolation (hardware virtualization boundary).
- containerd/overlayfs provides the filesystem snapshot layer.
- virtiofsd provides host-guest filesystem sharing.
- No in-process observability hooks exist. Stderr from the Firecracker process
  is logged to `process.stderr` (prefixed `[firecracker]`) but not captured or
  structured.

**What issue #384 must provide:**

- A concrete definition of "host-side eBPF monitoring" for this architecture.
  Given Firecracker VMs are the isolation primitive (not OCI containers), eBPF
  hooks would attach to the host kernel to observe VM-level syscalls, network
  events, or cgroup activity — not to a container runtime.
- Clarification of whether "crun" refers to the OCI container runtime
  (`containers/crun`) or is a naming convention for something else. If it
  refers to `containers/crun`, the integration point is the `fastenv` binary's
  container execution backend, not the CLI code.

---

## Where Multi-Host Fits

The current single-host control plane has three natural extension seams for
multi-host scheduling:

| Seam | Location | What changes for multi-host |
| ---- | -------- | --------------------------- |
| VM dispatch | `packages/firecracker/vm.ts` — `buildVmSnapshot()` / `restoreVm()` | Currently calls `spawn()` directly on the local process. Multi-host would replace `spawn()` with a remote dispatch call (SSH, gRPC, or HTTP API on the target host). |
| Workspace fork | `packages/cli/lib/fastenv.ts` — `forkWorkspace()` | Currently calls `fastenv fork` locally. Multi-host would need fastenv running on the target host and a way to reference it. |
| Job identity | `packages/cli/commands/ci.ts` — random `forkId` per run | No job registry exists. Multi-host scheduling needs a durable job ID namespace and status store. |

**Recommended multi-host seam location:** a `DispatchTarget` interface wrapping
`spawn()` + `execFileAsync()` in `vm.ts` and `fastenv.ts`. The default
implementation is local-process dispatch; a remote implementation would talk to
a host agent over a controlled channel.

---

## Substrate Reliability — Current Objectives

### PRD requirements (from `docs/prd.md`)

The PRD states two reliability requirements:

> **Reliability:** the brain meets enterprise expectations for availability,
> recoverability, and auditability of every change.

> **Reliability.** The brain must meet enterprise expectations for availability,
> backup, and recovery, befitting a system of record a large business depends on.

No numeric SLO, RTO, or RPO targets appear anywhere in the current documentation.

### Architecture — single Postgres instance constraint

The architecture document mandates one Postgres instance with namespaced
schemas (decision recorded in `docs/architecture.md § Single-Instance Database
Schema Layout`). This concentrates all substrate state — Sharp, Nexum, auth,
and episodes schemas — in a single process.

**Implications for reliability:**

- A single-instance layout eliminates synchronous replication complexity but
  makes the substrate a single point of failure.
- There is no standby, no streaming replication configuration, and no backup
  procedure anywhere in the repository today.
- The CLI K8s templates provision a `StatefulSet` with a 20 Gi `local-path`
  PVC. `local-path` is node-local storage — it does not survive node failure.

### What issue #385 must define

Before issue #385 can be implemented, the following objectives must be stated
and accepted:

| Objective | Current state | Target (to be defined in #385) |
| --------- | ------------- | ----------------------------- |
| **RPO** (Recovery Point Objective) | Undefined | e.g. ≤ 5 minutes |
| **RTO** (Recovery Time Objective) | Undefined | e.g. ≤ 15 minutes |
| **Standby lag** | None — no standby | e.g. ≤ 30 s streaming replication lag |
| **Backup frequency** | None | e.g. daily snapshot + WAL archiving |
| **Restore smoke test** | None | e.g. weekly automated restore verification |

---

## Integration Points Discovered

| Point | Location | Notes |
| ----- | -------- | ----- |
| `spawn()` call in VM lifecycle | `packages/firecracker/vm.ts:startFirecrackerProcess()` | Single-host dispatch seam. Multi-host dispatch replaces this. |
| `execFileAsync` call for fastenv | `packages/cli/lib/fastenv.ts:forkWorkspace()` and peers | Single-host workspace fork seam. |
| Random `forkId` generation | `packages/cli/commands/ci.ts:prepareFastenvWorkspace()` | No persistence — job identity is ephemeral. Multi-host needs durable job IDs. |
| `local-path` PVC in K8s template | `packages/core/templates/k8s/postgres.yaml.tpl` | Node-local storage; does not survive node failure. Replacement needed for reliable substrate. |
| No eBPF hooks | Entire codebase | Zero eBPF/bpf/crun surface exists. #384 starts from scratch. |
| No backup procedure | Entire codebase | Zero pg_dump, WAL archiving, or pgBackRest configuration exists. #385 starts from scratch. |

---

## Risks

| Risk | Severity | Details |
| ---- | -------- | ------- |
| **No job registry** | High | FastEnv forks and VMs have no persistent identity store. A host crash loses all active job state. Multi-host scheduling requires durable job IDs before any dispatch can be retried. |
| **virtiofsd not on $PATH** | Medium | Confirmed in scout #281: virtiofsd is only available at `/snap/lxd/38800/bin/virtiofsd` on the self-hosted runner. Any multi-host node must also have virtiofsd provisioned. |
| **local-path PVC** | High | Node-local Postgres storage does not survive node failure. Must be replaced with network-attached or replicated storage before reliability objectives can be met. |
| **No numeric reliability targets** | High | PRD says "enterprise expectations" but defines no RPO/RTO. Without concrete targets, #385 cannot be accepted. Scout recommends defining RPO ≤ 5 min / RTO ≤ 15 min as a starting point. |
| **eBPF surface undefined** | Medium | The architecture document does not specify what eBPF events are expected or how they will be consumed. #384 must define this before implementation begins. |
| **fastenv binary not yet shipped** | Medium | The workspace forking path in `ci.ts` is explicitly marked as staged pending the fastenv binary. Multi-host scheduling cannot be tested without this binary being available on all target hosts. |
| **crun definition unclear** | Medium | "Promote crun from stub to real" in #384 is ambiguous. If it means `containers/crun` as a replacement for runc in fastenv's containerd configuration, that is an internal fastenv concern, not a CLI concern. Clarification needed before #384 begins. |

---

## Downstream Issues — Findings

### #384 — eBPF monitoring and crun

- There is no existing eBPF or crun code in this repository. The feature starts
  from zero.
- The natural host-side eBPF attachment point for Firecracker VMs is the host
  kernel's `kprobe`/`tracepoint` infrastructure, not a container runtime shim.
  Consider `bpftrace` or `libbpf` for the monitoring agent on the host.
- If "crun" is `containers/crun` as the OCI runtime inside fastenv, the
  integration point is the fastenv binary's configuration, not the CLI TypeScript
  code.
- Key stub seam to define: an `EbpfMonitor` interface (or equivalent) that the
  CI runner can call to attach/detach monitoring for a given VM ID.

### #385 — substrate replication, backup, and recovery

- There is no existing backup, WAL archiving, or replication configuration
  anywhere in the repository.
- The K8s `postgres.yaml.tpl` uses `local-path` storage — this must be replaced
  before replication or backup makes sense.
- The first deliverable for #385 should be defining and documenting RPO/RTO
  targets, then choosing an implementation (streaming replication via `pg_basebackup`
  + WAL archiving, or a managed service backup API).
- Key stub seam to define: a `SubstrateBackup` interface (or equivalent) that
  records backup completion events into the `episodes` schema.

---

## Canonical Docs References

- `docs/architecture.md` — single-instance Postgres decision, gaps table
- `docs/prd.md` — reliability requirements (§ Reliability)
- `docs/plan.md` — Phase D-3 (FastEnv), issues #384, #385
- `docs/roadmap.md` — Track D, Phase D-3
- `docs/scout/281-oci-firecracker-toolchain.md` — toolchain availability matrix, virtiofsd situation
- `packages/firecracker/vm.ts` — VM lifecycle, single-host dispatch seam
- `packages/firecracker/provision.ts` — binary/kernel provisioning
- `packages/firecracker/virtiofsd.ts` — virtiofsd host-guest filesystem bridge
- `packages/cli/lib/fastenv.ts` — fastenv binary shim
- `packages/cli/commands/ci.ts` — `superfield ci` command surface
- `packages/core/templates/k8s/postgres.yaml.tpl` — local-path PVC (single point of failure)
