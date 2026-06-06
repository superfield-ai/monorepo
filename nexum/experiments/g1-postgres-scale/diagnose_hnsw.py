"""
diagnose_hnsw.py — G1-OPT-1 (Issue #73) HNSW semantic ANN diagnosis & optimization.

Implements the protocol in issue #73:

  Step 1 — EXPLAIN (ANALYZE, BUFFERS) on a representative ANN query.
  Step 2 — Compare HNSW index size vs. shared_buffers.
  Step 3 — If memory-bound, evaluate optimizations:
              A. halfvec quantization     (pgvector >= 0.7)
              B. lower HNSW m parameter   (m=8)
              C. IVFFlat                  (lists=1000, probes=5/10/20)
  Step 4 — (Out-of-process) bare-metal comparison if Docker I/O is the culprit.
  Step 5 — ef_search sweep (20, 40, 80, 200) on the winning configuration,
            measuring P50/P99 latency AND recall@10 vs. an exact ground-truth
            scan.

The script:

  - Detects whether `blocks_embedding_hnsw_idx` already exists; if not, builds
    it with the requested parameters (default m=16, ef_construction=64).
  - For each named configuration ("hnsw_m16_full", "hnsw_m16_halfvec",
    "hnsw_m8_full", "ivfflat_1000") it (re)builds the index when --rebuild is
    set, then runs EXPLAIN, latency, and recall measurements.
  - Writes a canonical phase-0 result envelope via experiments._lib.results_writer
    to experiments/g1-postgres-scale/results/g1-opt-1_<timestamp>.json.

Usage:
    python diagnose_hnsw.py --db-url postgresql://nexum:nexum@localhost:5433/nexum_bench \\
        --configs hnsw_m16_full hnsw_m16_halfvec hnsw_m8_full \\
        --n-queries 100 --recall-queries 50 \\
        --output results/g1-opt-1.json

Notes:
- Recall@10 is computed against a ground-truth exact scan
  (`SET enable_indexscan=off`). For a 1M-row table this is slow (~3s/query),
  hence --recall-queries (default 50) is smaller than --n-queries.
- This module imports experiments._lib lazily so it can be tested without
  the harness library installed.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import psycopg2


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------

def _connect(db_url: str):
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    return conn


def _scalar(conn, sql: str, params: tuple = ()) -> Any:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    return row[0] if row else None


def _index_size_bytes(conn, index_name: str) -> int | None:
    return _scalar(
        conn,
        "SELECT pg_relation_size(c.oid) FROM pg_class c "
        "WHERE c.relname = %s AND c.relkind = 'i'",
        (index_name,),
    )


def _shared_buffers_bytes(conn) -> int:
    raw = _scalar(conn, "SHOW shared_buffers")
    return _parse_size(raw)


def _parse_size(s: str) -> int:
    """Parse a Postgres size string like '128MB', '1GB', '8192kB'."""
    s = s.strip()
    units = {"kB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
    for suffix, mult in units.items():
        if s.endswith(suffix):
            return int(float(s[: -len(suffix)]) * mult)
    return int(s)


# ---------------------------------------------------------------------------
# Index management — drop / build per configuration
# ---------------------------------------------------------------------------

@dataclass
class IndexConfig:
    """One named configuration to evaluate.

    `kind`        = "hnsw" | "ivfflat"
    `column_type` = "vector" | "halfvec"  (the active blocks.embedding type)
    `opclass`     = e.g. "vector_cosine_ops" or "halfvec_cosine_ops"
    `params`      = WITH-clause params, e.g. {"m": 16, "ef_construction": 64}
    """

    name: str
    kind: str
    column_type: str
    opclass: str
    params: dict[str, int]


CONFIGS: dict[str, IndexConfig] = {
    "hnsw_m16_full": IndexConfig(
        name="hnsw_m16_full",
        kind="hnsw",
        column_type="vector",
        opclass="vector_cosine_ops",
        params={"m": 16, "ef_construction": 64},
    ),
    "hnsw_m8_full": IndexConfig(
        name="hnsw_m8_full",
        kind="hnsw",
        column_type="vector",
        opclass="vector_cosine_ops",
        params={"m": 8, "ef_construction": 64},
    ),
    "hnsw_m16_halfvec": IndexConfig(
        name="hnsw_m16_halfvec",
        kind="hnsw",
        column_type="halfvec",
        opclass="halfvec_cosine_ops",
        params={"m": 16, "ef_construction": 64},
    ),
    "ivfflat_1000": IndexConfig(
        name="ivfflat_1000",
        kind="ivfflat",
        column_type="vector",
        opclass="vector_cosine_ops",
        params={"lists": 1000},
    ),
}


_INDEX_NAME = "blocks_embedding_hnsw_idx"  # we reuse this name for all configs


def _drop_index(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(f"DROP INDEX IF EXISTS {_INDEX_NAME}")


def _ensure_column_type(conn, column_type: str, dim: int) -> None:
    """Ensure blocks.embedding is the requested type. ALTERs in place if not."""
    actual = _scalar(
        conn,
        "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
        "WHERE attrelid = 'blocks'::regclass AND attname = 'embedding'",
    )
    target = f"{column_type}({dim})"
    if actual == target:
        return
    print(f"[diag] altering blocks.embedding {actual} -> {target}")
    with conn.cursor() as cur:
        cur.execute(
            f"ALTER TABLE blocks ALTER COLUMN embedding TYPE {column_type}({dim}) "
            f"USING embedding::{column_type}({dim})"
        )


def _build_index(conn, cfg: IndexConfig, dim: int) -> dict[str, Any]:
    """Build the index for `cfg` and return timing + size."""
    _drop_index(conn)
    _ensure_column_type(conn, cfg.column_type, dim)

    with_parts = ", ".join(f"{k} = {v}" for k, v in cfg.params.items())
    sql = (
        f"CREATE INDEX {_INDEX_NAME} ON blocks USING {cfg.kind} "
        f"(embedding {cfg.opclass}) WITH ({with_parts})"
    )
    print(f"[diag] building: {sql}")
    t0 = time.perf_counter()
    with conn.cursor() as cur:
        cur.execute(sql)
    build_seconds = time.perf_counter() - t0
    size_bytes = _index_size_bytes(conn, _INDEX_NAME) or 0
    print(
        f"[diag] built in {build_seconds:.1f}s, "
        f"index size = {size_bytes / (1024**2):.1f} MiB"
    )
    return {
        "build_seconds": build_seconds,
        "index_size_bytes": size_bytes,
        "params": dict(cfg.params),
        "opclass": cfg.opclass,
        "kind": cfg.kind,
        "column_type": cfg.column_type,
    }


# ---------------------------------------------------------------------------
# Query measurement
# ---------------------------------------------------------------------------

def _explain_buffers(
    conn, query_vec: list[float], cfg: IndexConfig, ef_search: int
) -> str:
    """Return EXPLAIN (ANALYZE, BUFFERS) output as a string."""
    with conn.cursor() as cur:
        if cfg.kind == "hnsw":
            cur.execute("SET hnsw.ef_search = %s", (ef_search,))
        elif cfg.kind == "ivfflat":
            cur.execute("SET ivfflat.probes = %s", (ef_search,))
        cur.execute(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) "
            "SELECT id FROM blocks ORDER BY embedding <=> %s::"
            f"{cfg.column_type} LIMIT 10",
            (query_vec,),
        )
        return "\n".join(row[0] for row in cur.fetchall())


def _measure_latency(
    conn,
    query_vecs: list[list[float]],
    cfg: IndexConfig,
    knob: int,
) -> dict[str, float]:
    """Return P50/P99/mean latency in ms."""
    latencies_ms: list[float] = []
    with conn.cursor() as cur:
        if cfg.kind == "hnsw":
            cur.execute("SET hnsw.ef_search = %s", (knob,))
        elif cfg.kind == "ivfflat":
            cur.execute("SET ivfflat.probes = %s", (knob,))
        sql = (
            "SELECT id FROM blocks ORDER BY embedding <=> %s::"
            f"{cfg.column_type} LIMIT 10"
        )
        for v in query_vecs:
            t0 = time.perf_counter()
            cur.execute(sql, (v,))
            cur.fetchall()
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)

    arr = np.array(latencies_ms, dtype=np.float64)
    return {
        "p50_ms": float(np.percentile(arr, 50)),
        "p95_ms": float(np.percentile(arr, 95)),
        "p99_ms": float(np.percentile(arr, 99)),
        "mean_ms": float(np.mean(arr)),
        "n": len(latencies_ms),
    }


def _ground_truth(conn, query_vecs: list[list[float]], column_type: str
) -> list[set[str]]:
    """Compute exact top-10 IDs per query via a sequential scan (index off)."""
    truth: list[set[str]] = []
    with conn.cursor() as cur:
        cur.execute("SET enable_indexscan = off")
        cur.execute("SET enable_bitmapscan = off")
        for v in query_vecs:
            cur.execute(
                "SELECT id FROM blocks ORDER BY embedding <=> %s::"
                f"{column_type} LIMIT 10",
                (v,),
            )
            truth.append({str(r[0]) for r in cur.fetchall()})
        cur.execute("RESET enable_indexscan")
        cur.execute("RESET enable_bitmapscan")
    return truth


def _measure_recall(
    conn,
    query_vecs: list[list[float]],
    truth: list[set[str]],
    cfg: IndexConfig,
    knob: int,
) -> float:
    """Return mean recall@10 (in [0, 1]) for the given knob (ef_search/probes)."""
    if not query_vecs:
        return 0.0
    hits = 0
    total = 0
    with conn.cursor() as cur:
        if cfg.kind == "hnsw":
            cur.execute("SET hnsw.ef_search = %s", (knob,))
        elif cfg.kind == "ivfflat":
            cur.execute("SET ivfflat.probes = %s", (knob,))
        sql = (
            "SELECT id FROM blocks ORDER BY embedding <=> %s::"
            f"{cfg.column_type} LIMIT 10"
        )
        for v, t in zip(query_vecs, truth):
            cur.execute(sql, (v,))
            got = {str(r[0]) for r in cur.fetchall()}
            hits += len(got & t)
            total += len(t)
    return hits / total if total else 0.0


# ---------------------------------------------------------------------------
# Query vector sourcing
# ---------------------------------------------------------------------------

def _sample_query_vectors(
    conn, n: int, dim: int, seed: int, mode: str
) -> list[list[float]]:
    """Return n query vectors. `mode` = 'random' or 'sample-from-corpus'.

    Sampling from the corpus is more realistic — synthetic random unit vectors
    are very far from any actual block, so HNSW exits early and over-reports
    speed. We default to corpus sampling.
    """
    if mode == "random":
        rng = np.random.default_rng(seed)
        out = []
        for _ in range(n):
            v = rng.standard_normal(dim).astype(np.float32)
            v /= np.linalg.norm(v) + 1e-9
            out.append(v.tolist())
        return out

    # corpus sampling — read existing embeddings as text and re-parse
    with conn.cursor() as cur:
        cur.execute(
            "SELECT embedding::text FROM blocks "
            "TABLESAMPLE SYSTEM (1) LIMIT %s",
            (n * 3,),
        )
        rows = cur.fetchall()
    rng = np.random.default_rng(seed)
    if len(rows) > n:
        idx = rng.choice(len(rows), size=n, replace=False)
        rows = [rows[i] for i in idx]
    out: list[list[float]] = []
    for (text,) in rows[:n]:
        # text is "[v1,v2,...]" — strip brackets and parse
        s = text.strip().strip("[]")
        out.append([float(x) for x in s.split(",")])
    return out


# ---------------------------------------------------------------------------
# Main protocol
# ---------------------------------------------------------------------------

def run_diagnosis(
    db_url: str,
    configs: list[str],
    n_queries: int,
    recall_queries: int,
    ef_search_sweep: list[int],
    seed: int,
    rebuild: bool,
    query_mode: str,
) -> dict[str, Any]:
    """Run the full diagnosis protocol and return a structured result dict."""
    conn = _connect(db_url)

    # --- Environment snapshot ---
    n_blocks = _scalar(conn, "SELECT count(*) FROM blocks")
    pgvector_version = _scalar(
        conn, "SELECT extversion FROM pg_extension WHERE extname='vector'"
    )
    pg_version = _scalar(conn, "SHOW server_version")
    shared_buffers = _scalar(conn, "SHOW shared_buffers")
    work_mem = _scalar(conn, "SHOW work_mem")
    maintenance_work_mem = _scalar(conn, "SHOW maintenance_work_mem")
    table_size = _scalar(
        conn,
        "SELECT pg_relation_size('blocks')",
    )
    embedding_dim = _scalar(
        conn,
        "SELECT vector_dims(embedding) FROM blocks "
        "WHERE embedding IS NOT NULL LIMIT 1",
    )

    env = {
        "n_blocks": n_blocks,
        "pg_version": pg_version,
        "pgvector_version": pgvector_version,
        "shared_buffers": shared_buffers,
        "shared_buffers_bytes": _parse_size(shared_buffers),
        "work_mem": work_mem,
        "maintenance_work_mem": maintenance_work_mem,
        "table_size_bytes": table_size,
        "embedding_dim": embedding_dim,
    }
    print(f"[diag] env = {json.dumps(env, indent=2)}")

    # --- Sample query vectors once, for fairness across configurations ---
    query_vecs = _sample_query_vectors(conn, n_queries, embedding_dim, seed, query_mode)
    recall_vecs = query_vecs[:recall_queries]
    print(f"[diag] sampled {len(query_vecs)} query vectors (mode={query_mode})")

    per_config: dict[str, Any] = {}

    for cfg_name in configs:
        if cfg_name not in CONFIGS:
            print(f"[diag] WARN: unknown config {cfg_name!r}, skipping")
            continue
        cfg = CONFIGS[cfg_name]
        print(f"\n[diag] ===== config: {cfg_name} =====")

        # Build (or skip if --no-rebuild and index exists)
        existing = _index_size_bytes(conn, _INDEX_NAME)
        if not rebuild and existing is not None:
            print(f"[diag] reusing existing index ({existing} bytes)")
            build_info = {
                "build_seconds": None,
                "index_size_bytes": existing,
                "params": dict(cfg.params),
                "opclass": cfg.opclass,
                "kind": cfg.kind,
                "column_type": cfg.column_type,
                "reused_existing": True,
            }
        else:
            build_info = _build_index(conn, cfg, embedding_dim)

        # Compute ground truth ONCE per column-type (recall is index-agnostic
        # by definition — the truth comes from a seq scan).
        print(f"[diag] computing ground truth for {recall_queries} queries…")
        t0 = time.perf_counter()
        truth = _ground_truth(conn, recall_vecs, cfg.column_type)
        truth_seconds = time.perf_counter() - t0
        print(f"[diag] ground-truth done in {truth_seconds:.1f}s")

        # EXPLAIN (ANALYZE, BUFFERS) for the default knob
        default_knob = ef_search_sweep[0]
        explain_text = _explain_buffers(conn, query_vecs[0], cfg, default_knob)

        # ef_search / probes sweep
        sweep: list[dict[str, Any]] = []
        for knob in ef_search_sweep:
            lat = _measure_latency(conn, query_vecs, cfg, knob)
            recall = _measure_recall(conn, recall_vecs, truth, cfg, knob)
            row = {
                "knob": knob,
                "knob_name": "ef_search" if cfg.kind == "hnsw" else "probes",
                "p50_ms": lat["p50_ms"],
                "p95_ms": lat["p95_ms"],
                "p99_ms": lat["p99_ms"],
                "mean_ms": lat["mean_ms"],
                "recall_at_10": recall,
            }
            print(
                f"[diag] {cfg_name} {row['knob_name']}={knob}: "
                f"P50={lat['p50_ms']:.1f}ms P99={lat['p99_ms']:.1f}ms "
                f"recall@10={recall:.3f}"
            )
            sweep.append(row)

        per_config[cfg_name] = {
            "build": build_info,
            "explain_buffers_default_knob": explain_text,
            "sweep": sweep,
        }

    conn.close()

    # --- Acceptance evaluation ---
    # Per #73: P99 < 200 ms with recall@10 >= 0.90 and index <= 1 GB.
    SHARED_BUFFER_TARGET_BYTES = 1024**3  # 1 GB
    P99_TARGET_MS = 200.0
    RECALL_TARGET = 0.90

    winners: list[dict[str, Any]] = []
    for cfg_name, info in per_config.items():
        for row in info["sweep"]:
            if (
                info["build"]["index_size_bytes"] <= SHARED_BUFFER_TARGET_BYTES
                and row["p99_ms"] < P99_TARGET_MS
                and row["recall_at_10"] >= RECALL_TARGET
            ):
                winners.append(
                    {
                        "config": cfg_name,
                        "knob": row["knob"],
                        "knob_name": row["knob_name"],
                        "p50_ms": row["p50_ms"],
                        "p99_ms": row["p99_ms"],
                        "recall_at_10": row["recall_at_10"],
                        "index_size_bytes": info["build"]["index_size_bytes"],
                    }
                )

    overall_pass = len(winners) > 0

    return {
        "env": env,
        "per_config": per_config,
        "winners": winners,
        "overall_pass": overall_pass,
        "acceptance": {
            "p99_target_ms": P99_TARGET_MS,
            "recall_target": RECALL_TARGET,
            "shared_buffer_target_bytes": SHARED_BUFFER_TARGET_BYTES,
        },
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="G1-OPT-1 HNSW diagnosis (#73)")
    p.add_argument(
        "--db-url",
        default="postgresql://nexum:nexum@localhost:5433/nexum_bench",
    )
    p.add_argument(
        "--configs",
        nargs="+",
        default=["hnsw_m16_full", "hnsw_m16_halfvec", "hnsw_m8_full"],
    )
    p.add_argument("--n-queries", type=int, default=100)
    p.add_argument("--recall-queries", type=int, default=30)
    p.add_argument(
        "--ef-search-sweep",
        nargs="+",
        type=int,
        default=[20, 40, 80, 200],
    )
    p.add_argument("--seed", type=int, default=42)
    p.add_argument(
        "--rebuild",
        action="store_true",
        help="Drop+rebuild the index for every named configuration.",
    )
    p.add_argument(
        "--query-mode",
        choices=["random", "corpus"],
        default="corpus",
        help="'corpus' samples real embeddings (realistic); "
        "'random' uses synthetic Gaussian unit vectors (matches PR#72).",
    )
    p.add_argument(
        "--output",
        default="results/g1-opt-1.json",
    )
    args = p.parse_args(argv)

    res = run_diagnosis(
        db_url=args.db_url,
        configs=args.configs,
        n_queries=args.n_queries,
        recall_queries=args.recall_queries,
        ef_search_sweep=args.ef_search_sweep,
        seed=args.seed,
        rebuild=args.rebuild,
        query_mode=args.query_mode,
    )

    # --- Write canonical phase-0 envelope ---
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from experiments._lib.runner import capture_run_context  # type: ignore
    from experiments._lib.results_writer import (  # type: ignore
        ResultEnvelope,
        write_result,
    )

    runtime = capture_run_context(gate="G1", hypothesis="H1.1", seed=args.seed)

    metrics: dict[str, Any] = {
        "env": res["env"],
        "winners": res["winners"],
        "overall_pass": res["overall_pass"],
        "acceptance": res["acceptance"],
        # Trim per_config for the envelope: keep build info + sweep, but drop
        # the long EXPLAIN text (we save it as a sidecar file).
        "per_config": {
            name: {"build": info["build"], "sweep": info["sweep"]}
            for name, info in res["per_config"].items()
        },
    }

    envelope = ResultEnvelope(
        gate="G1",
        hypothesis="H1.1",
        passed=res["overall_pass"],
        metrics=metrics,
        runtime=runtime,
        notes="G1-OPT-1 (#73) HNSW diagnosis & optimization sweep.",
    )

    out_dir = Path(__file__).resolve().parent
    written = write_result(envelope, out_dir)
    print(f"[diag] envelope written to {written}")

    # Sidecar: write each EXPLAIN to a separate text file for easy review.
    explain_dir = out_dir / "results" / "explain"
    explain_dir.mkdir(parents=True, exist_ok=True)
    for name, info in res["per_config"].items():
        (explain_dir / f"{name}.txt").write_text(
            info["explain_buffers_default_knob"], encoding="utf-8"
        )
    print(f"[diag] EXPLAIN sidecars in {explain_dir}")

    # Also write a stable, non-timestamped JSON for reproducible diffs.
    stable = out_dir / args.output
    stable.parent.mkdir(parents=True, exist_ok=True)
    stable.write_text(
        json.dumps(envelope.to_dict(results_path=str(stable)), indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(f"[diag] stable copy at {stable}")

    return 0 if res["overall_pass"] else 2


if __name__ == "__main__":
    sys.exit(main())
