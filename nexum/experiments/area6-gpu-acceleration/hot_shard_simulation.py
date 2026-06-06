"""
hot_shard_simulation.py — H6.5, H6.6: VRAM tiering strategy simulation.

H6.5: for a corpus 10x VRAM capacity, hot-shard (top-N% by in-degree pinned)
achieves > 80% of full-fit GPU throughput; CUDA UVM page-fault path achieves
< 30%.

H6.6: Nexum block graph access distribution is sufficiently Zipfian that a 10%
VRAM footprint covers > 70% of inference retrievals.

No CUDA required — this is a statistical simulation of access patterns and
throughput under three tiering policies.
"""

from __future__ import annotations

import numpy as np


def _zipf_weights(n_blocks: int, alpha: float, rng: np.random.Generator) -> np.ndarray:
    """Return a normalised probability distribution over n_blocks following Zipf(alpha)."""
    ranks = np.arange(1, n_blocks + 1, dtype=np.float64)
    weights = 1.0 / ranks**alpha
    weights /= weights.sum()
    return weights


def _uniform_weights(n_blocks: int, rng: np.random.Generator) -> np.ndarray:
    return np.ones(n_blocks, dtype=np.float64) / n_blocks


def _burst_weights(n_blocks: int, rng: np.random.Generator) -> np.ndarray:
    """Short burst: 5% of blocks receive 90% of traffic; rest uniform."""
    weights = np.ones(n_blocks, dtype=np.float64) * 0.10 / (0.95 * n_blocks)
    burst_size = max(1, int(0.05 * n_blocks))
    burst_idx = rng.choice(n_blocks, size=burst_size, replace=False)
    weights[burst_idx] = 0.90 / burst_size
    weights /= weights.sum()
    return weights


def _fit_zipf_alpha(access_counts: np.ndarray) -> float:
    """
    Estimate Zipf alpha from observed access counts via log-log linear regression.

    For a Zipf distribution, log(count) ~ -alpha * log(rank) + const.
    """
    sorted_counts = np.sort(access_counts)[::-1]
    sorted_counts = sorted_counts[sorted_counts > 0]
    if len(sorted_counts) < 2:
        return 0.0
    ranks = np.arange(1, len(sorted_counts) + 1, dtype=np.float64)
    log_ranks = np.log(ranks)
    log_counts = np.log(sorted_counts.astype(np.float64))
    # Least squares: log_counts = a - alpha * log_ranks
    A = np.vstack([np.ones_like(log_ranks), log_ranks]).T
    result = np.linalg.lstsq(A, log_counts, rcond=None)
    coeffs = result[0]
    alpha = -coeffs[1]
    return float(alpha)


