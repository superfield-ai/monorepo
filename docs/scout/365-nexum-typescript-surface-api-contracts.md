# Scout: Nexum TypeScript Surface, API Contracts, and Consumers

**Issue:** #365
**Phase:** Nexum in Rust
**Feeds:** Rust `crates/nexum` port, `crates/api` HTTP router, #366 (ingestion pipeline), #367 (query layer), #368 (schema migration)

---

## Summary

Nexum is the company knowledge graph service (`superfield-ai/nexum`), written in
TypeScript/Node.js. This scout maps its HTTP API surface, internal module seams,
database schema, and every consumer so that the Rust port preserves all
contracts without regression.

The TypeScript surface breaks into three layers:

1. **HTTP API** — Express routes served by `src/index.ts`
2. **Internal modules** — ingestion, embedding, linker, query, DB adapters
3. **CLI-side shim** — `packages/db/nexum-graph.ts` (graph traversal helper that
   lives in this repo, not in `superfield-ai/nexum`)

---

## HTTP API Surface (`superfield-ai/nexum/src/routes/`)

All routes are mounted under `http://localhost:<NEXUM_PORT>` (default: `3000`).
No independent auth layer — corpus-level access tokens are passed via
`Authorization: Bearer <token>` header; validated against `nexum.corpus_access`.

### Corpus management

| Method | Path                  | Request body                             | Response body                           | Notes                       |
| ------ | --------------------- | ---------------------------------------- | --------------------------------------- | --------------------------- |
| POST   | `/corpora`            | `{ name: string, description?: string }` | `{ id, name, description, created_at }` | Create a new corpus         |
| GET    | `/corpora`            | —                                        | `{ corpora: Corpus[] }`                 | List all corpora            |
| GET    | `/corpora/:id`        | —                                        | `Corpus`                                | Fetch one corpus            |
| DELETE | `/corpora/:id`        | —                                        | `204 No Content`                        | Delete corpus + cascade     |
| POST   | `/corpora/:id/access` | `{ token: string, scopes: string[] }`    | `{ id, corpus_id, token, scopes }`      | Issue a corpus access token |

### Document ingestion

| Method | Path                            | Request body                                                  | Response body                 | Notes                                       |
| ------ | ------------------------------- | ------------------------------------------------------------- | ----------------------------- | ------------------------------------------- |
| POST   | `/corpora/:id/documents`        | `{ source_path: string, content: string, metadata?: object }` | `{ document_id, version_id }` | Ingest a document; triggers embed job       |
| GET    | `/corpora/:id/documents`        | —                                                             | `{ documents: Document[] }`   | List documents in corpus                    |
| GET    | `/corpora/:id/documents/:docId` | —                                                             | `Document` + `versions[]`     | Fetch document with version history         |
| PUT    | `/corpora/:id/documents/:docId` | `{ content: string, metadata?: object }`                      | `{ version_id }`              | Update document content; triggers embed job |
| DELETE | `/corpora/:id/documents/:docId` | —                                                             | `204 No Content`              | Delete document + cascade                   |

### Block and link query

| Method | Path                           | Request body / query params                                    | Response body                       | Notes                                              |
| ------ | ------------------------------ | -------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| GET    | `/corpora/:id/blocks`          | `?limit&offset`                                                | `{ blocks: Block[] }`               | Paginated block list for corpus                    |
| GET    | `/corpora/:id/blocks/:blockId` | —                                                              | `Block`                             | Fetch one block                                    |
| POST   | `/corpora/:id/query`           | `{ q: string, limit?: number, layer?: string }`                | `{ results: BlockSearchResult[] }`  | Semantic search (cosine ANN on `blocks.embedding`) |
| POST   | `/corpora/:id/links`           | `{ src: string, dst: string, layer: string, weight?: number }` | `{ id, src, dst, layer, weight }`   | Create a directed link between blocks              |
| GET    | `/corpora/:id/graph`           | `?start=<blockId>&depth=<n>&layer=<l>`                         | `{ nodes: Block[], edges: Link[] }` | Multi-hop graph traversal (recursive CTE; no AGE)  |
| DELETE | `/corpora/:id/links/:linkId`   | —                                                              | `204 No Content`                    | Delete link                                        |

### Entity management

| Method | Path                    | Request body                                        | Response body            | Notes                              |
| ------ | ----------------------- | --------------------------------------------------- | ------------------------ | ---------------------------------- |
| POST   | `/corpora/:id/entities` | `{ name: string, type: string, block_id?: string }` | `Entity`                 | Register a named entity            |
| GET    | `/corpora/:id/entities` | `?type=<t>`                                         | `{ entities: Entity[] }` | List entities (optionally by type) |

### Job queue / ingestion status

| Method | Path    | Query params              | Response body     | Notes                                        |
| ------ | ------- | ------------------------- | ----------------- | -------------------------------------------- |
| GET    | `/jobs` | `?corpus_id&status&limit` | `{ jobs: Job[] }` | Inspect pending / in-progress embedding jobs |

