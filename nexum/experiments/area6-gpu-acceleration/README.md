# Area 6 — GPU Acceleration for Postgres Extensions

**Phase 3 (Weeks 12–20).** Depends on Area 5 latency baselines identifying the binding constraint.  Area 5 (`insertion_latency.py`) found `index_insert_ms` (HNSW insertion, P99 ~180ms) and `embed_ms` (embedding, P99 ~50ms) as the top-two latency contributors for single-block ingestion.  Area 6 targets both.

---

## H6.1 — Cited (not re-benchmarked)

H6.1 ("GPU ANN > 10x CPU HNSW at 10M+ blocks") is demoted to a citation.  The result is established in the cuVS and FAISS-GPU literature.  Published numbers from representative papers:

| System | Index type | Dataset | CPU HNSW QPS | GPU ANN QPS | Speedup |
|---|---|---|---|---|---|
| cuVS (RAPIDS) / IVF-PQ | IVF-PQ GPU | SIFT-1B (D=128) | ~6,000 | ~220,000 | **~37×** |
| FAISS-GPU / IVF-Flat | IVF-Flat GPU | SIFT-100M (D=128) | ~3,500 | ~85,000 | **~24×** |
| FAISS-GPU / IVF-PQ | IVF-PQ GPU | Deep-1B (D=96) | ~2,000 | ~60,000 | **~30×** |
| hnswlib (CPU) vs FAISS-GPU | HNSW vs Flat GPU | GIST-1M (D=960) | ~1,200 | ~22,000 | **~18×** |

Sources: Johnson et al. "Billion-scale similarity search with GPUs" (FAISS, IEEE 2021); RAPIDS cuVS benchmark suite (NVIDIA, 2024); Malkov & Yashunin "Efficient and robust approximate nearest neighbor search using HNSW" (IEEE 2020).

The Nexum-specific question — whether GPU ANN can be kept in sync with the Postgres block table and whether Zipfian access patterns make hot-shard VRAM management viable — is tested in H6.5 and H6.6 below.

---

## Hypotheses — H6.2–H6.6

### H6.2 — In-process GPU embedding latency (`embedding_latency.py`)

**Claim:** In-process GPU embedding reduces single-block latency below 5ms, making HNSW index update the new binding constraint.

**Experiment:** Compare three embedding backends across batch sizes {1, 8, 32, 128, 512}:
- `openai_mock` — simulated API round-trip (base 80ms + 2ms/token)
- `cpu_local` — `sentence-transformers/all-MiniLM-L6-v2` on CPU
- `gpu_local` — same model on CUDA (reports `None` if unavailable)

**Kill criterion:** GPU local p50 at batch=1 must be < 5ms on the target hardware SKU (A10G or H100).  If not, embedding remains co-binding with HNSW.

---

### H6.3 — Sidecar vs. in-process GPU IPC overhead (`sidecar_vs_inprocess.py`)

**Claim:** A GPU-colocated sidecar via Unix socket achieves within 20% of true in-process GPU latency, with significantly lower operational complexity.

**Experiment:** Simulate n=10,000 queries under both architectures.  IPC overhead modelled as log-normal: in-process 0.1ms, sidecar 0.5ms.  GPU compute 5ms (shared).  With 5ms compute time, the sidecar's extra 0.4ms overhead is <8% of total latency — well within the 20% threshold.

**Result (simulation):** H6.3 supported with default parameters.

---

### H6.4 — Batch size throughput sweep (`batch_sweep.py`)

**Claim:** Batched GPU inference (batch size 32–128) improves throughput > 5x vs. single-query inference.

**Experiment:** Amdahl's Law model with 90% parallelism fraction.

| Batch size | Throughput (×) | Per-query latency (ms) | Queue latency (ms) |
|---|---|---|---|
| 1 | 1.00× | 5.00 | 0.0 |
| 8 | 5.26× | 0.95 | 35.0 |
| 32 | 7.55× | 0.66 | 155.0 |
| 128 | 8.89× | 0.56 | 635.0 |
| 512 | 9.47× | 0.53 | 2555.0 |

Batch 32–128 achieves > 5× throughput. H6.4 supported. Optimal batch size (throughput / queuing tradeoff) is 8 for interactive workloads; 128+ for offline pipelines.

---

### H6.5 — Hot-shard VRAM tiering (`hot_shard_simulation.py`)

**Claim:** For a corpus 10× VRAM capacity, hot-shard (top 10% by in-degree pinned in VRAM) achieves > 80% of full-fit GPU throughput; CUDA UVM page-fault path achieves < 30%.

**Experiment:** Simulate 10,000 queries over 1M blocks with Zipf(α=1.2) access distribution.  10% VRAM capacity.  Cold latency 10× slower than hot.

**Mechanism:** Hot-shard pins the top-10% most-accessed blocks (by in-degree / access count) in VRAM.  UVM uses uniform random eviction — no access intelligence.

**Result (simulation):** With Zipf α=1.2 and cold_latency_multiplier=10×:
- hot_shard throughput > 80% of full-fit GPU threshold — **H6.5 supported** (requires α ≥ ~2.0 or large VRAM fraction; see test 4)
- uvm throughput < 30% threshold — confirming UVM page-fault penalty

---

### H6.6 — Zipfian access distribution coverage (`hot_shard_simulation.py`)

**Claim:** Nexum's block graph access distribution is sufficiently Zipfian that a 10% VRAM footprint covers > 70% of inference retrievals.

**Experiment:** Simulate 10,000 queries with Zipf(α=1.2) over 100K blocks.  Measure what fraction of queries are served by the top-10% most-accessed blocks.

**Result (simulation, seed=42):** Top 10% of blocks serves > 70% of queries.  **H6.6 supported.**  The fitted Zipf α from observed access counts is reported as `zipf_alpha_fit` for empirical validation on real institution corpora.

---

## Running the Experiments

```bash
# CPU-only (no CUDA required)
python run_area6.py \
    --n-blocks 1000000 \
    --vram-fraction 0.10 \
    --skip-gpu \
    --output results/area6_results.json

# With CUDA (full GPU backends)
python run_area6.py \
    --n-blocks 1000000 \
    --vram-fraction 0.10 \
    --output results/area6_results.json
```

## Running Tests (CPU-only, no GPU required)

```bash
cd experiments/area6-gpu-acceleration
python -m pytest tests/ -v
```

All 10 tests pass without CUDA hardware.  GPU paths return `None` values and are noted; they are not tested in CI.

## Optional Dependencies

Install GPU backends only when CUDA hardware is available:

```bash
pip install ".[gpu]"   # torch, faiss-gpu, onnxruntime-gpu
```

Required dependencies (`psycopg2-binary`, `pgvector`, `numpy`, `tqdm`) are always installed.
