"""
ingest.py — Synthetic corpus ingestion for the G1 benchmark.

Generates a synthetic block corpus (random embeddings, fake text) and ingests it
into the Nexum Postgres schema via batched inserts.  OpenAI is NOT called: this
is a scale and latency test, not a quality test.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Any

import numpy as np
import psycopg2.extras

# ---------------------------------------------------------------------------
# Domain mix definitions
# ---------------------------------------------------------------------------

DOMAIN_MIXES: dict[str, dict[str, float]] = {
    "legal": {"pdf": 0.6, "docx": 0.3, "markdown": 0.1},
    "medical": {"pdf": 0.7, "docx": 0.2, "markdown": 0.1},
    "mixed": {"pdf": 0.45, "docx": 0.35, "markdown": 0.20},
}

_BLOCK_TYPES = ["paragraph", "heading", "list_item", "table"]
_BLOCK_TYPE_WEIGHTS = [0.65, 0.15, 0.15, 0.05]

_LINK_LAYERS = ["structural", "semantic", "ai"]
_LINK_LAYER_WEIGHTS = [0.4, 0.3, 0.3]

_REL_TYPES = ["cites", "contradicts", "elaborates", "overrides", "supports"]
_REL_TYPE_WEIGHTS = [0.3, 0.1, 0.25, 0.1, 0.25]

# Average links per block (will be ~10 on expectation)
_LINKS_PER_BLOCK_MEAN = 10


def _fake_content(rng: np.random.Generator, word_count: int = 40) -> str:
    """Generate plausible-length text without requiring the Faker library at
    import time (saves ~100 ms for unit-test cold starts)."""
    words = [
        "the", "of", "and", "to", "in", "a", "is", "that", "for", "on",
        "are", "with", "as", "at", "be", "this", "from", "or", "an", "by",
        "legal", "medical", "document", "block", "clause", "section", "term",
        "provision", "agreement", "contract", "regulation", "statute", "rule",
        "evidence", "record", "data", "patient", "treatment", "diagnosis",
        "research", "study", "result", "finding", "analysis", "method",
    ]
    chosen = rng.choice(words, size=word_count, replace=True)
    sentence = " ".join(chosen).capitalize() + "."
    return sentence


def _random_embedding(rng: np.random.Generator, dim: int) -> list[float]:
    """Unit-normalised random float32 vector — mimics a real embedding."""
    v = rng.standard_normal(dim).astype(np.float32)
    norm = np.linalg.norm(v)
    if norm > 0:
        v = v / norm
    return v.tolist()


def generate_and_ingest(
    conn,
    n_blocks: int,
    domain_mix: dict[str, float],
    embedding_dim: int = 1536,
    seed: int = 42,
    batch_size: int = 1000,
) -> dict[str, Any]:
    """Generate a synthetic block corpus and ingest it into Postgres.

    Args:
        conn: Open psycopg2 connection with autocommit=False.
        n_blocks: Total number of blocks to generate.
        domain_mix: Mapping ``{source_format: fraction}`` (fractions must sum
                    to 1.0).  Controls the mix of document source formats.
        embedding_dim: Dimensionality of synthetic embeddings.
        seed: Random seed for reproducibility.
        batch_size: Number of rows per ``execute_values`` call.

    Returns:
        A dict with keys: ``n_blocks``, ``n_documents``, ``n_links``,
        ``embedding_dim``, ``storage_bytes``, ``embedding_storage_bytes``,
        ``ingest_time_seconds``.
    """
    rng = np.random.default_rng(seed)
    t0 = time.perf_counter()

    formats = list(domain_mix.keys())
    format_probs = np.array([domain_mix[f] for f in formats], dtype=float)
    format_probs /= format_probs.sum()  # normalise to guard against rounding

    # ------------------------------------------------------------------
    # 1. Create one document per ~500 blocks  (≈ 2 documents per 1 000 blocks)
    # ------------------------------------------------------------------
    n_docs = max(1, n_blocks // 500)
    doc_ids: list[str] = []

    with conn.cursor() as cur:
        doc_rows = []
        for _ in range(n_docs):
            doc_id = str(uuid.uuid4())
            doc_ids.append(doc_id)
            src_fmt = rng.choice(formats, p=format_probs)
            doc_rows.append(
                (
                    doc_id,
                    f"Synthetic Document {doc_id[:8]}",
                    src_fmt,
                    json.dumps({"synthetic": True}),
                )
            )

        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO documents (id, title, source_format, meta)
            VALUES %s
            ON CONFLICT DO NOTHING
            """,
            doc_rows,
            template="(%s, %s, %s, %s::jsonb)",
        )

        # ------------------------------------------------------------------
        # 2. Create one document_version per document
        # ------------------------------------------------------------------
        ver_rows = []
        ver_ids: list[str] = []
        for doc_id in doc_ids:
            ver_id = str(uuid.uuid4())
            ver_ids.append(ver_id)
            ver_rows.append((ver_id, doc_id, 1, "v1", "done"))

        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO document_versions (id, doc_id, version_num, label, status)
            VALUES %s
            ON CONFLICT DO NOTHING
            """,
            ver_rows,
        )
        conn.commit()

        # ------------------------------------------------------------------
        # 3. Insert blocks in batches
        # ------------------------------------------------------------------
        all_block_ids: list[str] = []
        doc_id_arr = np.array(doc_ids)
        ver_id_arr = np.array(ver_ids)

        for batch_start in range(0, n_blocks, batch_size):
            batch_end = min(batch_start + batch_size, n_blocks)
            actual_batch = batch_end - batch_start

            block_rows = []
            for i in range(actual_batch):
                global_idx = batch_start + i
                block_id = str(uuid.uuid4())
                all_block_ids.append(block_id)

                # Assign to a document (round-robin)
                doc_idx = global_idx % len(doc_ids)
                doc_id = doc_id_arr[doc_idx]

                content = _fake_content(rng, word_count=rng.integers(20, 80))
                content_hash = hashlib.sha256(content.encode()).hexdigest()
                block_type = rng.choice(_BLOCK_TYPES, p=_BLOCK_TYPE_WEIGHTS)
                level = int(rng.integers(1, 4)) if block_type == "heading" else None
                embedding = _random_embedding(rng, embedding_dim)
                meta = json.dumps({"word_count": len(content.split()), "synthetic": True})

                block_rows.append(
                    (
                        block_id,
                        doc_id,
                        content,
                        content_hash,
                        block_type,
                        level,
                        global_idx,          # line_start
                        global_idx + 1,      # line_end
                        embedding,
                        meta,
                    )
                )

            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO blocks
                    (id, doc_id, content, content_hash, block_type, level,
                     line_start, line_end, embedding, meta)
                VALUES %s
                ON CONFLICT DO NOTHING
                """,
                block_rows,
                template=(
                    "(%s, %s, %s, %s, %s, %s, %s, %s, %s::vector, %s::jsonb)"
                ),
            )
            conn.commit()

        # ------------------------------------------------------------------
        # 4. Insert version_blocks junction rows in batches
        # ------------------------------------------------------------------
        vb_rows_buffer = []
        for global_idx, block_id in enumerate(all_block_ids):
            doc_idx = global_idx % len(doc_ids)
            ver_id = ver_id_arr[doc_idx]
            seq = global_idx // len(doc_ids)
            vb_rows_buffer.append((ver_id, block_id, seq))

            if len(vb_rows_buffer) >= batch_size:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO version_blocks (version_id, block_id, seq)
                    VALUES %s
                    ON CONFLICT DO NOTHING
                    """,
                    vb_rows_buffer,
                )
                conn.commit()
                vb_rows_buffer = []

        if vb_rows_buffer:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO version_blocks (version_id, block_id, seq)
                VALUES %s
                ON CONFLICT DO NOTHING
                """,
                vb_rows_buffer,
            )
            conn.commit()

        # ------------------------------------------------------------------
        # 5. Generate links  (~10 per block on average)
        # ------------------------------------------------------------------
        n_links_target = n_blocks * _LINKS_PER_BLOCK_MEAN
        link_rows_buffer: list[tuple] = []
        n_links_inserted = 0

        block_id_arr = np.array(all_block_ids)
        n_b = len(block_id_arr)
        now_str = "2026-05-01T00:00:00Z"

        for _ in range(n_links_target):
            src_idx = rng.integers(0, n_b)
            dst_idx = rng.integers(0, n_b)
            if src_idx == dst_idx:
                dst_idx = (dst_idx + 1) % n_b

            layer = rng.choice(_LINK_LAYERS, p=_LINK_LAYER_WEIGHTS)
            rel_type = rng.choice(_REL_TYPES, p=_REL_TYPE_WEIGHTS)
            weight = float(rng.uniform(0.3, 1.0))
            confidence = float(rng.uniform(0.5, 1.0))
            provenance = json.dumps(
                {
                    "layer": layer,
                    "model": "synthetic",
                    "confidence": round(confidence, 3),
                    "created_at": now_str,
                }
            )

            link_rows_buffer.append(
                (
                    str(uuid.uuid4()),
                    block_id_arr[src_idx],
                    block_id_arr[dst_idx],
                    layer,
                    rel_type,
                    weight,
                    provenance,
                )
            )

            if len(link_rows_buffer) >= batch_size:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO links
                        (id, src, dst, layer, rel_type, weight, provenance)
                    VALUES %s
                    ON CONFLICT DO NOTHING
                    """,
                    link_rows_buffer,
                    template="(%s, %s, %s, %s, %s, %s, %s::jsonb)",
                )
                conn.commit()
                n_links_inserted += len(link_rows_buffer)
                link_rows_buffer = []

        if link_rows_buffer:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO links
                    (id, src, dst, layer, rel_type, weight, provenance)
                VALUES %s
                ON CONFLICT DO NOTHING
                """,
                link_rows_buffer,
                template="(%s, %s, %s, %s, %s, %s, %s::jsonb)",
            )
            conn.commit()
            n_links_inserted += len(link_rows_buffer)

        # ------------------------------------------------------------------
        # 6. Measure actual Postgres table sizes
        # ------------------------------------------------------------------
        cur.execute(
            """
            SELECT
                pg_total_relation_size('blocks') AS blocks_total,
                pg_total_relation_size('links')  AS links_total,
                pg_total_relation_size('documents') AS docs_total,
                pg_total_relation_size('document_versions') AS versions_total,
                pg_total_relation_size('version_blocks') AS vb_total
            """
        )
        row = cur.fetchone()
        storage_bytes = sum(r for r in row if r is not None)

        # Embedding storage: n_blocks × dim × 4 bytes (float32)
        # This is the theoretical size; pg_column_size overhead is minimal.
        embedding_storage_bytes = n_blocks * embedding_dim * 4

    ingest_time = time.perf_counter() - t0

    return {
        "n_blocks": n_blocks,
        "n_documents": n_docs,
        "n_links": n_links_inserted,
        "embedding_dim": embedding_dim,
        "storage_bytes": storage_bytes,
        "embedding_storage_bytes": embedding_storage_bytes,
        "ingest_time_seconds": round(ingest_time, 3),
    }
