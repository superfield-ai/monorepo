# G1 — Postgres Scale Floor Benchmark

**Gate:** G1 — Does Postgres + pgvector serve as the storage layer for Nexum at target corpus scale?

**Hypothesis:** H1.1 — PostgreSQL with pgvector is sufficient for corpora below 20M blocks with mixed document types, with no measurable query quality degradation vs. a specialized graph DB.

**Phase:** 0, Spike B (see `docs/research.md` → Phase 0 → Spike B)

**Pass criterion:** P99 query latency < 500 ms at 5M blocks for all three query modes (semantic, full-text, graph traversal).

---

## Prerequisites

- Python ≥ 3.10
- PostgreSQL ≥ 16 with the `pgvector` extension
- (No OpenAI key needed — synthetic embeddings only)

### Install Postgres + pgvector

```bash
# Ubuntu / Debian
sudo apt install postgresql-16 postgresql-16-pgvector

# macOS
brew install postgresql@16
brew install pgvector
```

### Create the benchmark database

```bash
createdb nexum_bench
```

The benchmark applies the Nexum schema automatically (`db/schema.sql`) before each run.

### Install Python dependencies

```bash
pip install -e ".[dev]"
# or:
pip install psycopg2-binary pgvector numpy tqdm faker pytest
```

---

## Running the Benchmark

```bash
# From this directory:
python run_benchmark.py \
    --db-url postgresql://localhost/nexum_bench \
    --scales 1m 5m \
    --n-queries 100 \
    --output results/g1_result.json
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--db-url` | `postgresql://localhost/nexum_bench` | Postgres connection URL |
| `--scales` | `1m 5m` | Corpus sizes (e.g. `1m 5m 20m`; `m` = millions) |
| `--n-queries` | `100` | Queries per mode per scale |
| `--domain-mix` | `mixed` | Synthetic corpus domain: `legal`, `medical`, `mixed` |
| `--embedding-dim` | `1536` | Embedding dimensionality |
| `--batch-size` | `1000` | Rows per `execute_values` call |
| `--output` | `results/g1_result.json` | Output JSON path |
| `--skip-schema` | (flag) | Skip schema creation if already applied |

### Example output

```
[G1] Connecting to 'postgresql://localhost/nexum_bench' …
[G1] Applying schema …
[G1] === Scale: 1M blocks ===
[G1] Truncating existing data …
[G1] Ingesting 1000000 blocks (domain_mix=mixed) …
[G1] Ingest done in 142.3s — 1,000,000 blocks, 10,000,000 links, 8.12 GB total, 6.14 GB embeddings
[G1] Running latency benchmark (100 queries/mode) …
[G1] 1M → PASS
       semantic:  P50=18.2ms   P99=42.1ms
       fulltext:  P50=3.1ms    P99=11.4ms
       graph 2h:  P50=8.7ms    P99=28.3ms
       graph 4h:  P50=19.4ms   P99=61.2ms
       graph 6h:  P50=38.1ms   P99=142.0ms

[G1] Results written to results/g1_result.json
[G1] Overall G1 gate: PASS
```

Exit code 0 = G1 PASS; exit code 1 = G1 FAIL (P99 ≥ 500 ms).

---

## Running Tests (no database required)

```bash
pytest tests/ -v
```

All 30 tests pass without a running database. The test suite mocks all psycopg2
calls and validates:

1. **Sizing memo arithmetic** — 1M × 1536 × 4 = 6,144,000,000 bytes (H1.3 resolved as arithmetic)
2. **Embedding fraction > 70%** — validates H1.3 claim across all scales
3. **Benchmark dict structure** — all required keys present in return value
4. **Pass/fail logic** — P99 = 499 ms → pass; P99 = 500 ms or 501 ms → fail
5. **Percentile computation** — P50/P99 correctness with hand-crafted inputs
6. **Ingest batch size** — `execute_values` is called in batches, not one row at a time

---

## Results

Pre-generated sizing memo: [`results/sizing_memo.md`](results/sizing_memo.md)

The sizing memo resolves **H1.3** (embedding storage dominance) as arithmetic:
at 1536 dims, embeddings are ~75% of total DB size across all scales. This
motivates int8 quantization (4× storage reduction) and informs the GPU paging
strategy in Area 6 (H6.5, H6.6).

Live benchmark results (requires Postgres) are written to `results/g1_result.json`
after each run.

---

## Architecture Notes

- **Synthetic embeddings:** Random unit-normalised float32 vectors. This tests
  Postgres/pgvector indexing and query throughput, not embedding quality.
- **Schema:** The full Nexum schema (`db/schema.sql`) is applied before each run.
  Tables are truncated between scale steps to avoid cross-contamination.
- **Link density:** ~10 links per block (mix of structural/semantic/ai), matching
  the expected production density for a typical legal or medical corpus.
