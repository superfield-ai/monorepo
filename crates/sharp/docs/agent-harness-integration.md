# Agent Harness Integration (Episodes)

This document is the API-depth companion to [`episodes.md`](./episodes.md). Where
`episodes.md` walks the conceptual lifecycle and the (TypeScript) `@sharp/episodes`
library, this document specifies the **Rust** library surface in
[`src/episode.rs`](../src/episode.rs) as actually implemented, maps it onto the
open / append / finish / link concepts a harness needs, and is explicit about
what is implemented in Rust versus what only exists in the deprecated TS
prototype. Read `episodes.md` first for the data model and analytics queries; it
is not duplicated here.

## 1. Problem Statement

An agent harness runs many automated change attempts against a repo: it fans out
N candidate runs from one parent commit, judges them, promotes a winner, retries
failures, and later replays archived runs against a newer model. Each run must
leave a complete, append-only, queryable record — prompts, context, tool calls
and results, intermediate patches, validation outcomes, judge scores — linked to
the commit it produced and to its sibling runs. The integration problem is giving
harness code a small typed library surface to bracket a run (open), stream
artifacts (append), finalize with a structured outcome (finish), and wire up
lineage (link) — without touching SQL.

## 2. Core Concepts

The Rust crate carries **two coexisting episode models** against the same
`sharp.episodes` table (migration `0002` generic + `0006` complete; see
[`migrations/0006_sharp_episode_model.sql`](../migrations/0006_sharp_episode_model.sql)).
Harness integration uses the **complete model**; the generic model
(`open`/`append`/`finish`/`events`) is the lightweight event-log surface that
`sf-cli` and the runtime-signal seam depend on.

**Two status vocabularies, one row.** This is the single most important thing to
internalize and the easiest to get wrong:

- `state` (`TEXT`, generic): `'open'` → `'finished'`. Drives `list_open`.
- `status` (`TEXT`, complete): `EpisodeStatus::{Started, Completed, Failed, Abandoned}`
  → `"started" | "completed" | "failed" | "abandoned"`. Drives provenance
  analytics. `NULL` for generic episodes.

`open_with_provenance` sets `status='started'` and `state='open'`;
`finish_with_status` sets the terminal `status` **and** flips `state='finished'`
so both surfaces stay consistent. There is no `partial_failure` status in the
implementation — the four-variant `EpisodeStatus` enum is the source of truth;
partial-failure is modeled as `Failed` plus the recorded validation/judge
artifacts (see §5).

**Artifact kinds** (`ArtifactKind`, enforced by a CHECK constraint):
`Prompt`, `Context`, `ToolCall`, `ToolResult`, `IntermediatePatch`, `Validation`,
`Judge` → the matching snake-case strings. `ArtifactKind::parse` returns
`SharpError::InvalidArtifact` for unknown strings. Semantics: `prompt`/`context`
are the replayable inputs; `tool_call`/`tool_result` are the action trace;
`intermediate_patch` is candidate output (typically large → CAS); `validation`
records a deterministic gate (e.g. `cargo check`, `tsc`); `judge` records an
LLM-judge or scorer outcome. Validation and judge artifacts are how
success/failure detail is reported — the harness writes a `judge` artifact such
as `{ "score": 0.87, "rationale": "..." }` and a `validation` artifact before
calling `finish_with_status`.

**Link relations** (`LinkRelation`): `Sibling`, `RetryOf`, `ReplayOf`,
`SupersededBy` → stored in `sharp.episode_relations` (distinct from `0002`'s
`episode_links`). These are the harness-lineage edges.

## 3. Architecture / Design

**Lifecycle.** `open_with_provenance` → repeated `add_artifact` / `add_artifact_inline`
→ `finish_with_status`. Each artifact gets a monotonic `seq` assigned as
`MAX(seq) + 1` starting at **1** (the complete-model artifact seq; note the
generic `append` event seq starts at **0** — a deliberate divergence matching the
TS prototype). `seq` preserves intra-episode ordering, which replay relies on.

**Linking siblings / replays.** `link_episodes(from, to, relation)` writes one
directed `episode_relations` edge, idempotent via `ON CONFLICT DO NOTHING`. By
convention:

- _Fan-out siblings_: every worker links to every peer with `Sibling`.
- _Winner selection_: each loser links to the winner with `SupersededBy`. The
  losing-sibling rows are the retained negative-example corpus.
- _Retry_: a fresh attempt from the same parent links to its predecessor with `RetryOf`.
- _Replay_: a re-run links to the original with `ReplayOf`.

**Replay mechanics — how an episode ID maps to a runnable replay request.** An
archived episode's provenance tuple (`parent_commit`, `agent_identity`,
`tool_versions`) plus its `prompt`/`context` artifacts _are_ the replay request.
To replay episode E against a new model: read `find`/`list_filtered` for the
provenance, `list_artifacts(E)` for the inputs, open a new episode via
`open_with_provenance` reusing `parent_commit`/`agent_identity`/`tool_versions`
but overriding `model_id`/`harness_version`/`decoding_params`, re-append the
`prompt` and `context` artifacts in `seq` order, run the harness, and call
`link_episodes(new, E, ReplayOf)`. **The Rust crate ships the primitives but not
a `replay()` driver** — see §4 and §7. The now-retired TS prototype's
`EpisodeHandle.replay` (`packages/episodes/src/index.ts` in the deprecated
`sharp-ts` tree) implemented exactly this orchestration and is the reference for
a future Rust helper.

