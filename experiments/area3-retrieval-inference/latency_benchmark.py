"""
latency_benchmark.py — H3.2: latency floor measurement.

Measures end-to-end retrieve+generate latency at varying k values,
computes P50/P99 across repetitions, and simulates a two-tier block cache
to model the hot/cold latency split.

Hypothesis H3.2: The latency gap between graph-resident inference and
static model inference can be bounded to 20–50x with a two-tier cache
(hot blocks in memory, cold blocks on disk-backed HNSW).
"""

from __future__ import annotations

import collections
import time
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from graph_inference_client import GraphInferenceClient


# ---------------------------------------------------------------------------
# Two-tier block cache
# ---------------------------------------------------------------------------


class TwoTierBlockCache:
    """
    Simulates a hot/cold block cache.

    The top-N blocks by access frequency are kept "in memory" (zero-latency
    lookup).  The remaining blocks live on "disk" — simulated by a configurable
    sleep to model HNSW retrieval latency.

    This implements the caching model described in H3.2.

    Parameters
    ----------
    hot_fraction:
        Fraction of the total corpus to keep in the hot tier (default 0.05 = 5%).
    cold_latency_ms:
        Simulated disk-lookup latency for cold-tier blocks (default 10 ms).
    """

    def __init__(
        self,
        hot_fraction: float = 0.05,
        cold_latency_ms: float = 10.0,
    ) -> None:
        if not 0.0 < hot_fraction < 1.0:
            raise ValueError(f"hot_fraction must be in (0, 1); got {hot_fraction}")
        if cold_latency_ms < 0:
            raise ValueError(f"cold_latency_ms must be non-negative; got {cold_latency_ms}")

        self.hot_fraction = hot_fraction
        self.cold_latency_ms = cold_latency_ms

        # Maps block_id → mock block dict
        self._all_blocks: dict[str, dict] = {}
        # Access frequency counter
        self._access_counts: collections.Counter[str] = collections.Counter()
        # Hot-tier set (rebuilt lazily on each access after a new block is registered)
        self._hot_set: set[str] = set()
        self._hot_set_dirty: bool = True

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _rebuild_hot_set(self) -> None:
        """Recompute the hot-tier set from current access counts."""
        n_total = len(self._all_blocks)
        if n_total == 0:
            self._hot_set = set()
            self._hot_set_dirty = False
            return

        n_hot = max(1, int(n_total * self.hot_fraction))
        # Top-n by access count; break ties by block_id for determinism.
        most_common = self._access_counts.most_common(n_hot)
        self._hot_set = {block_id for block_id, _ in most_common}
        self._hot_set_dirty = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def register(self, block: dict) -> None:
        """Add a block to the backing store (call once per block in the corpus).

        Parameters
        ----------
        block:
            Dict with at least a ``"block_id"`` key.
        """
        block_id = block["block_id"]
        self._all_blocks[block_id] = block
        self._hot_set_dirty = True

    def get(self, block_id: str) -> tuple[dict | None, float]:
        """Retrieve a block, simulating hot/cold latency.

        The hot set is recomputed periodically (every 100 accesses) so that
        frequently accessed blocks migrate into the hot tier as access counts
        accumulate.

        Parameters
        ----------
        block_id:
            The block to fetch.

        Returns
        -------
        tuple[dict | None, float]
            ``(block_or_None, latency_ms)`` — latency is 0.0 for hot hits,
            ``cold_latency_ms`` for cold hits, and 0.0 for misses (block
            not found anywhere).
        """
        block = self._all_blocks.get(block_id)
        if block is None:
            return None, 0.0

        # Record access
        self._access_counts[block_id] += 1

        # Rebuild hot set periodically so new access patterns are reflected,
        # or when explicitly dirtied by a register() call.
        total = sum(self._access_counts.values())
        if self._hot_set_dirty or (total % 100 == 0 and total > 0):
            self._rebuild_hot_set()

        if block_id in self._hot_set:
            latency_ms = 0.0
        else:
            # Simulate cold-tier disk latency
            time.sleep(self.cold_latency_ms / 1000.0)
            latency_ms = self.cold_latency_ms

        return block, latency_ms

    def access_pattern_stats(self) -> dict:
        """Return statistics about the current access pattern.

        Returns
        -------
        dict with keys:
            - ``total_accesses``: total number of get() calls that found a block
            - ``hot_hit_rate``: fraction of accesses served from the hot tier
            - ``cold_hit_rate``: fraction of accesses served from the cold tier
            - ``n_hot_blocks``: number of blocks in the hot tier
            - ``n_cold_blocks``: number of blocks in the cold tier
            - ``n_total_blocks``: total registered blocks
            - ``zipf_alpha_estimate``: rough Zipf exponent fit to access counts
              (uses OLS on log-rank vs. log-count; None if too few data points)
        """
        if self._hot_set_dirty:
            self._rebuild_hot_set()

        total_accesses = sum(self._access_counts.values())
        if total_accesses == 0:
            return {
                "total_accesses": 0,
                "hot_hit_rate": 0.0,
                "cold_hit_rate": 0.0,
                "n_hot_blocks": len(self._hot_set),
                "n_cold_blocks": len(self._all_blocks) - len(self._hot_set),
                "n_total_blocks": len(self._all_blocks),
                "zipf_alpha_estimate": None,
            }

        hot_accesses = sum(
            count
            for block_id, count in self._access_counts.items()
            if block_id in self._hot_set
        )
        hot_hit_rate = hot_accesses / total_accesses
        cold_hit_rate = 1.0 - hot_hit_rate

        # Zipf alpha estimation via OLS on log(rank) ~ log(count)
        zipf_alpha: float | None = None
        counts_sorted = sorted(self._access_counts.values(), reverse=True)
        if len(counts_sorted) >= 3:
            ranks = np.arange(1, len(counts_sorted) + 1, dtype=float)
            log_ranks = np.log(ranks)
            log_counts = np.log(np.array(counts_sorted, dtype=float) + 1e-9)
            # Slope of log_count ~ a + b*log_rank; b should be ~ -alpha
            b = np.polyfit(log_ranks, log_counts, deg=1)[0]
            zipf_alpha = float(-b)

        return {
            "total_accesses": total_accesses,
            "hot_hit_rate": float(hot_hit_rate),
            "cold_hit_rate": float(cold_hit_rate),
            "n_hot_blocks": len(self._hot_set),
            "n_cold_blocks": len(self._all_blocks) - len(self._hot_set),
            "n_total_blocks": len(self._all_blocks),
            "zipf_alpha_estimate": zipf_alpha,
        }


