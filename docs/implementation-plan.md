# Nexum — API Server Implementation Plan

## Context

The research program has complete experiment code (14 issues, all merged) but every experiment that calls Nexum's REST API mocks out `ConnectionError` — because there is no running API server. The schema exists (`db/schema.sql`), the engineering design exists (`docs/engineering.md`), and the product spec exists (`docs/product.md`). What's missing is the implementation.

This document is the build plan for the Nexum API server: the minimum viable system that lets the experiment code produce real results.

---

## Language and Stack Decision

Engineering.md specifies Rust + tokio for the ingestion pipeline. The README specifies Node.js ≥ 20. These are not contradictory: the API server and ingestion pipeline can be TypeScript now, with the CPU-bound parsing stages migrated to Rust later as the performance envelope tightens.

**Dependency principle:** only pull in a third-party package when the equivalent built-in implementation would be genuinely complex (>200 lines, meaningful correctness risk, or domain-specific format knowledge). Framework dependencies that wrap simple operations — HTTP routing, config parsing, job queues, API clients — are replaced with direct Node.js equivalents.

**No paid API dependencies.** OpenAI and Anthropic are excluded: they are metered, non-deterministic across runs, require network access, and introduce reliability risk for experiments that need reproducible results.

**Language policy: TypeScript only in the runtime.** Python is permitted only in `experiments/` for evaluation harnesses with unavoidable Python-ecosystem dependencies (torch, beir, ogb, etc.). No Python in the API server, ingestion pipeline, or any code path that runs when a request is served. See `docs/engineering.md` for the full rationale.

**Actual runtime dependencies (3 packages):**

| Package | Why it stays |
|---|---|
| `pg` | PostgreSQL wire protocol; no realistic built-in alternative |
| `mammoth` | DOCX is ZIP + namespaced XML; correct heading/paragraph extraction is ~500 LOC |
| `@xenova/transformers` | ONNX Runtime + model hub client; produces local CPU embeddings; not replicable in ~50 LOC |

**Everything else is Node built-ins:**

| Concern | Implementation | LOC |
|---|---|---|
| HTTP server + router | `node:http` + path/method dispatch table | ~40 |
| JSON body parsing | `async function readBody(req)` | ~10 |
| Environment config | Read `.env` with `node:fs`, `process.env` | ~10 |
| Job queue | `SELECT ... FOR UPDATE SKIP LOCKED` polling loop | ~60 |
| Markdown parsing | Line-by-line heading/paragraph state machine | ~30 |
| pgvector encoding | `[${vec.join(',')}]` string; `JSON.parse` on read | ~5 |
| SHA-256 content hash | `node:crypto` `createHash('sha256')` | ~3 |
| UUID generation | `node:crypto` `randomUUID()` | ~1 |

**Embeddings — `@xenova/transformers` (local ONNX, in-process):**
`@xenova/transformers` runs ONNX models entirely within the Node.js process using ONNX Runtime. No API key, no network call, no subprocess, no Python. The model (`Xenova/all-MiniLM-L6-v2`, 384 dims, ~25 MB) downloads from Hugging Face on first run and is cached locally. Subsequent loads are instant. Output is deterministic across runs — critical for reproducible experiment results.

```typescript
import { pipeline } from '@xenova/transformers'
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
const output = await embedder(texts, { pooling: 'mean', normalize: true })
// output.data is a Float32Array of shape [n_texts, 384]
```

This is the same model family the lab-bench experiments use (`all-MiniLM-L6-v2` via Python `sentence-transformers`), ensuring consistency between the API embeddings and the evaluation harness embeddings.

**AI linker — heuristics, no model:**
The AI linker is the third link layer (`layer: 'ai'`). For MVP, it does not need a language model. The research experiments (Area 2, Area 7) test whether better classification matters — so the MVP just needs a reasonable baseline. A cosine similarity threshold plus negation/support keyword detection produces useful `contradicts` / `supports` / `elaborates` / `none` classifications without any model.

```
contradicts:    sim > 0.7 AND block_b contains {not, however, contrary, but, instead, unlike}
supports:       sim > 0.7 AND block_b contains {similarly, also, furthermore, consistent, confirms}
elaborates:     sim > 0.7 AND block_b contains {specifically, for example, in particular, namely}
overrides:      sim > 0.7 AND block_b contains {supersedes, replaces, amends, notwithstanding}
is-exception-to: sim > 0.7 AND block_b contains {except, unless, provided that, subject to}
none:           sim ≤ 0.7 OR no keyword match
```

This is deterministic, zero-cost, and produces the typed link structure the experiments require. A better model can be swapped in later without API changes.

**Embedding dimension: 384 (configurable)**
`all-MiniLM-L6-v2` outputs 384 dimensions. The schema uses `vector(384)` by default. Override with `EMBEDDING_DIM` env var for future model changes. All three query modes work the same regardless of dimension.

