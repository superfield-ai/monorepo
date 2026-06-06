"""
run_benchmark.py — Main entry point for the G1 Postgres scale benchmark.

Usage::

    python run_benchmark.py \\
        --db-url postgresql://localhost/nexum_bench \\
        --scales 1m 5m \\
        --n-queries 100 \\
        --output results/g1_result.json

Runs ingestion + benchmark at each scale.
Writes a structured results JSON and prints pass/fail for G1.
Exit code 0 if P99 < 500 ms at all tested scales, else 1.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

import psycopg2
import psycopg2.extras

from ingest import generate_and_ingest, DOMAIN_MIXES
from benchmark import run_latency_benchmark
from schema import ensure_schema
from sizing_memo import compute_sizing_memo
from traversal_diagnostics import run_full_diagnosis


# ---------------------------------------------------------------------------
# Scale parsing
# ---------------------------------------------------------------------------

def _parse_scale(s: str) -> int:
    """Parse a scale string like '1m', '5m', '20m', '100m' to an int."""
    s = s.strip().lower()
    if s.endswith("m"):
        return int(float(s[:-1]) * 1_000_000)
    if s.endswith("k"):
        return int(float(s[:-1]) * 1_000)
    return int(s)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _connect(db_url: str) -> "psycopg2.connection":
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return conn


def _truncate_tables(conn) -> None:
    """Remove all rows from Nexum tables to start a fresh benchmark scale."""
    with conn.cursor() as cur:
        cur.execute(
            "TRUNCATE links, version_blocks, blocks, "
            "document_versions, documents RESTART IDENTITY CASCADE"
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="G1 Postgres scale floor benchmark — Nexum H1.1 Phase 0 Spike B"
    )
    parser.add_argument(
        "--db-url",
        default="postgresql://localhost/nexum_bench",
        help="Postgres connection URL (default: postgresql://localhost/nexum_bench)",
    )
    parser.add_argument(
        "--scales",
        nargs="+",
        default=["1m", "5m"],
        metavar="SCALE",
        help="Corpus sizes to benchmark, e.g. 1m 5m 20m (default: 1m 5m)",
    )
    parser.add_argument(
        "--n-queries",
        type=int,
        default=100,
        metavar="N",
        help="Queries per mode per scale (default: 100)",
    )
    parser.add_argument(
        "--domain-mix",
        choices=list(DOMAIN_MIXES.keys()),
        default="mixed",
        help="Domain mix for synthetic corpus generation (default: mixed)",
    )
    parser.add_argument(
        "--embedding-dim",
        type=int,
        default=1536,
        help="Embedding dimensionality (default: 1536)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=1000,
        help="Batch size for execute_values inserts (default: 1000)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed (default: 42)",
    )
    parser.add_argument(
        "--output",
        default="results/g1_result.json",
        metavar="PATH",
        help="Output JSON path (default: results/g1_result.json)",
    )
    parser.add_argument(
        "--skip-schema",
        action="store_true",
        help="Skip schema creation (assumes schema already applied)",
    )
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help=(
            "Issue #74 (G1-OPT-2) — run the deep-traversal diagnosis "
            "and Fix A–D benchmarks after the latency benchmark completes "
            "for each scale. Adds a 'diagnostics' block to the result JSON."
        ),
    )
    parser.add_argument(
        "--diagnose-n-queries",
        type=int,
        default=30,
        help=(
            "Per-fix query budget for the issue #74 diagnosis. "
            "Each query runs at 2/4/6 hops, so wall time scales linearly. "
            "(default: 30)"
        ),
    )
    args = parser.parse_args(argv)

    scales = [_parse_scale(s) for s in args.scales]
    domain_mix = DOMAIN_MIXES[args.domain_mix]

    print(f"[G1] Connecting to {args.db_url!r} …")
    try:
        conn = _connect(args.db_url)
    except Exception as exc:
        print(f"[G1] ERROR — cannot connect: {exc}", file=sys.stderr)
        return 1

    if not args.skip_schema:
        print("[G1] Applying schema …")
        try:
            ensure_schema(conn)
        except Exception as exc:
            print(f"[G1] ERROR — schema apply failed: {exc}", file=sys.stderr)
            conn.close()
            return 1

    all_results: list[dict[str, Any]] = []
    overall_pass = True

    for n_blocks in scales:
        scale_label = f"{n_blocks // 1_000_000}M" if n_blocks >= 1_000_000 else str(n_blocks)
        print(f"\n[G1] === Scale: {scale_label} blocks ===")

        print(f"[G1] Truncating existing data …")
        _truncate_tables(conn)

        print(f"[G1] Ingesting {n_blocks:,} blocks (domain_mix={args.domain_mix}) …")
        t_ingest = time.perf_counter()
        ingest_stats = generate_and_ingest(
            conn=conn,
            n_blocks=n_blocks,
            domain_mix=domain_mix,
            embedding_dim=args.embedding_dim,
            seed=args.seed,
            batch_size=args.batch_size,
        )
        print(
            f"[G1] Ingest done in {ingest_stats['ingest_time_seconds']:.1f}s — "
            f"{ingest_stats['n_blocks']:,} blocks, "
            f"{ingest_stats['n_links']:,} links, "
            f"{ingest_stats['storage_bytes'] / 1e9:.2f} GB total, "
            f"{ingest_stats['embedding_storage_bytes'] / 1e9:.2f} GB embeddings"
        )

        print(f"[G1] Running latency benchmark ({args.n_queries} queries/mode) …")
        bench = run_latency_benchmark(
            conn=conn,
            corpus_id=scale_label,
            n_queries=args.n_queries,
            embedding_dim=args.embedding_dim,
            seed=args.seed,
        )

        status = "PASS" if bench["pass_g1"] else "FAIL"
        if not bench["pass_g1"]:
            overall_pass = False

        print(
            f"[G1] {scale_label} → {status}\n"
            f"       semantic:  P50={bench['semantic']['p50_ms']:.1f}ms  "
            f"P99={bench['semantic']['p99_ms']:.1f}ms\n"
            f"       fulltext:  P50={bench['fulltext']['p50_ms']:.1f}ms  "
            f"P99={bench['fulltext']['p99_ms']:.1f}ms\n"
            f"       graph 2h:  P50={bench['graph_traversal']['2_hop']['p50_ms']:.1f}ms  "
            f"P99={bench['graph_traversal']['2_hop']['p99_ms']:.1f}ms\n"
            f"       graph 4h:  P50={bench['graph_traversal']['4_hop']['p50_ms']:.1f}ms  "
            f"P99={bench['graph_traversal']['4_hop']['p99_ms']:.1f}ms\n"
            f"       graph 6h:  P50={bench['graph_traversal']['6_hop']['p50_ms']:.1f}ms  "
            f"P99={bench['graph_traversal']['6_hop']['p99_ms']:.1f}ms"
        )

        scale_block: dict[str, Any] = {
            "scale_label": scale_label,
            "ingest": ingest_stats,
            "benchmark": bench,
        }

        if args.diagnose:
            print(
                f"[G1] Running issue #74 diagnostics "
                f"({args.diagnose_n_queries} queries/fix) …"
            )
            try:
                # Reuse the same seeds the latency benchmark sampled by
                # taking a fresh sample of the same size from blocks.
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id FROM blocks "
                        "TABLESAMPLE SYSTEM (1) LIMIT %s",
                        (args.diagnose_n_queries,),
                    )
                    seed_ids = [r[0] for r in cur.fetchall()]
                report = run_full_diagnosis(
                    conn,
                    seed_ids=seed_ids,
                    n_queries=args.diagnose_n_queries,
                )
                scale_block["diagnostics"] = report.to_dict()
                chosen = report.chosen_fix or "none"
                print(f"[G1]   diagnose chose fix: {chosen}")
                print(f"[G1]   {report.chosen_fix_rationale}")
            except Exception as exc:  # pragma: no cover — runtime guard
                print(f"[G1]   diagnose ERROR: {exc}", file=sys.stderr)
                scale_block["diagnostics_error"] = str(exc)

        all_results.append(scale_block)

    # Sizing memo (always computed — arithmetic, not experiment)
    sizing = compute_sizing_memo(embedding_dim=args.embedding_dim)

    output = {
        "gate": "G1",
        "hypothesis": "H1.1",
        "pass_criterion": "P99 < 500ms at 5M blocks for all query modes",
        "overall_pass": overall_pass,
        "scales_tested": [s["scale_label"] for s in all_results],
        "results": all_results,
        "sizing_memo": sizing,
    }

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(output, fh, indent=2)
    print(f"\n[G1] Results written to {args.output}")

    overall_label = "PASS" if overall_pass else "FAIL"
    print(f"[G1] Overall G1 gate: {overall_label}")

    conn.close()
    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())