# ---------------------------------------------------------------------------
# Latency benchmark
# ---------------------------------------------------------------------------


def run_latency_benchmark(
    client: "GraphInferenceClient",
    queries: list[str],
    k_values: list[int] | None = None,
    n_reps: int = 5,
) -> dict:
    """Measure end-to-end retrieve+generate latency at each k value.

    For each (query, k) combination, runs ``n_reps`` repetitions and
    records retrieval_ms, generation_ms, total_ms.  Computes P50/P99 across
    all reps × queries for each k.

    Tests H3.2: can latency be bounded to 20–50x vs. parametric inference?

    Parameters
    ----------
    client:
        A :class:`~graph_inference_client.GraphInferenceClient` instance.
    queries:
        List of query strings to benchmark.
    k_values:
        List of k values to test (default ``[1, 5, 10, 50, 100]``).
    n_reps:
        Number of repetitions per (query, k) pair (default 5).

    Returns
    -------
    dict
        Keyed by k value (int).  Each value is a dict with:
        ``p50_total_ms``, ``p99_total_ms``,
        ``p50_retrieval_ms``, ``p99_retrieval_ms``,
        ``p50_generation_ms``, ``p99_generation_ms``,
        ``mean_total_ms``, ``tokens_per_sec_estimate``,
        ``n_samples``.
    """
    if k_values is None:
        k_values = [1, 5, 10, 50, 100]

    results: dict[int, dict] = {}

    for k in k_values:
        total_ms_list: list[float] = []
        retrieval_ms_list: list[float] = []
        generation_ms_list: list[float] = []

        for query in queries:
            for _ in range(n_reps):
                result = client.query(query, k=k)
                total_ms_list.append(result["latency_ms"])
                retrieval_ms_list.append(result["retrieval_ms"])
                generation_ms_list.append(result["generation_ms"])

        total_arr = np.array(total_ms_list, dtype=float)
        retr_arr = np.array(retrieval_ms_list, dtype=float)
        gen_arr = np.array(generation_ms_list, dtype=float)

        # Rough tokens/sec estimate: assume ~100 tokens per answer, generation time in sec
        mean_gen_sec = float(np.mean(gen_arr)) / 1000.0
        tokens_per_sec = (100.0 / mean_gen_sec) if mean_gen_sec > 0 else float("inf")

        results[k] = {
            "p50_total_ms": float(np.percentile(total_arr, 50)),
            "p99_total_ms": float(np.percentile(total_arr, 99)),
            "p50_retrieval_ms": float(np.percentile(retr_arr, 50)),
            "p99_retrieval_ms": float(np.percentile(retr_arr, 99)),
            "p50_generation_ms": float(np.percentile(gen_arr, 50)),
            "p99_generation_ms": float(np.percentile(gen_arr, 99)),
            "mean_total_ms": float(np.mean(total_arr)),
            "tokens_per_sec_estimate": tokens_per_sec,
            "n_samples": len(total_ms_list),
        }

    return results
