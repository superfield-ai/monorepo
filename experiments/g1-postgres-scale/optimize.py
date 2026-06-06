"""
optimize.py — Step 3 of the G1-OPT-1 protocol.

Tests three low-memory index optimizations and measures their effect on:
  - Index size (target: ≤1GB)
  - Semantic ANN latency P50/P99 (target: P99 < 200ms)
  - Recall@10 vs brute-force (floor: ≥0.90)

Optimizations tested (in order):
  A. halfvec quantization (pgvector ≥ 0.7) — halves index storage
  B. HNSW m=8  — reduces graph degree; smaller index, lower recall
  C. IVFFlat   — inverted-list index; much smaller than HNSW

Usage::

    python optimize.py --db-url postgresql://localhost/nexum_bench

Requires a populated blocks table (run run_benchmark.py first).
Does NOT require blocks to be in memory — the script recreates the index
with each optimization and measures from a cold state.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import types

import numpy as np
import psycopg2
import psycopg2.extras

from db_cache import cmd_restore, _dump_path


RECALL_FLOOR = 0.90
P99_TARGET_MS = 200.0


# ── helpers ──────────────────────────────────────────────────────────────────

def _connect(db_url: str):
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    return conn


def _rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def _random_unit_vec(dim: int, rng: np.random.Generator) -> list[float]:
    v = rng.standard_normal(dim).astype(np.float32)
    v /= np.linalg.norm(v) + 1e-9
    return v.tolist()


def _detect_embedding_dim(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT embedding FROM blocks LIMIT 1")
        row = cur.fetchone()
        if row is None:
            raise RuntimeError("blocks table is empty — run ingest first")
        vec = row[0]
        if isinstance(vec, (list, tuple)):
            return len(vec)
        return len(str(vec).strip("[]").split(","))


def _detect_column_type(conn) -> str:
    """Return 'halfvec' or 'vector' based on actual blocks.embedding column type."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT udt_name FROM information_schema.columns
            WHERE table_name = 'blocks' AND column_name = 'embedding'
            """
        )
        row = cur.fetchone()
        return row[0] if row else "vector"


def _pgvector_version(conn) -> tuple[int, int]:
    with conn.cursor() as cur:
        cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        row = cur.fetchone()
        if not row:
            return (0, 0)
        parts = row[0].split(".")
        return (int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)


def _index_size_mb(conn, index_name: str) -> float:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_relation_size(%s)", (index_name,))
        row = cur.fetchone()
        return (row[0] or 0) / 1024**2


def _drop_index(conn, index_name: str) -> None:
    """Drop index unconditionally via IF EXISTS — avoids pg_indexes cache issues."""
    with conn.cursor() as cur:
        cur.execute(f"DROP INDEX IF EXISTS {index_name}")
    print(f"  dropped {index_name} (if existed)")


# ── recall measurement ────────────────────────────────────────────────────────

def _brute_force_top10(conn, qv: list[float], col_type: str) -> set[str]:
    """Exact top-10 via sequential scan. col_type must match current column type."""
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


def _measure_recall_and_latency(
    conn,
    dim: int,
    rng: np.random.Generator,
    n_queries: int,
    col_type: str = "vector",
) -> dict:
    recalls: list[float] = []
    latencies: list[float] = []

    for _ in range(n_queries):
        qv = _random_unit_vec(dim, rng)
        exact = _brute_force_top10(conn, qv, col_type)

        t0 = time.perf_counter()
        approx = _ann_top10(conn, qv, col_type)
        latencies.append((time.perf_counter() - t0) * 1000.0)

        overlap = len(exact & approx)
        recalls.append(overlap / max(len(exact), 1))

    arr_lat = np.array(latencies)
    return {
        "n_queries": n_queries,
        "recall_mean": round(float(np.mean(recalls)), 4),
        "recall_min": round(float(np.min(recalls)), 4),
        "p50_ms": round(float(np.percentile(arr_lat, 50)), 1),
        "p99_ms": round(float(np.percentile(arr_lat, 99)), 1),
        "mean_ms": round(float(np.mean(arr_lat)), 1),
    }


def _passes(result: dict) -> bool:
    return result["recall_mean"] >= RECALL_FLOOR and result["p99_ms"] < P99_TARGET_MS


# ── optimization A: halfvec ───────────────────────────────────────────────────

def opt_a_halfvec(conn, dim: int, rng: np.random.Generator, n_queries: int) -> dict:
    """
    Option A: Cast embedding column to halfvec(dim) and rebuild HNSW index.
    Requires pgvector >= 0.7.  Skips ALTER TABLE if column is already halfvec.
    """
    print("\n[OPT-A] halfvec quantization …")
    major, minor = _pgvector_version(conn)
    if (major, minor) < (0, 7):
        return {"skipped": True, "reason": f"pgvector {major}.{minor} < 0.7; halfvec not available"}

    col_type = _detect_column_type(conn)
    if col_type == "halfvec":
        print("  column already halfvec — skipping ALTER TABLE")
    else:
        print("  ALTER TABLE blocks ALTER COLUMN embedding TYPE halfvec …")
        # pgvector 0.8+ auto-converts the HNSW index during ALTER TABLE,
        # so drop it first to ensure we rebuild with our specific parameters.
        _drop_index(conn, "blocks_embedding_hnsw_idx")
        try:
            with conn.cursor() as cur:
                cur.execute(f"ALTER TABLE blocks ALTER COLUMN embedding TYPE halfvec({dim})")
        except Exception as exc:
            return {"skipped": True, "reason": f"ALTER failed: {exc}"}

    # After ALTER TABLE, pgvector may have recreated the index. Always drop and
    # rebuild to ensure our chosen m/ef_construction parameters are in effect.
    _drop_index(conn, "blocks_embedding_hnsw_idx")

    print("  CREATE INDEX USING hnsw (halfvec_cosine_ops, m=16, ef_construction=64) …")
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE INDEX blocks_embedding_hnsw_idx
            ON blocks USING hnsw (embedding halfvec_cosine_ops)
            WITH (m = 16, ef_construction = 64)
            """
        )
    build_s = time.perf_counter() - t0
    print(f"  index built in {build_s:.0f}s")

    size_mb = _index_size_mb(conn, "blocks_embedding_hnsw_idx")
    print(f"  index size: {size_mb:.0f} MB")

    print(f"  benchmarking ({n_queries} queries, recall@10 vs brute-force) …")
    with conn.cursor() as cur:
        cur.execute("SET hnsw.ef_search = 40")
    metrics = _measure_recall_and_latency(conn, dim, rng, n_queries, col_type="halfvec")
    ok = _passes(metrics)

    print(
        f"  recall@10={metrics['recall_mean']:.3f}  "
        f"P50={metrics['p50_ms']}ms  P99={metrics['p99_ms']}ms  "
        f"{'PASS' if ok else 'FAIL'}"
    )

    # Restore column to vector(dim) so subsequent optimizations run on vector type.
    print("  restoring column type to vector …")
    _drop_index(conn, "blocks_embedding_hnsw_idx")
    with conn.cursor() as cur:
        cur.execute(
            f"ALTER TABLE blocks ALTER COLUMN embedding TYPE vector({dim}) "
            f"USING embedding::vector"
        )

    return {
        "optimization": "halfvec",
        "index_size_mb": round(size_mb, 1),
        "index_build_s": round(build_s, 1),
        "metrics": metrics,
        "passes": ok,
    }


