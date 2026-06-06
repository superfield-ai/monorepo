"""
bench_real.py — G1 latency + recall benchmark using REAL query embeddings.

Drop-in extension of ``benchmark.py`` that:

1. Generates query texts from the same topic-templated distribution used
   during ingest (see ``ingest_real._TOPICS``), embeds them with
   ``all-MiniLM-L6-v2``, and uses those vectors for semantic ANN queries.
2. Computes recall@10 against an exact brute-force ground truth on a query
   subset by toggling ``SET LOCAL enable_indexscan = off`` (forces sequential
   exact KNN).  Recall is the fraction of ANN-returned IDs that appear in the
   brute-force top-10.
3. Re-uses the same ``run_latency_benchmark`` API shape so callers can
   substitute it without changing their result-handling code.

The full-text and graph-traversal phases are unchanged from ``benchmark.py``.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from benchmark import (
    G1_P99_THRESHOLD_MS,
    _measure_fulltext,
    _measure_graph_traversal,
    _sample_block_ids,
    _count_blocks,
)
from ingest_real import _TOPICS, _generate_block_text, _load_model, DEFAULT_MODEL_NAME

DEFAULT_RECALL_NQ = 50  # ground-truth queries (each is one full seq scan)


def _generate_query_vectors(
    rng: np.random.Generator,
    n_queries: int,
    model_name: str,
) -> tuple[np.ndarray, list[str]]:
    """Generate ``n_queries`` query texts (one per random topic) and embed."""
    texts: list[str] = []
    for _ in range(n_queries):
        topic_idx = int(rng.integers(0, len(_TOPICS)))
        texts.append(_generate_block_text(rng, topic_idx))
    model = _load_model(model_name)
    vecs = model.encode(
        texts, batch_size=64, show_progress_bar=False,
        convert_to_numpy=True, normalize_embeddings=True,
    ).astype(np.float32)
    return vecs, texts


def _measure_semantic_real(
    conn,
    n_queries: int,
    rng: np.random.Generator,
    model_name: str,
    ef_search: int = 40,
) -> tuple[dict[str, float], np.ndarray, list[list[str]]]:
    """Run semantic ANN with real query embeddings; return stats + vectors +
    per-query top-10 IDs (used to compute recall@10 against brute-force)."""
    vecs, _ = _generate_query_vectors(rng, n_queries, model_name)
    latencies_ms: list[float] = []
    top10_per_query: list[list[str]] = []

    with conn.cursor() as cur:
        cur.execute(f"SET LOCAL hnsw.ef_search = {int(ef_search)}")
        for i in range(n_queries):
            qv = vecs[i].tolist()
            t0 = time.perf_counter()
            cur.execute(
                "SELECT id FROM blocks ORDER BY embedding <=> %s::vector LIMIT 10",
                (qv,),
            )
            rows = cur.fetchall()
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)
            top10_per_query.append([str(r[0]) for r in rows])

    arr = np.array(latencies_ms, dtype=np.float64)
    stats = {
        "p50_ms": float(np.percentile(arr, 50)),
        "p95_ms": float(np.percentile(arr, 95)),
        "p99_ms": float(np.percentile(arr, 99)),
        "mean_ms": float(np.mean(arr)),
        "ef_search": ef_search,
    }
    return stats, vecs, top10_per_query


def _measure_recall_at_10(
    conn,
    query_vecs: np.ndarray,
    ann_top10: list[list[str]],
    n_recall_queries: int = DEFAULT_RECALL_NQ,
) -> dict[str, Any]:
    """Compute recall@10 of HNSW vs. exact brute force on a query subset.

    For each of the first ``n_recall_queries`` queries we:
      1. Disable indexscan (forces seq scan exact KNN).
      2. Compare the ANN top-10 IDs against the exact top-10 IDs.
      3. Recall@10 = |intersection| / 10.

    Returns mean and quantiles plus per-query brute-force latency for context.
    """
    n_recall_queries = min(n_recall_queries, query_vecs.shape[0])
    recalls: list[float] = []
    bf_latencies_ms: list[float] = []

    with conn.cursor() as cur:
        # Force sequential scan on blocks.embedding for the exact baseline.
        cur.execute("SET LOCAL enable_indexscan = off")
        cur.execute("SET LOCAL enable_bitmapscan = off")
        for i in range(n_recall_queries):
            qv = query_vecs[i].tolist()
            t0 = time.perf_counter()
            cur.execute(
                "SELECT id FROM blocks ORDER BY embedding <=> %s::vector LIMIT 10",
                (qv,),
            )
            exact = [str(r[0]) for r in cur.fetchall()]
            bf_latencies_ms.append((time.perf_counter() - t0) * 1000.0)
            ann_set = set(ann_top10[i])
            exact_set = set(exact)
            if not exact_set:
                continue
            recalls.append(len(ann_set & exact_set) / 10.0)

    rec = np.array(recalls, dtype=np.float64)
    bf = np.array(bf_latencies_ms, dtype=np.float64)
    return {
        "n_queries_used": int(rec.size),
        "mean_recall_at_10": float(np.mean(rec)) if rec.size else 0.0,
        "p10_recall_at_10": float(np.percentile(rec, 10)) if rec.size else 0.0,
        "p50_recall_at_10": float(np.percentile(rec, 50)) if rec.size else 0.0,
        "brute_force_p50_ms": float(np.percentile(bf, 50)) if bf.size else 0.0,
        "brute_force_p99_ms": float(np.percentile(bf, 99)) if bf.size else 0.0,
    }


def run_latency_benchmark_real(
    conn,
    corpus_id: str,
    n_queries: int = 100,
    seed: int = 42,
    model_name: str = DEFAULT_MODEL_NAME,
    ef_search: int = 40,
    n_recall_queries: int = DEFAULT_RECALL_NQ,
) -> dict[str, Any]:
    """Run all three modes plus recall@10. Same shape as
    ``benchmark.run_latency_benchmark`` plus a ``recall`` block."""
    rng = np.random.default_rng(seed)
    n_blocks = _count_blocks(conn)

    semantic_stats, qvecs, ann_top10 = _measure_semantic_real(
        conn, n_queries, rng, model_name, ef_search=ef_search,
    )
    recall_stats = _measure_recall_at_10(
        conn, qvecs, ann_top10, n_recall_queries=n_recall_queries,
    )
    fulltext_stats = _measure_fulltext(conn, n_queries, rng)
    seed_ids = _sample_block_ids(conn, min(n_queries, n_blocks), rng)
    graph_stats = _measure_graph_traversal(conn, n_queries, seed_ids, rng)

    p99_semantic = semantic_stats["p99_ms"]
    p99_fulltext = fulltext_stats["p99_ms"]
    p99_graph_max = max(v["p99_ms"] for v in graph_stats.values())
    pass_g1 = (
        p99_semantic < G1_P99_THRESHOLD_MS
        and p99_fulltext < G1_P99_THRESHOLD_MS
        and p99_graph_max < G1_P99_THRESHOLD_MS
    )

    return {
        "corpus_id": corpus_id,
        "n_blocks_in_corpus": n_blocks,
        "embedding_model": model_name,
        "semantic": semantic_stats,
        "recall": recall_stats,
        "fulltext": fulltext_stats,
        "graph_traversal": graph_stats,
        "pass_g1_latency": pass_g1,
        "pass_g1_p99_threshold_ms": G1_P99_THRESHOLD_MS,
    }
