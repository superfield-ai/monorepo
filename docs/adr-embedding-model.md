# ADR: Governed Embedding Model and Dimensionality

**Date:** 2026-05-31
**Status:** Accepted
**Closes:** #432
**Related:** architecture.md §Governed Embedding Standard, `crates/nexum/src/embed.rs`
**Amended:** 2026-07-02 — see Amendment at the end of this document

---

## Context

Nexum and future Sharp/embedding features each produce vector embeddings of
documents and code. Without a governed model choice the embedding space is
fragmented: different models produce incompatible vector geometries, pgvector
indexes declared with the wrong dimensionality are silently corrupt, and
cross-component semantic joins (e.g. a Sharp episode joined to a Nexum block)
are impossible.

This decision pins the model, dimensionality, distance function, and index
type so that every store shares one governed vector space.

---

## Decision

All Superfield components **must** embed text using:

| Property          | Value                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| **Model**         | `sentence-transformers/all-MiniLM-L6-v2` (safetensors, via `hf-hub` + `candle`)             |
| **Runtime**       | Rust (`crates/nexum/src/embed.rs`) — the sole shipping runtime _(see Amendment 2026-07-02)_ |
| **HF revision**   | `c9745ed` — `sentence-transformers/all-MiniLM-L6-v2@c9745ed`                                |
| **Dimensions**    | **384**                                                                                     |
| **Normalisation** | L2-normalised (unit vectors)                                                                |
| **Distance**      | Cosine similarity                                                                           |
| **Index type**    | HNSW via pgvector — `USING hnsw (col vector_cosine_ops)`                                    |

No other embedding model or dimensionality is permitted without a superseding
ADR that also covers corpus re-embedding and schema migration.

---

## Rationale

**Why all-MiniLM-L6-v2?**

- Nexum already ships `blocks.embedding vector(384)` backed by this model in
  production. Standardising on it avoids a breaking schema migration.
- The model is freely licensed (Apache 2.0), widely benchmarked, and
  produces strong retrieval quality on document-block workloads.
- 384 dimensions are small enough for low-latency HNSW queries while still
  capturing semantic nuance adequate for code/document retrieval.
- Local inference (safetensors via `hf-hub` + `candle` in Rust; historically
  also ONNX in the retired JS prototype — see Amendment 2026-07-02) keeps all
  vector production inside the one-binary boundary — no external API key, no
  network call at inference time, no vendor lock-in.
- A single vector space makes cross-component semantic joins (Sharp ↔ Nexum)
  possible in a single SQL query.

**Why HNSW cosine?**

- L2-normalised vectors make cosine similarity equivalent to inner product,
  which HNSW handles efficiently.
- pgvector's HNSW index is production-ready and already deployed for Nexum.

**Why L2 normalisation?**

- Cosine distance between unit vectors equals `1 − dot_product`. Normalising
  at embed time lets pgvector use the fast `vector_cosine_ops` operator class
  without a per-query division.

---

## Rejected alternatives

| Option                                         | Why rejected                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI `text-embedding-3-small` (1536-dim)     | External API dependency; breaks one-binary constraint; per-call cost; dimension mismatch with existing Nexum data requiring full re-embed. |
| OpenAI `text-embedding-ada-002` (1536-dim)     | Same objections as above.                                                                                                                  |
| `all-mpnet-base-v2` (768-dim)                  | Re-embedding all existing Nexum corpora; larger index; no demonstrated retrieval gain for document-block workloads.                        |
| `bge-small-en-v1.5` (384-dim)                  | No material quality advantage; switching would still require re-embedding existing corpora.                                                |
| A quantised GGUF model (Phi-3-mini, TinyLlama) | GGUF format not natively supported by candle BERT pipeline; ONNX GGUF tooling immature; no demonstrated embedding quality advantage.       |

---

## Governance constants

### Rust (`crates/nexum/src/embed.rs`)

