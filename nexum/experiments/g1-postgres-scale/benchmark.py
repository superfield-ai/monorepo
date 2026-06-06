"""
benchmark.py — Query latency measurement for the G1 benchmark.

Runs all three query modes (semantic, full-text, graph traversal) against the
Nexum schema and records P50 / P99 / mean latency in milliseconds.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

# G1 pass criterion: P99 latency must stay below this threshold for all modes.
G1_P99_THRESHOLD_MS = 500.0

_FULLTEXT_WORDS = [
    "legal", "medical", "contract", "agreement", "treatment", "evidence",
    "section", "provision", "clause", "statute", "regulation", "diagnosis",
    "research", "study", "finding", "analysis", "method", "result", "data",
    "patient", "record", "document",
]


def _sample_block_ids(conn, n: int, rng: np.random.Generator) -> list[str]:
    """Return up to *n* random block IDs from the database."""
    with conn.cursor() as cur:
        # TABLESAMPLE SYSTEM is much faster than ORDER BY random() at scale.
        # We oversample and truncate; fall back to ORDER BY random() if needed.
        cur.execute(
            """
            SELECT id FROM blocks
            TABLESAMPLE SYSTEM (1)
            LIMIT %s
            """,
            (n * 2,),
        )
        rows = cur.fetchall()
        if not rows:
            cur.execute("SELECT id FROM blocks LIMIT %s", (n,))
            rows = cur.fetchall()

    ids = [r[0] for r in rows]
    if len(ids) > n:
        chosen = rng.choice(len(ids), size=n, replace=False)
        ids = [ids[i] for i in chosen]
    return ids


def _measure_semantic(
    conn, n_queries: int, embedding_dim: int, rng: np.random.Generator
) -> dict[str, float]:
    """Run semantic (ANN) queries and return latency stats in milliseconds."""
    latencies_ms: list[float] = []

    with conn.cursor() as cur:
        for _ in range(n_queries):
            # Random unit-normalised query vector
            v = rng.standard_normal(embedding_dim).astype(np.float32)
            v /= np.linalg.norm(v) + 1e-9
            query_vec = v.tolist()

            t0 = time.perf_counter()
            cur.execute(
                "SELECT id FROM blocks ORDER BY embedding <-> %s::vector LIMIT 10",
                (query_vec,),
            )
            cur.fetchall()
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)

    arr = np.array(latencies_ms, dtype=np.float64)
    return {
        "p50_ms": float(np.percentile(arr, 50)),
        "p99_ms": float(np.percentile(arr, 99)),
        "mean_ms": float(np.mean(arr)),
    }


def _measure_fulltext(
    conn, n_queries: int, rng: np.random.Generator
) -> dict[str, float]:
    """Run full-text search queries and return latency stats."""
    latencies_ms: list[float] = []
    words = _FULLTEXT_WORDS

    with conn.cursor() as cur:
        for _ in range(n_queries):
            # Use 1–3 random words as the query
            n_words = int(rng.integers(1, 4))
            query_str = " ".join(rng.choice(words, size=n_words, replace=False).tolist())

            t0 = time.perf_counter()
            cur.execute(
                "SELECT id FROM blocks WHERE tsv @@ plainto_tsquery(%s) LIMIT 10",
                (query_str,),
            )
            cur.fetchall()
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)

    arr = np.array(latencies_ms, dtype=np.float64)
    return {
        "p50_ms": float(np.percentile(arr, 50)),
        "p99_ms": float(np.percentile(arr, 99)),
        "mean_ms": float(np.mean(arr)),
    }


def _measure_graph_traversal(
    conn, n_queries: int, seed_ids: list[str], rng: np.random.Generator
) -> dict[str, dict[str, float]]:
    """Run recursive CTE graph traversal at 2 / 4 / 6 hops.

    Returns a nested dict keyed by ``'2_hop'``, ``'4_hop'``, ``'6_hop'``.
    """
    hop_latencies: dict[int, list[float]] = {2: [], 4: [], 6: []}
    n_seeds = len(seed_ids)

    if n_seeds == 0:
        # No data — return zeros
        return {
            f"{h}_hop": {"p50_ms": 0.0, "p99_ms": 0.0}
            for h in (2, 4, 6)
        }

    with conn.cursor() as cur:
        for _ in range(n_queries):
            seed_id = seed_ids[int(rng.integers(0, n_seeds))]
            for max_depth in (2, 4, 6):
                t0 = time.perf_counter()
                cur.execute(
                    """
                    WITH RECURSIVE traversal AS (
                        SELECT dst AS target_block_id, 1 AS depth
                        FROM links
                        WHERE src = %s
                        UNION ALL
                        SELECT l.dst, t.depth + 1
                        FROM links l
                        JOIN traversal t ON l.src = t.target_block_id
                        WHERE t.depth < %s
                    )
                    SELECT target_block_id FROM traversal
                    """,
                    (seed_id, max_depth),
                )
                cur.fetchall()
                hop_latencies[max_depth].append(
                    (time.perf_counter() - t0) * 1000.0
                )

    result: dict[str, dict[str, float]] = {}
    for h in (2, 4, 6):
        arr = np.array(hop_latencies[h], dtype=np.float64)
        result[f"{h}_hop"] = {
            "p50_ms": float(np.percentile(arr, 50)) if arr.size else 0.0,
            "p99_ms": float(np.percentile(arr, 99)) if arr.size else 0.0,
        }
    return result


def _count_blocks(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM blocks")
        return int(cur.fetchone()[0])


def run_latency_benchmark(
    conn,
    corpus_id: str,
    n_queries: int = 100,
    embedding_dim: int = 1536,
    seed: int = 42,
) -> dict[str, Any]:
    """Run all three query modes and measure P50/P99 latency.

    Args:
        conn: Open psycopg2 connection.
        corpus_id: Identifier string for the corpus being benchmarked (used in
                   the returned dict for traceability; not queried).
        n_queries: Number of queries to issue per mode (and per hop depth for
                   graph traversal).
        embedding_dim: Dimensionality of synthetic query embeddings.
        seed: Random seed for reproducibility.

    Returns:
        A dict with keys:
            ``n_blocks_in_corpus``, ``semantic``, ``fulltext``,
            ``graph_traversal``, ``pass_g1``.
    """
    rng = np.random.default_rng(seed)

    n_blocks = _count_blocks(conn)

    semantic_stats = _measure_semantic(conn, n_queries, embedding_dim, rng)
    fulltext_stats = _measure_fulltext(conn, n_queries, rng)

    seed_ids = _sample_block_ids(conn, min(n_queries, n_blocks), rng)
    graph_stats = _measure_graph_traversal(conn, n_queries, seed_ids, rng)

    # G1 pass criterion: P99 < 500 ms for all three modes
    p99_semantic = semantic_stats["p99_ms"]
    p99_fulltext = fulltext_stats["p99_ms"]
    p99_graph_max = max(
        v["p99_ms"] for v in graph_stats.values()
    )

    pass_g1 = (
        p99_semantic < G1_P99_THRESHOLD_MS
        and p99_fulltext < G1_P99_THRESHOLD_MS
        and p99_graph_max < G1_P99_THRESHOLD_MS
    )

    return {
        "corpus_id": corpus_id,
        "n_blocks_in_corpus": n_blocks,
        "semantic": semantic_stats,
        "fulltext": fulltext_stats,
        "graph_traversal": graph_stats,
        "pass_g1": pass_g1,
    }
