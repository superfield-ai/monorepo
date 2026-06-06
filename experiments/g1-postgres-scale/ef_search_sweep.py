"""
ef_search_sweep.py — Step 5 of the G1-OPT-1 protocol.

Sweeps hnsw.ef_search over [20, 40, 80, 200] on the winning index config
to find the latency/recall knee and produce the recommended ef_search value.

Run AFTER optimize.py has identified the winning index configuration and
rebuilt the HNSW index with those parameters.

Usage::

    python ef_search_sweep.py --db-url postgresql://localhost/nexum_bench

Output: JSON + ASCII latency-vs-recall table, recommended ef_search value.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
import psycopg2


RECALL_FLOOR = 0.90
P99_TARGET_MS = 200.0
EF_VALUES = [20, 40, 80, 200]


# ── helpers ──────────────────────────────────────────────────────────────────

def _connect(db_url: str):
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    return conn


def _random_unit_vec(dim: int, rng: np.random.Generator) -> list[float]:
    v = rng.standard_normal(dim).astype(np.float32)
    v /= np.linalg.norm(v) + 1e-9
    return v.tolist()


def _detect_embedding_dim(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT embedding FROM blocks LIMIT 1")
        row = cur.fetchone()
        if row is None:
            raise RuntimeError("blocks table is empty")
        vec = row[0]
        if isinstance(vec, (list, tuple)):
            return len(vec)
        return len(str(vec).strip("[]").split(","))


def _detect_column_type(conn) -> str:
    """Return 'halfvec' or 'vector' based on the blocks.embedding column type."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT udt_name FROM information_schema.columns
            WHERE table_name = 'blocks' AND column_name = 'embedding'
            """
        )
        row = cur.fetchone()
        return row[0] if row else "vector"


def _detect_index_type(conn) -> str:
    """Return 'hnsw' or 'ivfflat' based on which index is present on blocks.embedding."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT am.amname FROM pg_indexes i
            JOIN pg_class c ON c.relname = i.indexname
            JOIN pg_am am ON am.oid = c.relam
            WHERE i.tablename = 'blocks'
              AND (i.indexname LIKE '%hnsw%' OR i.indexname LIKE '%ivfflat%')
            LIMIT 1
            """
        )
        row = cur.fetchone()
        return row[0] if row else "hnsw"


def _brute_force_top10(conn, qv: list[float], col_type: str) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SET enable_indexscan = off")
        cur.execute("SET enable_bitmapscan = off")
        cur.execute(
            f"SELECT id FROM blocks ORDER BY embedding <=> %s::{col_type} LIMIT 10",
            (qv,),
        )
        rows = cur.fetchall()
        cur.execute("RESET enable_indexscan")
        cur.execute("RESET enable_bitmapscan")
    return {r[0] for r in rows}


def _ann_top10(conn, qv: list[float], col_type: str) -> set[str]:
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT id FROM blocks ORDER BY embedding <=> %s::{col_type} LIMIT 10",
            (qv,),
        )
        rows = cur.fetchall()
    return {r[0] for r in rows}


# ── sweep ─────────────────────────────────────────────────────────────────────

def sweep_ef(
    conn,
    ef_values: list[int],
    dim: int,
    col_type: str,
    index_type: str,
    n_queries: int,
    rng: np.random.Generator,
) -> list[dict]:
    results = []

    for ef in ef_values:
        print(f"  ef_search={ef} …", end=" ", flush=True)

        with conn.cursor() as cur:
            if index_type == "hnsw":
                cur.execute(f"SET hnsw.ef_search = {ef}")
            else:
                # IVFFlat uses probes, not ef_search; map ef roughly to probes
                probes = max(1, ef // 4)
                cur.execute(f"SET ivfflat.probes = {probes}")

        latencies: list[float] = []
        recalls: list[float] = []

        for _ in range(n_queries):
            qv = _random_unit_vec(dim, rng)
            exact = _brute_force_top10(conn, qv, col_type)

            t0 = time.perf_counter()
            approx = _ann_top10(conn, qv, col_type)
            latencies.append((time.perf_counter() - t0) * 1000.0)

            overlap = len(exact & approx)
            recalls.append(overlap / max(len(exact), 1))

        arr = np.array(latencies)
        recall_mean = float(np.mean(recalls))
        p50 = float(np.percentile(arr, 50))
        p99 = float(np.percentile(arr, 99))

        passes = recall_mean >= RECALL_FLOOR and p99 < P99_TARGET_MS
        print(
            f"recall={recall_mean:.3f}  P50={p50:.1f}ms  P99={p99:.1f}ms  "
            f"{'✓' if passes else '✗'}"
        )

        results.append({
            "ef_search": ef,
            "recall_mean": round(recall_mean, 4),
            "recall_min": round(float(np.min(recalls)), 4),
            "p50_ms": round(p50, 1),
            "p99_ms": round(p99, 1),
            "mean_ms": round(float(np.mean(arr)), 1),
            "passes": passes,
        })

    return results


def _find_knee(results: list[dict]) -> dict | None:
    """
    Find the lowest ef_search that meets both RECALL_FLOOR and P99_TARGET_MS.
    If none meet both, return the one with the best recall at minimum P99.
    """
    passing = [r for r in results if r["passes"]]
    if passing:
        return min(passing, key=lambda r: r["ef_search"])
    # No passing point — return lowest P99 among those with recall ≥ floor
    above_recall = [r for r in results if r["recall_mean"] >= RECALL_FLOOR]
    if above_recall:
        return min(above_recall, key=lambda r: r["p99_ms"])
    return None


def _ascii_table(results: list[dict]) -> str:
    header = f"{'ef_search':>10}  {'recall@10':>10}  {'P50 ms':>8}  {'P99 ms':>8}  {'pass':>6}"
    sep = "─" * len(header)
    rows = [header, sep]
    for r in results:
        rows.append(
            f"{r['ef_search']:>10}  {r['recall_mean']:>10.3f}  "
            f"{r['p50_ms']:>8.1f}  {r['p99_ms']:>8.1f}  "
            f"{'✓' if r['passes'] else '✗':>6}"
        )
    return "\n".join(rows)


# ── main ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="G1-OPT-1 Step 5: ef_search sweep for HNSW recall/latency knee"
    )
    parser.add_argument("--db-url", default="postgresql://localhost/nexum_bench")
    parser.add_argument("--n-queries", type=int, default=50)
    parser.add_argument(
        "--ef-values",
        nargs="+",
        type=int,
        default=EF_VALUES,
        metavar="EF",
        help=f"ef_search values to sweep (default: {EF_VALUES})",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", default="results/ef_search_sweep.json")
    args = parser.parse_args(argv)

    print(f"[EF_SWEEP] Connecting to {args.db_url!r} …")
    try:
        conn = _connect(args.db_url)
    except Exception as exc:
        print(f"[EF_SWEEP] ERROR: {exc}", file=sys.stderr)
        return 1

    try:
        dim = _detect_embedding_dim(conn)
    except RuntimeError as exc:
        print(f"[EF_SWEEP] ERROR: {exc}", file=sys.stderr)
        return 1

    col_type = _detect_column_type(conn)
    idx_type = _detect_index_type(conn)
    print(f"[EF_SWEEP] dim={dim}  column_type={col_type}  index_type={idx_type}")
    print(f"[EF_SWEEP] Sweeping ef_search over {args.ef_values} ({args.n_queries} queries each)")

    rng = np.random.default_rng(args.seed)
    results = sweep_ef(conn, args.ef_values, dim, col_type, idx_type, args.n_queries, rng)

    table = _ascii_table(results)
    print(f"\n{table}")

    knee = _find_knee(results)
    if knee:
        recommendation = (
            f"Recommended ef_search = {knee['ef_search']} "
            f"(recall@10={knee['recall_mean']:.3f}, P99={knee['p99_ms']:.1f}ms)"
        )
    else:
        recommendation = "No configuration met both criteria — consider index rebuild with larger m or more lists."

    print(f"\n{recommendation}")

    output = {
        "embedding_dim": dim,
        "column_type": col_type,
        "index_type": idx_type,
        "recall_floor": RECALL_FLOOR,
        "p99_target_ms": P99_TARGET_MS,
        "ef_values_tested": args.ef_values,
        "results": results,
        "knee": knee,
        "recommendation": recommendation,
    }

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w") as fh:
        json.dump(output, fh, indent=2)
    print(f"[EF_SWEEP] Results written to {args.output}")

    conn.close()
    return 0 if knee and knee["passes"] else 1


if __name__ == "__main__":
    sys.exit(main())
