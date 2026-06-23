# Runtime Agent Selection

How Superfield picks a backend and model for each inference request.

---

## Concepts

### Backend

A vendor CLI that Superfield can spawn: `claude`, `codex`, or `opencode`.

### Model tier

An abstract capability level independent of any backend:

| Tier     | Claude | Codex        | OpenCode            |
| -------- | ------ | ------------ | ------------------- |
| `high`   | opus   | o3           | opencode/big-pickle |
| `medium` | sonnet | gpt-5.4      | opencode/big-pickle |
| `low`    | haiku  | gpt-5.4-mini | opencode/big-pickle |

### Job type

A named inference role — what the agent is being asked to do. Each job type carries a preferred backend+tier and an ordered failover list. See [Job type catalogue](#job-type-catalogue) below.

### Availability window

When a backend hits a rate limit or login failure the system records the earliest time it may be retried. Availability is checked before each selection; a backend whose retry window has not elapsed is treated as unavailable for that selection.

---

## Selection algorithm

When `spawnAgent` is called it executes this procedure in order:

### 1. Resolve the candidate list

Build an ordered list of `(backend, model)` pairs for this job type:

```
preferred → (claude, sonnet)
failovers → (codex, gpt-5.4) | (opencode, big-pickle)
```

If the caller supplies an explicit `provider` override that is not `"auto"`, the candidate list collapses to a single entry using the caller-supplied backend and the job type's tier.

### 2. Filter by availability

Remove any candidate whose backend is within an active rate-limit window (the backend is "cooling down"). If all candidates are filtered out, fall through to [step 4](#4-wait-for-availability).

### 3. Try in order

Attempt each remaining candidate in sequence. On a successful call, record the elapsed time and return the result.

On a rate-limit or unsupported-model error:

- Mark the backend unavailable with a computed retry time (see [Availability tracking](#availability-tracking)).
- Advance to the next candidate.

On any other error: surface the error immediately — do not fall back.

### 4. Wait for availability

If every candidate is unavailable, poll until at least one backend clears its retry window, then return to step 2.

---

## Failover resolution for generic tiers

A job type's failover list may reference an abstract tier name — `"thinking-medium"`, `"thinking-high"`, `"coding-low"`, etc. — instead of a specific backend.

Abstract tier names are resolved against the **app-wide tier priority table** configured in `~/.superfield/config.yaml`. Example:

```yaml
tiers:
  thinking-high:
    - backend: claude
      model: opus
    - backend: codex
      model: o3
    - backend: opencode
      model: opencode/big-pickle

  thinking-medium:
    - backend: claude
      model: sonnet
    - backend: codex
      model: gpt-5.4
    - backend: opencode
      model: opencode/big-pickle

  thinking-low:
    - backend: claude
      model: haiku
    - backend: codex
      model: gpt-5.4-mini
    - backend: opencode
      model: opencode/big-pickle

  coding-medium:
    - backend: codex
      model: gpt-5.4
    - backend: claude
      model: sonnet
    - backend: opencode
      model: opencode/big-pickle
```

When a job type references `"thinking-medium"` in its failover list, the resolver expands it to the ordered `(backend, model)` pairs from this table. These pairs are appended to the candidate list after any explicitly named failovers.

The table ships with defaults matching the values above. Users may override any tier by editing the YAML.

---

## Job type catalogue

Each job type entry specifies:

- **preferred** — the first candidate: `(backend, tier)` pairs, resolved to a concrete model at runtime
- **failovers** — ordered list of fallbacks; entries are either a specific `(backend, tier)` or an abstract tier name

### `dev` — feature development (primary and speculative agents)

```yaml
preferred:
  backend: claude
  tier: medium # → sonnet

failovers:
  - backend: codex
    tier: medium # → gpt-5.4
  - thinking-medium # resolved from app-wide tier table
```

### `dev-scout` — stub-only integration pass

Same profile as `dev`. Scouts do not need a higher-capability model; they write stubs, not implementations.

```yaml
preferred:
  backend: claude
  tier: medium

failovers:
  - backend: codex
    tier: medium
  - thinking-medium
```

### `ci-failure` — CI remediation

Same profile as `dev`. The model tier does not need to increase because CI failures are typically narrowly scoped.

```yaml
preferred:
  backend: claude
  tier: medium

failovers:
  - backend: codex
    tier: medium
  - thinking-medium
```

### `plan` — replan evaluation (one-shot, structured JSON output)

Planning requires strong reasoning but is short-lived. Prefer high tier so the Plan JSON is reliable.

```yaml
preferred:
  backend: claude
  tier: high # → opus

failovers:
  - backend: codex
    tier: high # → o3
  - thinking-high
```

### `feature-evaluate` — feature triage (one-shot, structured JSON output)

Lower stakes than full planning; medium is sufficient.

```yaml
preferred:
  backend: claude
  tier: medium

failovers:
  - backend: codex
    tier: medium
  - thinking-medium
```

### `issue-audit` — schema conformance check (planning loop)

Lightweight classification task. Low tier acceptable.

```yaml
preferred:
  backend: claude
  tier: low # → haiku

failovers:
  - backend: codex
    tier: low # → gpt-5.4-mini
  - thinking-low
```

### `blueprint-conformance` — rule evaluation (planning loop)

Moderate reasoning needed to match issue content against rule descriptions.

```yaml
preferred:
  backend: claude
  tier: medium

failovers:
  - backend: codex
    tier: medium
  - thinking-medium
```

### `doc-coverage` / `doc-canonical-sync` / `doc-consistency` — documentation loop

Low-to-medium writing tasks. Medium tier preserves quality.

```yaml
preferred:
  backend: claude
  tier: medium

failovers:
  - backend: codex
    tier: medium
  - thinking-medium
```

### `pre-pr-self-audit` — blueprint self-audit before PR

Requires careful reading of diffs against rule bodies. Medium tier.

```yaml
preferred:
  backend: claude
  tier: medium

failovers:
  - backend: codex
    tier: medium
  - thinking-medium
```

---

## Availability tracking

The system maintains an in-memory map of `backend → retryAfter` timestamps. This map is process-local and does not persist across restarts.

| Event                               | Effect                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Rate-limit error (HTTP 429 / prose) | `retryAfter = now + backoffMs`                                         |
| Unsupported-model error             | Mark backend unavailable for this selection only; no persistent window |
| Login / auth failure                | `retryAfter = now + 300_000` (5 min); log a warning                    |
| Successful response                 | Clear any existing `retryAfter` for that backend                       |

Initial backoff: **60 seconds** (matching the current `waitForAvailableBackend` poll interval). A future improvement may implement exponential backoff with jitter.

Retry windows apply per-backend, not per-`(backend, model)` pair. If `claude/sonnet` is rate-limited, `claude/opus` is also skipped until the window clears.

---

## Configuration reference

`~/.superfield/config.yaml` (additions to the existing schema):

```yaml
# --- existing fields ---
users: [...]
repositories: [...]

# --- new fields ---

# App-wide tier priority table.
# Keys are abstract tier names; values are ordered (backend, model) lists.
# Omit to use built-in defaults.
tiers:
  thinking-high:
    - { backend: claude, model: opus }
    - { backend: codex, model: o3 }
    - { backend: opencode, model: opencode/big-pickle }
  thinking-medium:
    - { backend: claude, model: sonnet }
    - { backend: codex, model: gpt-5.4 }
    - { backend: opencode, model: opencode/big-pickle }
  thinking-low:
    - { backend: claude, model: haiku }
    - { backend: codex, model: gpt-5.4-mini }
    - { backend: opencode, model: opencode/big-pickle }
  coding-medium:
    - { backend: codex, model: gpt-5.4 }
    - { backend: claude, model: sonnet }
    - { backend: opencode, model: opencode/big-pickle }

# Per-job overrides. Keys are job type names (see catalogue above).
# Fully replaces the built-in preferred + failovers for that job type.
jobs:
  plan:
    preferred: { backend: claude, tier: high }
    failovers:
      - { backend: codex, tier: high }
      - thinking-high
```

If `tiers` or `jobs` is absent, built-in defaults apply. Partial overrides are not merged — a `jobs.plan` entry replaces the entire built-in `plan` spec.

---

## Relationship to existing code

| Concept in this spec         | Current location in code                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `AgentBackend`, `ModelTier`  | `packages/core/agent.ts`                                                                 |
| `MODEL_TIER_MAPPING`         | `packages/core/agent.ts:26`                                                              |
| `filterAvailableBackends`    | `packages/core/agent.ts:214` — login check only; no retry window yet                     |
| `waitForAvailableBackend`    | `packages/core/agent.ts:424` — polls every 60s                                           |
| `callWithBackendPriority`    | `packages/core/agent.ts:342` — iterates backends                                         |
| Job type → backend mapping   | **not yet implemented** — all jobs use the same `["claude","codex","opencode"]` default  |
| Availability window tracking | **not yet implemented** — rate-limit handling exits immediately; no per-backend cooldown |
| App-wide tier config         | **not yet implemented** — tier resolution is hardcoded in `MODEL_TIER_MAPPING`           |

This spec defines the target behaviour. Implementation will extend `AgentOpts` with a `jobType` field, introduce a per-process `BackendAvailabilityStore`, and add a `JobRegistry` that maps job types to their preferred + failover candidate lists.
