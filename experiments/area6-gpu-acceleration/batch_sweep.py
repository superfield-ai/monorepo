"""
batch_sweep.py — H6.4: batch size throughput vs. latency tradeoff.

H6.4: batched GPU inference (batch size 32–128) improves throughput by > 5x
vs. single-query GPU inference; the added queuing latency is acceptable for
non-interactive workloads.

Uses Amdahl's Law to model throughput scaling:
    speedup(N) = 1 / (s + p / N)
where s = serial fraction (1 - parallelism_fraction), p = parallelism_fraction,
N = batch size.

Queuing latency is modelled as the extra time required to fill a batch:
    queuing_latency_ms ≈ (batch_size - 1) * single_query_ms / throughput_relative
"""

from __future__ import annotations


def run_batch_sweep(
    batch_sizes: list[int] = None,
    single_query_ms: float = 5.0,
    throughput_model: str = "amdahl",
    parallelism_fraction: float = 0.90,
) -> dict:
    """
    H6.4: model throughput improvement from batching using Amdahl's Law.

    throughput_model options:
    - "amdahl":  speedup = 1 / (s + p/N) where s=1-parallelism_fraction
    - "linear":  speedup = N (perfect linear scaling, theoretical upper bound)
    - "measured": alias for "amdahl" (placeholder for real GPU measurements)

    Returns:
        {
            batch_size: {
                'throughput_relative': float,   # relative to batch_size=1
                'latency_ms': float,            # per-query latency at this batch size
                'queuing_latency_ms': float,    # extra wait to fill the batch
            }
            ...
            'h6_4_supported': bool,
            'optimal_batch_size': int,
        }
    """
    if batch_sizes is None:
        batch_sizes = [1, 8, 32, 128, 512]

    serial_fraction = 1.0 - parallelism_fraction
    results: dict = {}

    for bs in batch_sizes:
        if throughput_model == "linear":
            speedup = float(bs)
        else:
            # Amdahl's Law (also used for "measured" as a model)
            speedup = 1.0 / (serial_fraction + parallelism_fraction / bs)

        throughput_relative = speedup
        latency_ms = single_query_ms / speedup

        # Queuing latency: time to accumulate a full batch at arrival rate of
        # 1 query per single_query_ms (i.e. the caller's perceived extra wait).
        # For batch_size=1 there is no queuing.
        queuing_latency_ms = (bs - 1) * single_query_ms if bs > 1 else 0.0

        results[bs] = {
            "throughput_relative": throughput_relative,
            "latency_ms": latency_ms,
            "queuing_latency_ms": queuing_latency_ms,
        }

    # H6.4: batch 32–128 must give > 5x throughput vs batch 1
    target_batch_sizes = [bs for bs in batch_sizes if 32 <= bs <= 128]
    h6_4_supported = bool(
        target_batch_sizes
        and all(results[bs]["throughput_relative"] > 5.0 for bs in target_batch_sizes)
    )

    # Optimal batch size: maximises throughput_relative / (1 + queuing_latency_ms / single_query_ms)
    # i.e. best throughput per unit of added queuing overhead
    def _score(bs: int) -> float:
        t = results[bs]["throughput_relative"]
        q = results[bs]["queuing_latency_ms"]
        return t / (1.0 + q / single_query_ms)

    optimal_batch_size = max(batch_sizes, key=_score)

    results["h6_4_supported"] = h6_4_supported
    results["optimal_batch_size"] = optimal_batch_size
    return results
