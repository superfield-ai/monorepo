# Recommended Postgres Config for Nexum HNSW (G1-OPT-1, issue #73)

This file is the **deployment-time** Postgres configuration that the G1-OPT-1
diagnosis recommends for serving semantic ANN over the Nexum block table at
1M+ blocks with 384-dim embeddings (`all-MiniLM-L6-v2`). It is the
authoritative reference for `docker-compose.yml`, the `db/schema.sql` HNSW
parameters, and the deployment guide.

## Fixed by issue #73 root cause

PR #72 measured P99 = 2424 ms because **no HNSW index existed** on
`blocks.embedding` when the benchmark ran. Every ANN query degraded to a
parallel sequential scan over 1M × 384-dim vectors (3.0 s in EXPLAIN
ANALYZE; see `results/explain/no_index_baseline.txt`). The schema's
`CREATE INDEX blocks_embedding_hnsw_idx` line was being skipped by the
benchmark's schema loader at the time, leaving the table un-indexed.

Two fixes are required:

1. **Schema enforcement** — the benchmark must verify the HNSW index exists
   after `ensure_schema()` and raise loudly if missing. (Fix landed in
   PR #72; verified by this issue.)
2. **Deployment defaults** — operators must run with the memory and HNSW
   parameters below, not stock `shared_buffers=128MB`.

## Recommended `postgresql.conf` overrides

| Parameter | Recommended | Stock | Rationale |
|---|---|---|---|
| `shared_buffers` | **1 GB** | 128 MB | HNSW index for 1M × 384-dim float32 ≈ 700 MiB; must fit in shared_buffers. |
| `maintenance_work_mem` | **2 GB** | 64 MB | HNSW build at 1M tuples needs ≥ 1 GB or build time goes from minutes to hours (we observed `hnsw graph no longer fits into maintenance_work_mem after 238 373 tuples` at 512 MB). |
| `max_parallel_maintenance_workers` | **4** | 2 | Parallel HNSW build is roughly linear in worker count up to 4. |
| `work_mem` | **64 MB** | 4 MB | ANN queries with `LIMIT 10` only need a small top-N heap, but graph-traversal CTEs benefit. |
| `effective_cache_size` | **4 GB** | 4 GB (matches Docker default) | Hint to planner that page cache is large; encourages index scans over seq scans. |
| `random_page_cost` | **1.1** | 4.0 | SSD-backed deployments — discourages the planner from preferring seq scan over HNSW. |
| `hnsw.ef_search` | **40** (default) | 40 | Tuned via the sweep in `g1-opt-1.json`; higher values traded a few ms of P99 for marginal recall gains. |

The `--shm-size=2g` Docker flag is also required when running pgvector under
Docker — the default 64 MiB `/dev/shm` is too small for parallel HNSW
builds with `maintenance_work_mem ≥ 1 GB`.

## Recommended HNSW index DDL

```sql
SET maintenance_work_mem = '2GB';
SET max_parallel_maintenance_workers = 4;

CREATE INDEX blocks_embedding_hnsw_idx
  ON blocks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

The `m` and `ef_construction` choices follow the diagnosis sweep
(see `experiments/g1-postgres-scale/results/g1-opt-1.json`):

- `m = 16` is the pgvector default and produced the best
  latency/recall trade-off at 1M scale. `m = 8` halved the index size
  but dropped recall@10 below the 0.90 floor at `ef_search = 40`.
- `halfvec` quantization (`ALTER COLUMN embedding TYPE halfvec(384)`) is
  a forward-looking option for ≥ 5M scale, where the float32 index
  exceeds 4 GiB and `shared_buffers` becomes the binding constraint.
  At 1M blocks float32 still fits in 1 GiB shared_buffers, so we did
  not require quantization for the gate.

## ef_search tuning guidance

The diagnosis swept `ef_search ∈ {20, 40, 80, 200}` at 1M blocks.
Operators serving recall-critical workloads (legal citation lookup,
medical evidence retrieval) should set `hnsw.ef_search = 80` per
session. The default `40` is acceptable for general retrieval.

## Verification command

After deploying, confirm the index exists and is being used:

```sql
\di+ blocks_embedding_hnsw_idx
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM blocks
ORDER BY embedding <=> (SELECT embedding FROM blocks LIMIT 1)
LIMIT 10;
```

The plan **must** include `Index Scan using blocks_embedding_hnsw_idx`
and `Buffers: shared hit=...` should dominate `read=...` (cache hits >
disk reads). If you see `Seq Scan on blocks`, the index is missing or
the planner has rejected it — check `random_page_cost` and ANALYZE the
table.
