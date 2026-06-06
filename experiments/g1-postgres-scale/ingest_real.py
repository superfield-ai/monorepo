"""
ingest_real.py — G1 corpus ingestion with REAL all-MiniLM-L6-v2 embeddings.

The original ``ingest.py`` ingests random Gaussian unit vectors which gives a
honest latency signal but a meaningless recall@10 number (cf. the H1.1 caveat
written in PR #81). This module is the H1.1 acceptance-criterion surface: it
generates plausible English text per block, embeds it with
``sentence-transformers/all-MiniLM-L6-v2`` (384-dim, the same dim the Nexum
schema uses), and ingests the result into the same Nexum schema. The link
graph generation is identical to ``ingest.py`` so latency is comparable.

Public API
----------
``generate_and_ingest_real(conn, n_blocks, ...)`` — drop-in replacement for
``ingest.generate_and_ingest`` that returns the same stats dict shape plus
``embedding_model`` so callers can record provenance.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from typing import Any, Iterator

import numpy as np
import psycopg2.extras

# Reuse domain mix and link constants from the random-Gaussian path so the two
# benchmarks are comparable on every axis except embedding semantics.
from ingest import (
    DOMAIN_MIXES,
    _BLOCK_TYPES,
    _BLOCK_TYPE_WEIGHTS,
    _LINK_LAYERS,
    _LINK_LAYER_WEIGHTS,
    _REL_TYPES,
    _REL_TYPE_WEIGHTS,
    _LINKS_PER_BLOCK_MEAN,
)

DEFAULT_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_EMBEDDING_DIM = 384  # all-MiniLM-L6-v2 native dim


# ---------------------------------------------------------------------------
# Synthetic but semantically-structured sentence generation
# ---------------------------------------------------------------------------
#
# To exercise HNSW recall meaningfully we need text whose embeddings cluster
# in non-degenerate ways — i.e. some queries should have far closer top-10
# neighbours than the random baseline. A pure bag-of-words generator yields
# embeddings that are all near the origin of the model's manifold (very high
# pairwise cosine similarity, essentially noise from the model's perspective).
#
# Strategy: generate per-block content from a small set of topic templates.
# Each block draws a topic; topic templates supply a domain phrase plus a few
# random fillers. Embeddings then cluster by topic, giving HNSW a real signal
# to recover.

_TOPICS: list[dict[str, list[str]]] = [
    {
        "name": ["contract"],
        "phrases": [
            "The parties hereby agree to the following terms and conditions of this binding agreement.",
            "Either party may terminate this agreement upon thirty days written notice to the other party.",
            "The contractor shall deliver all services in accordance with the schedule attached as Exhibit A.",
            "Payment terms are net thirty days from receipt of a properly submitted invoice.",
            "All disputes arising under this contract shall be resolved through binding arbitration.",
        ],
    },
    {
        "name": ["statute"],
        "phrases": [
            "No person shall be deprived of life, liberty, or property without due process of law.",
            "Any violation of this section shall constitute a misdemeanor punishable by fine or imprisonment.",
            "The provisions of this chapter shall apply to all transactions completed after the effective date.",
            "The court may, in its discretion, award reasonable attorney fees to the prevailing party.",
            "This statute supersedes all prior conflicting state regulations on the same subject matter.",
        ],
    },
    {
        "name": ["medical"],
        "phrases": [
            "The patient presents with persistent chest pain radiating to the left arm and jaw.",
            "Initial examination revealed elevated blood pressure and an irregular heart rhythm.",
            "Recommended treatment includes daily aspirin therapy and lifestyle modifications.",
            "Follow up echocardiogram is scheduled in two weeks to evaluate cardiac function.",
            "The patient denies any history of diabetes, smoking, or significant family cardiac disease.",
        ],
    },
    {
        "name": ["research"],
        "phrases": [
            "The study examined the relationship between sleep duration and cognitive performance in adults.",
            "Participants were randomly assigned to either the treatment group or the control group.",
            "Statistical analysis used a mixed-effects model controlling for age, sex, and baseline score.",
            "Results showed a statistically significant improvement in the treatment group at six weeks.",
            "Limitations include the relatively small sample size and the single-site recruitment design.",
        ],
    },
    {
        "name": ["finance"],
        "phrases": [
            "Quarterly revenue increased twelve percent year over year, driven by enterprise subscription growth.",
            "Operating expenses grew slower than revenue, expanding the operating margin by two hundred basis points.",
            "The company repurchased shares totaling approximately one hundred million dollars during the quarter.",
            "Free cash flow conversion remained strong at over ninety percent of net income.",
            "Management reaffirmed full year guidance for revenue, operating margin, and earnings per share.",
        ],
    },
    {
        "name": ["software"],
        "phrases": [
            "The new release adds support for streaming responses and reduces median latency by forty percent.",
            "Users can now configure rate limits per API key from the dashboard or via the management API.",
            "The deprecated v1 endpoint will be removed in the next major release scheduled for Q3.",
            "Known issue: cancelling a long running request may leave the cursor open for up to thirty seconds.",
            "The migration guide describes how to update existing client code to the new authentication flow.",
        ],
    },
    {
        "name": ["news"],
        "phrases": [
            "Officials announced today that the proposed infrastructure bill has cleared its final committee vote.",
            "Markets opened sharply lower after the central bank signalled a more hawkish monetary stance.",
            "Severe weather caused widespread power outages across three counties in the northern region.",
            "Negotiators reported substantial progress in the ongoing trade talks but no final agreement.",
            "The mayor announced a new initiative to expand public transit service into underserved neighborhoods.",
        ],
    },
    {
        "name": ["recipe"],
        "phrases": [
            "Combine the flour, sugar, baking powder, and salt in a large mixing bowl and whisk to combine.",
            "Heat the olive oil in a heavy bottomed skillet over medium heat until shimmering but not smoking.",
            "Simmer the sauce uncovered for about twenty minutes, stirring occasionally, until it thickens.",
            "Transfer the dough to a lightly floured surface and knead for about ten minutes until smooth.",
            "Bake at three hundred and fifty degrees for thirty to thirty five minutes until golden brown.",
        ],
    },
]


def _generate_block_text(rng: np.random.Generator, topic_idx: int) -> str:
    """Pick a phrase from the chosen topic and add light per-block variation."""
    topic = _TOPICS[topic_idx]
    base = rng.choice(topic["phrases"])
    # Small per-block variation: append 1-3 generic filler words so two blocks
    # in the same topic are not byte-identical (otherwise dedup would collapse
    # them and recall is trivially 1.0).
    fillers = ["Section", "Item", "Note", "Reference", "Detail", "Paragraph",
               "Clause", "Schedule", "Annex", "Appendix"]
    suffix_words = rng.choice(fillers, size=int(rng.integers(1, 4)),
                              replace=True)
    suffix_num = int(rng.integers(1, 100000))
    return f"{base} {' '.join(suffix_words)} {suffix_num}."


def _iter_block_text(
    rng: np.random.Generator, n_blocks: int
) -> Iterator[tuple[int, str]]:
    """Yield (topic_idx, content) pairs for *n_blocks* blocks."""
    for _ in range(n_blocks):
        topic_idx = int(rng.integers(0, len(_TOPICS)))
        yield topic_idx, _generate_block_text(rng, topic_idx)


# ---------------------------------------------------------------------------
# Embedding model loader (cached at module level for repeated calls in tests)
# ---------------------------------------------------------------------------

_MODEL_CACHE: dict[str, Any] = {}


def _load_model(model_name: str):
    """Load an all-MiniLM-L6-v2 (or compatible) sentence-transformer."""
    if model_name in _MODEL_CACHE:
        return _MODEL_CACHE[model_name]
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "sentence-transformers is required for ingest_real. "
            "Install with: pip install sentence-transformers"
        ) from exc
    model = SentenceTransformer(model_name)
    _MODEL_CACHE[model_name] = model
    return model


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def generate_and_ingest_real(
    conn,
    n_blocks: int,
    domain_mix: dict[str, float],
    embedding_dim: int = DEFAULT_EMBEDDING_DIM,
    seed: int = 42,
    batch_size: int = 1000,
    embed_batch_size: int = 256,
    model_name: str = DEFAULT_MODEL_NAME,
    progress: bool = True,
) -> dict[str, Any]:
    """Ingest *n_blocks* blocks with real ``all-MiniLM-L6-v2`` embeddings.

    Returns a stats dict matching ``ingest.generate_and_ingest`` plus
    ``embedding_model`` and ``embed_seconds``.
    """
    if embedding_dim != DEFAULT_EMBEDDING_DIM:
        raise ValueError(
            f"all-MiniLM-L6-v2 produces 384-dim vectors; embedding_dim must "
            f"equal 384 (got {embedding_dim}). Override the model_name to "
            f"use a different dimensionality."
        )

    rng = np.random.default_rng(seed)
    t0_total = time.perf_counter()

    formats = list(domain_mix.keys())
    format_probs = np.array([domain_mix[f] for f in formats], dtype=float)
    format_probs /= format_probs.sum()

    # ------------------------------------------------------------------
    # 1. Documents (one per ~500 blocks)
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
                (doc_id, f"Synthetic Document {doc_id[:8]}", src_fmt,
                 json.dumps({"synthetic": True, "real_embeddings": True}))
            )
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO documents (id, title, source_format, meta) VALUES %s "
            "ON CONFLICT DO NOTHING",
            doc_rows,
            template="(%s, %s, %s, %s::jsonb)",
        )

        # Versions
        ver_rows = []
        ver_ids: list[str] = []
        for doc_id in doc_ids:
            ver_id = str(uuid.uuid4())
            ver_ids.append(ver_id)
            ver_rows.append((ver_id, doc_id, 1, "v1", "done"))
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO document_versions (id, doc_id, version_num, label, status) "
            "VALUES %s ON CONFLICT DO NOTHING",
            ver_rows,
        )
        conn.commit()

        # ------------------------------------------------------------------
        # 2. Pre-generate ALL block text and topic_idx (cheap, ~50 MB at 1M).
        # ------------------------------------------------------------------
        if progress:
            print(f"[real-ingest] Generating {n_blocks:,} block texts …",
                  flush=True)
        all_topics = np.empty(n_blocks, dtype=np.int32)
        all_text: list[str] = [""] * n_blocks
        for i, (topic_idx, content) in enumerate(_iter_block_text(rng, n_blocks)):
            all_topics[i] = topic_idx
            all_text[i] = content

        # ------------------------------------------------------------------
        # 3. Embed in batches with all-MiniLM-L6-v2
        # ------------------------------------------------------------------
        if progress:
            print(f"[real-ingest] Loading model {model_name} …", flush=True)
        model = _load_model(model_name)

        if progress:
            print(f"[real-ingest] Embedding {n_blocks:,} texts "
                  f"(batch={embed_batch_size}) …", flush=True)
        t0_embed = time.perf_counter()
        all_embeddings = model.encode(
            all_text,
            batch_size=embed_batch_size,
            show_progress_bar=progress,
            convert_to_numpy=True,
            normalize_embeddings=True,
        ).astype(np.float32)
        embed_seconds = time.perf_counter() - t0_embed
        if progress:
            print(f"[real-ingest] Embedded in {embed_seconds:.1f}s "
                  f"({n_blocks / embed_seconds:.0f} sent/s)", flush=True)

        # ------------------------------------------------------------------
        # 4. Insert blocks in batches
        # ------------------------------------------------------------------
        if progress:
            print(f"[real-ingest] Inserting {n_blocks:,} blocks …", flush=True)
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
                doc_idx = global_idx % len(doc_ids)
                doc_id = doc_id_arr[doc_idx]
                content = all_text[global_idx]
                content_hash = hashlib.sha256(content.encode()).hexdigest()
                block_type = rng.choice(_BLOCK_TYPES, p=_BLOCK_TYPE_WEIGHTS)
                level = (int(rng.integers(1, 4))
                         if block_type == "heading" else None)
                embedding = all_embeddings[global_idx].tolist()
                meta = json.dumps({
                    "topic_idx": int(all_topics[global_idx]),
                    "topic_name": _TOPICS[int(all_topics[global_idx])]["name"][0],
                    "real_embeddings": True,
                })
                block_rows.append(
                    (block_id, doc_id, content, content_hash, block_type,
                     level, global_idx, global_idx + 1, embedding, meta)
                )
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO blocks "
                "(id, doc_id, content, content_hash, block_type, level, "
                "line_start, line_end, embedding, meta) VALUES %s "
                "ON CONFLICT DO NOTHING",
                block_rows,
                template=("(%s, %s, %s, %s, %s, %s, %s, %s, "
                          "%s::vector, %s::jsonb)"),
            )
            conn.commit()

        # ------------------------------------------------------------------
        # 5. version_blocks
        # ------------------------------------------------------------------
        vb_buf: list[tuple] = []
        for global_idx, block_id in enumerate(all_block_ids):
            doc_idx = global_idx % len(doc_ids)
            ver_id = ver_id_arr[doc_idx]
            seq = global_idx // len(doc_ids)
            vb_buf.append((ver_id, block_id, seq))
            if len(vb_buf) >= batch_size:
                psycopg2.extras.execute_values(
                    cur,
                    "INSERT INTO version_blocks (version_id, block_id, seq) "
                    "VALUES %s ON CONFLICT DO NOTHING",
                    vb_buf,
                )
                conn.commit()
                vb_buf = []
        if vb_buf:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO version_blocks (version_id, block_id, seq) "
                "VALUES %s ON CONFLICT DO NOTHING",
                vb_buf,
            )
            conn.commit()

        # ------------------------------------------------------------------
        # 6. Links (~10 per block on average) — same shape as ingest.py
        # ------------------------------------------------------------------
        if progress:
            print(f"[real-ingest] Inserting "
                  f"~{n_blocks * _LINKS_PER_BLOCK_MEAN:,} links …", flush=True)
        n_links_target = n_blocks * _LINKS_PER_BLOCK_MEAN
        block_id_arr = np.array(all_block_ids)
        n_b = len(block_id_arr)
        now_str = "2026-05-09T00:00:00Z"
        link_buf: list[tuple] = []
        n_links_inserted = 0
        for _ in range(n_links_target):
            src_idx = rng.integers(0, n_b)
            dst_idx = rng.integers(0, n_b)
            if src_idx == dst_idx:
                dst_idx = (dst_idx + 1) % n_b
            layer = rng.choice(_LINK_LAYERS, p=_LINK_LAYER_WEIGHTS)
            rel_type = rng.choice(_REL_TYPES, p=_REL_TYPE_WEIGHTS)
            weight = float(rng.uniform(0.3, 1.0))
            confidence = float(rng.uniform(0.5, 1.0))
            provenance = json.dumps({
                "layer": layer,
                "model": "synthetic",
                "confidence": round(confidence, 3),
                "created_at": now_str,
            })
            link_buf.append(
                (str(uuid.uuid4()), block_id_arr[src_idx],
                 block_id_arr[dst_idx], layer, rel_type, weight, provenance)
            )
            if len(link_buf) >= batch_size:
                psycopg2.extras.execute_values(
                    cur,
                    "INSERT INTO links "
                    "(id, src, dst, layer, rel_type, weight, provenance) "
                    "VALUES %s ON CONFLICT DO NOTHING",
                    link_buf,
                    template="(%s, %s, %s, %s, %s, %s, %s::jsonb)",
                )
                conn.commit()
                n_links_inserted += len(link_buf)
                link_buf = []
        if link_buf:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO links "
                "(id, src, dst, layer, rel_type, weight, provenance) "
                "VALUES %s ON CONFLICT DO NOTHING",
                link_buf,
                template="(%s, %s, %s, %s, %s, %s, %s::jsonb)",
            )
            conn.commit()
            n_links_inserted += len(link_buf)

        # ------------------------------------------------------------------
        # 7. Storage measurement
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
        embedding_storage_bytes = n_blocks * embedding_dim * 4

    ingest_time = time.perf_counter() - t0_total
    return {
        "n_blocks": n_blocks,
        "n_documents": n_docs,
        "n_links": n_links_inserted,
        "embedding_dim": embedding_dim,
        "embedding_model": model_name,
        "embed_seconds": round(embed_seconds, 3),
        "storage_bytes": storage_bytes,
        "embedding_storage_bytes": embedding_storage_bytes,
        "ingest_time_seconds": round(ingest_time, 3),
    }
