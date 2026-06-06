"""
run_g1_benchmark.py — G1 gate benchmark for issue #135.

Runs the G1 Postgres scale floor benchmark at the specified scales (1M, 5M, 20M)
and writes results through ``experiments/_lib/results_writer`` with
``gate=G1, hypothesis=H1.1``.

Usage::

    python run_g1_benchmark.py \\
        --db-url postgresql://nexum:nexum@localhost:15432/nexum_bench \\
        --scales 1m \\
        --domain-mixes mixed legal medical \\
        --n-queries 100 \\
        --embedding-dim 384 \\
        --seed 42

Exit code 0 if P99 < 500 ms at the gate criterion scale (5M),
exit code 1 otherwise (or if that scale was not tested).

Key differences from run_benchmark.py
--------------------------------------
- Uses ``experiments/_lib/results_writer.ResultEnvelope`` for canonical output.
- ``fast_load=True`` by default: drops HNSW index before bulk ingest and
  rebuilds afterwards (~5× faster bulk loads).
- All three domain mixes (legal, medical, mixed) run at each scale to check
  for heterogeneity effects.
- HNSW index build time and size are measured and recorded.

References
----------
- docs/research/hypotheses/H1.1_postgres-sufficient-20m-blocks.md
- experiments/g1-postgres-scale/generate_corpus.py
- experiments/_lib/results_writer.py
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

# ---------------------------------------------------------------------------
# Path setup: allow running from repo root or from g1-postgres-scale/
# ---------------------------------------------------------------------------
_here = os.path.dirname(os.path.abspath(__file__))
_repo_root = os.path.abspath(os.path.join(_here, "..", ".."))
for _p in (_here, _repo_root):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from ingest import generate_and_ingest, DOMAIN_MIXES
from benchmark import run_latency_benchmark, G1_P99_THRESHOLD_MS
from schema import ensure_schema
from sizing_memo import compute_sizing_memo
from experiments._lib.results_writer import ResultEnvelope, write_result
from experiments._lib.runner import capture_run_context


# ---------------------------------------------------------------------------
# Scale parsing helpers
# ---------------------------------------------------------------------------

def _parse_scale(s: str) -> int:
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


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _connect(db_url: str) -> "psycopg2.connection":
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return conn


def _truncate_tables(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "TRUNCATE links, version_blocks, blocks, "
            "document_versions, documents RESTART IDENTITY CASCADE"
        )
    conn.commit()


def _get_index_size(conn, index_name: str) -> int | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT pg_relation_size(%s)",
            (index_name,),
        )
        row = cur.fetchone()
        return int(row[0]) if row and row[0] else None


def _drop_hnsw_index(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("DROP INDEX IF EXISTS blocks_embedding_hnsw_idx;")
    conn.commit()


def _rebuild_hnsw_index(conn) -> float:
    """Rebuild the HNSW index and return build time in seconds."""
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute(
            "CREATE INDEX blocks_embedding_hnsw_idx "
            "ON blocks USING hnsw (embedding vector_cosine_ops) "
            "WITH (m = 16, ef_construction = 64);"
        )
    conn.commit()
    return time.perf_counter() - t0


# ---------------------------------------------------------------------------
# Per-scale benchmark
# ---------------------------------------------------------------------------

def _run_scale(
    conn,
    n_blocks: int,
    domain_mixes: list[str],
    n_queries: int,
    embedding_dim: int,
    seed: int,
    batch_size: int,
    fast_load: bool,
) -> dict[str, Any]:
    """
    Run ingest + benchmark at one scale across all requested domain mixes.

    Returns a dict with keys:
        scale_label, n_blocks, ingest (per-domain), benchmark (per-domain),
        hnsw_index, overall_pass
    """
    label = _scale_label(n_blocks)
    print(f"\n[G1] ═══ Scale: {label} blocks ═══", flush=True)

    per_domain: dict[str, Any] = {}
    hnsw_info: dict[str, Any] = {}

    for domain in domain_mixes:
        domain_mix = DOMAIN_MIXES[domain]
        print(f"[G1]  Domain: {domain}", flush=True)

        print(f"[G1]    Truncating …", flush=True)
        _truncate_tables(conn)

        if fast_load:
            _drop_hnsw_index(conn)

        print(f"[G1]    Ingesting {n_blocks:,} blocks …", flush=True)
        ingest_stats = generate_and_ingest(
            conn=conn,
            n_blocks=n_blocks,
            domain_mix=domain_mix,
            embedding_dim=embedding_dim,
            seed=seed,
            batch_size=batch_size,
        )
        print(
            f"[G1]    Ingest: {ingest_stats['ingest_time_seconds']:.1f}s, "
            f"{ingest_stats['n_links']:,} links, "
            f"{ingest_stats['storage_bytes'] / 1e9:.2f} GB",
            flush=True,
        )

        if fast_load:
            print(f"[G1]    Rebuilding HNSW …", flush=True)
            hnsw_build_s = _rebuild_hnsw_index(conn)
            hnsw_size = _get_index_size(conn, "blocks_embedding_hnsw_idx")
            hnsw_info = {
                "build_seconds": round(hnsw_build_s, 1),
                "index_size_bytes": hnsw_size,
                "m": 16,
                "ef_construction": 64,
            }
            print(
                f"[G1]    HNSW built in {hnsw_build_s:.1f}s, "
                f"size={hnsw_size / 1e9:.2f} GB",
                flush=True,
            )

        print(
            f"[G1]    Benchmarking ({n_queries} queries/mode) …",
            flush=True,
        )
        bench = run_latency_benchmark(
            conn=conn,
            corpus_id=f"{label}/{domain}",
            n_queries=n_queries,
            embedding_dim=embedding_dim,
            seed=seed,
        )

        status = "PASS" if bench["pass_g1"] else "FAIL"
        print(
            f"[G1]    {label}/{domain} → {status}\n"
            f"[G1]      semantic: P50={bench['semantic']['p50_ms']:.1f}ms "
            f"P99={bench['semantic']['p99_ms']:.1f}ms\n"
            f"[G1]      fulltext: P50={bench['fulltext']['p50_ms']:.1f}ms "
            f"P99={bench['fulltext']['p99_ms']:.1f}ms\n"
            f"[G1]      graph 2h: P50={bench['graph_traversal']['2_hop']['p50_ms']:.1f}ms "
            f"P99={bench['graph_traversal']['2_hop']['p99_ms']:.1f}ms\n"
            f"[G1]      graph 4h: P50={bench['graph_traversal']['4_hop']['p50_ms']:.1f}ms "
            f"P99={bench['graph_traversal']['4_hop']['p99_ms']:.1f}ms\n"
            f"[G1]      graph 6h: P50={bench['graph_traversal']['6_hop']['p50_ms']:.1f}ms "
            f"P99={bench['graph_traversal']['6_hop']['p99_ms']:.1f}ms",
            flush=True,
        )

        per_domain[domain] = {
            "ingest": ingest_stats,
            "benchmark": bench,
            "hnsw_index": hnsw_info,
        }

    # Aggregate pass/fail: passes if ALL domain × mode combinations pass
    overall_pass = all(v["benchmark"]["pass_g1"] for v in per_domain.values())

    return {
        "scale_label": label,
        "n_blocks": n_blocks,
        "per_domain": per_domain,
        "overall_pass": overall_pass,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="G1 Postgres scale floor benchmark (issue #135, H1.1)"
    )
    parser.add_argument(
        "--db-url",
        default="postgresql://nexum:nexum@localhost:5432/nexum_bench",
        help="Postgres connection URL",
    )
    parser.add_argument(
        "--scales",
        nargs="+",
        default=["1m"],
        metavar="SCALE",
        help="Corpus sizes to benchmark (default: 1m)",
    )
    parser.add_argument(
        "--domain-mixes",
        nargs="+",
        choices=list(DOMAIN_MIXES.keys()),
        default=["mixed", "legal", "medical"],
        help="Domain mixes to test (default: mixed legal medical)",
    )
    parser.add_argument(
        "--n-queries",
        type=int,
        default=100,
        help="Queries per mode per scale (default: 100)",
    )
    parser.add_argument(
        "--embedding-dim",
        type=int,
        default=384,
        help="Embedding dimensionality (default: 384)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=5000,
        help="Rows per execute_values call (default: 5000)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed (default: 42)",
    )
    parser.add_argument(
        "--skip-schema",
        action="store_true",
        help="Skip schema creation",
    )
    parser.add_argument(
        "--no-fast-load",
        action="store_true",
        help="Disable fast-load (maintain HNSW during inserts)",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="PATH",
        help="Override output JSON path (default: auto-timestamped under results/)",
    )
    args = parser.parse_args(argv)

    scales = [_parse_scale(s) for s in args.scales]

    # Capture runtime context
    run_ctx = capture_run_context(gate="G1", hypothesis="H1.1", seed=args.seed)

    print(f"[G1] Connecting to {args.db_url!r} …", flush=True)
    try:
        conn = _connect(args.db_url)
    except Exception as exc:
        print(f"[G1] ERROR: cannot connect: {exc}", file=sys.stderr)
        return 1

    if not args.skip_schema:
        print("[G1] Applying schema …", flush=True)
        try:
            ensure_schema(conn)
        except Exception as exc:
            print(f"[G1] ERROR: schema apply failed: {exc}", file=sys.stderr)
            conn.close()
            return 1

    all_scale_results: list[dict[str, Any]] = []
    gate_pass = False  # True if 5M scale passes (or any scale if 5M not tested)

    for n_blocks in scales:
        try:
            scale_result = _run_scale(
                conn=conn,
                n_blocks=n_blocks,
                domain_mixes=args.domain_mixes,
                n_queries=args.n_queries,
                embedding_dim=args.embedding_dim,
                seed=args.seed,
                batch_size=args.batch_size,
                fast_load=not args.no_fast_load,
            )
        except Exception as exc:
            print(f"[G1] ERROR at scale {_scale_label(n_blocks)}: {exc}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            continue

        all_scale_results.append(scale_result)

        # Gate criterion: P99 < 500ms at 5M (or best available scale)
        if n_blocks == 5_000_000:
            gate_pass = scale_result["overall_pass"]

    # If 5M wasn't tested, use the highest tested scale for the gate
    if not any(r["n_blocks"] == 5_000_000 for r in all_scale_results) and all_scale_results:
        highest = max(all_scale_results, key=lambda r: r["n_blocks"])
        gate_pass = highest["overall_pass"]

    conn.close()

    # Sizing memo
    sizing = compute_sizing_memo(embedding_dim=args.embedding_dim)

    # Identify binding constraint if gate fails
    binding_constraint = _identify_binding_constraint(all_scale_results)

    # Assemble metrics for the canonical envelope
    metrics: dict[str, Any] = {
        "gate_criterion": f"P99 < {G1_P99_THRESHOLD_MS}ms at 5M blocks for semantic+graph+fulltext",
        "scales_tested": [r["scale_label"] for r in all_scale_results],
        "domain_mixes_tested": args.domain_mixes,
        "embedding_dim": args.embedding_dim,
        "n_queries_per_mode": args.n_queries,
        "results_by_scale": all_scale_results,
        "sizing_memo": sizing,
        "binding_constraint": binding_constraint,
    }

    # Determine pass/fail for hypothesis
    passed = gate_pass and bool(all_scale_results)

    notes = _compose_notes(all_scale_results, passed, binding_constraint)

    envelope = ResultEnvelope(
        gate="G1",
        hypothesis="H1.1",
        passed=passed,
        metrics=metrics,
        runtime=run_ctx,
        notes=notes,
    )

    area_dir = _here  # experiments/g1-postgres-scale/
    if args.output:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        import json as _json
        with open(args.output, "w", encoding="utf-8") as fh:
            _json.dump(envelope.to_dict(results_path=args.output), fh, indent=2)
        out_path = args.output
    else:
        out_path = write_result(envelope, area_dir=area_dir)

    print(f"\n[G1] Results written to {out_path}", flush=True)
    overall_label = "PASS" if passed else "FAIL"
    print(f"[G1] Overall G1 gate: {overall_label}", flush=True)
    if binding_constraint:
        print(f"[G1] Binding constraint: {binding_constraint}", flush=True)

    return 0 if passed else 1


def _identify_binding_constraint(
    scale_results: list[dict[str, Any]],
) -> str | None:
    """
    If any scale fails, identify whether graph traversal or ANN is the
    binding constraint (per issue #135 acceptance criteria).
    """
    for sr in scale_results:
        for domain, dr in sr.get("per_domain", {}).items():
            bench = dr.get("benchmark", {})
            if not bench.get("pass_g1", True):
                sem_p99 = bench.get("semantic", {}).get("p99_ms", 0)
                ft_p99 = bench.get("fulltext", {}).get("p99_ms", 0)
                graph_p99 = max(
                    bench.get("graph_traversal", {}).get(k, {}).get("p99_ms", 0)
                    for k in ("2_hop", "4_hop", "6_hop")
                )
                if graph_p99 >= 500.0 and sem_p99 < 500.0:
                    if ft_p99 >= 500.0:
                        return "graph_traversal_and_fulltext"
                    return "graph_traversal"
                elif ft_p99 >= 500.0 and sem_p99 < 500.0:
                    return "fulltext"
                elif sem_p99 >= 500.0:
                    return "semantic_ann"
    return None


def _compose_notes(
    scale_results: list[dict[str, Any]],
    passed: bool,
    binding_constraint: str | None,
) -> str:
    if not scale_results:
        return "No scales were successfully benchmarked."

    lines = [f"issue #135 G1 gate benchmark — scales: {[r['scale_label'] for r in scale_results]}"]

    if passed:
        lines.append(
            "Gate PASS: P99 < 500ms for all query modes at the gate criterion scale."
        )
    else:
        lines.append(
            f"Gate FAIL: one or more query modes exceeded the 500ms P99 threshold."
        )
        if binding_constraint:
            lines.append(
                f"Binding constraint: {binding_constraint} — see H5.1 for graph-traversal follow-up."
            )

    return " ".join(lines)


if __name__ == "__main__":
    sys.exit(main())