## 4. API / Interface

Real Rust signatures (all `async`, all return `Result<_, SharpError>`):

```rust
// Open with full provenance (status='started', state='open').
pub async fn open_with_provenance(pool: &PgPool, input: &OpenEpisodeInput)
    -> Result<Episode, SharpError>;

// OpenEpisodeInput { repo_id, title, parent_commit, agent_identity,
//                    model_id, harness_version, tool_versions: Json, decoding_params: Json }

// Append a typed artifact — inline jsonb, or CAS-backed by content hash.
pub async fn add_artifact_inline(pool, episode_id, kind: ArtifactKind, inline: Json)
    -> Result<TypedArtifact, SharpError>;
pub async fn add_artifact(pool, episode_id, repo_id, kind: ArtifactKind, data: &[u8])
    -> Result<TypedArtifact, SharpError>;   // stores `data` as a blob in sharp.objects, records content_ref

// Finalize with a terminal status + optional promoted commit (hex sha).
pub async fn finish_with_status(pool, episode_id, status: EpisodeStatus,
    promoted_commit: Option<&str>) -> Result<Episode, SharpError>;

// Lineage edge (idempotent).
pub async fn link_episodes(pool, from_episode: Uuid, to_episode: Uuid,
    relation: LinkRelation) -> Result<(), SharpError>;

// Query / read-back.
pub async fn find(pool, episode_id) -> Result<Episode, SharpError>;
pub async fn list_artifacts(pool, episode_id) -> Result<Vec<TypedArtifact>, SharpError>;
pub async fn list_filtered(pool, &EpisodeFilter) -> Result<Vec<Episode>, SharpError>;
pub async fn list_for_repo(pool, repo_id) -> Result<Vec<Episode>, SharpError>;
pub async fn redact(pool, episode_id, seq, policy, actor, redacted: Json) -> Result<(), SharpError>;
```

Concept-to-method map: `open` → `open_with_provenance`; `append` →
`add_artifact{,_inline}`; `finish` → `finish_with_status`; `link` →
`link_episodes`. There is no `linkSibling`/`markSuperseded`/`replay` sugar in
Rust — callers pass the explicit `LinkRelation`.

**Inline vs CAS routing is the caller's decision in Rust.** Unlike the TS library
(which auto-routes at a 32 KB threshold and rejects >64 KB inline at the server),
the Rust crate exposes both methods and the harness chooses: small structured
payloads → `add_artifact_inline`; large or binary payloads (system prompts,
patches) → `add_artifact`, which deduplicates identical content across episodes
in `sharp.objects`. The DB CHECK enforces exactly one of `content_ref`/`inline`.

**Error handling.**

- `add_artifact{,_inline}` / `finish_with_status` surface `SharpError::Db` on DB
  failure; `finish_with_status` returns `SharpError::EpisodeNotFound` for an
  unknown id and `SharpError::InvalidArtifact` if you pass `EpisodeStatus::Started`
  (not terminal).
- **Discrepancy / sharp edge:** the complete-model `add_artifact*` functions do
  **not** guard episode state — unlike the generic `append`, which returns
  `SharpError::EpisodeNotOpen` when the episode is finished. Appending a typed
  artifact after `finish_with_status` will currently succeed at the DB level. The
  harness must enforce "no append after finish" itself. See §7.
- A failed `add_artifact` (e.g. transient DB error) leaves the episode open with
  the artifacts written so far; the harness should retry the append or finish the
  episode as `Failed`. Each call is its own transaction except `redact`, which is
  transactional (clears payload + writes the `episode_redactions` audit row
  atomically).

## 5. Example — Multi-step Harness Workflow with Error Handling

