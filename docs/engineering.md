# Nexum — Engineering Design

## Overview

Nexum's backend is a single PostgreSQL database serving as both vector store and graph store, fronted by a Rust ingestion pipeline and a query API. The design avoids separate graph databases and vector databases: PostgreSQL with `pgvector` HNSW indexes for semantic search, full-text search via `tsvector`, and Apache AGE Cypher for graph traversal handles all three query modes with acceptable performance at legal-corpus scale (tens of millions of blocks). The phase-1 cutover (issues #98–#103) made AGE the canonical graph store; the relational `links` table remains as the row-of-truth for edge metadata and edge-similarity ANN, but multi-hop graph reads run exclusively through Cypher.

---

## Data Model

### Core Principle

The atomic unit is a **block** — one paragraph, clause, or numbered line. Every block has a stable UUID, a vector embedding, its raw text, and positional metadata. All connections between blocks are stored as **links** in a separate edge table. Documents are metadata containers; all meaningful queries target blocks.

### Schema

```sql
-- Document registry: the logical identity of a document across all its versions
CREATE TABLE documents (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title              TEXT NOT NULL,
    source_path        TEXT,
    source_format      TEXT CHECK (source_format IN ('pdf', 'docx', 'markdown')),
    current_version_id UUID,                 -- FK set after first version inserted
    meta               JSONB,
    created_at         TIMESTAMPTZ DEFAULT now()
);

-- One row per ingested version of a document
CREATE TABLE document_versions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id        UUID NOT NULL REFERENCES documents(id),
    version_num   INTEGER NOT NULL,          -- 1, 2, 3 ...
    label         TEXT,                      -- "filed 2026-01-15", "redline v3"
    status        TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending', 'parsed', 'embedded', 'done', 'error')),
    ingested_at   TIMESTAMPTZ DEFAULT now(),
    meta          JSONB,
    UNIQUE (doc_id, version_num)
);

ALTER TABLE documents
    ADD CONSTRAINT fk_current_version
    FOREIGN KEY (current_version_id) REFERENCES document_versions(id)
    DEFERRABLE INITIALLY DEFERRED;

-- Blocks: immutable once created, content-addressed by hash
-- Unchanged blocks are shared across versions via version_blocks
CREATE TABLE blocks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id          UUID NOT NULL REFERENCES documents(id),
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,           -- SHA-256 of content; used for dedup on re-ingest
    block_type      TEXT NOT NULL,           -- paragraph, heading, list_item, table
    level           INTEGER,                 -- heading depth, null for non-headings
    line_start      INTEGER,
    line_end        INTEGER,
    eid             TEXT,                    -- Akoma Ntoso eId if source is AKN
    parent_block_id UUID REFERENCES blocks(id), -- lineage: prior version of this block
    embedding       vector(1536),
    tsv             TSVECTOR
                    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    meta            JSONB                    -- raw_refs, section context, page, etc.
);

CREATE INDEX ON blocks (doc_id, content_hash);
CREATE INDEX ON blocks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON blocks USING gin (tsv);
CREATE INDEX ON blocks (parent_block_id);

-- Junction table: maps versions to their ordered set of blocks
-- Unchanged blocks appear in multiple version rows with the same block_id
CREATE TABLE version_blocks (
    version_id    UUID NOT NULL REFERENCES document_versions(id),
    block_id      UUID NOT NULL REFERENCES blocks(id),
    seq           INTEGER NOT NULL,          -- ordering within this version
    PRIMARY KEY (version_id, block_id)
);

CREATE INDEX ON version_blocks (block_id);
CREATE UNIQUE INDEX ON version_blocks (version_id, seq);

-- Links: the graph edges between blocks
-- Because unchanged blocks share their UUID across versions,
-- their links are automatically inherited by every version that contains them
CREATE TABLE links (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    src           UUID NOT NULL REFERENCES blocks(id),
    dst           UUID NOT NULL REFERENCES blocks(id),
    layer         TEXT NOT NULL
                  CHECK (layer IN ('structural', 'semantic', 'ai')),
    rel_type      TEXT,                      -- cites, contradicts, elaborates, overrides, supports
    weight        FLOAT DEFAULT 1.0,
    confirmed     BOOLEAN,                   -- null=unreviewed, true=accepted, false=rejected
    provenance    JSONB NOT NULL,            -- {model, version, confidence, created_at}
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON links (src);
CREATE INDEX ON links (dst);
CREATE INDEX ON links (src, layer);
CREATE INDEX ON links (dst, layer);
```

