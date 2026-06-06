# PostgreSQL Extension Landscape

Extensions available today, and the case for building our own.

---

## Extensions on the Table

### Apache AGE

Adds an openCypher query layer on top of standard PostgreSQL. Stores graph data in Postgres tables but lets you write `SELECT * FROM cypher(...)` instead of recursive CTEs.

**What it buys:** Cypher is far more expressive than recursive CTEs for multi-hop traversal — variable-length paths, pattern matching, shortest path — without leaving Postgres. No separate graph DB process.

**The catch:** AGE is still immature. Its performance on deep traversals is roughly equivalent to well-tuned recursive CTEs. It doesn't change the underlying storage engine, so it won't help past the CTE bottleneck — it just makes the query language nicer. Active development; some known correctness bugs in complex patterns.

**Relevance to Nexum:** Mostly a DX improvement for traversal queries. Worth testing as a drop-in for the recursive CTE graph queries to measure whether Cypher-compiled plans beat hand-written CTEs. Relevant to [Area 1](../research.md#area-1--storage-architecture-fitness).

---

### pgml (PostgreSQL ML)

Runs model inference *inside* Postgres via a Rust extension. You can call `pgml.transform(...)` or `pgml.embed(...)` as a SQL function. Supports HuggingFace models natively. This is the most directly relevant extension to the inference substrate thesis — it literally executes forward passes inside the database process.

**What it buys:** If inference runs inside the database process, the graph-as-inference-substrate architecture collapses to: retrieve blocks via ANN, aggregate, run generation — all in a single transaction, no network hop to a model server.

**The catch:** In-process inference is limited to models that fit in shared memory alongside the Postgres buffer pool. Large LLMs don't work. Compelling for embedding models and small classifiers; marginal for generation at scale.

**Relevance to Nexum:** Direct embodiment of the inference substrate thesis for small-to-medium models. Dedicated experiment slot in [Area 3](../research.md#area-3--graph-as-inference-substrate).

---

### TimescaleDB

Adds time-series partitioning and continuous aggregates to Postgres. Hypertables automatically partition by time; materialized aggregates update incrementally.

**What it buys in context:** Not directly about graph or vector queries, but relevant to the "real-time updating model" claim. If blocks are appended continuously (live corpus — news feeds, regulatory updates, EHR streams), TimescaleDB's hypertable partitioning handles high-ingest time-ordered appends better than standard heap tables. Continuous aggregates could maintain running link density stats, embedding centroid drift metrics, or training curriculum readiness scores without full table scans.

**The catch:** Complicates the schema. The block table is content-addressed (UUID + content_hash), not naturally time-series. TimescaleDB is most useful for a separate `ingest_events` or `link_activity` table, not the primary block store.

**Relevance to Nexum:** Supporting infrastructure for [Areas 3 and 4](../research.md) recency experiments.

---

### ParadeDB

Adds BM25 full-text search to Postgres via a Rust extension (Tantivy under the hood). Outperforms `tsvector` significantly on sparse keyword retrieval tasks.

**What it buys:** The current `tsvector` full-text layer is adequate but not competitive with dedicated search engines. ParadeDB is a drop-in upgrade that adds relevance tuning, field boosting, and fuzzy matching without leaving Postgres.

**Relevance to Nexum:** Full-text baseline improvement for [Area 1](../research.md#area-1--storage-architecture-fitness) hybrid search benchmarks.

---

### Lantern / pg_embedding

Alternative HNSW implementations for ANN search. Lantern uses the USEARCH library and benchmarks at 2–5x faster index build time than pgvector with comparable recall. pg_embedding is Neon's fork with better memory efficiency at large scale.

**Relevance to Nexum:** Drop-in pgvector replacements for the [Area 1](../research.md#area-1--storage-architecture-fitness) index build and recall benchmarks.

---

## Summary Table

| Extension | Research Area | Role |
|---|---|---|
| Apache AGE | Area 1 | Traversal query language vs. recursive CTEs |
| pgml | Area 3 | In-process inference; eliminates model server hop |
| TimescaleDB | Areas 3, 4 | Continuous ingest; incremental stats for recency experiments |
| ParadeDB | Area 1 | BM25 full-text; replace tsvector for sparse retrieval comparison |
| Lantern / pg_embedding | Area 1 | ANN index build time + recall benchmarks |
| FAISS-GPU / cuVS (sidecar) | Area 6 | GPU ANN throughput vs. pgvector CPU HNSW |
| pgml + CUDA | Area 6 | In-process GPU embedding; buffer pool pressure |

---

## Writing Our Own Extension

### Why

Every extension above solves one concern in isolation. None are aware that blocks have embeddings *and* typed graph edges *and* version lineage *simultaneously*. The result is that any query combining all three requires the planner to compose independent indexes — it cannot reason across them jointly. A purpose-built extension can expose a unified index structure and query operators that treat the (embedding, link-layer, version) triple as a first-class primitive.

A custom extension is also the only path to the inference substrate thesis at full fidelity. pgml runs generic HuggingFace models inside Postgres. What we actually need is a client that understands the block graph schema — traversal-aware generation, where each forward pass step is a typed graph walk rather than a flat token window.

---

### What It Would Do

#### 1. Typed Graph-Vector Index (`nxm_gv_index`)

A composite index over `(embedding vector, link layer, rel_type, weight)` per block. Instead of two separate index scans (HNSW for ANN, B-tree for link filtering) composed by the planner, the index natively answers:

> "Find the 20 blocks most similar to this embedding, reachable within 2 hops via `ai` or `structural` links, weighted by link confidence."

This is the core query in hybrid retrieval and the inner loop of the inference substrate. Implementing it as a single index scan eliminates the cross-product join the planner currently emits.

Internally: a navigable small-world graph augmented with per-node link adjacency lists. Each node stores its embedding, its link-typed neighbor list, and a version bitmask. The ANN walk and link-layer filtering are interleaved rather than post-filtered.

**Hypotheses unlocked:** H1.1, H3.2, H3.3

---

#### 2. Block Lineage Operator (`nxm_lineage`)

A native operator for the `parent_block_id` chain. Currently expressed as a recursive CTE; at scale this is expensive because the planner re-evaluates the recursion per query.

A native operator would precompute lineage metadata in the index (depth, root UUID, version span) and answer lineage queries in O(depth) rather than O(corpus). Critically it would support:

```sql
SELECT nxm_lineage(block_id, max_depth := 10, version_filter := $version_id)
```

returning a set of `(block_id, generation, change_type)` rows — the same semantic as the current version diff CTE but without the full table scan.

**Hypotheses unlocked:** H2.4, H4.1, H5.4

---

#### 3. In-Process Curriculum Walker (`nxm_walk`)

A set-returning function that executes a parameterized walk policy over the link graph, returning an ordered sequence of block UUIDs suitable as a training curriculum batch:

```sql
SELECT nxm_walk(
    seed        := $block_id,
    policy      := 'ucb',          -- 'bfs' | 'dfs' | 'ucb' | 'contrastive'
    layers      := ARRAY['ai', 'structural'],
    max_steps   := 512,
    visit_decay := 0.9             -- down-weight recently visited blocks
)
```

The `contrastive` policy specifically alternates between `supports` and `contradicts` neighbors, producing pairs suitable for contrastive loss training. The `ucb` policy tracks visit counts per block across calls within a session and applies UCB scoring to unexplored branches.

State for `ucb` and `visit_decay` is maintained in a Postgres background worker, persisted to an unlogged table, and shared across connections — meaning multiple training workers pulling curriculum batches from the same database coordinate implicitly without a separate scheduler.

**Hypotheses unlocked:** H2.1, H2.2, H5.1, H5.2

---

#### 4. Inference Step Function (`nxm_infer_step`)

The primitive for graph-resident inference. Takes a query embedding and a partial generation state, retrieves the k most relevant blocks via the `nxm_gv_index`, applies a lightweight aggregation (weighted sum of embeddings, or a small attention kernel via pgml), and returns the next retrieval target and an updated state vector.

```sql
SELECT nxm_infer_step(
    query_embedding := $vec,
    state           := $state_jsonb,
    k               := 10,
    layers          := ARRAY['ai'],
    aggregator      := 'attention_softmax'
)
RETURNING next_query_embedding, retrieved_blocks, updated_state, confidence
```

This is not a full generation loop — it is one step of a retrieval-augmented generation loop expressed as a SQL function. The client calls it iteratively, accumulating `retrieved_blocks` across steps, then passes the full context to an LLM (in-process via pgml, or external via API). The innovation is that each step is graph-aware: retrieval is not flat ANN but typed traversal.

**Hypotheses unlocked:** H3.1, H3.2, H3.3, H3.4, H4.1

---

#### 5. Provenance Aggregate (`nxm_provenance_agg`)

A custom aggregate that, given a set of block UUIDs contributing to an output, traces them back through the link graph to their source documents and versions, producing a structured citation set:

```sql
SELECT nxm_provenance_agg(block_ids)
RETURNING JSONB  -- [{doc_id, version_id, seq, rel_type, confidence}, ...]
```

This closes the attribution loop for H4.4: every answer generated by the inference step function can be paired with a provenance record in a single additional query. No separate tracing pass, no post-hoc reconstruction.

---

### Build Approach

PostgreSQL extensions are written in C (or Rust via `pgrx`). We should use **pgrx** — it exposes the full Postgres extension API (index AM, custom operators, background workers, GUC parameters) with Rust's type safety and the ability to share dependency code with the existing Rust ingestion pipeline.

**Incremental milestones:**

| Milestone | What ships | Validates |
|---|---|---|
| M0 | pgrx scaffold, CI, extension loads cleanly | Build infra |
| M1 | `nxm_lineage` operator | Simplest non-trivial: set-returning, no custom index |
| M2 | `nxm_walk` with `bfs` and `contrastive` policies | Background worker, session state |
| M3 | `nxm_gv_index` AM (read path only, fallback to HNSW for write) | Index AM, composite query |
| M4 | `nxm_infer_step` + `nxm_provenance_agg` | Full inference loop |
| M5 | `nxm_walk` `ucb` policy with shared state | Multi-worker coordination |

M1 and M2 can be done without the custom index and deliver research value immediately (curriculum walking experiments in Area 2). M3 is the inflection point — it either validates or refutes H3.2 (latency bound).

---

### Risks

**Performance regression during M3:** Custom index AMs in Postgres must implement a full set of scan callbacks. An incomplete implementation will fall back to sequential scan silently. The test suite must assert index usage via `EXPLAIN`.

**Memory pressure:** The `nxm_gv_index` stores adjacency lists in shared memory alongside the HNSW graph. At 10M blocks with average degree 5, that's roughly 10M × 5 × 16 bytes (UUID) ≈ 800 MB just for the link layer. Needs a tiered structure: hot adjacency in shared_buffers, cold on disk.

**pgrx API stability:** pgrx tracks upstream Postgres closely but major version upgrades (e.g., PG16 → PG17) can require extension rebuilds. Pin the Postgres version in CI.

**Scope creep:** M4 (`nxm_infer_step`) is where the extension starts to resemble a model server. Keep the inference step stateless and thin — state lives in the caller, not the extension. The extension is a retrieval primitive, not a generation engine.
