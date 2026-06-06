# Area 1 — Storage Architecture Fitness

Extends the G1 spike (`experiments/g1-postgres-scale/`) to the full Phase 1A
scale benchmark (H1.1–H1.3). Adds Kuzu schema comparison and embedding
dimension ablation.

## What this runs

| Module | What it measures |
|--------|-----------------|
| `scale_benchmark.py` | Postgres P50/P99 latency at 1M / 5M / 20M / 100M blocks, HNSW build time, VACUUM ANALYZE time, throughput |
| `schema_comparison.py` | Postgres recursive CTE vs. Kuzu in-process graph at 2/4/6-hop depths; crossover point |
| `embedding_ablation.py` | Recall@10 across 512/768/1024/1536 dims on BEIR (nfcorpus, fiqa); minimum viable dimensionality |
| `report.py` | Converts results dict → Markdown report with tables |
| `run_area1.py` | Orchestrator CLI |
| `h12_retrieval_comparison.py` | H1.2 cross-type retrieval comparison across fulltext / semantic / graph_only / hybrid / edge_semantic on a 50K mixed-type planted-answer corpus. Writes an `H1.2` envelope via `experiments._lib.results_writer`. |

### H1.2 retrieval comparison (issue #6)

```bash
DATABASE_URL=postgresql://nexum:nexum@localhost:5433/nexum_bench \
  python experiments/area1-storage-fitness/h12_retrieval_comparison.py \
  --n-blocks 50000 --n-topics 400 --write-results
```

Outputs per-mode recall@10 / NDCG@10 / p50 ms / p99 ms and writes a result envelope to `results/h1.2_<timestamp>.json`. See `docs/research/hypotheses/H1.2_graph-beats-semantic-cross-type.md` for interpretation.

## Dependencies

- **Postgres + pgvector**: required for scale benchmark and schema comparison.
- **Kuzu**: required for schema comparison in-process graph. Install with `pip install kuzu>=0.5.0`.
- **sentence-transformers**: required for embedding ablation. No external API calls.
- **Neo4j**: optional. Set `NEO4J_URL` environment variable if a running instance is available.

## Install

```bash
cd experiments/area1-storage-fitness
pip install -e ".[dev]"
```

## Run

### Quick run (CI — 1M and 5M only, skip embedding ablation)

```bash
python run_area1.py \
  --db-url postgresql://localhost/nexum_bench \
  --scales 1m 5m \
  --skip-embedding-ablation \
  --output results/area1_results.json
```

### Full run

```bash
python run_area1.py \
  --db-url postgresql://localhost/nexum_bench \
  --scales 1m 5m 20m 100m \
  --output results/area1_results.json
```

### Skip Kuzu (if not installed)

```bash
python run_area1.py \
  --db-url postgresql://localhost/nexum_bench \
  --scales 1m 5m \
  --skip-kuzu \
  --output results/area1_results.json
```

### Embedding ablation with synthetic data (no BEIR download)

```bash
python run_area1.py \
  --db-url postgresql://localhost/nexum_bench \
  --scales 1m \
  --skip-kuzu \
  --embedding-use-synthetic \
  --output results/area1_results.json
```

## Tests

```bash
pytest tests/ -v
```

Most tests run without a database. The Kuzu test (`test_kuzu_schema_creation`)
requires `kuzu` installed and is skipped gracefully if absent.

## Expected outputs

- `results/area1_results.json` — structured results dict (all sections).
- `results/area1_report.md` — Markdown report with latency tables and H1.1 verdict.

## H1.1 criterion

P99 latency < 500ms at all scales ≤ 20M blocks for all three query modes
(semantic, full-text, 4-hop graph traversal).

- **Supported**: P99 < 500ms at 1M, 5M, and 20M.
- **Refuted**: P99 ≥ 500ms at any scale ≤ 20M. Consequence: graph DB migration required.