### JSONB Usage

`meta` on blocks stores source-format-specific data that doesn't belong in typed columns:

```json
{
  "raw_refs": ["42 U.S.C. § 1983", "See ¶ 14 of Exhibit B"],
  "section_heading": "III. ARGUMENT",
  "page": 4,
  "akn_eid": "sec_3__para_2__subpara_a",
  "word_count": 87
}
```

`provenance` on links captures auditability:

```json
{
  "layer": "ai",
  "model": "claude-sonnet-4-6",
  "confidence": 0.91,
  "created_at": "2026-04-27T14:32:00Z",
  "prompt_version": "v2"
}
```

---

## Ingestion Pipeline

The ingestion pipeline is written in Rust using `tokio` for async I/O and `rayon` for CPU-bound parsing. It is a staged channel pipeline with bounded channels providing automatic backpressure.

### Stages

```
[Discoverer]          scans filesystem or queue for new documents
      │ mpsc::channel<DocPath> (bound: 64)
      ▼
[Reader]              reads raw bytes, dispatches by format
      │ mpsc::channel<RawDoc> (bound: 64)
      ▼
[Parser Pool]         format-specific parsers, spawn_blocking → rayon
      │ mpsc::channel<Vec<RawBlock>> (bound: 256)
      ▼
[Citation Extractor]  regex patterns resolve raw_refs to block candidates
      │ mpsc::channel<Vec<BlockWithRefs>> (bound: 256)
      ▼
[Embedder]            HTTP to embedding API, semaphore rate-limited
      │ mpsc::channel<Vec<Block>> (bound: 512)
      ▼
[Postgres Writer]     sqlx COPY protocol, batched inserts
```

Each stage is a `tokio::spawn` loop. Parsing is CPU-bound and dispatched to `rayon` via `spawn_blocking`. Embedding calls are I/O-bound and run concurrently behind a `tokio::sync::Semaphore` to respect API rate limits.

### Format Parsers

| Format | Approach |
|--------|----------|
| PDF | `pdftotext` (poppler) via `tokio::process::Command` for text; structure recovered via heuristics (line numbers, heading caps, indentation) |
| DOCX | `docx-rs` crate; heading styles map directly to `level`, paragraph styles to `block_type` |
| Markdown | `pulldown-cmark`; ATX headings, paragraphs, and list items are natural block boundaries |

All parsers emit the same `RawBlock` type. Format-specific metadata is preserved in `meta: JSONB`.

### Citation Extraction

After parsing, a regex pass over `content` extracts citation strings into `meta.raw_refs`. These are later resolved to target block UUIDs during a link-building pass. Resolution uses:

- Case citations (`Smith v. Jones, 123 F.3d 456`) matched against the block corpus by document title and block content
- Section/paragraph references (`¶ 14`, `§ 3.2`, `Exhibit B`) resolved against the same document's block index

Resolved citations become `layer: structural` links.

### Embedding

Blocks are embedded in batches via the configured embedding API (OpenAI `text-embedding-3-small` at 1536 dimensions, or a self-hosted model via compatible API). A `tokio::sync::Semaphore` caps concurrent requests. Embeddings are written to `blocks.embedding` as `pgvector` vectors.

### Versioning During Ingestion

When a new version of an existing document is ingested, the pipeline performs block-level diffing before inserting:

1. Parse the new document into `RawBlock` structs and compute `SHA-256(content)` for each.
2. Query `blocks WHERE doc_id = $id AND content_hash = ANY($hashes)` to find unchanged blocks.
3. **Unchanged blocks** — reuse the existing `block_id` in `version_blocks`. No re-embedding needed.
4. **Modified or new blocks** — insert a new `blocks` row. Set `parent_block_id` to the closest positional match from the prior version (matched by `seq`). Queue for embedding and AI linking.
5. **Deleted blocks** — simply absent from the new `version_blocks` entries; their rows and links are retained for historical queries.
6. Set `documents.current_version_id` to the new version after the pipeline completes.