```rust
use sharp::episode::{self, ArtifactKind, EpisodeStatus, LinkRelation, OpenEpisodeInput};
use serde_json::json;

async fn run_attempt(pool: &PgPool, repo_id: Uuid, parent: &str, task: &str)
    -> Result<Uuid, sharp::SharpError>
{
    let ep = episode::open_with_provenance(pool, &OpenEpisodeInput {
        repo_id, title: format!("attempt: {task}"),
        parent_commit: parent.to_string(),
        agent_identity: "codex-worker-42".into(),
        model_id: "claude-opus-4-8".into(),
        harness_version: "0.2.0".into(),
        tool_versions: json!({ "cargo": "1.92.0" }),
        decoding_params: json!({ "temperature": 0.2 }),
    }).await?;

    // Replayable inputs.
    episode::add_artifact_inline(pool, ep.id, ArtifactKind::Prompt,
        json!({ "role": "user", "content": task })).await?;

    // Action trace + large patch routed to CAS.
    episode::add_artifact_inline(pool, ep.id, ArtifactKind::ToolCall,
        json!({ "tool": "apply_patch" })).await?;
    let patch: &[u8] = b"--- a/foo.rs\n+++ b/foo.rs\n...";
    episode::add_artifact(pool, ep.id, repo_id, ArtifactKind::IntermediatePatch, patch).await?;

    // Deterministic gate + judge outcome.
    let compiles = run_cargo_check().await;     // harness logic
    episode::add_artifact_inline(pool, ep.id, ArtifactKind::Validation,
        json!({ "tool": "cargo check", "result": if compiles {"pass"} else {"fail"} })).await?;

    if !compiles {
        // Error / partial-failure path: record the judge verdict, finish Failed.
        episode::add_artifact_inline(pool, ep.id, ArtifactKind::Judge,
            json!({ "score": 0.0, "rationale": "did not compile" })).await?;
        episode::finish_with_status(pool, ep.id, EpisodeStatus::Failed, None).await?;
        return Ok(ep.id);
    }

    // Happy path: promote and finish Completed.
    let commit_sha = commit_result(pool).await?;     // harness logic
    episode::add_artifact_inline(pool, ep.id, ArtifactKind::Judge,
        json!({ "score": 0.91, "rationale": "tests pass" })).await?;
    episode::finish_with_status(pool, ep.id, EpisodeStatus::Completed, Some(&commit_sha)).await?;
    Ok(ep.id)
}

// Fan-out + judge selection: link siblings, then supersede losers.
async fn judge_fanout(pool: &PgPool, attempts: &[Uuid], winner: Uuid)
    -> Result<(), sharp::SharpError>
{
    for (i, &a) in attempts.iter().enumerate() {
        for &b in &attempts[i + 1..] {
            episode::link_episodes(pool, a, b, LinkRelation::Sibling).await?;
            episode::link_episodes(pool, b, a, LinkRelation::Sibling).await?;
        }
    }
    for &loser in attempts.iter().filter(|&&a| a != winner) {
        episode::link_episodes(pool, loser, winner, LinkRelation::SupersededBy).await?;
    }
    Ok(())
}
```

The **happy path** finishes `Completed` with a `promoted_commit`; the **error
path** writes a failing `validation` + `judge` and finishes `Failed` with no
commit. An attempt abandoned mid-run (harness killed, timeout) should finish
`Abandoned`. **Partial failure** — e.g. patch applies and compiles but a judge
rejects it — is recorded as `Failed` with the distinguishing detail living in the
`validation` (pass) and `judge` (reject) artifacts rather than in a dedicated
status. A **runtime crash discovered after merge** attaches via
[`runtime_signal::record`](../src/runtime_signal.rs), which is intentionally
best-effort: the signal row is committed even if the episode is already finished
(the mirrored event-log append's `EpisodeNotOpen` is ignored).

## 6. Tradeoffs

- **Two models on one table.** Keeping `0002`'s generic event log alongside the
  `0006` typed-artifact model avoids a breaking migration for `sf-cli` and the
  runtime-signal seam, at the cost of two status columns (`state` vs `status`)
  and two seq conventions (0-based vs 1-based) that callers must not conflate.
- **Caller-chosen CAS routing.** More control and no hidden 32 KB heuristic than
  the TS library, but the harness owns the inline-vs-CAS decision and the
  payload-size discipline the TS server enforced server-side.
- **Append-only facts, mutable annotations.** Redaction is destructive by design
  (`redact` clears the payload, keeps an audit row) — provenance of _what was
  scrubbed_ survives; the original content does not.
- **Idempotent links** make double-linking safe but mean a wrong-direction edge
  is silently retained; the harness owns link-direction correctness.

## 7. Known Limitations

- **No `replay()` driver in Rust.** Only the primitives exist
  (`list_artifacts` + `open_with_provenance` + `link_episodes` with `ReplayOf`).
  The orchestration — fetch original, re-append `prompt`/`context` in seq order,
  link `replay_of` — is implemented only in the TS prototype and must be
  hand-rolled (or ported) for Rust harnesses. Replay-as-evaluation methodology is
  research-track and out of scope (see `episodes.md` and engineering-plan §9.2).
- **`add_artifact*` does not guard finished episodes** (unlike generic `append`).
  Post-finish appends succeed at the DB layer; "immutable after finish" is a
  convention the harness must enforce until a state guard lands.
- **No `partial_failure` status.** The `EpisodeStatus` enum is four variants;
  partial failure is `Failed` + artifact detail.
- **No structured judge type.** `Judge` artifacts are free-form `Json`; there is
  no schema enforcing `score`/`rationale`. Outcome reporting is convention.
- **Seq assignment is `MAX(seq)+1` per call**, not transactionally reserved, so
  two concurrent appenders to the same episode could race on `seq`. Harnesses
  should keep a single writer per episode.
- **No Rust HTTP/client layer.** These are in-process library calls against a
  `PgPool`. The TS prototype's HTTP server + `@sharp/episodes` client
  (`openEpisode`/`appendArtifact`/`finish`/`replay`) is the only networked
  surface and is deprecated; a Rust server/client equivalent is not yet shipped.

```

```