**`package.json` devDependencies only:**
- `typescript`, `tsx`, `@types/node`, `@types/pg` — compile-time tooling
- `node:test` (built-in) for unit tests; `testcontainers` for integration tests against real Postgres

---

## Corpus Model

The product (`docs/product.md`) has corpora as first-class entities. The current schema has no corpus table. Every ingested document belongs to a corpus; every query targets a corpus. The schema needs a `corpora` table added, and `documents` needs a `corpus_id` foreign key.

The experiment code calls:
- `POST /corpora` — create a corpus
- `POST /documents` — ingest a document (with `corpus_id` in body)
- `POST /query` — query a corpus (with `corpus_id` and `mode`)
- `POST /blocks/embed` — embed raw text (MTEB adapter)
- `GET /health`

---

## Build Sequence

Issues are ordered by dependency. Issues within the same group can be worked in parallel.

### Group 0 — Foundation (blocks everything)
1. **Schema: add corpus table, external_id, and corpus_id FK** — migrate `db/schema.sql`; add `corpora` table, `corpus_id` on `documents`, `external_id` on `documents` (used by experiment adapters). Idempotent migration script.
2. **Dev environment: docker-compose + npm scaffold** — `docker-compose.yml` for Postgres 16 + pgvector; `package.json` with Fastify, pg, openai, anthropic, vitest; `tsconfig.json`; `src/` directory structure; `npm run dev` starts the server.

### Group 1 — API Skeleton (parallel after Group 0)
3. **HTTP server: Fastify scaffold, health endpoint, error handling** — `src/server.ts`, plugin registration, JSON schema validation, global error handler, `GET /health`, environment config via `dotenv`.
4. **Database client: connection pool, migration runner** — `src/db/pool.ts` wrapping `pg.Pool`; `src/db/migrate.ts` that applies `db/schema.sql` on startup (idempotent); typed query helpers.

### Group 2 — Corpus and Document APIs (parallel after Group 1)
5. **Corpus management: POST /corpora, GET /corpora/:id** — create, read corpus records; return `{id, name, created_at}`; 404 on missing. No auth yet.
6. **Document ingest: POST /documents (text + markdown)** — accept `{corpus_id, title, content, format, external_id?}` for plaintext and markdown formats; parse into blocks using `unified`/`remark-parse`; insert document + version + blocks (with dedup via `content_hash`); return `{id, version_id, block_count, status: "pending_embed"}`.

### Group 3 — Parsing (parallel after Group 2)
7. **Document ingest: PDF support** — shell out to `pdftotext`; heuristic block boundary detection (blank lines, indentation); parse result into blocks; plug into the same ingest pipeline.
8. **Document ingest: DOCX support** — `mammoth` for paragraph/heading extraction; map heading levels to `block_type`/`level`; plug into ingest pipeline.

### Group 4 — Embedding (blocks query API)
9. **Embedding pipeline: OpenAI batched embedding with pg-boss queue** — after block insertion, enqueue an embedding job via `pg-boss`; worker calls `openai.embeddings.create` in batches of 96; writes vectors back to `blocks.embedding`; updates `document_versions.status` to `"embedded"` when all blocks in version are done. `POST /blocks/embed` (synchronous, single text) for the MTEB adapter.

### Group 5 — Query API (parallel after Group 4)
10. **Query API: semantic search** — `POST /query` with `{corpus_id, query, mode: "semantic", limit}`: embed the query string; `ORDER BY embedding <=> $vec LIMIT $n`; return `[{block_id, content, score, document: {id, title, external_id}}]`.
11. **Query API: full-text search** — `mode: "fulltext"`: `plainto_tsquery` + `ts_rank`; same response shape.
12. **Query API: graph traversal** — `mode: "graph"`: requires `seed_block_id` + optional `{layers, rel_types, max_hops}`; recursive CTE from `links`; returns blocks with depth and `rel_type`. `mode: "hybrid"`: semantic ANN then one-hop graph expansion.

### Group 6 — Linking (parallel after Group 4)
13. **Structural linker: citation extraction and link creation** — regex pass over block content for `§ N`, `¶ N`, `See [block]`, and case citation patterns; resolve to target block UUIDs within the same corpus; insert `links` rows with `layer: "structural"`, `rel_type: "cites"`, full provenance. Run as a `pg-boss` job after embedding.
14. **AI linker: Anthropic link classification** — for each block pair above a cosine similarity threshold (> 0.85), call Claude Haiku with a structured prompt to classify relationship as `contradicts | supports | elaborates | overrides | is-exception-to | none`; insert `links` rows with `layer: "ai"`, full provenance. Rate-limited background worker via `pg-boss`.

### Group 7 — Access Control (parallel after Group 2)
15. **Entity model and scope-based auth** — `entities` table (users + agents); API key authentication via `Authorization: Bearer <key>`; scope checks on corpus access (`corpus:read`, `corpus:write`); middleware that attaches `req.principal` to every request. No-auth mode for local dev (`NEXUM_AUTH=off`).

