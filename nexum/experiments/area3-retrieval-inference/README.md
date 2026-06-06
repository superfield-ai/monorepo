# Area 3 — Retrieval-Augmented Inference

**Phase 2 experiment.** Measures how good typed-link provenance-aware RAG can
get and at what latency cost, versus vanilla RAG and a static model baseline.

## Research Context

Area 3 answers the honest engineering question behind the original
"graph replaces static weight files" framing:

> How good can typed-link, provenance-aware RAG over the Nexum block graph
> get, and at what latency cost?

Parametric weights are not eliminated — they are augmented with a structured,
real-time retrieval substrate.

## Hypotheses

| ID | Claim | Kill Criterion |
|----|-------|----------------|
| **H3.1** | For factoid Q&A over a corpus updated in the last 24 hours, a graph-resident inference client outperforms RAG over a **stale snapshot** on recency-sensitive questions. | Nexum accuracy ≤ vanilla accuracy on FreshQA-style recency questions after amendment ingestion. |
| **H3.2** | The latency gap between graph-resident inference and static model inference can be bounded to 20–50x with a two-tier cache (hot blocks in memory, cold blocks on disk-backed HNSW). | Effective latency > 50x static inference even with hot/cold cache. |
| **H3.3** | A transformer with sparse cross-attention over ANN-retrieved blocks produces outputs competitive with a static model on summarization tasks, accessing only 1–5% of the graph per inference call. | LM-judge score at k=5 not significantly better than k=1; no saturation point. |

## Modules

| File | Purpose |
|------|---------|
| `graph_inference_client.py` | Minimal graph-inference client: ANN retrieval → typed-link traversal → LM generation. Handles `ConnectionError` gracefully for offline use. |
| `latency_benchmark.py` | H3.2: end-to-end latency measurement across k values; `TwoTierBlockCache` simulation. |
| `recency_test.py` | H3.1: compare Nexum (live graph + amendments) vs. vanilla RAG (stale snapshot) on recency-sensitive questions. |
| `sparse_attention_ablation.py` | H3.3: sweep k=1..100; LM-as-judge scoring; `parse_judge_score` utility. |
| `run_area3.py` | CLI orchestrator — runs all three experiments and writes JSON results. |
| `inference_client_adapter.py` | Python adapter for the Phase-2 `InferenceClient` seam (`src/inference/client.ts`). In-memory + HTTP variants. |
| `quality_benchmark.py` | Issue-#10 small-scale quality benchmark: attribution F1 + factual correctness via the seam, comparing `vector` vs. `graph` modes. Writes a canonical `H3.1` envelope through `experiments/_lib/results_writer`. |
| `run_quality.py` | CLI for the issue-#10 benchmark; `--offline` runs entirely without Nexum or an API key. |
| `tests/test_area3.py` | Existing area-3 test suite (no live services required). |
| `tests/test_quality_benchmark.py` | Issue-#10 quality benchmark tests (offline, deterministic). |

## Setup

```bash
cd experiments/area3-retrieval-inference
pip install -e ".[dev]"
```

## Running the experiments

```bash
# All experiments (requires running Nexum + Anthropic key):
python run_area3.py \
  --nexum-url http://localhost:3000 \
  --anthropic-key $ANTHROPIC_API_KEY \
  --max-questions 50 \
  --output results/area3_results.json

# Skip the recency test (needs a corpus with known amendments):
python run_area3.py \
  --nexum-url http://localhost:3000 \
  --anthropic-key $ANTHROPIC_API_KEY \
  --skip-recency-test \
  --output results/area3_results.json

# Dry run (CI / offline verification):
python run_area3.py --dry-run --output results/area3_dry_run.json
```

### Issue-#10 quality benchmark (small-scale, attribution F1 + factual correctness)

```bash
# Offline (no Nexum, no API key) — 50 synthetic CUAD-style questions:
python run_quality.py --offline --max-questions 50

# Live small-scale run against a Nexum instance:
python run_quality.py --nexum-url http://localhost:3000 --max-questions 100
```

Writes a canonical `H3.1` envelope to `results/h3.1_<timestamp>.json` and
prints a summary to stdout. The benchmark compares the `vector` (flat ANN
baseline) and `graph` (typed-link traversal) modes of the Phase-2
`InferenceClient` seam (`src/inference/client.ts`).

## Running the tests

```bash
pytest tests/ -v
```

All tests pass without a live Nexum instance or Anthropic API key.

## Output format

`results/area3_results.json` contains:

```json
{
  "nexum_url": "http://localhost:3000",
  "n_questions": 50,
  "k_values": [1, 5, 10, 50, 100],
  "latency_benchmark": {
    "1":  { "p50_total_ms": ..., "p99_total_ms": ..., "tokens_per_sec_estimate": ... },
    "10": { ... },
    ...
  },
  "sparse_ablation": {
    "1":  { "mean_judge_score": ..., "p50_latency_ms": ..., "p99_latency_ms": ... },
    "10": { ... },
    ...
  },
  "recency_test": {
    "nexum_accuracy_after_amendment": ...,
    "vanilla_accuracy_after_amendment": ...,
    "accuracy_delta": ...,
    "h3_1_supported": true
  }
}
```

## Dependencies

See `pyproject.toml`. Key packages:

- `anthropic>=0.25.0` — LM generation and LM-as-judge calls
- `llama-index>=0.10.0`, `llama-index-core` — vanilla RAG baseline (H3.1)
- `numpy` — latency statistics (P50/P99)
- `requests` — Nexum REST API calls
- `tqdm` — progress bars in long-running sweeps
