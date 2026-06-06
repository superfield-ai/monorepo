"""
generate_corpus.py — Standalone synthetic corpus generator for the G1 benchmark.

Usage::

    python generate_corpus.py \\
        --db-url postgresql://nexum:nexum@localhost:15432/nexum_bench \\
        --scale 1m \\
        --domain-mix mixed \\
        --embedding-dim 384 \\
        --seed 42 \\
        --batch-size 5000

Generates a reproducible synthetic block corpus at the requested scale and
ingests it into the Nexum schema.  Optimises for bulk load speed by dropping
the HNSW index during ingest and rebuilding it afterwards — gives ~5× faster
inserts than maintaining the HNSW incrementally.

Corpus layout
-------------
- ~5 links per block on average (sparse link graph, realistic degree
  distribution)
- All embedding vectors are random unit-normalised float32 at the specified
  dimensionality (deterministic from seed)
- Realistic block metadata: domain-appropriate source formats, block types,
  provenance

The generator is deterministic: the same (scale, domain-mix, embedding-dim,
seed) triple always produces the same corpus.

References
----------
- experiments/g1-postgres-scale/ingest.py  — low-level batched insert helpers
- experiments/g1-postgres-scale/schema.py  — schema application
- docs/research/hypotheses/H1.1_postgres-sufficient-20m-blocks.md
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Any

import psycopg2

# Allow running from the g1-postgres-scale directory or from repo root
import os as _os
_here = _os.path.dirname(_os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

from ingest import generate_and_ingest, DOMAIN_MIXES
from schema import ensure_schema


def _parse_scale(s: str) -> int:
    """Parse a scale string like '1m', '5m', '20m' or an int."""
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


def generate_corpus(
    db_url: str,
    n_blocks: int,
    domain_mix: dict[str, float],
    embedding_dim: int = 384,
    seed: int = 42,
    batch_size: int = 5000,
    skip_schema: bool = False,
    fast_load: bool = True,
) -> dict[str, Any]:
    """
    Generate and ingest a synthetic corpus at the requested scale.

    Parameters
    ----------
    db_url:       Postgres connection URL.
    n_blocks:     Total number of blocks to generate.
    domain_mix:   Mapping ``{source_format: fraction}``.
    embedding_dim: Dimensionality of synthetic embeddings (default: 384).
    seed:         RNG seed for reproducibility.
    batch_size:   Rows per execute_values call.
    skip_schema:  If True, skip schema application (assumes it's already done).
    fast_load:    If True, drop HNSW index before bulk load and rebuild
                  afterwards.  Gives ~5× speedup for large corpora.

    Returns
    -------
    Ingest stats dict with keys:
        n_blocks, n_documents, n_links, embedding_dim,
        storage_bytes, embedding_storage_bytes, ingest_time_seconds,
        hnsw_rebuild_seconds (when fast_load=True)
    """
    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    try:
        if not skip_schema:
            print("[corpus] Applying schema …", flush=True)
            ensure_schema(conn)

        if fast_load:
            print("[corpus] Dropping HNSW index for bulk load …", flush=True)
            with conn.cursor() as cur:
                cur.execute("DROP INDEX IF EXISTS blocks_embedding_hnsw_idx;")
            conn.commit()

        print(
            f"[corpus] Ingesting {n_blocks:,} blocks "
            f"(dim={embedding_dim}, domain={list(domain_mix.keys())}, seed={seed}) …",
            flush=True,
        )
        stats = generate_and_ingest(
            conn=conn,
            n_blocks=n_blocks,
            domain_mix=domain_mix,
            embedding_dim=embedding_dim,
            seed=seed,
            batch_size=batch_size,
        )
        print(
            f"[corpus] Ingest done in {stats['ingest_time_seconds']:.1f}s — "
            f"{stats['n_blocks']:,} blocks, "
            f"{stats['n_links']:,} links, "
            f"{stats['storage_bytes'] / 1e9:.2f} GB total",
            flush=True,
        )

        if fast_load:
            print(
                f"[corpus] Rebuilding HNSW index (m=16, ef_construction=64) …",
                flush=True,
            )
            t_hnsw = time.perf_counter()
            with conn.cursor() as cur:
                cur.execute(
                    "CREATE INDEX blocks_embedding_hnsw_idx "
                    "ON blocks USING hnsw (embedding vector_cosine_ops) "
                    "WITH (m = 16, ef_construction = 64);"
                )
            conn.commit()
            hnsw_seconds = time.perf_counter() - t_hnsw
            stats["hnsw_rebuild_seconds"] = round(hnsw_seconds, 1)
            print(
                f"[corpus] HNSW index built in {hnsw_seconds:.1f}s",
                flush=True,
            )

    finally:
        conn.close()

    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "G1 corpus generator — creates a reproducible synthetic block "
            "corpus and ingests it into the Nexum Postgres schema."
        )
    )
    parser.add_argument(
        "--db-url",
        default="postgresql://nexum:nexum@localhost:5432/nexum_bench",
        help="Postgres connection URL",
    )
    parser.add_argument(
        "--scale",
        default="1m",
        metavar="SCALE",
        help="Corpus size, e.g. 100k, 1m, 5m, 20m (default: 1m)",
    )
    parser.add_argument(
        "--domain-mix",
        choices=list(DOMAIN_MIXES.keys()),
        default="mixed",
        help="Domain mix for synthetic corpus (default: mixed)",
    )
    parser.add_argument(
        "--embedding-dim",
        type=int,
        default=384,
        help="Embedding dimensionality (default: 384, matches all-MiniLM-L6-v2)",
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
        help="Random seed for reproducibility (default: 42)",
    )
    parser.add_argument(
        "--skip-schema",
        action="store_true",
        help="Skip schema creation (assumes schema already applied)",
    )
    parser.add_argument(
        "--no-fast-load",
        action="store_true",
        help="Disable fast-load mode (maintain HNSW during inserts — slow for large corpora)",
    )
    parser.add_argument(
        "--truncate",
        action="store_true",
        help="Truncate existing data before generating new corpus",
    )
    args = parser.parse_args(argv)

    n_blocks = _parse_scale(args.scale)
    domain_mix = DOMAIN_MIXES[args.domain_mix]

    print(f"[corpus] Connecting to {args.db_url!r} …", flush=True)
    if args.truncate:
        conn = psycopg2.connect(args.db_url)
        conn.autocommit = False
        with conn.cursor() as cur:
            cur.execute(
                "TRUNCATE links, version_blocks, blocks, "
                "document_versions, documents RESTART IDENTITY CASCADE"
            )
        conn.commit()
        conn.close()
        print("[corpus] Database truncated.", flush=True)

    stats = generate_corpus(
        db_url=args.db_url,
        n_blocks=n_blocks,
        domain_mix=domain_mix,
        embedding_dim=args.embedding_dim,
        seed=args.seed,
        batch_size=args.batch_size,
        skip_schema=args.skip_schema,
        fast_load=not args.no_fast_load,
    )

    label = _scale_label(n_blocks)
    print(f"\n[corpus] ✓ {label} corpus generated:")
    print(f"  Blocks:        {stats['n_blocks']:>12,}")
    print(f"  Documents:     {stats['n_documents']:>12,}")
    print(f"  Links:         {stats['n_links']:>12,}")
    print(f"  Embedding dim: {stats['embedding_dim']:>12}")
    print(f"  Total storage: {stats['storage_bytes'] / 1e9:>11.2f} GB")
    if "hnsw_rebuild_seconds" in stats:
        print(f"  HNSW rebuild:  {stats['hnsw_rebuild_seconds']:>10.1f}s")

    return 0


if __name__ == "__main__":
    sys.exit(main())