### Group 8 — Integration Tests and Polish
16. **Integration test suite** — `vitest` tests using `testcontainers` to spin up Postgres 16 + pgvector; cover the full ingest → embed → link → query cycle for each query mode; assert block dedup across document versions; assert structural links are created correctly; assert graph traversal returns correct hop depths.
17. **Developer experience: seed data, API docs, npm scripts** — `npm run seed` loads 10 CUAD contracts into a local corpus (uses the lab-bench fixture); OpenAPI spec auto-generated from Fastify schemas; `npm run dev` with `tsx --watch` hot-reload.

---

## API Contract (Endpoints the Experiments Expect)

```
GET  /health                        → {status: "ok", db: "connected"}

POST /corpora                       → {id, name, created_at}
GET  /corpora/:id                   → {id, name, document_count, block_count}

POST /documents                     → {id, version_id, block_count, status}
  body: {corpus_id, title, content, format, external_id?, meta?}

POST /query                         → {results: [{block_id, content, score, document, links?}]}
  body: {corpus_id, query, mode, limit?, seed_block_id?, max_hops?, layers?, rel_types?}

POST /blocks/embed                  → {embedding: float[]}
  body: {text}

GET  /blocks/:id                    → {id, content, embedding?, links, document, version}
GET  /blocks/:id/links              → [{id, dst, layer, rel_type, weight, provenance}]
```

---

## Non-Goals (Out of Scope for This Plan)

- Synthesis API (`POST /synthesize`, quorum voting) — product feature, not needed for experiments
- Block-level access control beyond corpus-level — implement entity/scope model in issue #15, full block-level ACL later
- Horizontal scaling / multi-worker — single process is fine; `pg-boss` supports multi-worker later with no API changes
- GPU-accelerated embedding — OpenAI API for now; pluggable in issue #9
- Rust ingestion rewrite — the TypeScript pipeline is the target; Rust migration is a future performance optimization

---

## File Structure

```
nexum/
├── db/
│   └── schema.sql                  # extended with corpora table (issue #20)
├── src/
│   ├── server.ts                   # Fastify app, plugin registration
│   ├── config.ts                   # env vars (DATABASE_URL, OPENAI_API_KEY, etc.)
│   ├── db/
│   │   ├── pool.ts                 # pg.Pool singleton
│   │   └── migrate.ts              # apply schema.sql on startup
│   ├── routes/
│   │   ├── health.ts
│   │   ├── corpora.ts              # issue #22
│   │   ├── documents.ts            # issues #23, #24, #25
│   │   ├── query.ts                # issues #27, #28, #29
│   │   └── blocks.ts               # block read, embed endpoint
│   ├── ingest/
│   │   ├── parse-markdown.ts       # issue #23
│   │   ├── parse-pdf.ts            # issue #24
│   │   ├── parse-docx.ts           # issue #25
│   │   └── dedup.ts                # content-hash dedup logic
│   ├── embed/
│   │   └── worker.ts               # issue #26 — pg-boss embedding worker
│   ├── linker/
│   │   ├── structural.ts           # issue #30
│   │   └── ai.ts                   # issue #31
│   └── auth/
│       └── middleware.ts           # issue #32
├── tests/
│   ├── integration/
│   │   └── ingest-query.test.ts    # issue #33
│   └── unit/
├── docker-compose.yml              # issue #21
├── package.json
└── tsconfig.json
```

---

## Issue Map

| # | Group | Issue | Blocks |
|---|---|---|---|
| 20 | 0 | Schema: corpus table + external_id migration | Everything |
| 21 | 0 | Dev environment: docker-compose + npm scaffold | Group 1+ |
| 22 | 1 | HTTP server: Fastify scaffold + health endpoint | Group 2+ |
| 23 | 1 | DB client: connection pool + migration runner | Group 2+ |
| 24 | 2 | Corpus management: POST /corpora, GET /corpora/:id | Group 3+ |
| 25 | 2 | Document ingest: text + markdown parsing | Group 3+ |
| 26 | 3 | Document ingest: PDF support | — |
| 27 | 3 | Document ingest: DOCX support | — |
| 28 | 4 | Embedding pipeline: pg-boss worker + POST /blocks/embed | Group 5 |
| 29 | 5 | Query API: semantic search | — |
| 30 | 5 | Query API: full-text search | — |
| 31 | 5 | Query API: graph traversal + hybrid | — |
| 32 | 6 | Structural linker: citation extraction + link creation | — |
| 33 | 6 | AI linker: Anthropic link classification worker | — |
| 34 | 7 | Entity model + scope-based auth middleware | — |
| 35 | 8 | Integration test suite | — |
| 36 | 8 | Developer experience: seed data + OpenAPI + npm scripts | — |