```rust
/// HuggingFace model ID for the governed embedding model.
pub const GOVERNED_MODEL: &str = "sentence-transformers/all-MiniLM-L6-v2";

/// Pinned HuggingFace model revision (commit SHA).
pub const GOVERNED_MODEL_REVISION: &str = "c9745ed";

/// Output dimension of the governed embedding model.
pub const GOVERNED_DIM: usize = 384;
```

### Model checkpoint lockfile (`models/embedding.lock`)

The canonical pinned revision is declared in `models/embedding.lock`. CI
resolves the checkpoint using this file.

---

## Vector column inventory

All existing pgvector columns are conforming:

| Component                  | Schema  | Table    | Column           | Declared dimension | Status                                                                                                |
| -------------------------- | ------- | -------- | ---------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| Nexum                      | `nexum` | `blocks` | `embedding`      | 384                | Conforming — HNSW cosine index live                                                                   |
| Nexum                      | `nexum` | `links`  | `edge_embedding` | 384                | Conforming — populated by `ai_link.rs` (`embed_edge` + INSERT); ANN search over it in `query.rs`      |
| Sharp                      | `sharp` | —        | —                | —                  | No vector columns yet                                                                                 |
| CLI (retired TS prototype) | local   | —        | —                | —                  | Historical — lowdb JSON store, no vector columns; retired with the prototype _(Amendment 2026-07-02)_ |

New vector columns added by any component must:

1. Declare `vector(384)`.
2. Add `CREATE INDEX … USING hnsw (col vector_cosine_ops)`.
3. Include the comment `-- embedding model: sentence-transformers/all-MiniLM-L6-v2, rev c9745ed, 384-dim`.

---

## Consequences

- All new stores inherit the 384-dim cosine vector space automatically if
  they reference `GOVERNED_EMBEDDING` / `GOVERNED_DIM`.
- Changing the model requires a new ADR, a schema migration for every `vector`
  column, and a corpus re-embedding pipeline run.
- The `crates/nexum/src/embed.rs` module is the canonical implementation; all embedding calls go through the Rust service layer.

---

## Amendment — 2026-07-02

Recorded following the 2026-07-02 red-team concept review
(`docs/code-reviews/2026-07-02-red-team-concept-review.md`, finding R-36) and
its ratified remediation. The original Decision above stands as the historical
record; this amendment refreshes stale facts and records the adopted plan of
record.

**Factual refresh (applied in place above):**

- The Rust `candle`/safetensors path (`crates/nexum/src/embed.rs`) is the sole
  shipping runtime. The "ONNX in JS" packaging and the `packages/db/index.ts`
  reference described the retired TypeScript prototype and are now marked
  historical.
- `nexum.links.edge_embedding` is no longer a stub: it is populated by
  `ai_link.rs` (`embed_edge` + INSERT) with ANN search over it in `query.rs`,
  matching architecture.md §Governed Embedding Standard.
- The prototype-era "CLI — lowdb JSON store" inventory row is marked
  historical.
- The canonical model identifier everywhere is
  `sentence-transformers/all-MiniLM-L6-v2`; the `Xenova/all-MiniLM-L6-v2` name
  that appeared in `docs/adr-schema-boundary.md` was the JS/ONNX port of the
  same weights and has been corrected there.

**Plan of record — versioned embedding space (planned, not yet implemented):**

The single-vector-space invariant is retained but **decoupled from this
specific model**, per the ratified R-36 remediation:

- Vector stores gain a **versioned embedding-space identifier** (model +
  revision + dimension) rather than an implicit permanent pin to
  `sentence-transformers/all-MiniLM-L6-v2@c9745ed`.
- A **designed corpus re-embed pipeline** makes model migration a routine
  operation instead of a breaking event.
- Retrieval is to be **benchmarked on code-plus-causal-link workloads** before
  the brain schema locks in 384 dimensions.

Until that work lands, the Decision above remains binding: all components
embed with `sentence-transformers/all-MiniLM-L6-v2@c9745ed`, 384-dim,
L2-normalised, cosine/HNSW, and changing the model still requires a
superseding ADR. The versioned space and re-embed pipeline are what will make
such a supersession cheap rather than corpus-breaking.