---

## Internal Module Seams (`superfield-ai/nexum/src/`)

```
src/
  index.ts              # Express server bootstrap; mounts routes; starts worker
  routes/
    corpora.ts          # /corpora CRUD
    documents.ts        # /corpora/:id/documents CRUD + version history
    blocks.ts           # /corpora/:id/blocks + /query
    links.ts            # /corpora/:id/links + /graph
    entities.ts         # /corpora/:id/entities
    jobs.ts             # /jobs status endpoint
  db/
    migrate.ts          # Idempotent SQL runner (reads db/schema.sql; no version table)
    pool.ts             # pg.Pool singleton; reads DATABASE_URL env var
    age.ts              # Lazy AGE second-Postgres pool (guarded; silent no-op if unset)
    migrate-age.ts      # Applies db/migrations/0001_age_shim.sql against AGE_DATABASE_URL
  embeddings/
    embed.ts            # Xenova/all-MiniLM-L6-v2 ONNX inference → float32[384]
    queue.ts            # Background worker: drains nexum.job_queue; calls embed.ts
  linker/
    linker.ts           # Heuristic + threshold-based link creation after ingest
  services/
    corpus.ts           # Business logic for corpus CRUD + access-token validation
    document.ts         # Document ingest, versioning, block chunking
    block.ts            # Block retrieval + ANN search (pgvector cosine)
    link.ts             # Link creation, weight update, graph traversal delegation
    entity.ts           # Entity extraction + registration
```

### Key internal contracts

| Module seam           | TypeScript signature (abbreviated)                                         | Port-risk note                                                                   |
| --------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `embeddings/embed.ts` | `embed(text: string): Promise<Float32Array>` → 384-dim f32                 | Must match model output exactly; governed by `GOVERNED_EMBEDDING` constant       |
| `embeddings/queue.ts` | Worker polls `nexum.job_queue` WHERE `status = 'pending'` ORDER BY created | Rust port: `tokio::task` + `sqlx` SELECT FOR UPDATE SKIP LOCKED                  |
| `linker/linker.ts`    | Called after every successful document ingest                              | Produces `(src, dst, layer, weight)` tuples; inserts into `nexum.links`          |
| `db/pool.ts`          | Singleton `pg.Pool`; `DATABASE_URL` required                               | Replace with `sqlx::PgPool` from `crates/db`                                     |
| `db/age.ts`           | `writeAgeEdge(src, dst)` — dual-write path; silently no-op without AGE_URL | **Removed in #359** — closed by recursive CTEs in `packages/db/nexum-graph.ts`   |
| `services/block.ts`   | `searchBlocks(corpusId, embedding, limit)` — pgvector `<=>` operator       | Requires `pgvector` extension; `crates/nexum` query layer must use same operator |

---

## Database Schema (`nexum` PostgreSQL schema)

```sql
nexum.corpora           (id, name, description, created_at)
nexum.corpus_access     (id, corpus_id, token, scopes[], created_at)
nexum.documents         (id, corpus_id, source_path, metadata, created_at)
nexum.document_versions (id, doc_id, content_hash, created_at)
nexum.blocks            (id, doc_version_id, content, embedding vector(384), created_at)
nexum.version_blocks    (version_id, block_id, position)
nexum.links             (id, src text→blocks.id, dst text→blocks.id, layer, weight numeric, edge_embedding vector(384), confirmed bool)
nexum.entities          (id, corpus_id, name, type, block_id→blocks.id, created_at)
nexum.job_queue         (id, corpus_id, doc_version_id, status, error, created_at, processed_at)
```

**Vector columns:**

| Table    | Column           | Dimensions | Index                 | Status                         |
| -------- | ---------------- | ---------- | --------------------- | ------------------------------ |
| `blocks` | `embedding`      | 384        | HNSW cosine           | Live (conforming, `#360`)      |
| `links`  | `edge_embedding` | 384        | HNSW cosine (planned) | Stub — not populated until #75 |

**Extensions required:** `pgcrypto`, `vector` (`pgvector/pgvector:pg16` image).

---

## CLI-Side Shim (`packages/db/nexum-graph.ts`)

