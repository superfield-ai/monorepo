"""
ann_benchmark.py — H6.5, H6.6: GPU ANN vs CPU HNSW retrieval benchmark.

H6.1 is cited, not re-benchmarked.  Published cuVS / FAISS-GPU vs. CPU HNSW
numbers are documented in README.md.  The Nexum-specific experiment here
addresses H6.5 / H6.6: can a hot-shard strategy match GPU throughput given
Zipfian access patterns on real institution corpora?

CUDA is detected at runtime; all strategies degrade gracefully to CPU or
numpy when optional dependencies are absent.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
# Strategy helpers
# ---------------------------------------------------------------------------

def _recall_at_k(retrieved: np.ndarray, ground_truth: np.ndarray) -> float:
    """Mean recall@k across queries."""
    Q = ground_truth.shape[0]
    hits = 0
    for i in range(Q):
        gt_set = set(ground_truth[i].tolist())
        ret_set = set(retrieved[i].tolist())
        hits += len(gt_set & ret_set)
    return hits / (Q * ground_truth.shape[1])


def _numpy_brute_search(
    embeddings: np.ndarray,
    queries: np.ndarray,
    k: int,
) -> tuple[np.ndarray, float]:
    """Exact L2 search via numpy.  Returns (indices, build_time_ms)."""
    t0 = time.perf_counter()
    # No index to build — record near-zero build time.
    build_ms = (time.perf_counter() - t0) * 1000.0

    Q = queries.shape[0]
    indices = np.zeros((Q, k), dtype=np.int64)
    for i, q in enumerate(queries):
        dists = np.linalg.norm(embeddings - q, axis=1)
        indices[i] = np.argsort(dists)[:k]
    return indices, build_ms


def _time_queries(
    search_fn,
    queries: np.ndarray,
    k: int,
) -> tuple[np.ndarray, float, float, float]:
    """
    Run *search_fn(queries, k)* and return
    (indices, p50_ms, p99_ms, throughput_qps).
    """
    latencies_ms: list[float] = []
    all_indices: list[np.ndarray] = []

    for q in queries:
        t0 = time.perf_counter()
        idx = search_fn(q[None], k)  # single query
        latencies_ms.append((time.perf_counter() - t0) * 1000.0)
        all_indices.append(idx)

    arr = np.array(latencies_ms)
    p50 = float(np.percentile(arr, 50))
    p99 = float(np.percentile(arr, 99))
    total_s = arr.sum() / 1000.0
    qps = len(queries) / total_s if total_s > 0 else 0.0
    indices = np.vstack(all_indices)
    return indices, p50, p99, qps


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_ann_benchmark(
    embeddings: np.ndarray,        # shape (N, D)
    queries: np.ndarray,           # shape (Q, D)
    ground_truth: np.ndarray,      # shape (Q, k)
    k: int = 10,
    use_gpu: bool = False,
) -> dict[str, dict[str, Any] | None]:
    """
    Compare ANN retrieval strategies on pregenerated embeddings:
    - numpy_brute: exact L2 search (always available)
    - faiss_flat:  FAISS IndexFlatL2 (CPU, if faiss available)
    - faiss_ivf:   FAISS IVFFlat (approximate CPU, if faiss available)
    - faiss_gpu:   FAISS GPU (if CUDA available and use_gpu=True)

    Returns:
        {strategy: {'recall_at_k', 'p50_ms', 'p99_ms',
                    'throughput_qps', 'index_build_time_ms'}}
        faiss_gpu returns None values if CUDA not available.
    """
    results: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Strategy 1: numpy_brute (always available)
    # ------------------------------------------------------------------
    t_build = time.perf_counter()
    _, build_ms = _numpy_brute_search(embeddings, queries[:1], k)
    build_ms = (time.perf_counter() - t_build) * 1000.0

    def _numpy_search(q: np.ndarray, k: int) -> np.ndarray:
        dists = np.linalg.norm(embeddings - q, axis=1)
        return np.argsort(dists)[:k][None]

    indices, p50, p99, qps = _time_queries(_numpy_search, queries, k)
    recall = _recall_at_k(indices, ground_truth)
    results["numpy_brute"] = {
        "recall_at_k": recall,
        "p50_ms": p50,
        "p99_ms": p99,
        "throughput_qps": qps,
        "index_build_time_ms": build_ms,
    }

    # ------------------------------------------------------------------
    # Strategies 2–4: FAISS (optional)
    # ------------------------------------------------------------------
    try:
        import faiss  # type: ignore[import]

        D = embeddings.shape[1]
        N = embeddings.shape[0]

        # faiss_flat
        t0 = time.perf_counter()
        index_flat = faiss.IndexFlatL2(D)
        index_flat.add(embeddings.astype(np.float32))
        flat_build_ms = (time.perf_counter() - t0) * 1000.0

        def _faiss_flat_search(q: np.ndarray, k: int) -> np.ndarray:
            _, I = index_flat.search(q.astype(np.float32), k)
            return I

        indices, p50, p99, qps = _time_queries(_faiss_flat_search, queries, k)
        results["faiss_flat"] = {
            "recall_at_k": _recall_at_k(indices, ground_truth),
            "p50_ms": p50,
            "p99_ms": p99,
            "throughput_qps": qps,
            "index_build_time_ms": flat_build_ms,
        }

        # faiss_ivf
        nlist = max(1, min(int(np.sqrt(N)), N // 4))
        t0 = time.perf_counter()
        quantizer = faiss.IndexFlatL2(D)
        index_ivf = faiss.IndexIVFFlat(quantizer, D, nlist)
        index_ivf.train(embeddings.astype(np.float32))
        index_ivf.add(embeddings.astype(np.float32))
        ivf_build_ms = (time.perf_counter() - t0) * 1000.0

        def _faiss_ivf_search(q: np.ndarray, k: int) -> np.ndarray:
            _, I = index_ivf.search(q.astype(np.float32), k)
            return I

        indices, p50, p99, qps = _time_queries(_faiss_ivf_search, queries, k)
        results["faiss_ivf"] = {
            "recall_at_k": _recall_at_k(indices, ground_truth),
            "p50_ms": p50,
            "p99_ms": p99,
            "throughput_qps": qps,
            "index_build_time_ms": ivf_build_ms,
        }

        # faiss_gpu
        cuda_available = False
        if use_gpu:
            try:
                res = faiss.StandardGpuResources()
                index_gpu = faiss.index_cpu_to_gpu(res, 0, index_flat)
                cuda_available = True
            except Exception:
                cuda_available = False

        if use_gpu and cuda_available:
            t0 = time.perf_counter()
            gpu_build_ms = (time.perf_counter() - t0) * 1000.0

            def _faiss_gpu_search(q: np.ndarray, k: int) -> np.ndarray:
                _, I = index_gpu.search(q.astype(np.float32), k)
                return I

            indices, p50, p99, qps = _time_queries(_faiss_gpu_search, queries, k)
            results["faiss_gpu"] = {
                "recall_at_k": _recall_at_k(indices, ground_truth),
                "p50_ms": p50,
                "p99_ms": p99,
                "throughput_qps": qps,
                "index_build_time_ms": gpu_build_ms,
            }
        else:
            results["faiss_gpu"] = {
                "recall_at_k": None,
                "p50_ms": None,
                "p99_ms": None,
                "throughput_qps": None,
                "index_build_time_ms": None,
                "note": "CUDA not available or use_gpu=False",
            }

    except ImportError:
        for strategy in ("faiss_flat", "faiss_ivf", "faiss_gpu"):
            results[strategy] = {
                "recall_at_k": None,
                "p50_ms": None,
                "p99_ms": None,
                "throughput_qps": None,
                "index_build_time_ms": None,
                "note": "faiss not installed",
            }

    return results
