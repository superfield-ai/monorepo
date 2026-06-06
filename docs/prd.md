# Superfield Control Room — Product Requirements

## Overview

The **Superfield Control Room** is a rename and expansion of `./studio`. It is a standalone
Bun executable (separate from the Calypso application server) that imports shared components
from the superfield toolchain. Its purpose is to give operators a single interface for
understanding and controlling every dimension of a Superfield project: the software being
built, the agents building it, and the environments it runs in.

Studio (the existing two-panel Claude chat + app iframe) becomes one view inside the
Control Room rather than the whole product.

---

## Goals

- Unify project development visibility (agents, git, GitHub, docs) and deployment visibility
  (cluster health, running instances, API admin) in one local web app.
- Replace `bun run studio` with `bun run control-room` (or a named binary) that boots the
  same server but with the expanded UI.
- Keep the footprint small: no new infrastructure, no assumed cloud credentials. Credentials
  are supplied explicitly by the operator and stored locally in the Control Room config.

---

## Views

### 1. Project View

Focuses on the software being built and the agents building it. Contains three panels that
can be shown together or independently.

#### 1a. Studio Panel (existing, promoted to sub-view)

The current two-panel layout (Claude chat sidebar + Calypso app iframe) lives here
unchanged. Provides:

- Live chat with a Claude agent session (SSE stream via `/studio/chat/stream`)
- Cluster status indicator (healthy / restarting / degraded / unknown)
- Embedded iframe of the running Calypso web app

#### 1b. Repository Panel

Near-realtime read-out of the repository state:

- **Git status** — current branch, working-tree dirty/clean, ahead/behind remote
- **Recent commits** — author, message, timestamp, SHA; link to GitHub commit page
- **GitHub Issues** — open issues from the linked repo; filter by label/milestone
- **GitHub Actions** — status of recent workflow runs (pass / fail / in progress); link
  to run detail
- **Markdown editor** — view and edit any `.md` file in the repo (PRD, PLAN, CLAUDE.md,
  blueprint docs). Changes saved as local edits; operator can commit via the UI.

#### 1c. Agent Supervisor Panel

Shows the progress of all Superfield agent processes:

- **Developer agents** — one card per active `calypso-auto` / `calypso-develop` worker:
  issue number, branch, current step, last log line, link to PR
- **Documentation agents** — doc-generation runs (status, last run time, output path)
- **Cron / audit agents** — scheduled code-audit jobs: next scheduled time, last result,
  log tail
- Each card shows a live log tail (SSE or polling) and a stop/restart control

---

### 2. Instances View

Focuses on running deployments of the Calypso application.

#### 2a. Deployment List

A row per environment (demo, staging, production, or any custom name):

- Environment name and URL
- Cluster health status (mirrors ClusterStatusIndicator, one per deployment)
- Last deploy timestamp and git SHA

#### 2b. Cluster Health Detail

Drill-down for a selected deployment:

- Pod / service status (k3s or equivalent)
- Recent restart events
- Resource utilisation (CPU, memory) if the cluster exposes metrics

#### 2c. API Console

Operator-supplied API credentials (stored in local Control Room config, never assumed)
unlock an in-browser API explorer for each deployment:

- Select a deployment → pick an API endpoint from the OpenAPI spec
- Execute requests authenticated with the stored credentials
- View response body, status, and latency
- Consolidates admin actions (e.g. triggering seeds, inspecting queue state) that would
  otherwise require `curl` + token management

---

## Architecture

### Executable

```
bun run control-room          # replaces: bun run studio
```

Entry point: `studio/scripts/control-room-start.ts` (rename of `studio-start.ts`).
Reuses existing prerequisites check, k3s apply, and server startup logic.

### Server

`studio/apps/server` extended with new route namespaces:

| Path prefix            | Handler                                      |
|------------------------|----------------------------------------------|
| `/studio/chat/stream`  | Existing Claude SSE stream (unchanged)       |
| `/studio/cluster/*`    | Existing cluster events SSE (unchanged)      |
| `/repo/*`              | New: git status, commits, GitHub API proxy   |
| `/agents/*`            | New: agent process registry and log streams  |
| `/instances/*`         | New: deployment registry and health checks   |
| `/api-console/*`       | New: credentialed proxy to deployment APIs   |
| `/app/*`               | Existing reverse-proxy to web ClusterIP      |
| `/api/*`               | Existing reverse-proxy to API ClusterIP      |
| `/*`                   | Existing static asset serving                |

GitHub API calls are made server-side using a stored GitHub token so the browser never
holds it directly.

Deployment credentials (API keys for demo/stage/prod) are stored in a local config file
(e.g. `~/.superfield/control-room.json`) loaded at server startup. The API console proxy
attaches the relevant credential to outbound requests; credentials are never sent to the
browser.

### Web UI

`studio/apps/web` extended with a top-level navigation shell:

```
┌─────────────────────────────────────────────────────┐
│  [Project]  [Instances]                   ● cluster │
├──────────────────────────────────────────────────────┤
│                                                      │
│  (selected view renders here)                        │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Project** tab contains three sub-panels (Studio, Repository, Agent Supervisor) in a
resizable split layout. **Instances** tab shows the deployment list with drill-down.

Existing components (`StudioPanel`, `ChatPanel`, `IframePanel`, `ClusterStatusIndicator`,
`OAuthPanel`) are reused without modification.

---

## Credentials and Security

- Control Room runs **locally** (localhost, not deployed). All credential storage is on
  the operator's machine.
- GitHub token: read access to the repo (issues, actions, commits). Stored in local config.
- Deployment API keys: per-environment, operator-supplied. Used only as an outbound proxy
  header by the Control Room server. Never sent to the browser.
- No privilege is assumed. If a credential is absent, the corresponding panel shows a
  prompt to supply it rather than failing silently.

---

## Out of Scope (v1)

- Multi-user / shared hosted deployment of Control Room
- Write access to GitHub (creating issues, closing PRs) from the UI — read-only for now
- Agent start/stop controls that go beyond sending SIGTERM to a local process
- Mobile layout