# ── optimization B: HNSW m=8 ─────────────────────────────────────────────────

def opt_b_hnsw_m8(conn, dim: int, rng: np.random.Generator, n_queries: int) -> dict:
    """
    Option B: Rebuild HNSW index with m=8 (half the default m=16).
    Reduces index size ~40%; lower recall at same ef_search.
    """
    print("\n[OPT-B] HNSW m=8 …")

    # Ensure column is vector type (opt_a may have left it as halfvec if restore failed)
    col_type = _detect_column_type(conn)
    if col_type == "halfvec":
        print("  converting column back to vector …")
        _drop_index(conn, "blocks_embedding_hnsw_idx")
        with conn.cursor() as cur:
            cur.execute(
                f"ALTER TABLE blocks ALTER COLUMN embedding TYPE vector({dim}) "
                f"USING embedding::vector"
            )

    _drop_index(conn, "blocks_embedding_hnsw_idx")

    print("  CREATE INDEX USING hnsw (m=8, ef_construction=64) …")
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE INDEX blocks_embedding_hnsw_idx
            ON blocks USING hnsw (embedding vector_cosine_ops)
            WITH (m = 8, ef_construction = 64)
            """
        )
    build_s = time.perf_counter() - t0
    print(f"  index built in {build_s:.0f}s")

    size_mb = _index_size_mb(conn, "blocks_embedding_hnsw_idx")
    print(f"  index size: {size_mb:.0f} MB")

    print(f"  benchmarking ({n_queries} queries, recall@10 vs brute-force) …")
    with conn.cursor() as cur:
        cur.execute("SET hnsw.ef_search = 40")
    metrics = _measure_recall_and_latency(conn, dim, rng, n_queries, col_type="vector")
    ok = _passes(metrics)

    print(
        f"  recall@10={metrics['recall_mean']:.3f}  "
        f"P50={metrics['p50_ms']}ms  P99={metrics['p99_ms']}ms  "
        f"{'PASS' if ok else 'FAIL'}"
    )

    _drop_index(conn, "blocks_embedding_hnsw_idx")
    return {
        "optimization": "hnsw_m8",
        "index_size_mb": round(size_mb, 1),
        "index_build_s": round(build_s, 1),
        "metrics": metrics,
        "passes": ok,
    }


# ── optimization C: IVFFlat ───────────────────────────────────────────────────

def opt_c_ivfflat(conn, n_blocks: int, dim: int, rng: np.random.Generator, n_queries: int) -> dict:
    """
    Option C: Replace HNSW with IVFFlat (lists = √n_blocks).
    Sweep probes=[5, 10, 20] to find recall/latency knee.
    """
    print("\n[OPT-C] IVFFlat …")

    col_type = _detect_column_type(conn)
    if col_type == "halfvec":
        print("  converting column back to vector …")
        _drop_index(conn, "blocks_embedding_hnsw_idx")
        with conn.cursor() as cur:
            cur.execute(
                f"ALTER TABLE blocks ALTER COLUMN embedding TYPE vector({dim}) "
                f"USING embedding::vector"
            )

    _drop_index(conn, "blocks_embedding_hnsw_idx")
    _drop_index(conn, "blocks_embedding_ivfflat_idx")

    lists = max(100, int(n_blocks ** 0.5))
    print(f"  CREATE INDEX USING ivfflat (lists={lists}) …")
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute(
            f"""
            CREATE INDEX blocks_embedding_ivfflat_idx
            ON blocks USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = {lists})
            """
        )
    build_s = time.perf_counter() - t0
    print(f"  index built in {build_s:.0f}s")

    size_mb = _index_size_mb(conn, "blocks_embedding_ivfflat_idx")
    print(f"  index size: {size_mb:.0f} MB")

    probe_results = []
    for probes in (5, 10, 20):
        print(f"  probes={probes}: benchmarking ({n_queries} queries) …")
        with conn.cursor() as cur:
            cur.execute(f"SET ivfflat.probes = {probes}")
        m = _measure_recall_and_latency(conn, dim, rng, n_queries, col_type="vector")
        ok = _passes(m)
        probe_results.append({"probes": probes, "metrics": m, "passes": ok})
        print(
            f"    recall@10={m['recall_mean']:.3f}  "
            f"P50={m['p50_ms']}ms  P99={m['p99_ms']}ms  "
            f"{'PASS' if ok else 'FAIL'}"
        )

    _drop_index(conn, "blocks_embedding_ivfflat_idx")
    best = max(probe_results, key=lambda r: r["metrics"]["recall_mean"])
    return {
        "optimization": "ivfflat",
        "lists": lists,
        "index_size_mb": round(size_mb, 1),
        "index_build_s": round(build_s, 1),
        "probe_results": probe_results,
        "best_probes": best["probes"],
        "passes": any(r["passes"] for r in probe_results),
    }


# ── main ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="G1-OPT-1 Step 3: HNSW optimization for low-memory operation"
    )
    parser.add_argument("--db-url", default="postgresql://localhost/nexum_bench")
    parser.add_argument("--n-queries", type=int, default=50)
    parser.add_argument(
        "--opts",
        nargs="+",
        choices=["halfvec", "m8", "ivfflat"],
        default=["halfvec", "m8", "ivfflat"],
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", default="results/optimize_result.json")
    parser.add_argument(
        "--from-cache",
        action="store_true",
        help="Restore database from ~/.cache/nexum/ dump before running optimizations.",
    )
    parser.add_argument("--docker-container", default="nexum-bench")
    parser.add_argument("--scale", default="1m", help="Scale label for cache lookup (default: 1m)")
    args = parser.parse_args(argv)

    if args.from_cache:
        dim_guess = 384  # will be confirmed after connect
        scale = args.scale.lower().rstrip("m") + "m"
        dump = _dump_path(scale, dim_guess)
        if not dump.exists():
            print(
                f"[OPTIMIZE] ERROR — --from-cache: no dump at {dump}\n"
                f"[OPTIMIZE] Run: python db_cache.py dump --scale {scale} --dim {dim_guess}",
                file=sys.stderr,
            )
            return 1
        restore_args = types.SimpleNamespace(
            docker_container=args.docker_container,
            db_url=args.db_url,
            scale=scale,
            dim=dim_guess,
            jobs=4,
        )
        print(f"[OPTIMIZE] --from-cache: restoring from {dump} …")
        rc = cmd_restore(restore_args)
        if rc != 0:
            return rc

    print(f"[OPTIMIZE] Connecting to {args.db_url!r} …")
    try:
        conn = _connect(args.db_url)
    except Exception as exc:
        print(f"[OPTIMIZE] ERROR: {exc}", file=sys.stderr)
        return 1

    try:
        dim = _detect_embedding_dim(conn)
    except RuntimeError as exc:
        print(f"[OPTIMIZE] ERROR: {exc}", file=sys.stderr)
        return 1

    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM blocks")
        n_blocks = cur.fetchone()[0]

    col_type = _detect_column_type(conn)
    print(f"[OPTIMIZE] n_blocks={n_blocks:,}  embedding_dim={dim}  column_type={col_type}")
    print(f"[OPTIMIZE] Recall floor ≥ {RECALL_FLOOR}  P99 target < {P99_TARGET_MS}ms")

    results = []

    if "halfvec" in args.opts:
        r = opt_a_halfvec(conn, dim, _rng(args.seed), args.n_queries)
        results.append(r)

    if "m8" in args.opts:
        r = opt_b_hnsw_m8(conn, dim, _rng(args.seed), args.n_queries)
        results.append(r)

    if "ivfflat" in args.opts:
        r = opt_c_ivfflat(conn, n_blocks, dim, _rng(args.seed), args.n_queries)
        results.append(r)

    passing = [r for r in results if r.get("passes") and not r.get("skipped")]
    print(f"\n[OPTIMIZE] {len(passing)}/{len(results)} optimizations passed both criteria")
    if passing:
        best = passing[0]
        print(f"[OPTIMIZE] Recommended: {best['optimization']} ({best['index_size_mb']:.0f} MB index)")

    output = {
        "n_blocks": n_blocks,
        "embedding_dim": dim,
        "recall_floor": RECALL_FLOOR,
        "p99_target_ms": P99_TARGET_MS,
        "results": results,
        "passing_optimizations": [r.get("optimization") for r in passing],
    }

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w") as fh:
        json.dump(output, fh, indent=2, default=str)
    print(f"[OPTIMIZE] Results written to {args.output}")

    conn.close()
    return 0 if passing else 1


if __name__ == "__main__":
    sys.exit(main())
