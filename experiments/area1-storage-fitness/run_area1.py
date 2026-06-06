"""
run_area1.py — Orchestrator for the Area 1 storage fitness experiment.

Runs scale benchmark, schema comparison (Kuzu), and embedding dimension ablation.
Each section is independently skippable via CLI flags.

Usage::

    python run_area1.py \\
        --db-url postgresql://localhost/nexum_bench \\
        --scales 1m 5m \\
        --skip-kuzu \\
        --skip-embedding-ablation \\
        --output results/area1_results.json

Full run (may take hours at 100M scale)::

    python run_area1.py \\
        --db-url postgresql://localhost/nexum_bench \\
        --scales 1m 5m 20m 100m \\
        --output results/area1_results.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any


# ---------------------------------------------------------------------------
# Scale parsing (shared with G1)
# ---------------------------------------------------------------------------

def _parse_scale(s: str) -> int:
    s = s.strip().lower()
    if s.endswith("m"):
        return int(float(s[:-1]) * 1_000_000)
    if s.endswith("k"):
        return int(float(s[:-1]) * 1_000)
    return int(s)


# ---------------------------------------------------------------------------
# Default domain mixes for the full area 1 run
# ---------------------------------------------------------------------------

DEFAULT_DOMAIN_MIXES = [
    {"pdf": 0.6, "docx": 0.3, "markdown": 0.1},   # legal-ish
    {"pdf": 0.7, "docx": 0.2, "markdown": 0.1},   # medical-ish
    {"pdf": 0.45, "docx": 0.35, "markdown": 0.20}, # mixed
]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Area 1 — Storage Architecture Fitness orchestrator"
    )
    parser.add_argument(
        "--db-url",
        default="postgresql://localhost/nexum_bench",
        help="Postgres connection URL",
    )
    parser.add_argument(
        "--scales",
        nargs="+",
        default=["1m", "5m"],
        metavar="SCALE",
        help="Corpus scales to benchmark (e.g. 1m 5m 20m 100m). Default: 1m 5m.",
    )
    parser.add_argument(
        "--n-queries",
        type=int,
        default=100,
        metavar="N",
        help="Queries per mode per scale (default: 100)",
    )
    parser.add_argument(
        "--embedding-dim",
        type=int,
        default=1536,
        help="Embedding dimensionality for scale benchmark (default: 1536)",
    )
    parser.add_argument(
        "--skip-schema",
        action="store_true",
        help="Skip Postgres schema creation",
    )
    parser.add_argument(
        "--skip-kuzu",
        action="store_true",
        help="Skip schema comparison (Kuzu in-process graph)",
    )
    parser.add_argument(
        "--skip-embedding-ablation",
        action="store_true",
        help="Skip embedding dimension ablation",
    )
    parser.add_argument(
        "--embedding-use-synthetic",
        action="store_true",
        help="Use synthetic data for embedding ablation (skip BEIR downloads)",
    )
    parser.add_argument(
        "--output",
        default="results/area1_results.json",
        metavar="PATH",
        help="Output JSON path (default: results/area1_results.json)",
    )
    parser.add_argument(
        "--report",
        default="results/area1_report.md",
        metavar="PATH",
        help="Output Markdown report path (default: results/area1_report.md)",
    )
    args = parser.parse_args(argv)

    scales = [_parse_scale(s) for s in args.scales]

    combined_results: dict[str, Any] = {
        "experiment": "area1_storage_fitness",
        "scales": [s for s in args.scales],
        "db_url": args.db_url,
        "scale_benchmark": None,
        "schema_comparison": None,
        "embedding_ablation": None,
    }

    # ------------------------------------------------------------------
    # 1. Scale benchmark
    # ------------------------------------------------------------------
    print("\n[Area1] === Scale Benchmark ===")
    try:
        from scale_benchmark import run_scale_benchmark

        t0 = time.perf_counter()
        scale_results = run_scale_benchmark(
            db_url=args.db_url,
            scales=scales,
            domain_mixes=DEFAULT_DOMAIN_MIXES,
            n_queries=args.n_queries,
            embedding_dim=args.embedding_dim,
            skip_schema=args.skip_schema,
        )
        elapsed = time.perf_counter() - t0
        combined_results["scale_benchmark"] = scale_results
        print(f"[Area1] Scale benchmark done in {elapsed:.1f}s")
    except Exception as exc:
        print(f"[Area1] Scale benchmark FAILED: {exc}", file=sys.stderr)
        combined_results["scale_benchmark_error"] = str(exc)

    # ------------------------------------------------------------------
    # 2. Schema comparison (Kuzu)
    # ------------------------------------------------------------------
    if not args.skip_kuzu:
        print("\n[Area1] === Schema Comparison (Postgres vs. Kuzu) ===")
        try:
            from schema_comparison import run_schema_comparison

            t0 = time.perf_counter()
            schema_results = run_schema_comparison(
                postgres_url=args.db_url,
                n_blocks=min(scales[0], 1_000_000),  # always 1M for schema comparison
                n_hops_list=[2, 4, 6],
                n_queries=50,
            )
            elapsed = time.perf_counter() - t0
            combined_results["schema_comparison"] = schema_results
            crossover = schema_results.get("crossover_hop")
            print(
                f"[Area1] Schema comparison done in {elapsed:.1f}s  "
                f"crossover_hop={crossover}"
            )
        except Exception as exc:
            print(f"[Area1] Schema comparison FAILED: {exc}", file=sys.stderr)
            combined_results["schema_comparison_error"] = str(exc)
    else:
        print("[Area1] Skipping schema comparison (--skip-kuzu)")

    # ------------------------------------------------------------------
    # 3. Embedding ablation
    # ------------------------------------------------------------------
    if not args.skip_embedding_ablation:
        print("\n[Area1] === Embedding Dimension Ablation ===")
        try:
            from embedding_ablation import run_embedding_ablation

            t0 = time.perf_counter()
            ablation_results = run_embedding_ablation(
                corpus_size=100_000,
                dimensions=[128, 256, 384, 512, 768, 1024, 1536],
                n_queries=200,
                use_synthetic=args.embedding_use_synthetic,
            )
            elapsed = time.perf_counter() - t0
            combined_results["embedding_ablation"] = ablation_results
            min_dim = ablation_results.get("min_dim_within_5pct")
            print(
                f"[Area1] Embedding ablation done in {elapsed:.1f}s  "
                f"min_dim_within_5pct={min_dim}"
            )
        except Exception as exc:
            print(f"[Area1] Embedding ablation FAILED: {exc}", file=sys.stderr)
            combined_results["embedding_ablation_error"] = str(exc)
    else:
        print("[Area1] Skipping embedding ablation (--skip-embedding-ablation)")

    # ------------------------------------------------------------------
    # Write JSON results
    # ------------------------------------------------------------------
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(combined_results, fh, indent=2)
    print(f"\n[Area1] Results written to {args.output}")

    # ------------------------------------------------------------------
    # Write Markdown report
    # ------------------------------------------------------------------
    try:
        from report import write_report

        write_report(combined_results, output_path=args.report)
    except Exception as exc:
        print(f"[Area1] Report generation failed: {exc}", file=sys.stderr)

    # Exit code: 0 if scale benchmark passed at all tested scales, else 1.
    sb = combined_results.get("scale_benchmark")
    if sb and sb.get("results"):
        any_fail = any(
            e.get("p99_exceeds_threshold", True) for e in sb["results"]
        )
        return 1 if any_fail else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
