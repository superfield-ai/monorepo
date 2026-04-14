# GCP Deploy Target — Technical Design

## Overview

This document covers the design for adding a `gcp` deploy target to the `superfield deploy` command. The goal is to move GCP provisioning and deployment concerns out of individual app repos (e.g. `calypso-starter-ts/scripts/gcp/`) and into the superfield CLI where they belong.

## Motivation

GCP infrastructure management (OAuth login, IAM doctor checks, VPC provisioning, AlloyDB, Compute VMs) is not a concern of a superfield application. Currently each app repo carries its own copy of these scripts. The CLI is the right owner: it is versioned independently of app code, can be shared across projects, and fits naturally alongside the existing `superfield deploy demo` command.

## CLI Surface

The `deploy` command accepts a positional `[target]` and an optional `--provision` flag, mirroring the existing `demo` target:

```
superfield deploy gcp [--provision] [options]
```

| Invocation | Behaviour |
|---|---|
| `superfield deploy gcp --provision` | Auth (if needed) + doctor + provisions GCP resources only |
| `superfield deploy gcp` | Auth (if needed) + doctor + provision + deploy |
| `superfield deploy gcp --login` | Force re-authentication (replaces stored token) |
| `superfield deploy gcp --logout` | Remove stored credential and exit |

`packages/cli/commands/deploy.ts` dispatches on `target === "gcp"` and delegates to `packages/core/gcp/`. Existing `demo` behaviour is unchanged.

### Provision phase (`--provision`)

Runs doctor pre-flight, then creates all GCP resources idempotently (safe to re-run):

1. VPC network
2. Subnet (with secondary ranges for pods/services)
3. SSH firewall rule (port 22)
4. App firewall rule (port 31415)
5. PSA (Private Service Access) global address + VPC peering for AlloyDB
6. AlloyDB cluster + primary instance
7. Compute Engine VM (with startup script `init-host.sh` or `init-host-talos.sh`)

Each resource is checked for existence before creation. Long-running operations are polled until `DONE`.

### Deploy phase (default)

Runs the provision phase first, then:

1. Verifies VM is `RUNNING` and has an external IP
2. Verifies AlloyDB cluster and instance are `READY`
3. Establishes an SSH tunnel to port 6443 (k3s API) **or** uses `talosctl kubeconfig` (`--talos-mode`)
4. Creates a short-lived deploy token via `kubectl create token`
5. Builds a minimal kubeconfig pointing at `https://localhost:6443`
6. Runs liveness checks (namespace, secrets, deployment rollout status)
7. Optionally checks `/health` HTTP endpoint on port 31415
8. Runs `./deploy.sh <image-tag>` with kubeconfig injected via `KUBECONFIG` env var
9. Annotates the deployment with actor, run ID, and image tag when running in GitHub Actions

### Authentication

Authentication happens automatically the first time `superfield deploy gcp` is run and no credential is found in the resolution chain. The **device-code flow (RFC 8628) is the default**: the CLI prints a short URL and a code; the user visits the URL in any browser (on any machine) and enters the code. No localhost callback server is required and no port needs to be reachable from outside the instance.

```
Visit https://www.google.com/device  and enter code: ABCD-1234
Waiting for authorization...
```

Once authorized, the token is written to `~/.config/superfield/gcp-oauth-token.json` and auto-refreshed on subsequent runs.

- `--login`: Force re-authentication even if a valid token already exists. Replaces the stored token.
- `--logout`: Delete the stored token file and exit without doing anything else.

If a non-OAuth credential is present (service account key, `GCP_ACCESS_TOKEN`) the OAuth flow is skipped entirely.

> The localhost-callback (PKCE) flow is not supported because the CLI runs on a remote instance — Google's redirect would land on `http://127.0.0.1:<port>` on the instance, not the user's machine.

## Module Layout

```
packages/core/gcp/
  index.ts           re-exports public API
  auth.ts            credential resolution chain, access token fetch, token file refresh
  login.ts           browser OAuth flow + device-code flow
  doctor.ts          IAM and API pre-flight checks
  provision.ts       idempotent resource creation
  deploy.ts          deploy pipeline (SSH tunnel or Talos path)
  operations.ts      GCP long-running operation polling
  ssh.ts             SSH auth material helpers, tunnel management
  http.ts            googleJsonRequest with optional record/replay fixture support
  types.ts           shared GCP response interfaces
```

