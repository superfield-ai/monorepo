"""
diagnose.py — Step 1+2 of the G1-OPT-1 protocol.

Measures whether the semantic ANN latency bottleneck is caused by:
  (A) Buffer cache misses — HNSW index larger than shared_buffers
  (B) CPU / Docker overhead — index is in cache but queries are still slow

Usage::

    python diagnose.py --db-url postgresql://localhost/nexum_bench

Output: JSON summary + human-readable verdict printed to stdout.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time

import numpy as np
import psycopg2
import psycopg2.extras


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
    """Read embedding dimensionality from the first block in the table."""
    with conn.cursor() as cur:
        cur.execute("SELECT embedding FROM blocks LIMIT 1")
        row = cur.fetchone()
        if row is None:
            raise RuntimeError("blocks table is empty — run ingest first")
        vec = row[0]
        if isinstance(vec, (list, tuple)):
            return len(vec)
        # pgvector returns a string representation like '[0.1, 0.2, ...]'
        return len(vec.strip("[]").split(","))


def _pgvector_version(conn) -> str:
    with conn.cursor() as cur:
        cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
        row = cur.fetchone()
        return row[0] if row else "unknown"


# ── step 1: EXPLAIN ANALYZE BUFFERS ──────────────────────────────────────────

def step1_explain_buffers(conn, embedding_dim: int, rng: np.random.Generator, n_samples: int = 3) -> dict:
    """
    Run EXPLAIN (ANALYZE, BUFFERS) on representative ANN queries.
    Returns aggregated buffer hit/read counts and a cache-miss ratio.
    """
    results = []
    with conn.cursor() as cur:
        for i in range(n_samples):
            qv = _random_unit_vec(embedding_dim, rng)
            cur.execute("SET hnsw.ef_search = 40")
            cur.execute(
                """
                EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
                SELECT id, embedding <=> %s::vector AS dist
                FROM blocks
                ORDER BY embedding <=> %s::vector
                LIMIT 20
                """,
                (qv, qv),
            )
            plan_rows = cur.fetchall()
            plan_text = "\n".join(r[0] for r in plan_rows)

            hit = _extract_buffer_count(plan_text, "hit")
            read = _extract_buffer_count(plan_text, "read")
            actual_ms = _extract_actual_time(plan_text)
            uses_index = "Index Scan" in plan_text or "Bitmap Index" in plan_text

            results.append({
                "sample": i + 1,
                "shared_hit": hit,
                "shared_read": read,
                "actual_time_ms": actual_ms,
                "uses_hnsw_index": uses_index,
                "plan_excerpt": plan_text[:800],
            })

    total_hit = sum(r["shared_hit"] for r in results)
    total_read = sum(r["shared_read"] for r in results)
    total_io = total_hit + total_read
    cache_miss_ratio = total_read / total_io if total_io > 0 else 0.0

    return {
        "n_samples": n_samples,
        "samples": results,
        "aggregate": {
            "total_shared_hit": total_hit,
            "total_shared_read": total_read,
            "cache_miss_ratio": round(cache_miss_ratio, 4),
        },
    }


def _extract_buffer_count(plan: str, kind: str) -> int:
    """Extract 'Buffers: shared hit=X' or 'shared read=Y' from EXPLAIN output."""
    pattern = rf"Buffers:.*?shared.*?{kind}=(\d+)"
    matches = re.findall(pattern, plan, re.IGNORECASE)
    return sum(int(m) for m in matches) if matches else 0


def _extract_actual_time(plan: str) -> float | None:
    """Extract the top-level 'actual time=X..Y' from EXPLAIN ANALYZE output."""
    m = re.search(r"actual time=[\d.]+\.\.([\d.]+)", plan)
    return float(m.group(1)) if m else None


# ── step 2: index size vs shared_buffers ─────────────────────────────────────

def step2_size_check(conn) -> dict:
    """
    Compare HNSW index size against shared_buffers.
    Returns sizes in bytes and a verdict on whether the index fits in cache.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                pg_relation_size('blocks_embedding_hnsw_idx')  AS hnsw_index_bytes,
                pg_total_relation_size('blocks')               AS blocks_total_bytes,
                current_setting('shared_buffers')              AS shared_buffers_setting
            """
        )
        row = cur.fetchone()

    hnsw_bytes = row[0] or 0
    blocks_bytes = row[1] or 0
    shared_buffers_str = row[2]

    shared_buffers_bytes = _parse_pg_size(shared_buffers_str)
    fits_in_cache = hnsw_bytes <= shared_buffers_bytes

    return {
        "hnsw_index_bytes": hnsw_bytes,
        "hnsw_index_mb": round(hnsw_bytes / 1024**2, 1),
        "blocks_total_bytes": blocks_bytes,
        "shared_buffers_setting": shared_buffers_str,
        "shared_buffers_bytes": shared_buffers_bytes,
        "shared_buffers_mb": round(shared_buffers_bytes / 1024**2, 1),
        "index_fits_in_cache": fits_in_cache,
        "overflow_mb": round(max(0, hnsw_bytes - shared_buffers_bytes) / 1024**2, 1),
    }


def _parse_pg_size(setting: str) -> int:
    """Convert a Postgres GUC size string ('128MB', '1GB', etc.) to bytes."""
    setting = setting.strip().upper()
    for suffix, mult in [("GB", 1024**3), ("MB", 1024**2), ("KB", 1024), ("B", 1)]:
        if setting.endswith(suffix):
            return int(float(setting[: -len(suffix)]) * mult)
    return int(setting)


# ── latency warm-up check ────────────────────────────────────────────────────

def step1b_warm_latency(conn, embedding_dim: int, rng: np.random.Generator, n: int = 20) -> dict:
    """
    Run n ANN queries WITHOUT EXPLAIN to measure raw latency.
    Separates first-query (cold) vs subsequent (warm) latency to detect caching.
    """
    latencies: list[float] = []
    with conn.cursor() as cur:
        cur.execute("SET hnsw.ef_search = 40")
        for _ in range(n):
            qv = _random_unit_vec(embedding_dim, rng)
            t0 = time.perf_counter()
            cur.execute(
                "SELECT id FROM blocks ORDER BY embedding <=> %s::vector LIMIT 20",
                (qv,),
            )
            cur.fetchall()
            latencies.append((time.perf_counter() - t0) * 1000.0)

    arr = np.array(latencies)
    return {
        "n": n,
        "first_ms": round(latencies[0], 1),
        "p50_ms": round(float(np.percentile(arr, 50)), 1),
        "p90_ms": round(float(np.percentile(arr, 90)), 1),
        "p99_ms": round(float(np.percentile(arr, 99)), 1),
        "mean_ms": round(float(np.mean(arr)), 1),
        "first_vs_p50_ratio": round(latencies[0] / (float(np.percentile(arr[1:], 50)) + 0.001), 2),
    }


# ── verdict ──────────────────────────────────────────────────────────────────

def _verdict(size: dict, buffers: dict, warm: dict) -> str:
    miss_ratio = buffers["aggregate"]["cache_miss_ratio"]
    fits = size["index_fits_in_cache"]
    overflow_mb = size["overflow_mb"]

    lines = []
    if not fits:
        lines.append(
            f"VERDICT: MEMORY — HNSW index ({size['hnsw_index_mb']:.0f} MB) exceeds "
            f"shared_buffers ({size['shared_buffers_mb']:.0f} MB) by {overflow_mb:.0f} MB. "
            f"Cache-miss ratio = {miss_ratio:.1%}. "
            "Proceed to Step 3: index optimization (halfvec / lower m / IVFFlat)."
        )
    elif miss_ratio > 0.5:
        lines.append(
            f"VERDICT: MEMORY (confirmed by buffers) — cache-miss ratio = {miss_ratio:.1%}. "
            "Index nominally fits but is not being kept warm. "
            "Proceed to Step 3."
        )
    else:
        lines.append(
            f"VERDICT: CPU/DOCKER — index IS cached (miss ratio = {miss_ratio:.1%}, "
            f"index fits = {fits}). "
            f"Warm P99 = {warm['p99_ms']} ms. "
            "Proceed to Step 4: compare bare-metal vs Docker."
        )
    return "\n".join(lines)


# ── main ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="G1-OPT-1 Step 1+2: diagnose ANN latency bottleneck")
    parser.add_argument("--db-url", default="postgresql://localhost/nexum_bench")
    parser.add_argument("--n-explain", type=int, default=3, help="EXPLAIN samples (default 3)")
    parser.add_argument("--n-warm", type=int, default=20, help="Warm latency queries (default 20)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", default="results/diagnose_result.json")
    args = parser.parse_args(argv)

    print(f"[DIAGNOSE] Connecting to {args.db_url!r} …")
    try:
        conn = _connect(args.db_url)
    except Exception as exc:
        print(f"[DIAGNOSE] ERROR: {exc}", file=sys.stderr)
        return 1

    rng = np.random.default_rng(args.seed)

    print("[DIAGNOSE] Detecting embedding dim …")
    try:
        dim = _detect_embedding_dim(conn)
    except RuntimeError as exc:
        print(f"[DIAGNOSE] ERROR: {exc}", file=sys.stderr)
        return 1

    pgv = _pgvector_version(conn)
    print(f"[DIAGNOSE] pgvector={pgv}, embedding_dim={dim}")

    print("[DIAGNOSE] Step 2: checking index size vs shared_buffers …")
    size = step2_size_check(conn)
    print(
        f"  HNSW index:     {size['hnsw_index_mb']:.0f} MB\n"
        f"  shared_buffers: {size['shared_buffers_mb']:.0f} MB\n"
        f"  fits in cache:  {size['index_fits_in_cache']}"
    )

    print(f"[DIAGNOSE] Step 1a: EXPLAIN ANALYZE BUFFERS ({args.n_explain} samples) …")
    buffers = step1_explain_buffers(conn, dim, rng, n_samples=args.n_explain)
    agg = buffers["aggregate"]
    print(
        f"  shared hit={agg['total_shared_hit']}  "
        f"read={agg['total_shared_read']}  "
        f"miss_ratio={agg['cache_miss_ratio']:.1%}"
    )

    print(f"[DIAGNOSE] Step 1b: warm latency ({args.n_warm} queries) …")
    warm = step1b_warm_latency(conn, dim, rng, n=args.n_warm)
    print(
        f"  P50={warm['p50_ms']} ms  P90={warm['p90_ms']} ms  "
        f"P99={warm['p99_ms']} ms  first={warm['first_ms']} ms"
    )

    verdict = _verdict(size, buffers, warm)
    print(f"\n{'─'*70}\n{verdict}\n{'─'*70}")

    result = {
        "pgvector_version": pgv,
        "embedding_dim": dim,
        "step2_size_check": size,
        "step1a_explain_buffers": buffers,
        "step1b_warm_latency": warm,
        "verdict": verdict,
    }

    import os
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w") as fh:
        json.dump(result, fh, indent=2, default=str)
    print(f"[DIAGNOSE] Results written to {args.output}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
