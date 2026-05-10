# Scout: OCI/containerd and Firecracker Toolchain Availability

**Issue:** #281
**Phase:** OCI workspace infrastructure
**Feeds:** #261 (OCI snapshot forking), #254 (local CI runner / Firecracker VM)

---

## Toolchain Availability Matrix

| Component | Dev (self-hosted) | CI (self-hosted runner) | Notes |
|---|---|---|---|
| containerd | ✅ v2.2.1 (`containerd.io`) | ✅ same runner | `dea7da59` |
| overlayfs snapshotter | ✅ active (default) | ✅ same runner | Docker also reports `overlayfs` driver type `io.containerd.snapshotter.v1` |
| `/dev/kvm` | ✅ present | ✅ same runner | Self-hosted runner on bare metal / KVM-capable host |
| virtiofsd | ⚠️ via snap/lxd only | ⚠️ via snap/lxd only | `v1.11.1` at `/snap/lxd/38800/bin/virtiofsd` — not on `$PATH` |
| Firecracker binary | ⚠️ not pre-installed | ⚠️ not pre-installed | v1.12.0 available via GitHub Releases; must be downloaded at runtime |

### Containerd overlay snapshotter confirmation

```
containerd containerd.io v2.2.1 dea7da592f5d1d2b7755e3a161be07f43fad8f75
Storage Driver: overlayfs
  driver-type: io.containerd.snapshotter.v1
Kernel: 5.15.0-173-generic (supports overlay in user namespaces)
```

Default snapshotter is `overlayfs` per `containerd config dump`:
```toml
snapshotter = 'overlayfs'
```

### Firecracker verification

Downloaded `firecracker-v1.12.0-x86_64.tgz` from GitHub Releases, verified:
```
Firecracker v1.12.0
2026-05-10T01:15:28 [main] Firecracker exiting successfully. exit_code=0
```

Binary size: 7.0 MB compressed. Must be downloaded during CI setup or bundled separately.

### virtiofsd situation

- **Not available as a standalone system package** on the runner OS (Ubuntu 22.04-based).
- `apt-cache show virtiofsd` returns nothing (not in default apt sources).
- `virtiofsd v1.11.1` exists inside the snap-managed LXD installation at `/snap/lxd/38800/bin/virtiofsd` but is not accessible from outside the snap sandbox without special configuration.
- **Mitigation options** (for #254):
  1. Build from source: `cargo install virtiofsd` (Rust toolchain required; ~5-10 min build)
  2. Use the QEMU-bundled `virtiofsd` (slower, legacy C implementation)
  3. Use `9p` filesystem passthrough in place of `virtiofsd` (lower performance)
  4. Pin a specific LXD snap version and call the binary directly (fragile)
  5. Ship a pre-built `virtiofsd` binary as a CI artifact alongside Firecracker

Recommended: option 5 — bundle `virtiofsd` static binary in CI setup the same way as Firecracker.

---

## Baseline containerd Snapshot Fork Latency

Measured via `docker create` / `docker rm` cycle on `alpine:3.20` (n=10 runs).
`docker create` triggers the containerd overlayfs snapshot fork path directly.

| Metric | Value |
|---|---|
| p50 | 196 ms |
| p95 | 208 ms |
| min | 179 ms |
| max | 221 ms |

Raw timings (ms): 221, 197, 196, 208, 204, 180, 199, 188, 179, 191

**Context:** This is full container create latency (containerd RPC + snapshot create +
OCI spec write). The pure snapshot fork component is a subset — estimated 50-100 ms
based on typical containerd profiling data. For #261 the target is <200 ms per fork
including metadata, so the current baseline suggests the snapshotter alone will fit
within budget.

---

## Integration Points and Risks for #261 and #254

### For #261 (OCI snapshot forking)

**Integration points:**
- containerd Go client: `github.com/containerd/containerd` (use `v2.x` matching server `v2.2.1`)
- Snapshotter API: `client.SnapshotService("overlayfs")`
- Methods: `Prepare(ctx, key, parent, ...Opt)`, `Stat(ctx, key)`, `Remove(ctx, key)`
- containerd socket: `/run/containerd/containerd.sock` (group `root:root 0660` — requires root or group membership in CI)

**Risks:**
- Socket permission: the containerd socket requires `root` or membership in the `containerd` group. CI jobs run as `runner` user. Need `usermod -aG containerd runner` or `sudo` wrapper.
- overlayfs in user namespaces: kernel 5.15 supports this but requires `CONFIG_USER_NS=y` and `CONFIG_OVERLAY_FS=y` — both confirmed present on this kernel.
- `v2` API break: containerd `v2.2.1` server requires the `v2` Go client import path (`github.com/containerd/containerd/v2`). Do not use the `v1` client.

### For #254 (Firecracker local CI runner)

**Integration points:**
- Firecracker API: Unix socket at a path chosen at runtime (e.g. `/tmp/firecracker-<id>.sock`), HTTP-over-Unix API
- Firecracker binary: must be downloaded and placed on `$PATH` or referenced by absolute path. No system package available.
- `virtiofsd`: required for shared filesystem between host and VM. Must be provisioned separately (see mitigation options above).
- `/dev/kvm`: confirmed available. Group ownership is `kvm` — CI runner needs `usermod -aG kvm runner`.

**Risks:**
- virtiofsd is a hard dependency for host-VM filesystem sharing. If not resolved before #254 starts, the feature cannot be tested end-to-end. **Flag: resolve virtiofsd provisioning strategy before #254 begins.**
- Firecracker static binary download in CI adds ~7 MB to setup time. Cache in a CI artifact or pre-bake into the runner image.
- Firecracker requires a rootfs image. Creating a minimal rootfs for CI is out of scope for #254 alone — needs a separate setup step or a pre-baked image stored in a registry.

---

## Recommended CI Setup Steps (before #261 and #254 can land)

```bash
# 1. Add runner to containerd group
sudo usermod -aG containerd $USER

# 2. Add runner to kvm group
sudo usermod -aG kvm $USER

# 3. Download Firecracker (in CI workflow setup step)
FC_VERSION=v1.12.0
ARCH=$(uname -m)
curl -sL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz" \
  | tar xz --strip-components=1 -C /usr/local/bin \
  --wildcards "*/firecracker-${FC_VERSION}-${ARCH}"
chmod +x /usr/local/bin/firecracker

# 4. Provision virtiofsd (recommended: pre-built binary, TBD in #254)
```

---

## References

- containerd overlayfs snapshotter docs: https://github.com/containerd/containerd/blob/main/docs/snapshotters/overlayfs.md
- Firecracker releases: https://github.com/firecracker-microvm/firecracker/releases
- virtiofsd: https://gitlab.com/virtio-fs/virtiofsd
- `docs/prd.md`, `docs/plan.md` (canonical product requirements)
