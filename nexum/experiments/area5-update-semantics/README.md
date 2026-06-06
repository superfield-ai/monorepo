# Area 5 — Update Semantics and Live Consistency

**Research area:** What are the consistency guarantees of the real-time ingest claim, and what breaks when they are violated?

**Phase:** Phase 2 (weeks 8–14, both branches converge here)

**Hypotheses:** H5.1–H5.5

---

## Hypotheses

### H5.1 — Insertion-to-Retrieval Latency (insertion_latency.py)

End-to-end insertion latency is dominated by the HNSW index update step, and can be reduced below 500 ms for single-block inserts by deferring index consolidation.

**Pass criterion:** Total P99 latency < 500 ms for a single-block insert.

**Stages measured:** `parse_ms`, `embed_ms`, `index_insert_ms`, `link_classify_ms`, `cache_invalidate_ms`, `total_ms`.

Falls back to realistic mock timing data when Nexum is not running.

---

### H5.2 — Partial-Link Safety (partial_visibility.py)

Serving partially-linked blocks (embedded + indexed, AI links not yet classified) degrades inference quality by less than 5% — embedding alone carries most retrieval signal.

**Pass criterion:** `delta_embedding_to_ai < 0.05`

**Method:** Answer 100 questions at three pipeline stages — embedding-only, structural links, AI links — and measure accuracy delta.

Falls back to simulated accuracy model when Nexum is not running.

---

### H5.3 — Version-Level Atomic Visibility (version_atomicity.py)

Version-level atomicity eliminates partial-visibility artifacts at the cost of a latency window proportional to document size; that window is acceptable for typical institutional documents.

**Signal:** Simulates indexing windows for 10, 50, 100, and 500-page documents at 50 ms/block. Classifies partial-visibility risk at 25% and 50% completion.

Fully offline — no Nexum or database required.

---

### H5.4 — Embedding Drift for Minor Edits (embedding_drift.py)

Embedding drift after minor content edits (< 5% token change) is below the retrieval discrimination threshold for 95% of blocks; selective re-embedding triggered by content-hash change is sufficient.

**Pass criterion:** `safe_edit_threshold >= 0.05` (highest edit fraction where < 5% of blocks shift more than 3 retrieval positions)

**Model:** `all-MiniLM-L6-v2` via `sentence-transformers` — runs locally, no API key needed.

Edit fractions tested: 1%, 2%, 5%, 10%, 20% token substitution.

---

### H5.5 — High-Ingest Contention (high_ingest_contention.py)

Under high-ingest load (10K blocks/minute), a write-optimized deferred insertion path outperforms synchronous index-on-insert in end-to-end query recall.

**Pass criterion:** Deferred strategy beats synchronous on both query recall and ingest throughput.

**Method:** Timing-model simulation (no real Postgres required). Models lock-contention effects on the synchronous path; linear-scan fallback on the deferred path.

---

## Setup

```bash
pip install psycopg2-binary pgvector numpy tqdm requests sentence-transformers
```

Or with the package:

```bash
pip install -e ".[dev]"
```

---

## Running Experiments

### All experiments (Nexum not running — uses mock/simulated data)

```bash
python3 run_area5.py \
  --nexum-url http://localhost:3000 \
  --skip-insertion-latency \
  --skip-partial-visibility \
  --output results/area5_results.json
```

### With live Nexum instance

```bash
python3 run_area5.py \
  --nexum-url http://localhost:3000 \
  --output results/area5_results.json
```

### Skip slow embedding drift (no sentence-transformers)

```bash
python3 run_area5.py \
  --skip-insertion-latency \
  --skip-partial-visibility \
  --skip-embedding-drift \
  --output results/area5_results.json
```

### Custom parameters

```bash
python3 run_area5.py \
  --nexum-url http://localhost:3000 \
  --n-single-blocks 200 \
  --n-batch-blocks 2000 \
  --n-drift-samples 500 \
  --seed 123 \
  --output results/area5_full.json
```

---

## Running Tests

```bash
# Fast tests only (default — slow test skipped)
pytest tests/ -v

# All tests including the real embedding drift (requires sentence-transformers)
pytest tests/ -v --run-slow
```

### Test coverage

| Test | Module | What it checks |
|---|---|---|
| `test_insertion_latency_structure` | H5.1 | All stage keys present; bottleneck_stage valid |
| `test_h5_1_criterion_supported` | H5.1 | P99 = 490 ms → supported |
| `test_h5_1_criterion_not_supported` | H5.1 | P99 = 510 ms → not supported |
| `test_partial_visibility_delta_supported` | H5.2 | Delta = 0.04 → h5_2_supported |
| `test_partial_visibility_delta_not_supported` | H5.2 | Delta = 0.06 → not supported |
| `test_partial_visibility_mock_run` | H5.2 | Mock path returns all keys |
| `test_version_atomicity_small_doc` | H5.3 | 10-page doc window < 5s |
| `test_version_atomicity_all_sizes_returned` | H5.3 | All doc sizes in result |
| `test_version_atomicity_signal_present` | H5.3 | h5_3_signal is non-empty |
| `test_cosine_distance_known_vectors` | H5.4 | Identical → 0; orthogonal → 1 |
| `test_cosine_distance_partial` | H5.4 | 45° vector → cos distance ≈ 0.293 |
| `test_rank_shift_counting` | H5.4 | Hand-crafted lists → shift ≥ 0 |
| `test_safe_edit_threshold_logic` | H5.4 | Threshold = highest safe fraction |
| `test_safe_edit_threshold_none_safe` | H5.4 | All unsafe → threshold = 0 |
| `test_apply_random_edit` | H5.4 | Token substitution changes tokens |
| `test_measure_embedding_drift_full` *(slow)* | H5.4 | Real sentence-transformers end-to-end |
| `test_deferred_beats_synchronous_default` | H5.5 | Default params → h5_5_supported |
| `test_h5_5_result_structure` | H5.5 | All keys present; values in range |
| `test_h5_5_not_supported_when_deferred_loses` | H5.5 | Deferred loses recall → not supported |
| `test_h5_5_supported_when_deferred_wins_both` | H5.5 | Both metrics better → supported |

---

## Results

Results are written to `results/area5_results.json` by default. The file contains:

```json
{
  "h5_1": { "single_block": {...}, "batch_1k": {...}, "bottleneck_stage": "...", "h5_1_supported": true },
  "h5_2": { "accuracy_embedding_only": 0.82, "delta_embedding_to_ai": 0.025, "h5_2_supported": true },
  "h5_3": { 10: {...}, 50: {...}, 100: {...}, 500: {...}, "h5_3_signal": "..." },
  "h5_4": { 0.01: {...}, 0.05: {...}, "safe_edit_threshold": 0.05, "h5_4_supported": true },
  "h5_5": { "synchronous": {...}, "deferred": {...}, "h5_5_supported": true }
}
```