## Credential Resolution

Resolved in order (first match wins):

| Priority | Source |
|---|---|
| 1 | `GCP_ACCESS_TOKEN` env var (raw token) |
| 2 | `GCP_OAUTH_TOKEN_FILE` (default: `~/.config/superfield/gcp-oauth-token.json`) |
| 3 | `GCP_SERVICE_ACCOUNT_JSON` (inline JSON) |
| 4 | `GOOGLE_APPLICATION_CREDENTIALS` (file path) |
| 5 | `GCP_SERVICE_ACCOUNT_FILE` (file path) |
| 6 | `GCP_SERVICE_ACCOUNT_KEY_JSON` (inline JSON, alternate name) |
| 7 | `GCP_SERVICE_ACCOUNT_KEY_FILE` (file path, alternate name) |

OAuth token files are auto-refreshed when the access token is expired and a refresh token is present.

## Injectable Dependencies

Following the existing `DeployCommandDeps` pattern, GCP modules accept a deps object rather than importing side-effectful operations directly. This enables unit and integration testing without real GCP API calls.

```typescript
interface GcpDeps {
  googleRequest: <T>(url: string, init?: RequestInit) => Promise<T>;
  getAccessToken: () => Promise<string>;
  log: (msg: string) => void;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
}
```

## Testing

### Unit tests

Deps are replaced with in-memory stubs. No network calls, no filesystem side effects.

### HTTP replay fixtures

The existing `scripts/gcp/` implementation has a record/replay mechanism: when `GCP_HTTP_FIXTURE_DIR` is set, requests are recorded on first run and replayed on subsequent runs. This fixture directory (`scripts/gcp/fixtures/`) is copied into `packages/core/gcp/fixtures/` and used in integration tests.

### Integration tests

Tests inject the replay transport as `googleRequest`. Full provision and deploy flows are exercised against fixture data, verifying the correct sequence of API calls, resource creation checks, and operation polling.

## Environment Variables

| Variable | Description |
|---|---|
| `GCP_PROJECT_ID` | GCP project ID |
| `GCP_REGION` | GCP region (e.g. `us-central1`) |
| `GCP_ZONE` | GCP zone (e.g. `us-central1-a`) |
| `CALYPSO_ENV` | Deployment environment name |
| `GCP_VM_NAME` | Compute Engine VM instance name |
| `GCP_ALLOYDB_CLUSTER` | AlloyDB cluster name |
| `GCP_ALLOYDB_INSTANCE` | AlloyDB instance name |
| `CALYPSO_IMAGE_TAG` | Docker image tag to deploy |
| `GCP_ACCESS_TOKEN` | Raw access token (credential source 1) |
| `GCP_OAUTH_TOKEN_FILE` | Path to OAuth token JSON file |
| `GCP_SERVICE_ACCOUNT_JSON` | Inline service account key JSON |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account key file |
| `CALYPSO_TALOS_MODE` | Use Talos kubeconfig path instead of SSH tunnel |
| `CALYPSO_SKIP_HTTP_CHECK` | Skip pre-deploy `/health` HTTP check |
| `CALYPSO_SSH_PRIVATE_KEY_FILE` | Path to SSH private key (if no SSH agent) |
| `GCP_HTTP_FIXTURE_DIR` | Directory for HTTP record/replay fixtures |
| `GITHUB_ACTOR` | Set by GitHub Actions; used for deploy annotation |
| `GITHUB_RUN_ID` | Set by GitHub Actions; used for deploy annotation |

## Open Questions

- **Network name convention**: currently hardcoded in provision scripts. Should the CLI accept `--network` or derive from `--environment`?
- **Talos vs k3s**: both paths are supported. Should one become the default, or remain behind a flag?
- **Token storage path**: `~/.config/superfield/` vs `~/.config/calypso/`. Migrate on first login or support both?
- **`deploy.sh` location**: currently expected at repo root. Should the CLI embed a default deploy script, or keep the convention of a user-supplied script?