This file lives in `superfield-ai/superfield-cli-ts` (this repo). It is NOT part
of the `superfield-ai/nexum` service; it is the local graph-traversal helper
that replaced the AGE second-Postgres dependency (issue #359).

**Exported surface:**

| Export                  | TypeScript signature                                                                                           | Purpose                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `NEXUM_GRAPH_SETUP_SQL` | `string` — DDL for `nexum.blocks` + `nexum.links` + indexes                                                    | Applied once at bootstrap to enable local graph traversal |
| `GraphEdge`             | `{ src, dst, layer, weight, confirmed }`                                                                       | Type alias for a link row                                 |
| `GraphTraversalResult`  | `{ blockId: string, depth: number }`                                                                           | Return type of `traverseGraph()`                          |
| `traverseGraph()`       | `(client: Client, startBlockId: string, maxDepth?: number, layer?: string) => Promise<GraphTraversalResult[]>` | Recursive CTE multi-hop traversal                         |
| `isGraphReady()`        | `(client: Client) => Promise<boolean>`                                                                         | Check that `nexum.links` table exists                     |

**Consumers in this repo:**

| File                                                     | Usage                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/db/tests/nexum-graph.test.ts`                  | Integration test suite (single-Postgres proof)                   |
| `packages/db/index.ts` (re-exports via `nexum-graph.ts`) | Exposes `NEXUM_GRAPH_SETUP_SQL`, `traverseGraph`, `isGraphReady` |

---

## Consumer Map

### Consumers of `superfield-ai/nexum` HTTP API

| Consumer                  | Location                         | Routes used                  | Notes                                                                     |
| ------------------------- | -------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| **CLI planning loop**     | `packages/core/steps/`           | Not yet wired (Phase 2)      | Phase D-2 deliverable: `packages/nexum/` corpus client into planning loop |
| **Control UI**            | `packages/control/`              | Not yet wired (Phase 2)      | Phase D-2: Nexum-backed semantic search in Studio UI                      |
| **Sharp cross-component** | `superfield-ai/sharp` (external) | DB join only — no HTTP calls | Sharp joins `nexum.blocks` in SQL; no direct HTTP dependency              |

**Finding:** No consumer in this repo makes HTTP calls to the Nexum service today. All
integration is at the SQL level (cross-schema joins), not the HTTP API level. The HTTP
API is currently consumed only by external scripts and future Phase D-2 features.

### Consumers of `packages/db/nexum-graph.ts` (CLI-side shim)

| Consumer                                | Type      | Notes                                    |
| --------------------------------------- | --------- | ---------------------------------------- |
| `packages/db/tests/nexum-graph.test.ts` | Test      | Integration test; requires Docker        |
| `packages/db/index.ts`                  | Re-export | Makes shim available as `@superfield/db` |

---

## Port-Risk Notes

| #   | Risk                                                      | Severity | Recommendation                                                                                                                          |
| --- | --------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Embedding parity** — Xenova/all-MiniLM-L6-v2 in Node.js | High     | Rust `crates/sf-embed` must produce byte-identical `[f32; 384]` vectors; run cross-language cosine parity test before ingest port lands |
| 2   | **Job queue worker** — `SELECT FOR UPDATE SKIP LOCKED`    | High     | Rust worker must use the same locking strategy; `sqlx` supports this natively                                                           |
| 3   | **Idempotent migration runner** — no version table        | Medium   | Port must convert to versioned migrations (numbered SQL files + `schema_migrations` table) per #368 and #386 findings                   |
| 4   | **`corpus_access` token validation** — inline in routes   | Medium   | Auth logic is scattered across route handlers, not in middleware; consolidate into `crates/auth` middleware in the Rust port            |
| 5   | **`links.edge_embedding`** — stub column, not populated   | Low      | Phase 2 / issue #75; Rust port should treat this column as nullable and not require embeddings for link queries                         |
| 6   | **Block chunking strategy** — in `services/document.ts`   | Low      | The chunking logic (fixed-size or sentence-boundary) must be preserved to avoid reindexing existing corpora                             |

---

## Integration Points for Downstream Issues

- **#366 (Rust ingestion pipeline):** implement `POST /corpora/:id/documents`, block
  chunking, and the `job_queue` worker using `crates/db` pool and `crates/sf-embed`.
- **#367 (Rust query layer):** implement `POST /corpora/:id/query` (pgvector ANN) and
  `GET /corpora/:id/graph` (recursive CTE traversal identical to `traverseGraph()` in
  `packages/db/nexum-graph.ts`).
- **#368 (schema migration):** convert idempotent SQL runner to versioned numbered files;
  `nexum` schema is authoritative source for tables listed in §Database Schema above.
- **`crates/nexum/src/lib.rs`:** currently a stub — downstream issues mount route
  handlers via `superfield::mount_nexum()` once the Rust port provides its service interface.

---

## Canonical Docs References

- `docs/architecture.md` §Namespaced schema layout, §AGE graph extension, §Governed Embedding Standard
- `docs/scout/386-postgres-provisioning-migration-schemas.md` — migration runner details
- `docs/scout/387-existing-service-runtimes-and-shared-boundaries.md` — runtime inventory
- `packages/db/nexum-graph.ts` — CLI-side graph traversal shim
- `packages/db/tests/nexum-graph.test.ts` — integration test covering recursive CTE parity
- `crates/nexum/src/lib.rs` — Rust stub awaiting this port
- `superfield-ai/nexum`: `src/routes/`, `src/embeddings/`, `src/linker/`, `db/schema.sql`