def simulate_vram_tiering(
    n_blocks: int,
    vram_capacity_fraction: float = 0.10,
    access_distribution: str = "zipf",
    zipf_alpha: float = 1.2,
    n_queries: int = 10_000,
    cold_latency_multiplier: float = 10.0,
    seed: int = 42,
) -> dict:
    """
    H6.5/H6.6: simulate three VRAM strategies on a corpus 10x VRAM capacity.

    Strategies:
    1. hot_shard  — top-N% blocks by in-degree pinned in VRAM.
    2. uvm        — uniform random eviction (simulates CUDA UVM page-fault overhead).
    3. cpu_fallback — all retrieval on CPU HNSW (baseline, throughput_relative=1.0).

    Returns:
        {
            'hot_shard': {'throughput_relative', 'hit_rate', 'recall_at_k'},
            'uvm':       {'throughput_relative', 'hit_rate', 'recall_at_k'},
            'cpu_fallback': {'throughput_relative': 1.0, 'hit_rate': 0.0, 'recall_at_k': 1.0},
            'zipf_alpha_fit': float,
            'top_10pct_serves_pct_queries': float,
            'h6_5_supported': bool,
            'h6_6_supported': bool,
        }
    """
    rng = np.random.default_rng(seed)

    n_hot = max(1, int(n_blocks * vram_capacity_fraction))

    # ------------------------------------------------------------------
    # Build access probability distribution
    # ------------------------------------------------------------------
    if access_distribution == "zipf":
        weights = _zipf_weights(n_blocks, zipf_alpha, rng)
    elif access_distribution == "uniform":
        weights = _uniform_weights(n_blocks, rng)
    elif access_distribution == "burst":
        weights = _burst_weights(n_blocks, rng)
    else:
        raise ValueError(f"Unknown access_distribution: {access_distribution!r}")

    # ------------------------------------------------------------------
    # Sample queries
    # ------------------------------------------------------------------
    query_blocks = rng.choice(n_blocks, size=n_queries, p=weights)

    # ------------------------------------------------------------------
    # Access counts and Zipf fit
    # ------------------------------------------------------------------
    access_counts = np.bincount(query_blocks, minlength=n_blocks)
    zipf_alpha_fit = _fit_zipf_alpha(access_counts)

    # Top-10% coverage metric (always uses 10% regardless of vram_capacity_fraction)
    top_10pct_n = max(1, int(n_blocks * 0.10))
    top_10pct_blocks = set(np.argsort(access_counts)[-top_10pct_n:].tolist())
    top_10pct_hits = sum(1 for b in query_blocks if b in top_10pct_blocks)
    top_10pct_serves_pct = top_10pct_hits / n_queries

    # ------------------------------------------------------------------
    # Strategy: hot_shard
    # Top n_hot blocks (by access count, as a proxy for in-degree) are
    # pinned in VRAM.  Hot queries are served at GPU speed; cold queries
    # pay cold_latency_multiplier overhead.
    # ------------------------------------------------------------------
    hot_blocks = set(np.argsort(access_counts)[-n_hot:].tolist())

    hot_shard_hit_mask = np.array([b in hot_blocks for b in query_blocks])
    hot_shard_hit_rate = float(hot_shard_hit_mask.mean())

    # Effective throughput: hot queries are 1x; cold queries are 1/cold_latency_multiplier.
    # throughput_relative = n_queries / sum_of_effective_latencies (normalised to cpu_fallback=1).
    # cpu_fallback latency per query = 1.0 (arbitrary unit)
    # hot_shard latency: hot → 1/C (fast GPU), cold → 1.0 (CPU fallback)
    # Here C = cold_latency_multiplier means cold is C× slower than GPU hot.
    gpu_speed = cold_latency_multiplier  # GPU is `cold_latency_multiplier`× faster than CPU
    hot_shard_latency = (
        hot_shard_hit_mask.sum() / gpu_speed
        + (~hot_shard_hit_mask).sum() * 1.0
    )
    cpu_fallback_latency = float(n_queries)  # all at 1.0 per query

    hot_shard_throughput_relative = cpu_fallback_latency / hot_shard_latency

    # ------------------------------------------------------------------
    # Strategy: uvm
    # Uniform random eviction: each query hits VRAM with probability
    # vram_capacity_fraction (no hot-shard intelligence).
    # ------------------------------------------------------------------
    uvm_hit_mask = rng.random(n_queries) < vram_capacity_fraction
    uvm_hit_rate = float(uvm_hit_mask.mean())

    uvm_latency = (
        uvm_hit_mask.sum() / gpu_speed
        + (~uvm_hit_mask).sum() * 1.0
    )
    uvm_throughput_relative = cpu_fallback_latency / uvm_latency

    # ------------------------------------------------------------------
    # H6.5 and H6.6 support criteria
    # ------------------------------------------------------------------
    h6_5_supported = (
        hot_shard_throughput_relative > 0.80 * hot_shard_throughput_relative  # always True
        # Proper criterion from spec:
        # hot_shard > 80% of *full-fit* GPU throughput
        # full-fit throughput = n_queries / (n_queries / gpu_speed) = gpu_speed
        # 80% of gpu_speed expressed as throughput_relative (normalised to cpu=1):
        # hot_shard_throughput_relative > 0.80 * gpu_speed
        # AND uvm_throughput_relative < 0.30 * gpu_speed
    )
    # Re-implement correctly relative to cpu_fallback=1.0 baseline:
    # "hot_shard > 80% of full-fit GPU throughput"
    # full-fit GPU throughput relative = gpu_speed (all queries GPU-speed)
    full_fit_throughput_relative = float(gpu_speed)
    h6_5_supported = bool(
        hot_shard_throughput_relative > 0.80 * full_fit_throughput_relative
        and uvm_throughput_relative < 0.30 * full_fit_throughput_relative
    )

    h6_6_supported = bool(top_10pct_serves_pct > 0.70)

    return {
        "hot_shard": {
            "throughput_relative": hot_shard_throughput_relative,
            "hit_rate": hot_shard_hit_rate,
            "recall_at_k": 1.0,  # simulation assumes perfect recall for in-VRAM blocks
        },
        "uvm": {
            "throughput_relative": uvm_throughput_relative,
            "hit_rate": uvm_hit_rate,
            "recall_at_k": 1.0,
        },
        "cpu_fallback": {
            "throughput_relative": 1.0,
            "hit_rate": 0.0,
            "recall_at_k": 1.0,
        },
        "zipf_alpha_fit": zipf_alpha_fit,
        "top_10pct_serves_pct_queries": top_10pct_serves_pct,
        "h6_5_supported": h6_5_supported,
        "h6_6_supported": h6_6_supported,
    }
