"""
run_g1_real.py — G1 verification harness with real all-MiniLM-L6-v2 embeddings.

This is the entry point for the H1.1 acceptance-criterion measurement
(issue #4). It:

  1. Ingests a synthetic-but-semantically-structured corpus at the requested
     scale, embedding every block with sentence-transformers/all-MiniLM-L6-v2.
  2. Runs the latency benchmark across semantic / full-text / graph modes.
  3. Computes recall@10 against an exact brute-force baseline.
  4. Writes a ``ResultEnvelope`` JSON via the shared
     ``experiments/_lib/results_writer.py``.

Usage::

    python run_g1_real.py \\
        --db-url postgresql://nexum:nexum@localhost:5433/nexum_bench_real \\
        --scale 100k \\
        --n-queries 100 \\
        --recall-queries 30

Exit code 0 on G1 latency pass (P99 < 500 ms across all modes), 1 otherwise.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any

import psycopg2

# Allow running as a script from anywhere — put repo root on sys.path so
# experiments._lib resolves.
_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from experiments._lib import (  # noqa: E402
    capture_run_context,
    ResultEnvelope,
    write_result,
)

# Local module imports (this file lives in experiments/g1-postgres-scale/ so
# bench_real / ingest_real / schema sit alongside).
sys.path.insert(0, str(_HERE))
from ingest_real import generate_and_ingest_real, DOMAIN_MIXES, DEFAULT_MODEL_NAME  # noqa: E402
from bench_real import run_latency_benchmark_real  # noqa: E402
from schema import ensure_schema  # noqa: E402


def _parse_scale(s: str) -> int:
    s = s.strip().lower()
    if s.endswith("m"):
        return int(float(s[:-1]) * 1_000_000)
    if s.endswith("k"):
        return int(float(s[:-1]) * 1_000)
    return int(s)


def _truncate(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "TRUNCATE links, version_blocks, blocks, "
            "document_versions, documents RESTART IDENTITY CASCADE"
        )
    conn.commit()


def _build_hnsw_if_missing(conn) -> dict[str, Any]:
    """Verify the HNSW index exists; (re)build if not. Returns build stats."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM pg_indexes "
            "WHERE schemaname='public' AND indexname=%s",
            ("blocks_embedding_hnsw_idx",),
        )
        present = cur.fetchone() is not None
        if present:
            cur.execute(
                "SELECT pg_relation_size('blocks_embedding_hnsw_idx')"
            )
            size_bytes = int(cur.fetchone()[0])
            return {"reused_existing": True, "build_seconds": None,
                    "index_size_bytes": size_bytes}

        # Build it. The schema bootstrap should have done this already, but
        # belt-and-braces.
        t0 = time.perf_counter()
        cur.execute(
            "CREATE INDEX blocks_embedding_hnsw_idx ON blocks "
            "USING hnsw (embedding vector_cosine_ops) "
            "WITH (m = 16, ef_construction = 64)"
        )
        conn.commit()
        build_seconds = time.perf_counter() - t0
        cur.execute("SELECT pg_relation_size('blocks_embedding_hnsw_idx')")
        size_bytes = int(cur.fetchone()[0])
    return {"reused_existing": False, "build_seconds": build_seconds,
            "index_size_bytes": size_bytes}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=("G1 verification with real all-MiniLM-L6-v2 embeddings "
                     "(issue #4)")
    )
    parser.add_argument(
        "--db-url",
        default="postgresql://nexum:nexum@localhost:5433/nexum_bench_real",
    )
    parser.add_argument("--scale", default="100k",
                        help="e.g. 10k, 100k, 1m, 5m")
    parser.add_argument("--domain-mix", default="mixed",
                        choices=list(DOMAIN_MIXES.keys()))
    parser.add_argument("--n-queries", type=int, default=100)
    parser.add_argument("--recall-queries", type=int, default=30,
                        help="brute-force recall@10 queries (each is one "
                             "sequential scan of the embeddings)")
    parser.add_argument("--ef-search", type=int, default=40)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--embed-batch-size", type=int, default=256)
    parser.add_argument(
        "--skip-ingest", action="store_true",
        help="Reuse an already-ingested corpus (skip TRUNCATE+ingest).",
    )
    parser.add_argument(
        "--skip-schema", action="store_true",
        help="Skip schema apply (assumes schema already present).",
    )
    parser.add_argument(
        "--results-dir",
        default=str(_HERE / "results"),
        help="Directory for the ResultEnvelope JSON.",
    )
    parser.add_argument(
        "--notes", default="",
        help="Free-form notes string written to the envelope.",
    )
    args = parser.parse_args(argv)

    n_blocks = _parse_scale(args.scale)
    scale_label = (f"{n_blocks // 1_000_000}M" if n_blocks >= 1_000_000
                   else f"{n_blocks // 1_000}K" if n_blocks >= 1_000
                   else str(n_blocks))

    print(f"[G1-real] scale={scale_label} n_blocks={n_blocks:,} db={args.db_url}")
    conn = psycopg2.connect(args.db_url)
    conn.autocommit = False

    if not args.skip_schema:
        print("[G1-real] Applying schema …")
        ensure_schema(conn)

    ingest_stats: dict[str, Any] | None = None
    if not args.skip_ingest:
        print("[G1-real] Truncating prior data …")
        _truncate(conn)

        print(f"[G1-real] Ingesting {n_blocks:,} blocks with real embeddings …")
        ingest_stats = generate_and_ingest_real(
            conn=conn,
            n_blocks=n_blocks,
            domain_mix=DOMAIN_MIXES[args.domain_mix],
            seed=args.seed,
            batch_size=args.batch_size,
            embed_batch_size=args.embed_batch_size,
        )
        print(f"[G1-real] Ingest done in "
              f"{ingest_stats['ingest_time_seconds']:.1f}s "
              f"(embed: {ingest_stats['embed_seconds']:.1f}s)")

    # The schema CREATE INDEX HNSW already runs at apply time, so the index
    # should be present on a fresh DB. Confirm.
    print("[G1-real] Verifying HNSW index …")
    index_stats = _build_hnsw_if_missing(conn)
    print(f"[G1-real]   {index_stats}")

    # Tighten Postgres planner stats so HNSW gets used.
    with conn.cursor() as cur:
        cur.execute("ANALYZE blocks")
        cur.execute("ANALYZE links")
    conn.commit()

    print(f"[G1-real] Running benchmark "
          f"(n_queries={args.n_queries}, recall_queries={args.recall_queries}, "
          f"ef_search={args.ef_search}) …")
    bench = run_latency_benchmark_real(
        conn=conn,
        corpus_id=scale_label,
        n_queries=args.n_queries,
        seed=args.seed,
        ef_search=args.ef_search,
        n_recall_queries=args.recall_queries,
    )

    sem = bench["semantic"]
    rec = bench["recall"]
    ft = bench["fulltext"]
    g = bench["graph_traversal"]
    print(
        f"[G1-real] Results @ {scale_label}:\n"
        f"  semantic    P50={sem['p50_ms']:.1f}ms  P99={sem['p99_ms']:.1f}ms  "
        f"(ef_search={sem['ef_search']})\n"
        f"  recall@10   mean={rec['mean_recall_at_10']:.3f}  "
        f"p10={rec['p10_recall_at_10']:.3f}  "
        f"(brute force P50={rec['brute_force_p50_ms']:.0f}ms)\n"
        f"  fulltext    P50={ft['p50_ms']:.1f}ms  P99={ft['p99_ms']:.1f}ms\n"
        f"  graph 2hop  P50={g['2_hop']['p50_ms']:.1f}ms  "
        f"P99={g['2_hop']['p99_ms']:.1f}ms\n"
        f"  graph 4hop  P50={g['4_hop']['p50_ms']:.1f}ms  "
        f"P99={g['4_hop']['p99_ms']:.1f}ms\n"
        f"  graph 6hop  P50={g['6_hop']['p50_ms']:.1f}ms  "
        f"P99={g['6_hop']['p99_ms']:.1f}ms"
    )

    # Pass logic: BOTH latency AND recall must hold to claim G1.
    pass_latency = bench["pass_g1_latency"]
    pass_recall = rec["mean_recall_at_10"] >= 0.90  # H1.1 acceptance criterion
    overall_pass = pass_latency and pass_recall
    print(f"[G1-real] pass_latency={pass_latency}  "
          f"pass_recall(>=0.90)={pass_recall}  overall={overall_pass}")

    ctx = capture_run_context(gate="G1", hypothesis="H1.1", seed=args.seed)
    metrics: dict[str, Any] = {
        "scale_label": scale_label,
        "n_blocks": bench["n_blocks_in_corpus"],
        "ingest": ingest_stats,
        "hnsw_index": index_stats,
        "embedding_model": DEFAULT_MODEL_NAME,
        "benchmark": bench,
        "acceptance": {
            "p99_threshold_ms": 500.0,
            "recall_at_10_min": 0.90,
            "pass_latency": pass_latency,
            "pass_recall": pass_recall,
            "overall_pass": overall_pass,
        },
    }
    envelope = ResultEnvelope(
        gate="G1",
        hypothesis="H1.1",
        passed=overall_pass,
        metrics=metrics,
        runtime=ctx,
        notes=args.notes or (
            f"Issue #4 G1 verification with real all-MiniLM-L6-v2 embeddings "
            f"at {scale_label}."
        ),
    )
    out = write_result(envelope, str(_HERE))
    print(f"[G1-real] Envelope written to: {out}")

    conn.close()
    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())
