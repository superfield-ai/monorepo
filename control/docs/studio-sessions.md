# Studio Sessions

Studio sessions provide isolated git worktrees so users can explore changes
without affecting the product repo's main branch. Each session gets its own
worktree forked from the current main HEAD.

## Session lifecycle

### Start

1. Resolve the product repo's current main HEAD hash.
2. Generate a 4-character session ID (alphanumeric).
3. Create a git worktree on branch `studio/session-<mainHash>-<sessionId>`.
4. Boot the cluster with the worktree as the product source directory.

The user sees an empty chat with their product running. Main is never modified.

### Restart

1. Tear down the running cluster.
2. Delete the old worktree and its branch.
3. Get the latest main HEAD hash (may have advanced).
4. Generate a new session ID.
5. Create a fresh worktree from the new main HEAD.
6. Boot the cluster against the new worktree.
7. Clear chat state on the client.

Restart is the user-facing "Start Over" action. It guarantees a clean slate
from the latest main.

### Teardown

1. Tear down the cluster.
2. Delete the worktree and branch.
3. Verify the worktree directory is removed from disk.

## Branch naming

Session branches follow the convention:

```
studio/session-<mainHash>-<sessionId>
```

- `mainHash`: the full or abbreviated commit hash of main at fork time.
- `sessionId`: a 4-character lowercase alphanumeric string (`[a-z0-9]{4}`).

Examples:
- `studio/session-abc123-x1y2`
- `studio/session-0ef4b54-k9m3`

The branch name is deterministic given the hash and session ID, which makes
concurrent sessions trivially distinct.

## Worktree storage

Worktrees are stored in a base directory (default: `<sourceDir>/../studio-worktrees/`).
Each worktree lives in a subdirectory named after the branch with slashes
replaced by dashes:

```
studio-worktrees/
  studio-session-abc123-x1y2/
  studio-session-abc123-k9m3/
```

The base directory is configurable via `worktreeBaseDir` in the session
start options.

## Concurrent sessions

Multiple sessions can run concurrently because:

- Each session has a unique session ID and therefore a unique branch name.
- Each session gets its own worktree directory on disk.
- Git worktrees use per-worktree lock files, not a global lock.
- Each session's cluster config points to its own worktree path.

## Isolation guarantees

- **Main branch is never modified.** Worktrees are created from main HEAD
  but all commits happen on the session branch.
- **Worktree is fully removed on teardown.** The directory is deleted and
  the branch is cleaned up.
- **Cluster state is scoped to the session.** The cluster config's `sourceDir`
  points to the session worktree.

## Checkpoint commits and timeline

After Claude completes a Design mode edit, studio automatically creates a
**checkpoint commit** on the session branch. Each checkpoint contains:

- A plain-language summary of the change (no technical jargon).
- An ISO 8601 timestamp.
- The abbreviated commit hash.

### Checkpoint creation

1. After the agent turn completes, check for uncommitted changes.
2. If no changes exist, skip — no checkpoint is created.
3. Stage all changes with `git add -A`.
4. Commit with a plain-language summary extracted from the agent's reply.

### Timeline view

The timeline is a linear, chronological list of all checkpoints in the current
session. It is exposed via:

- `GET /studio/timeline` — returns `{ timeline: CheckpointEntry[] }`
- `GET /studio/status` — includes `timeline` in the response
- `POST /studio/chat` — includes updated `timeline` after each turn
- `POST /studio/rollback` — includes updated `timeline` after rollback

Each `CheckpointEntry` has: `hash`, `summary` (or `message`), and `timestamp`.

### Rollback

Clicking a previous checkpoint in the timeline rolls the worktree back to that
commit and discards all subsequent commits (`git reset --hard`). The timeline
updates to reflect the new HEAD.

### Linear-only

The timeline is strictly linear — no branches or forks within a single session.
All commits are sequential on the session branch.

## Files

| File | Purpose |
| --- | --- |
| `packages/core/studio-session.ts` | Session ID generation, branch naming, parsing |
| `packages/core/worktree-manager.ts` | Git worktree create/delete/list operations |
| `packages/core/session-lifecycle.ts` | Session start/restart/teardown orchestration |
| `packages/core/checkpoint-manager.ts` | Checkpoint commit creation, timeline, and rollback |
| `packages/core/tests/worktree-manager.test.ts` | Unit tests for worktree operations |
| `packages/core/tests/session-lifecycle.test.ts` | Unit tests for lifecycle sequencing |
| `packages/core/tests/checkpoint-manager.test.ts` | Unit tests for checkpoint operations |
| `packages/core/tests/checkpoint-integration.test.ts` | Integration tests for checkpoint workflow |
| `docs/studio-sessions.md` | This document |
