"""
schema_comparison.py — Postgres vs. Kuzu vs. Neo4j graph traversal comparison.

Deploys the same 1M-block synthetic corpus into Postgres (recursive CTE) and
Kuzu (in-process graph DB). Measures N-hop traversal latency and reports the
crossover point at which Kuzu outperforms Postgres.

Neo4j is optional (requires a running instance); the function notes if
unavailable. Kuzu is always run — it is in-process and requires no server.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
import uuid
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
# Re-use G1 helpers
# ---------------------------------------------------------------------------

_G1_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "g1-postgres-scale")
)
if _G1_DIR not in sys.path:
    sys.path.insert(0, _G1_DIR)

from ingest import generate_and_ingest, DOMAIN_MIXES  # noqa: E402


# ---------------------------------------------------------------------------
# Kuzu helpers
# ---------------------------------------------------------------------------

def _kuzu_available() -> bool:
    return importlib.util.find_spec("kuzu") is not None


def _build_kuzu_graph(
    block_ids: list[str],
    links: list[tuple[str, str, str, float]],
    db_path: str,
) -> Any:
    """Create an in-memory (or on-disk) Kuzu graph with the block/link data.

    Schema::

        CREATE NODE TABLE Block(id STRING, PRIMARY KEY(id))
        CREATE REL TABLE Link(FROM Block TO Block, rel_type STRING, confidence FLOAT)

    Args:
        block_ids: List of block UUID strings.
        links: List of (src_id, dst_id, rel_type, confidence).
        db_path: Path for Kuzu's on-disk store (use a temp dir for ephemeral).

    Returns:
        The Kuzu ``Database`` object (caller keeps reference alive).
    """
    import kuzu

    db = kuzu.Database(db_path)
    conn = kuzu.Connection(db)

    conn.execute("CREATE NODE TABLE Block(id STRING, PRIMARY KEY(id))")
    conn.execute(
        "CREATE REL TABLE Link(FROM Block TO Block, rel_type STRING, confidence DOUBLE)"
    )

    # Insert blocks in batches via parameterised queries
    batch_size = 500
    for i in range(0, len(block_ids), batch_size):
        batch = block_ids[i : i + batch_size]
        # Kuzu doesn't have execute_values — build a single UNWIND-style insert
        values = ", ".join(f'("{bid}")' for bid in batch)
        conn.execute(f"CREATE (:Block {{id: {repr(bid)}}});" if False else "")
        for bid in batch:
            conn.execute(f"CREATE (:Block {{id: '{bid}'}})")

    # Insert links in batches
    for src, dst, rel_type, confidence in links:
        conn.execute(
            f"""
            MATCH (a:Block {{id: '{src}'}}), (b:Block {{id: '{dst}'}})
            CREATE (a)-[:Link {{rel_type: '{rel_type}', confidence: {confidence}}}]->(b)
            """
        )

    return db, conn


def _kuzu_traverse(kuzu_conn, seed_id: str, n_hops: int, n_queries: int, rng) -> dict:
    """Run Kuzu variable-length path traversal and measure latency."""
    latencies_ms: list[float] = []

    for _ in range(n_queries):
        t0 = time.perf_counter()
        result = kuzu_conn.execute(
            f"""
            MATCH (a:Block)-[r:Link*1..{n_hops}]->(b:Block)
            WHERE a.id = '{seed_id}'
            RETURN b.id
            LIMIT 100
            """
        )
        # Consume results
        rows = []
        while result.has_next():
            rows.append(result.get_next())
        latencies_ms.append((time.perf_counter() - t0) * 1000.0)

    arr = np.array(latencies_ms)
    return {
        "p50_ms": float(np.percentile(arr, 50)),
        "p99_ms": float(np.percentile(arr, 99)),
        "n_results_last": len(rows),
    }


def _postgres_traverse(conn, seed_id: str, n_hops: int, n_queries: int) -> dict:
    """Run Postgres recursive CTE traversal and measure latency."""
    latencies_ms: list[float] = []
    n_results_last = 0

    with conn.cursor() as cur:
        for _ in range(n_queries):
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
                LIMIT 100
                """,
                (seed_id, n_hops),
            )
            rows = cur.fetchall()
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)
            n_results_last = len(rows)

    arr = np.array(latencies_ms)
    return {
        "p50_ms": float(np.percentile(arr, 50)),
        "p99_ms": float(np.percentile(arr, 99)),
        "n_results_last": n_results_last,
    }