- **Batching:** All inserts use `psycopg2.extras.execute_values` in configurable
  batches (default 1000 rows/batch) for throughput. COPY protocol is faster but
  `execute_values` gives accurate batch-size control for the benchmark.
- **Graph traversal:** Recursive CTE with a depth guard (no cycle guard for
  performance — cycle guard adds significant overhead that would not be present
  in an optimised production query).

---

## G1-OPT-1: Diagnosing and Fixing HNSW Latency

The G1 spike (2026-05-04) measured semantic ANN P99=2424ms at 1M blocks with Docker defaults
(`shared_buffers=128MB`). The G1-OPT-1 issue tracks diagnosis and optimization.

### Step 1+2 — Diagnose the bottleneck

```bash
python diagnose.py --db-url postgresql://localhost/nexum_bench
```

Runs `EXPLAIN (ANALYZE, BUFFERS)` and checks HNSW index size vs `shared_buffers`.
Outputs a verdict: **MEMORY** (cache-miss) or **CPU/DOCKER** (index cached but slow).

### Step 3 — Optimize for low memory (if memory is culprit)

```bash
# Test all three optimization strategies
python optimize.py --db-url postgresql://localhost/nexum_bench

# Or test individually
python optimize.py --db-url postgresql://localhost/nexum_bench --opts halfvec
python optimize.py --db-url postgresql://localhost/nexum_bench --opts m8
python optimize.py --db-url postgresql://localhost/nexum_bench --opts ivfflat
```

Each optimization rebuilds the index, measures P50/P99 latency and recall@10 vs brute-force.
Pass criterion: P99 < 200ms **and** recall@10 ≥ 0.90.

### Step 5 — ef_search sweep (after winning index is chosen)

```bash
python ef_search_sweep.py --db-url postgresql://localhost/nexum_bench
```

Sweeps `hnsw.ef_search` over [20, 40, 80, 200] and prints a latency/recall table.
Identifies the knee: lowest ef_search meeting both P99 and recall criteria.

### Recommended Postgres config

See `postgres.conf` for the full recommended configuration. Key settings:

```
shared_buffers = 1GB       # covers halfvec HNSW index for 1M blocks
work_mem = 256MB            # ANN queries need more working memory than default 4MB
hnsw.ef_search = 80        # knee value (update after ef_search_sweep.py run)
```

Apply to a running Postgres instance:
```sql
ALTER SYSTEM SET shared_buffers = '1GB';
ALTER SYSTEM SET work_mem = '256MB';
SELECT pg_reload_conf();
```

---

## Interpreting Results

| Result | Meaning |
|---|---|
| G1 PASS at 5M | Postgres is sufficient for Phase 1. Proceed with Area 1 full benchmark (20M/100M) in parallel with Phase 1 work. |
| G1 PASS at 1M only | Postgres may be marginal. Run 5M with index tuning (HNSW `m`/`ef_construction` params) before declaring G1. |
| G1 FAIL at 5M | Graph DB migration required (Kuzu or Neptune). Areas 3, 5, 6 blocked until resolved. G2 wedge demo proceeds on ≤ 1M corpus. |

If graph traversal P99 fails before semantic search, the binding constraint is
recursive CTE depth — consider Apache AGE (Cypher on Postgres) or an external
graph DB. If semantic search fails first, the binding constraint is HNSW index
tuning or pgvector version.

---

## Real-embedding harness (issue #4 — H1.1 verification)

`run_g1_real.py` runs the same gate, but ingests text per block and embeds
with `sentence-transformers/all-MiniLM-L6-v2` (384-dim) instead of using
random Gaussian vectors. This is required to interpret recall@10 as an
index-quality signal — see the H1.1 caveat written in PR #81.

```bash
# Smallest reasonable smoke (≈30s on CPU)
python run_g1_real.py \
    --db-url postgresql://nexum:nexum@localhost:5433/nexum_bench_real \
    --scale 10k --n-queries 50 --recall-queries 10

# Acceptance-criterion run (largest scale that fits in your time budget)
python run_g1_real.py --scale 500k --n-queries 100 --recall-queries 30
```

Differences vs. `run_benchmark.py`:

- **Ingest:** `ingest_real.generate_and_ingest_real`. Uses topic-templated
  English sentences (8 topics) embedded by `all-MiniLM-L6-v2`. Embedding
  rate on a 40-thread CPU is ~440-880 sentences/second.
- **Bench:** `bench_real.run_latency_benchmark_real`. Same shape, plus a
  `recall` block computed against an exact brute-force baseline (forced
  via `SET LOCAL enable_indexscan = off`).
- **Envelope:** Written via `experiments/_lib/results_writer.py`
  (`schema_version=1`).
- **Pass criterion:** *Both* P99 < 500ms across all modes AND mean
  recall@10 ≥ 0.90.

Tests live in `tests/test_g1_real.py` and run without a DB and without
`sentence-transformers` installed (the model loader is mocked).
