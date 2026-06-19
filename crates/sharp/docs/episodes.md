# Sharp Episodes

Walkthrough for `@sharp/episodes`, the TypeScript library agent harnesses use to record the full lifecycle of an automated change attempt.

For the data model specification see whitepaper §5. For the server HTTP API surface see engineering-plan §4 and §9.

---

## Overview

An **episode** is a first-class record attached to a commit. It captures everything that happened during one agent run: prompts, retrieved context, tool calls and results, intermediate patches, validation outcomes, judge scores, and the snapshot (if any) promoted as output. Episodes are append-only as facts; mutable annotations (redactions, re-labels, eval scores) are layered on top without rewriting the underlying record.

The `@sharp/episodes` library is the idiomatic way for harnesses to write episodes. It handles:

- Opening and closing episodes via the Sharp HTTP API.
- Routing artifact payloads: small structured objects go inline as jsonb; larger payloads are stored as content-addressed objects (CAS) and referenced by hash.
- Linking sibling episodes from fan-out runs and marking superseded episodes after judge selection.

---

## Installation

`@sharp/episodes` is a workspace package in the Sharp monorepo. In production harnesses it will be published to npm; during v1 development, consume it from the workspace:

```json
{
  "dependencies": {
    "@sharp/episodes": "workspace:*"
  }
}
```

```bash
bun install
```

---

## API

### `Sharp` — connection handle

```typescript
import { Sharp, openEpisode } from "@sharp/episodes";

const sharp = new Sharp({
  url: "http://localhost:5174",
  token: process.env.SHARP_TOKEN,
  repo: "my-project",
});
```

`Sharp` holds the server URL, token, and repo name. Pass this handle to `openEpisode` and to any standalone methods that talk to the server.

---

### `openEpisode` — start a run

```typescript
const ep = await openEpisode(sharp, {
  parent_commit: "<hex>", // commit the agent started from (required)
  agent_identity: "codex-worker-42",
  model_id: "claude-opus-4-7",
  harness_version: "0.1.3",
  tool_versions: { tsc: "5.5.0", cargo: "1.92.0" },
  decoding_params: { temperature: 0.2, top_p: 0.9 },
});
```

Returns an `Episode` object. The server creates a row in `episodes` with `status = 'started'` and returns the episode's UUID.

`parent_commit` is the only required field besides the provenance tuple (`model_id`, `harness_version`, `tool_versions`, `decoding_params`). These fields are immutable once the episode is opened; they define the reproducibility contract for replay.

---

### `ep.appendArtifact` — record an artifact

```typescript
await ep.appendArtifact('prompt',    { role: 'system', content: '...' });
await ep.appendArtifact('context',   { document: '...', source: 'retrieval' });
await ep.appendArtifact('tool_call', { tool: 'apply_patch', args: { ... } });
await ep.appendArtifact('tool_result', { ok: true, output: '...' });
await ep.appendArtifact('intermediate_patch', someBigBuffer);   // auto-routed to CAS
await ep.appendArtifact('validation', { result: 'pass', tool: 'tsc' });
await ep.appendArtifact('judge',      { score: 0.87, rationale: '...' });
```

Valid artifact kinds: `prompt`, `context`, `tool_call`, `tool_result`, `intermediate_patch`, `validation`, `judge`.

`seq` is assigned by the library in call order and preserves intra-episode ordering for replay.

Each call is fire-and-await. The library handles routing transparently — see the inline vs CAS section below.

---

### `ep.finish` — close the episode

```typescript
// Success: promote the commit produced
await ep.finish({
  status: "completed",
  promoted_commit: "<hex>",
});

// Failure: no commit produced
await ep.finish({
  status: "failed",
});

// Abandoned mid-run
await ep.finish({
  status: "abandoned",
});
```

Valid statuses: `completed`, `failed`, `abandoned`. A `completed` episode should always supply a `promoted_commit`; the server does not enforce this but analytics queries depend on it.

After `finish`, the episode is immutable. Calling `appendArtifact` after `finish` is an error.

---

### `ep.linkSibling` — connect fan-out peers

```typescript
// In a fan-out harness, each worker episode calls linkSibling for every peer
await ep.linkSibling(otherEpisodeId);
```

Creates an `episode_links` row with `relation = 'sibling'`. Sibling links are bidirectional by convention — each episode in the fan-out group should link to every other. This makes "all episodes from the same fan-out run" a simple join query.

---