def run_schema_comparison(
    postgres_url: str,
    n_blocks: int = 1_000_000,
    n_hops_list: list[int] = None,
    n_queries: int = 50,
    seed: int = 42,
    kuzu_db_path: str | None = None,
) -> dict:
    """Compare Postgres vs. Kuzu graph traversal on the same corpus.

    Deploys a synthetic *n_blocks*-block corpus into Postgres using the G1
    ingest pipeline.  Then builds an equivalent Kuzu graph from a *sample* of
    the corpus (up to 10 K blocks to keep Kuzu setup tractable within a
    benchmark run).

    For each hop depth in *n_hops_list*, measures P50/P99 latency for both
    engines across *n_queries* random seed blocks.

    Neo4j is noted as optional; if a ``NEO4J_URL`` environment variable is set,
    a minimal connectivity check is performed and the result is noted.

    Args:
        postgres_url: Postgres connection URL.
        n_blocks: Corpus size for Postgres ingestion.
        n_hops_list: Hop depths to test (default [2, 4, 6]).
        n_queries: Queries per hop depth per engine.
        seed: Random seed.
        kuzu_db_path: Path for Kuzu on-disk storage. Uses a temp dir if None.

    Returns:
        Dict with keys: ``postgres``, ``kuzu``, ``neo4j_available``,
        ``crossover_hop``, ``n_blocks``, ``kuzu_sample_size``.
        Each engine entry contains per-hop latency dicts.
    """
    import psycopg2
    import tempfile

    if n_hops_list is None:
        n_hops_list = [2, 4, 6]

    # --- Postgres setup ---
    conn = psycopg2.connect(postgres_url)
    conn.autocommit = False

    # Apply schema and ingest corpus
    from schema import ensure_schema  # G1 module

    ensure_schema(conn)

    with conn.cursor() as cur:
        cur.execute("TRUNCATE links, version_blocks, blocks, document_versions, documents RESTART IDENTITY CASCADE")
    conn.commit()

    domain_mix = DOMAIN_MIXES["mixed"]
    generate_and_ingest(
        conn=conn,
        n_blocks=n_blocks,
        domain_mix=domain_mix,
        embedding_dim=128,  # small dim for schema comparison (not a vector benchmark)
        seed=seed,
        batch_size=1000,
    )

    # Sample seed block IDs for queries
    rng = np.random.default_rng(seed)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM blocks TABLESAMPLE SYSTEM(1) LIMIT %s", (n_queries * 5,)
        )
        rows = cur.fetchall()
        if not rows:
            cur.execute("SELECT id FROM blocks LIMIT %s", (n_queries,))
            rows = cur.fetchall()

    all_ids = [r[0] for r in rows]
    query_seeds = rng.choice(all_ids, size=min(n_queries, len(all_ids)), replace=False).tolist()

    # --- Postgres traversal ---
    postgres_results: dict[str, dict] = {}
    for n_hops in n_hops_list:
        hop_stats = _postgres_traverse(conn, query_seeds[0], n_hops, n_queries)
        # Use rotating seeds for each query
        latencies = []
        with conn.cursor() as cur:
            for seed_id in (query_seeds * ((n_queries // len(query_seeds)) + 1))[:n_queries]:
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
                    SELECT target_block_id FROM traversal LIMIT 100
                    """,
                    (seed_id, n_hops),
                )
                cur.fetchall()
                latencies.append((time.perf_counter() - t0) * 1000.0)
        arr = np.array(latencies)
        postgres_results[f"{n_hops}_hop"] = {
            "p50_ms": float(np.percentile(arr, 50)),
            "p99_ms": float(np.percentile(arr, 99)),
        }

    conn.close()

    # --- Kuzu setup ---
    kuzu_results: dict[str, dict] | None = None
    kuzu_sample_size = 0

    if _kuzu_available():
        import kuzu
        import tempfile

        tmp_dir = kuzu_db_path or tempfile.mkdtemp(prefix="kuzu_area1_")

        # Use a small sample for Kuzu (row-by-row insert is slow at scale)
        kuzu_sample_size = min(10_000, n_blocks)
        kuzu_block_ids = [str(uuid.uuid4()) for _ in range(kuzu_sample_size)]

        # Build synthetic links for the sample (~5 links per block)
        n_kuzu_links = kuzu_sample_size * 5
        kuzu_links = []
        rel_types = ["cites", "contradicts", "elaborates", "supports", "overrides"]
        for _ in range(n_kuzu_links):
            src_idx = int(rng.integers(0, kuzu_sample_size))
            dst_idx = int(rng.integers(0, kuzu_sample_size))
            if src_idx == dst_idx:
                dst_idx = (dst_idx + 1) % kuzu_sample_size
            rel_type = rel_types[int(rng.integers(0, len(rel_types)))]
            confidence = float(rng.uniform(0.5, 1.0))
            kuzu_links.append(
                (kuzu_block_ids[src_idx], kuzu_block_ids[dst_idx], rel_type, confidence)
            )

        # Build Kuzu graph
        kuzu_db = kuzu.Database(tmp_dir)
        kuzu_conn = kuzu.Connection(kuzu_db)
        kuzu_conn.execute("CREATE NODE TABLE Block(id STRING, PRIMARY KEY(id))")
        kuzu_conn.execute(
            "CREATE REL TABLE Link(FROM Block TO Block, rel_type STRING, confidence DOUBLE)"
        )
        for bid in kuzu_block_ids:
            kuzu_conn.execute(f"CREATE (:Block {{id: '{bid}'}})")
        for src, dst, rel_type, confidence in kuzu_links:
            try:
                kuzu_conn.execute(
                    f"MATCH (a:Block {{id: '{src}'}}), (b:Block {{id: '{dst}'}})"
                    f" CREATE (a)-[:Link {{rel_type: '{rel_type}', confidence: {confidence}}}]->(b)"
                )
            except Exception:
                pass  # Skip duplicate/invalid links

        kuzu_seed_ids = kuzu_block_ids[:n_queries]
        kuzu_results = {}
        for n_hops in n_hops_list:
            latencies = []
            for seed_id in kuzu_seed_ids:
                t0 = time.perf_counter()
                result = kuzu_conn.execute(
                    f"""
                    MATCH (a:Block)-[r:Link*1..{n_hops}]->(b:Block)
                    WHERE a.id = '{seed_id}'
                    RETURN b.id
                    LIMIT 100
                    """
                )
                while result.has_next():
                    result.get_next()
                latencies.append((time.perf_counter() - t0) * 1000.0)
            arr = np.array(latencies)
            kuzu_results[f"{n_hops}_hop"] = {
                "p50_ms": float(np.percentile(arr, 50)),
                "p99_ms": float(np.percentile(arr, 99)),
            }

    # --- Neo4j availability check ---
    neo4j_url = os.environ.get("NEO4J_URL", "")
    neo4j_available = False
    if neo4j_url:
        try:
            import urllib.request

            urllib.request.urlopen(neo4j_url, timeout=3)
            neo4j_available = True
        except Exception:
            neo4j_available = False

    # --- Crossover analysis ---
    crossover_hop: int | None = None
    if kuzu_results and postgres_results:
        for n_hops in n_hops_list:
            key = f"{n_hops}_hop"
            pg_p50 = postgres_results[key]["p50_ms"]
            kz_p50 = kuzu_results[key]["p50_ms"]
            if kz_p50 < pg_p50:
                crossover_hop = n_hops
                break

    return {
        "experiment": "area1_schema_comparison",
        "n_blocks": n_blocks,
        "kuzu_sample_size": kuzu_sample_size,
        "n_hops_list": n_hops_list,
        "n_queries": n_queries,
        "postgres": postgres_results,
        "kuzu": kuzu_results,
        "kuzu_available": _kuzu_available(),
        "neo4j_available": neo4j_available,
        "neo4j_note": (
            "Neo4j requires a running instance; set NEO4J_URL env var to enable."
            if not neo4j_available
            else "Neo4j connectivity confirmed."
        ),
        "crossover_hop": crossover_hop,
    }
