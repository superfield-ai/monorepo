# Studio Container Sandbox

The container sandbox provides physical network isolation for Claude's agent
runtime. Even if the logical permission sandbox (#25) is misconfigured, the
container's network namespace guarantees no unauthorized egress.

## Architecture

```
                   Host
+------------------+--------------------+
|  Sandbox         |  Shared Volume     |
|  Container       |  /studio/          |
|  (--network none)|  build-output/     |
|                  |                    |
|  Claude Agent    |  image.tar  ------>  k8s cluster
|  Source code     |  (tarball)         |  (watches volume)
|  Build tools     |                    |
+------------------+--------------------+
         |
         | iptables: ALLOW only
         v
    api.anthropic.com:443
```

## Network isolation

### iptables rules

The container starts with `--network none` and `--cap-add NET_ADMIN`. On
startup, iptables rules are injected that:

1. Set the default OUTPUT policy to DROP.
2. Allow loopback traffic.
3. Allow established/related return traffic.
4. Allow DNS queries to localhost only (restricted resolver).
5. Allow HTTPS (port 443) to Anthropic API IPs (resolved at start time).
6. Drop all other outbound traffic.

### DNS restriction

A dnsmasq configuration is injected that:

- Resolves `api.anthropic.com` via upstream DNS.
- Returns NXDOMAIN for all other domain queries.

This prevents DNS-based exfiltration and ensures only the Anthropic API
endpoint is reachable by name.

### What is blocked

| Target | Status |
| --- | --- |
| Anthropic API (api.anthropic.com:443) | Allowed |
| Any other external host | Blocked |
| k8s API server | Blocked |
| Cluster-internal services | Blocked |
| DNS for non-Anthropic domains | Blocked (NXDOMAIN) |

## Shared volume image handoff

Built images are never pushed to a registry. Instead:

1. A build runs inside the sandbox using the existing `Dockerfile.release`.
2. The resulting image is exported as a tarball via `docker save`.
3. The tarball is written to the shared volume at `/studio/build-output/`.
4. The host or k8s watcher picks up the tarball and loads it.

This keeps the blast radius minimal - the sandbox container never initiates
a network connection to any registry.

## Container configuration

| Setting | Value | Purpose |
| --- | --- | --- |
| `--network` | `none` | No default network access |
| `--cap-add` | `NET_ADMIN` | Required for iptables |
| `--cap-drop` | `ALL` | Drop all other capabilities |
| `--security-opt` | `no-new-privileges` | Prevent privilege escalation |
| `--label` | `app=calypso-studio-sandbox` | Container identification |
| `-v` (source) | `<worktree>:/studio/src:rw` | Source code access |
| `-v` (output) | `<buildDir>:/studio/build-output:rw` | Image handoff volume |

## Session lifecycle integration

The sandbox lifecycle is driven by session lifecycle hooks (#28):

- **Session start**: `startSandbox()` creates the isolated container.
- **Session teardown**: `stopSandbox()` gracefully stops and removes it.
- **Crash recovery**: `cleanupOrphanedSandboxes()` finds and removes
  containers with the `calypso-studio-sandbox` label.
- **Status check**: `isSandboxRunning()` queries the container state.

### Container naming

Container names are deterministic: `studio-sandbox-<sessionId>`. This makes
them trivially discoverable and prevents naming collisions between sessions.

## Integration with Dockerfile.release

The sandbox uses the same `calypso-release:studio` image that the existing
build pipeline produces. The `buildAndExportImage()` function runs the build
inside the sandbox and exports the tarball to the shared volume, maintaining
the isomorphic deployment guarantee from #21.

## Files

| File | Purpose |
| --- | --- |
| `packages/core/container-sandbox.ts` | Sandbox lifecycle, network rules, image export |
| `packages/core/tests/container-sandbox.test.ts` | Unit tests for sandbox operations |
| `docs/studio-container-sandbox.md` | This document |
