"""
tests/test_area6.py — CPU-only tests for Area 6 GPU acceleration experiments.

All 10 tests run without CUDA hardware; GPU paths return None and are noted.
"""

from __future__ import annotations

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Test 1 — H6.5/H6.6 (via ANN benchmark): numpy brute-force recall
# ---------------------------------------------------------------------------

def test_ann_benchmark_numpy_brute():
    """Numpy brute-force on 1000 random embeddings must achieve recall@10 > 0.99."""
    from ann_benchmark import run_ann_benchmark

    rng = np.random.default_rng(0)
    N, D, Q, k = 1000, 64, 50, 10

    embeddings = rng.standard_normal((N, D)).astype(np.float32)
    queries = rng.standard_normal((Q, D)).astype(np.float32)

    # Brute-force ground truth via exact inner product / L2
    ground_truth = np.zeros((Q, k), dtype=np.int64)
    for i, q in enumerate(queries):
        dists = np.linalg.norm(embeddings - q, axis=1)
        ground_truth[i] = np.argsort(dists)[:k]

    results = run_ann_benchmark(
        embeddings=embeddings,
        queries=queries,
        ground_truth=ground_truth,
        k=k,
        use_gpu=False,
    )

    assert "numpy_brute" in results
    assert results["numpy_brute"]["recall_at_k"] > 0.99


# ---------------------------------------------------------------------------
# Test 2 — H6.6: Zipf coverage — top 10% of blocks covers > 70% of queries
# ---------------------------------------------------------------------------

def test_hot_shard_zipf_coverage():
    """With zipf_alpha=1.2, top 10% of 100K blocks must serve > 70% of 10K queries."""
    from hot_shard_simulation import simulate_vram_tiering

    result = simulate_vram_tiering(
        n_blocks=100_000,
        vram_capacity_fraction=0.10,
        access_distribution="zipf",
        zipf_alpha=1.2,
        n_queries=10_000,
        seed=42,
    )

    assert result["top_10pct_serves_pct_queries"] > 0.70


# ---------------------------------------------------------------------------
# Test 3 — H6.5: UVM throughput < hot_shard throughput
# ---------------------------------------------------------------------------

def test_uvm_lower_than_hot_shard():
    """UVM throughput_relative must be lower than hot_shard throughput_relative."""
    from hot_shard_simulation import simulate_vram_tiering

    result = simulate_vram_tiering(
        n_blocks=100_000,
        vram_capacity_fraction=0.10,
        access_distribution="zipf",
        zipf_alpha=1.2,
        n_queries=10_000,
        seed=42,
    )

    assert result["uvm"]["throughput_relative"] < result["hot_shard"]["throughput_relative"]


# ---------------------------------------------------------------------------
# Test 4 — H6.5 supported when conditions met
# ---------------------------------------------------------------------------

def test_h6_5_supported_when_conditions_met():
    """
    With high Zipf skew (alpha=2.0) and large VRAM fraction (0.20),
    hot_shard > 80% and uvm < 30% → h6_5_supported True.
    """
    from hot_shard_simulation import simulate_vram_tiering

    result = simulate_vram_tiering(
        n_blocks=10_000,
        vram_capacity_fraction=0.20,
        access_distribution="zipf",
        zipf_alpha=2.0,
        n_queries=5_000,
        cold_latency_multiplier=20.0,
        seed=7,
    )

    assert result["h6_5_supported"] is True


# ---------------------------------------------------------------------------
# Test 5 — H6.2: embedding latency structure check
# ---------------------------------------------------------------------------

def test_embedding_latency_structure():
    """Output must contain all expected backend / batch-size keys."""
    from embedding_latency import measure_embedding_latency

    batch_sizes = [1, 8, 32, 128, 512]
    backends = ["openai_mock", "cpu_local", "gpu_local"]

    result = measure_embedding_latency(
        texts=["sample text " * 20] * 512,
        batch_sizes=batch_sizes,
        backends=backends,
    )

    for backend in ["openai_mock", "cpu_local"]:
        assert backend in result, f"Missing backend: {backend}"
        for bs in batch_sizes:
            assert bs in result[backend], f"Missing batch_size {bs} in {backend}"
            for key in ("p50_ms", "p99_ms", "throughput_tokens_per_sec"):
                assert key in result[backend][bs], f"Missing key {key}"

    assert "gpu_local" in result
    assert "h6_2_signal" in result


# ---------------------------------------------------------------------------
# Test 6 — H6.2: mock latency increases with batch size
# ---------------------------------------------------------------------------

def test_openai_mock_increases_with_batch():
    """OpenAI mock total latency (p50_ms) at batch 128 must exceed batch 1."""
    from embedding_latency import measure_embedding_latency

    result = measure_embedding_latency(
        texts=["token word " * 30] * 512,
        batch_sizes=[1, 128],
        backends=["openai_mock"],
    )

    p50_batch1 = result["openai_mock"][1]["p50_ms"]
    p50_batch128 = result["openai_mock"][128]["p50_ms"]
    assert p50_batch128 > p50_batch1


# ---------------------------------------------------------------------------
# Test 7 — H6.3: sidecar within 20% of in-process latency
# ---------------------------------------------------------------------------

def test_sidecar_within_20pct():
    """Default params (0.5ms vs 0.1ms IPC overhead, 5ms compute) → sidecar within 20%."""
    from sidecar_vs_inprocess import simulate_sidecar_comparison

    result = simulate_sidecar_comparison(
        n_queries=1000,
        inprocess_overhead_ms=0.1,
        sidecar_overhead_ms=0.5,
        compute_ms_per_query=5.0,
    )

    assert result["sidecar_within_20pct"] is True
    assert result["h6_3_supported"] is True


# ---------------------------------------------------------------------------
# Test 8 — H6.4: Amdahl batch sweep — batch 32 gives > 5x throughput vs batch 1
# ---------------------------------------------------------------------------

def test_batch_sweep_amdahl():
    """With 90% parallelism, Amdahl model: batch 32 must give > 5x throughput vs batch 1."""
    from batch_sweep import run_batch_sweep

    result = run_batch_sweep(
        batch_sizes=[1, 8, 32, 128, 512],
        single_query_ms=5.0,
        throughput_model="amdahl",
        parallelism_fraction=0.90,
    )

    assert result[32]["throughput_relative"] > 5.0


# ---------------------------------------------------------------------------
# Test 9 — H6.4 supported flag
# ---------------------------------------------------------------------------

def test_h6_4_supported():
    """Batch 32–128 giving > 5x throughput → h6_4_supported True."""
    from batch_sweep import run_batch_sweep

    result = run_batch_sweep(
        batch_sizes=[1, 8, 32, 128, 512],
        single_query_ms=5.0,
        throughput_model="amdahl",
        parallelism_fraction=0.90,
    )

    assert result["h6_4_supported"] is True


# ---------------------------------------------------------------------------
# Test 10 — H6.6 supported flag
# ---------------------------------------------------------------------------

def test_h6_6_supported():
    """Top 10% covering > 70% of queries → h6_6_supported True."""
    from hot_shard_simulation import simulate_vram_tiering

    result = simulate_vram_tiering(
        n_blocks=100_000,
        vram_capacity_fraction=0.10,
        access_distribution="zipf",
        zipf_alpha=1.2,
        n_queries=10_000,
        seed=42,
    )

    assert result["h6_6_supported"] is True
