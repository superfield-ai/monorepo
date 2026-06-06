"""
scale_benchmark.py — Full-scale Postgres benchmark for Area 1 (H1.1).

Extends the G1 spike (experiments/g1-postgres-scale/) to 20M and 100M blocks,
adds HNSW index build time, VACUUM ANALYZE time, and throughput metrics.

Import helpers from the G1 package where possible; fall back to local copies
for anything that requires structural changes.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
from typing import Any

import numpy as np
import psycopg2  # noqa: F401 — imported here so tests can patch scale_benchmark.psycopg2

# ---------------------------------------------------------------------------
# Re-use G1 modules if on the path, otherwise add the path.
# ---------------------------------------------------------------------------

_G1_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "g1-postgres-scale")
)
if _G1_DIR not in sys.path:
    sys.path.insert(0, _G1_DIR)

from ingest import generate_and_ingest, DOMAIN_MIXES  # noqa: E402 (G1)
from benchmark import run_latency_benchmark, G1_P99_THRESHOLD_MS  # noqa: E402 (G1)
from schema import ensure_schema  # noqa: E402 (G1)

# Streaming insertion threshold: corpora above this size are ingested in
# multiple chunks rather than generating all block IDs up front.
STREAMING_THRESHOLD = 10_000_000  # 10M blocks


def _parse_scale(s: str) -> int:
    """Parse scale strings like '1m', '20m', '100m' to int."""
    s = s.strip().lower()
    if s.endswith("m"):
        return int(float(s[:-1]) * 1_000_000)
    if s.endswith("k"):
        return int(float(s[:-1]) * 1_000)
    return int(s)


def _scale_label(n: int) -> str:
    if n >= 1_000_000:
        return f"{n // 1_000_000}M"
    if n >= 1_000:
        return f"{n // 1_000}K"
    return str(n)


def _measure_hnsw_build_time(conn, embedding_dim: int) -> float:
    """Drop and rebuild the HNSW index; return wall-clock seconds."""
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute("DROP INDEX IF EXISTS idx_blocks_embedding")
        cur.execute(
            f"""
            CREATE INDEX idx_blocks_embedding
            ON blocks
            USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
            """
        )
    conn.commit()
    return time.perf_counter() - t0


def _measure_vacuum_analyze(conn) -> float:
    """Run VACUUM ANALYZE on blocks; return wall-clock seconds."""
    old_autocommit = conn.autocommit
    conn.autocommit = True
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute("VACUUM ANALYZE blocks")
    elapsed = time.perf_counter() - t0
    conn.autocommit = old_autocommit
    return elapsed


def _truncate_tables(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "TRUNCATE links, version_blocks, blocks, "
            "document_versions, documents RESTART IDENTITY CASCADE"
        )
    conn.commit()


def _ingest_streaming(
    conn,
    n_blocks: int,
    domain_mix: dict[str, float],
    embedding_dim: int,
    seed: int,
    chunk_size: int = 500_000,
    batch_size: int = 1000,
) -> dict[str, Any]:
    """Ingest large corpora in chunks to avoid holding all block IDs in memory.

    Delegates each chunk to generate_and_ingest (which itself uses execute_values
    batches internally). Aggregates stats across chunks.
    """
    t0 = time.perf_counter()
    total_links = 0
    total_storage = 0
    n_chunks = (n_blocks + chunk_size - 1) // chunk_size

    for chunk_idx in range(n_chunks):
        remaining = n_blocks - chunk_idx * chunk_size
        this_chunk = min(chunk_size, remaining)
        chunk_seed = seed + chunk_idx * 7919  # deterministic per-chunk seed

        stats = generate_and_ingest(
            conn=conn,
            n_blocks=this_chunk,
            domain_mix=domain_mix,
            embedding_dim=embedding_dim,
            seed=chunk_seed,
            batch_size=batch_size,
        )
        total_links += stats["n_links"]
        total_storage = stats["storage_bytes"]  # latest measurement is total

    elapsed = time.perf_counter() - t0
    return {
        "n_blocks": n_blocks,
        "n_links": total_links,
        "storage_bytes": total_storage,
        "embedding_storage_bytes": n_blocks * embedding_dim * 4,
        "ingest_time_seconds": round(elapsed, 3),
        "streaming": True,
        "n_chunks": n_chunks,
        "chunk_size": chunk_size,
    }


def run_scale_benchmark(
    db_url: str,
    scales: list[int],
    domain_mixes: list[dict],
    n_queries: int = 100,
    output_dir: str = "results/scale",
    embedding_dim: int = 1536,
    seed: int = 42,
    batch_size: int = 1000,
    skip_schema: bool = False,
) -> dict:
    """Full-scale Area 1 benchmark across all scale × domain-mix combinations.

    For each scale in *scales* and each mix in *domain_mixes*:
      - Ingest a synthetic corpus (streaming for ≥ STREAMING_THRESHOLD blocks).
      - Rebuild the HNSW index; record build time.
      - Run VACUUM ANALYZE; record time.
      - Run the G1 latency benchmark (semantic / fulltext / graph traversal).
      - Record P50/P99 latency and effective throughput (queries/s at P50).
      - Record whether P99 exceeds the 500 ms threshold.

    Args:
        db_url: Postgres connection URL.
        scales: List of corpus sizes as integers (e.g. [1_000_000, 20_000_000]).
        domain_mixes: List of domain-mix dicts, each ``{domain: fraction}``.
        n_queries: Queries per mode (passed to the G1 benchmark).
        output_dir: Directory for intermediate per-scale JSON results.
        embedding_dim: Embedding dimensionality.
        seed: Base random seed.
        batch_size: Batch size for execute_values inserts.
        skip_schema: If True, skip schema creation.

    Returns:
        Structured results dict with keys:
            ``scales_tested``, ``domain_mixes``, ``results``.
        Each entry in ``results`` contains:
            ``scale_label``, ``n_blocks``, ``domain_mix``, ``ingest``,
            ``hnsw_build_time_seconds``, ``vacuum_analyze_time_seconds``,
            ``benchmark``, ``throughput_qps_p50``, ``p99_exceeds_threshold``.
    """
    os.makedirs(output_dir, exist_ok=True)

    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    if not skip_schema:
        ensure_schema(conn)

    all_results: list[dict] = []

    for n_blocks in scales:
        label = _scale_label(n_blocks)
        use_streaming = n_blocks >= STREAMING_THRESHOLD

        for mix_idx, domain_mix in enumerate(domain_mixes):
            print(
                f"[Area1] Scale={label}  Mix={mix_idx}  streaming={use_streaming}"
            )
            _truncate_tables(conn)

            # --- Ingest ---
            if use_streaming:
                ingest_stats = _ingest_streaming(
                    conn=conn,
                    n_blocks=n_blocks,
                    domain_mix=domain_mix,
                    embedding_dim=embedding_dim,
                    seed=seed + mix_idx,
                    batch_size=batch_size,
                )
            else:
                ingest_stats = generate_and_ingest(
                    conn=conn,
                    n_blocks=n_blocks,
                    domain_mix=domain_mix,
                    embedding_dim=embedding_dim,
                    seed=seed + mix_idx,
                    batch_size=batch_size,
                )

            # --- HNSW rebuild ---
            hnsw_time = _measure_hnsw_build_time(conn, embedding_dim)

            # --- VACUUM ANALYZE ---
            vacuum_time = _measure_vacuum_analyze(conn)

            # --- Latency benchmark ---
            bench = run_latency_benchmark(
                conn=conn,
                corpus_id=f"{label}_mix{mix_idx}",
                n_queries=n_queries,
                embedding_dim=embedding_dim,
                seed=seed,
            )

            # Throughput: queries per second at P50 latency
            p50_ms = bench["semantic"]["p50_ms"]
            throughput_qps = 1000.0 / p50_ms if p50_ms > 0 else float("inf")

            # P99 threshold check across all modes
            p99_max = max(
                bench["semantic"]["p99_ms"],
                bench["fulltext"]["p99_ms"],
                max(v["p99_ms"] for v in bench["graph_traversal"].values()),
            )
            p99_exceeds = p99_max >= G1_P99_THRESHOLD_MS

            entry = {
                "scale_label": label,
                "n_blocks": n_blocks,
                "domain_mix": domain_mix,
                "mix_index": mix_idx,
                "ingest": ingest_stats,
                "hnsw_build_time_seconds": round(hnsw_time, 3),
                "vacuum_analyze_time_seconds": round(vacuum_time, 3),
                "benchmark": bench,
                "throughput_qps_p50": round(throughput_qps, 2),
                "p99_exceeds_threshold": p99_exceeds,
            }
            all_results.append(entry)
            print(
                f"[Area1]   semantic P99={bench['semantic']['p99_ms']:.1f}ms  "
                f"fulltext P99={bench['fulltext']['p99_ms']:.1f}ms  "
                f"graph-4hop P99={bench['graph_traversal']['4_hop']['p99_ms']:.1f}ms  "
                f"HNSW build={hnsw_time:.1f}s"
            )

    conn.close()

    return {
        "experiment": "area1_scale_benchmark",
        "scales_tested": [_scale_label(s) for s in scales],
        "domain_mixes": domain_mixes,
        "results": all_results,
    }