This means structural and AI-inferred links on an unchanged block are inherited by the new version automatically — no re-linking pass required for the stable parts of a document.

### Idempotency

`document_versions.status` tracks pipeline progress per version. A crashed run resumes from the last completed stage. Blocks are inserted with `ON CONFLICT DO NOTHING` keyed on `(doc_id, content_hash)`. Version-block mappings use `ON CONFLICT DO NOTHING` on the `version_blocks` primary key.

---

## Query Modes

### Semantic Search

```sql
SELECT b.id, b.content, b.embedding <=> $1 AS distance
FROM blocks b
ORDER BY b.embedding <=> $1
LIMIT 20;
```

HNSW index makes this sub-millisecond at millions of rows.

### Full-Text Search

```sql
SELECT b.id, b.content, ts_rank(b.tsv, query) AS rank
FROM blocks b, plainto_tsquery('english', $1) query
WHERE b.tsv @@ query
ORDER BY rank DESC
LIMIT 20;
```

### Graph Traversal (multi-hop)

After the phase-1 AGE-default cutover (issues #98–#103) graph traversal runs
through Apache AGE Cypher against the `nexum_links` graph. The pre-cutover
recursive CTE over the `links` table has been deleted from production code.

```sql
SELECT block_id, depth, rel_type
FROM cypher('nexum_links', $$
    MATCH p = (a:Block {id: $seed})-[r:LINK*1..$max_hops]->(b:Block)
    WHERE ALL(rel IN relationships(p) WHERE rel.layer IN [$layers])
    RETURN b.id AS block_id, length(p) AS depth,
           last(relationships(p)).rel_type AS rel_type
$$) AS (block_id agtype, depth agtype, rel_type agtype);
```

Block content is hydrated from the relational store (`blocks` JOIN
`documents`) in a second batched query, keyed by the ids returned above.
See `src/routes/query.ts::graphSearch` for the production implementation,
including direction handling, layer/`rel_type` filters, and the
shortest-path collapse.

### Version-Aware Queries

**Blocks in the current version of a document:**
```sql
SELECT b.*, vb.seq
FROM blocks b
JOIN version_blocks vb ON vb.block_id = b.id
WHERE vb.version_id = (
    SELECT current_version_id FROM documents WHERE id = $1
)
ORDER BY vb.seq;
```

**Blocks in a specific historical version:**
```sql
SELECT b.*, vb.seq
FROM blocks b
JOIN version_blocks vb ON vb.block_id = b.id
WHERE vb.version_id = $version_id
ORDER BY vb.seq;
```

**Diff two versions — added, removed, and changed blocks:**
```sql
WITH v1 AS (
    SELECT block_id, seq FROM version_blocks WHERE version_id = $v1_id
),
v2 AS (
    SELECT block_id, seq FROM version_blocks WHERE version_id = $v2_id
)
SELECT
    COALESCE(v2.block_id, v1.block_id) AS block_id,
    CASE
        WHEN v1.block_id IS NULL THEN 'added'
        WHEN v2.block_id IS NULL THEN 'removed'
        ELSE 'unchanged'
    END AS change
FROM v1
FULL OUTER JOIN v2 USING (block_id);
```

**Lineage of a block through all versions:**
```sql
WITH RECURSIVE lineage AS (
    SELECT id, content, parent_block_id, 1 AS generation
    FROM blocks WHERE id = $1

    UNION ALL

    SELECT b.id, b.content, b.parent_block_id, l.generation + 1
    FROM blocks b
    JOIN lineage l ON b.id = l.parent_block_id
)
SELECT * FROM lineage ORDER BY generation DESC;
```

### Hybrid (semantic + graph neighborhood)

Find semantically similar blocks, then expand each result one hop through the graph to surface structurally related content:

```sql
WITH neighbors AS (
    SELECT id, content, embedding <=> $1 AS distance
    FROM blocks
    ORDER BY embedding <=> $1
    LIMIT 10
),
expanded AS (
    SELECT l.dst AS id, 'graph' AS origin
    FROM links l
    JOIN neighbors n ON l.src = n.id
    WHERE l.layer IN ('structural', 'ai')
)
SELECT b.*, n.distance, e.origin
FROM blocks b
LEFT JOIN neighbors n ON n.id = b.id
LEFT JOIN expanded e ON e.id = b.id
WHERE b.id IN (SELECT id FROM neighbors UNION SELECT id FROM expanded);
```

---

## Link Generation (Layer 3 — AI)

After embedding, a separate AI linker pass reads block pairs (seeded by semantic similarity candidates) and asks the LLM to classify the relationship. Only pairs above a similarity threshold are evaluated to bound cost.

The linker runs as an async Rust process calling the Anthropic API, writing results to `links` with `layer: 'ai'` and full provenance.

---

## Technology Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Database | PostgreSQL 16 | Single store for documents, vectors, and graph |
| Vector index | pgvector HNSW | Sub-ms ANN search, native Postgres |
| Full-text | tsvector (built-in) | No additional service |
| API server | TypeScript / Node.js ≥ 20 | `node:http` directly — no HTTP framework |
| PDF parsing | pdftotext (poppler) | Reliable for complex legal layouts; CLI already a prerequisite |
| DOCX parsing | `mammoth` (npm) | DOCX is ZIP + namespaced XML; correct extraction is ~500 LOC |
| Markdown | Line-by-line state machine | ~30 LOC; no parser library needed |
| DB driver | `pg` (npm) | PostgreSQL wire protocol; no ORM |
| Embeddings | `@xenova/transformers` — `all-MiniLM-L6-v2` | Local ONNX inference, CPU-bound, deterministic, 384-dim |
| AI linking | Cosine similarity + keyword heuristics | Deterministic, zero-cost; model can be swapped in later |
| Job queue | `SELECT ... FOR UPDATE SKIP LOCKED` | Postgres-native; no separate queue service |

### Language Policy

**TypeScript (Node.js) is the language for all runtime code** — the API server, ingestion pipeline, query layer, background workers, and linkers.

**Python is permitted only for benchmarking tools with unavoidable Python-ecosystem dependencies.** Specifically: evaluation harnesses in `experiments/` that require `torch`, `torch-geometric`, `beir`, `mteb`, `ogb`, `datasets`, or `sentence-transformers`. These tools exist to *measure* Nexum from the outside; they are not part of Nexum's runtime.

**Python is prohibited in:**
- The API server (`src/`)
- Ingestion workers
- Any code that runs as part of serving a request or background job

**The boundary is clear:** if it runs when a user or experiment hits the Nexum API, it is TypeScript. If it runs as an external evaluation harness that treats Nexum as a black box, Python is acceptable.

This rule exists because:
1. Mixed-language runtime boundaries add operational complexity (two process managers, two dependency trees, two failure modes)
2. Python subprocesses from Node introduce latency, startup cost, and serialization overhead that belong in benchmarks, not production paths
3. All embedding and link classification can be done in-process in TypeScript using ONNX Runtime (`@xenova/transformers`) without paid APIs or network calls

---

## Scalability Notes

- At legal-corpus scale (< 10M blocks), PostgreSQL handles all three query modes without a dedicated graph DB.
- Recursive CTE traversal degrades past 5–6 hops on dense graphs. For deeper traversal, Apache AGE (adds Cypher to Postgres) or an external graph DB (Kuzu) can be introduced later without changing the block/link schema.
- Embedding and AI linking are the pipeline bottlenecks. Both are horizontally scalable by running multiple ingestion worker processes against the same database, coordinated via `documents.status` row locking (`SELECT ... FOR UPDATE SKIP LOCKED`).

---

## Phase-1 Scout Seams (issue #78)

The phase-1 dev-scout pre-stubs three surfaces that downstream phase-1 issues
share. Nothing here implements feature behaviour; each seam exists so two
issues can develop in parallel against a fixed contract. Cross-references in
parentheses point to the implementation issues.

### 1. AGE migration shim (#75 owns the implementation; #6 consumes it)

- `docker-compose.yml` exposes a single Postgres service on port 5432 using
  `apache/age:PG16_latest` (issue #99 cutover). The image bundles the AGE
  extension; pgvector is loaded on top via the schema migration.
- `db/migrations/0001_age_shim.sql` is mounted into
  `/docker-entrypoint-initdb.d` and creates the AGE extension, a graph
  called `nexum_links`, and stub `Block` / `LINK` labels. It is guarded by
  `pg_available_extensions` so it remains safe to re-run.
- `db/schema.sql` adds `links.edge_embedding vector(384)` (nullable, no
  default). No code reads or writes it yet; #75 will populate it in the new
  edge-embedding ingest stage.

### 2. QA evaluation harness (#9 / #11)

- `src/eval/harness.ts` exports `QAExample`, `QAPrediction`, `QAScore`,
  `QAReport`, `QAMode`, `QAScorer`, `NullQAScorer`, and `aggregate`.
- `NullQAScorer` returns null for every dimension; #11 ships the real
  exact-match, F1, and citation-overlap scorers behind the same interface.
- `aggregate()` produces the report shape consumed by
  `experiments/_lib/results_writer.py`.

### 3. Per-stage ingest timing (#12 / #75)

- `src/ingest/timing.ts` exports a `timeStage(stage, ctx, fn)` wrapper that
  emits one JSON line per stage to stdout under the key
  `nexum_ingest_stage`. The default sink is swappable via `setStageSink`.
- The `IngestStage` union enumerates canonical stage names, including the
  not-yet-implemented `edge_embed` stage that #75 will populate.
- `src/routes/documents.ts` wraps the parse and hash stages today; #12 will
  extend coverage to embed / link / version stages without changing the call
  site contract.

---

## Phase-1 AGE-default cutover seams (issue #98)

A second phase-1 dev-scout pre-stubbed three surfaces shared by the
follow-on phase-1 implementation issues that cut the codebase from a
recursive-CTE posture over to Apache AGE as the default graph layer. The
seams below are the frozen contract those issues developed against. With
the cutover landed (#99 boot gate, #100 backfill, #101/#102 query ports,
#103 helper deletion) the seams are now the production surface.

Cross-references in parentheses point to the implementation issues.

### 1. `startupRequireAge()` boot hook (hardened by issue #99)

- `src/db/age.ts` exports `startupRequireAge(): Promise<StartupRequireAgeResult>`.
- `src/index.ts` invokes it after `migrate()` and before `server.listen()`.
- Phase-1 cutover (#99) made this a hard gate: it probes the configured
  Postgres for the `age` extension and throws when missing. The soft-fail
  / `optional` / `unavailable` branches were deleted; on a successful boot
  the only reachable mode is `required`. `NEXUM_REQUIRE_AGE=false` is
  reserved for unit tests that need the module loaded without an AGE
  Postgres present (mode `skipped`).
- The supported runtime image is `apache/age:PG16_latest`, which the only
  Postgres service in `docker-compose.yml` now uses.

### 2. `CypherGraphClient` interface (#4 / #5 / #6 consume it)

- `src/db/age.ts` exports the `CypherGraphClient` interface with four methods:
  `writeEdge(edge)`, `countEdges()`, `query<T>(cypher)`, `available()`.
- `createCypherGraphClient()` returns a thin adapter over the runtime
  `writeAgeEdge` / `countAgeEdges` helpers, so swapping a call site onto
  the interface is observably a no-op until the implementation issues land.
- The `AgeEdgeInput` payload mirrors the shape already accepted by
  `writeAgeEdge` so the structural and AI linker call sites can be swapped
  mechanically.
- Issues #101 (`graphSearch`) and #102 (`hybridSearch`) ported their
  traversals to Cypher against `nexum_links`. Issue #103 deleted the
  recursive-CTE helpers and the dual-write framing that the seams replaced.

### 3. `backfillLinksToAge()` migrate step (issue #100, shipped)

- `src/db/migrate.ts` exports `backfillLinksToAge(): Promise<BackfillLinksToAgeResult>`
  and calls it from the end of `migrate()` after `migrateAge()`.
- When AGE is unavailable the function short-circuits to
  `{ ok: true, copied: 0, skipped: 'age-unavailable' }` so the soft-fail
  contract for non-AGE deploys is preserved.
- When AGE is available the function streams every row of `links` through a
  server-side Postgres cursor (batch size 500) and replays each row into
  `nexum_links` as a `MERGE`-keyed `LINK` edge. The MERGE key is `link_id`
  so the AGE edge count is exactly the `links` row count, even if two rows
  collapse to the same `(src, dst, layer, rel_type)` tuple.
- Re-running `migrate()` against an already-backfilled graph is a no-op: the
  function compares `countEdges()` against the row count and skips the cursor
  scan when the graph already has at least one edge per row.
- Errors during backfill (including row-validation failures) propagate out of
  `migrate()` so operators see partial-state errors instead of a silently
  divergent graph.

### Cutover status

- Startup hard gate: shipped in #99.
- `links` → AGE backfill: shipped in #100.
- `graphSearch` / `hybridSearch` Cypher port: shipped in #101 / #102.
- Recursive-CTE helper + dual-write cleanup: shipped in #103.

---

## Phase-2 Scout Seams (issue #79)

The phase-2 dev-scout pre-stubs three surfaces shared by the Area-2/3/6/7
implementation issues. Nothing here implements feature behaviour; each seam
exists so two issues can develop in parallel against a fixed contract.
Cross-references in parentheses point to the implementation issues.

### 1. GPU runtime container spec (#13 / #18)

- `docker/Dockerfile.gpu` is the canonical SPEC of the GPU runtime image.
  It composes `apache/age:PG16_latest` (matching the phase-1 AGE shim) on
  top of `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04` and installs
  Python 3.11 + libpq.
- The scout does NOT build or push the image. CI is CPU-only; the first
  downstream issue that needs the runtime flips on a build/push step in
  `.github/workflows/experiments-harness.yml` and pins the
  torch / onnxruntime-gpu versions for its workload.
- Both #13 and #18 MUST consume this Dockerfile (or a child image FROM it)
  so the AGE / CUDA / Postgres versions stay in lockstep.

### 2. Inference-client interface (#10 / #14)

- `src/inference/client.ts` exports `InferenceClient`, `RetrievalMode`,
  `RetrievedBlock`, `RetrievalResult`, `EvidenceScore`, and a
  `StubInferenceClient` whose methods reject loudly.
- `RetrievalMode` discriminates `vector` / `graph` / `hybrid`. New modes
  added later MUST extend the union in `client.ts` before being referenced
  elsewhere.
- #10 ships an HTTP-backed retrieval client; #14 ships an in-process client
  that walks the curriculum graph. Both implement the same interface so the
  evaluator in `src/eval/harness.ts` can swap them without conditional logic.

### 3. GPU paging conventions

The GPU runtime image and any host that runs it MUST follow these mount
conventions so that downstream experiments can be moved between hosts
without code changes:

- `/var/cache/nexum/embed` — ephemeral embedding cache. SHOULD be backed by
  tmpfs in production; treated as scratch by all code that writes to it.
  Cache misses re-embed; nothing here is durable.
- `/var/cache/nexum/models` — model weight cache. SHOULD be a read-only
  bind mount in production so that swapping a checkpoint is a host-level
  operation, not a container rebuild.
- `/var/lib/postgresql/data` — the ONLY durable mount. AGE graph state and
  pgvector tables both live here. GPU experiments MUST NOT write durable
  state anywhere else; if they need to, they extend `db/schema.sql` and
  ride the standard migration path.
- Pinned host memory for GPU staging is sized at runtime via
  `--shm-size=2g` on `docker run`; the container itself does not assume a
  specific value. Issues #13 / #18 record the value they used in the
  experiment result JSON so reproducers can match it.

### 4. CI lint: phase-2 entries import the inference client

- `scripts/lint-phase2-inference-client.mjs` greps `experiments/area2-*`,
  `experiments/area3-*`, `experiments/area6-*`, and `experiments/area7-*`
  for any TypeScript entry that calls into an inference / retrieval / score
  function but does NOT import from `src/inference/client.ts`. The lint is
  a no-op while those experiment dirs are stub-only and exists so that the
  first real implementation lands behind the shared interface.

## Phase-3 InferenceClient default seams (issue #114)

The phase-3 dev-scout (#114) freezes the surface that #105/#106/#107/#108 plug
into so those four issues can develop in parallel without touching each
other's files. Nothing here changes runtime behaviour: every concrete client
ships as a "throws not-yet-implemented" stub; the existing AI linker keeps
running the inline `classifyPair` heuristic. The seams are:

### 1. `InferenceClient.classifyLink` (interface extension)

- `src/inference/client.ts` now exposes `classifyLink({ contentA, contentB,
  cosineSim }) → Promise<string | null>` on the `InferenceClient` interface,
  alongside the existing `embed`, `retrieve`, `score` methods. The return
  string is a `SIGNALS` key from `src/linker/ai.ts` (e.g. `'supports'`,
  `'contradicts'`); `null` means "no link".
- `StubInferenceClient.classifyLink` rejects loudly. #106 ports the linker's
  hot loop from `classifyPair` to `getDefaultInferenceClient().classifyLink`.

### 2. `LocalCpuInferenceClient` default backend (#105)

- `src/inference/local-cpu.ts` exports `LocalCpuInferenceClient`
  implementing the full `InferenceClient` surface; every method throws.
- Architecture constraint A4 (out-of-the-box default) and OD1 (opinionated
  defaults) require a CPU-friendly local model as the default so a fresh
  clone runs without API keys. #105 fills the methods using
  `@xenova/transformers` (already a dependency) — likely
  `Xenova/all-MiniLM-L6-v2` for embeddings.
- The class signature (constructor config, method signatures) is FROZEN by
  this scout. Widening or narrowing happens by editing
  `src/inference/client.ts` first so the lint catches drift.

### 3. Default-binding hook: `getDefaultInferenceClient()`

- `src/inference/index.ts` exports `getDefaultInferenceClient()`,
  `setDefaultInferenceClient(client)`, and `resetDefaultInferenceClient()`.
  The factory is memoised; the first resolution wins for the lifetime of
  the process.
- Selection consults `process.env.NEXUM_INFERENCE_BACKEND`:
    * `'stub'`       (today's `PHASE3_DEFAULT_BACKEND`) — returns
      `StubInferenceClient`. Preserves "no behaviour change" for #114.
    * `'local-cpu'`  — returns `LocalCpuInferenceClient`. #105 flips the
      `PHASE3_DEFAULT_BACKEND` constant once the real backend ships.
    * `'anthropic'` / `'openai'` — opt-in hosted-provider adapters
      (filled in by #108).
  Unknown values fall back to the default with one stderr warning.
- `src/linker/ai.ts` imports the hook and resolves the client at module
  init (`export const defaultInferenceClient = getDefaultInferenceClient()`).
  The hot loop still calls `classifyPair`; #106 swaps it to
  `defaultInferenceClient.classifyLink(...)`.

### 4. Hosted-provider adapter directory (#108)

- `src/inference/adapters/anthropic.ts` exports
  `AnthropicInferenceClient`; `src/inference/adapters/openai.ts` exports
  `OpenAiInferenceClient`. Both implement `InferenceClient` and throw on
  every method.
- API keys are read from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` by the
  real implementations. Embedding and retrieval likely delegate to the
  local-CPU client (Anthropic ships no first-party embeddings API);
  `classifyLink` and `score` go to the hosted model. #108 fills the
  adapters in.

### 5. Lint glob extension marker (#107)

- `scripts/lint-phase2-inference-client.mjs` carries a `TODO(#107)` comment
  on the `PHASE2_AREAS` constant. #107 broadens the glob from
  `experiments/area*` to all of `src/` so production code paths are held to
  the same seam discipline. Behaviour is unchanged in #114.