### `ep.markSuperseded` — record the winner

```typescript
// Called on the winning episode after judge selection
await ep.markSuperseded([losingEpisodeId1, losingEpisodeId2]);
```

Creates `episode_links` rows with `relation = 'superseded_by'` pointing from each losing episode to the winner. Failed siblings with `superseded_by` links are the negative-example corpus: queryable, retained, and connected to the commit that was ultimately promoted.

---

### `ep.replay` — re-run against a new model or harness

```typescript
const replayed = await ep.replay({
  model_id: "claude-opus-4-8",
  harness_version: "0.2.0",
});
```

Reads the original episode's `prompt`, `context`, and `tool_call` artifacts and re-runs them through the harness against the overridden provenance fields. Creates a **new** episode linked back to the original via `episode_links.relation = 'replay_of'`.

Replay is the mechanism for evaluating model and harness upgrades against real production workloads. The methodology for summarizing divergence across replays is research-track (see `docs/research.md` §6); v1 ships the mechanism only.

---

## Inline vs CAS Auto-Routing

Every artifact payload is either stored **inline** as a jsonb column in `episode_artifacts` or as a **content-addressed object** (CAS) in the same object store that holds blobs and trees, with only a `content_ref` hash pointer in the row.

The library picks the route automatically:

| Condition                                | Route        |
| ---------------------------------------- | ------------ |
| `JSON.stringify(payload).length < 32 KB` | Inline jsonb |
| Payload is a `Buffer` / `Uint8Array`     | CAS (always) |
| Serialized JSON >= 32 KB                 | CAS          |

The 32 KB threshold is a heuristic: it keeps the hot path (small tool-call argument dicts, judge scores, short validation summaries) in the row for fast reads, while routing large payloads (system prompts, retrieved documents, intermediate patches) through CAS where identical content across many episodes deduplicates to one object.

The server enforces a hard cap: inline payloads larger than 64 KB are rejected with a `400` error. If you are hitting that cap, ensure you are passing large payloads as `Buffer` objects so the library routes them to CAS.

---

## Analytics Queries

The three queries from engineering-plan §10.1 that the server must answer cheaply. Run them through the operator-scoped read-only passthrough (`POST /repos/:repo/query`, or the `sharp query` operator command). They are described here at the level of what they return; the literal query text and the relation schema live in [`postgres-storage-plugin.md`](./postgres-storage-plugin.md) and engineering-plan §10, kept out of these docs so the doc set stays free of in-narrative SQL.

### All episodes that touched file X

Join episodes to the `commit_paths` relation through each episode's `promoted_commit`, filtered by `(repo, path)`. `commit_paths` is populated on every commit creation by walking the diff against the parent; the index on `(repo_id, path)` makes this fast even on large repositories.

### All failed siblings of commit Y

From the episode that produced commit Y, walk its `sibling` links and keep the peers whose status is `failed` or `abandoned`. Returns every episode that ran from the same fan-out group as the episode that produced commit Y but did not produce a promoted commit. This is the negative-example corpus for training and evaluation.

### All episodes using model Z, with success rate by harness version

Group episodes for the given `(repo, model)` by `harness_version`, counting completed-with-promoted-commit runs as wins over total to get a per-harness-version success rate. Use this to evaluate whether a harness upgrade improved or regressed success rates against the same model.

---

## Complete Example

```typescript
import { Sharp, openEpisode } from "@sharp/episodes";

const sharp = new Sharp({
  url: process.env.SHARP_URL ?? "http://localhost:5174",
  token: process.env.SHARP_TOKEN!,
  repo: process.env.SHARP_REPO ?? "my-project",
});

async function runAgent(parentCommit: string, task: string) {
  const ep = await openEpisode(sharp, {
    parent_commit: parentCommit,
    agent_identity: `worker-${process.pid}`,
    model_id: "claude-opus-4-7",
    harness_version: "0.1.3",
    tool_versions: { tsc: "5.5.0" },
    decoding_params: { temperature: 0.2 },
  });

  try {
    await ep.appendArtifact("prompt", { role: "user", content: task });

    // ... run the agent, append tool_call / tool_result / validation artifacts ...

    const promotedCommit = await commitResult(); // your harness logic

    await ep.finish({ status: "completed", promoted_commit: promotedCommit });
    return { episodeId: ep.id, promotedCommit };
  } catch (err) {
    await ep.finish({ status: "failed" });
    throw err;
  }
}
```
