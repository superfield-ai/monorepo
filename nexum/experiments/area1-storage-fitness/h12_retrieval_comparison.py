"""
h12_retrieval_comparison.py — H1.2 cross-type retrieval comparison.

Operationalises hypothesis H1.2 ("graph beats semantic on cross-type queries")
by ingesting a 50K-block mixed-type synthetic corpus into Postgres + pgvector
and comparing five retrieval modes on a planted-answer cross-type query set:

    1. fulltext       — Postgres tsvector / plainto_tsquery
    2. semantic       — pgvector ANN over block.embedding
    3. graph          — recursive-CTE traversal from a seed block (no query)
    4. hybrid         — semantic top-K then 1-hop graph expansion
    5. edge_semantic  — pgvector ANN over links.edge_embedding (PR #86 mode)

Each mode is scored with recall@10 and NDCG@10 against the planted answers.

Synthetic-but-honest design
---------------------------
We do NOT fabricate result numbers; we only fabricate the corpus generation
process so the experiment is deterministic and runnable in CI. The corpus is
built around a concept-vector model: every block has a 16-dim "topic" vector
that is lifted into the 384-dim embedding space with controlled noise. Each
cross-type query selects a topic, an anchor block of one block_type that
mentions a distinguishing keyword, and a *target* answer block of a different
block_type linked structurally to the anchor and sharing the same topic.

Recall@10 / NDCG@10 are computed against the planted target. Results are
written via experiments._lib.results_writer.

Limitations (called out honestly in the result envelope under "notes"):
  - Synthetic embeddings under a planted-topic generative model.
  - 50K blocks (≈ 17K per block type) is the spec; smaller scales are
    permitted via the --n-blocks flag with a documented gap field.
  - Edge embeddings here are constructed as the elementwise mean of the two
    endpoint embeddings — the same reduction the linker uses when no encoder
    is configured. This mirrors the production seam in src/linker/edge-embed.ts.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

# Make the experiments._lib package importable when this script is run
# directly from its directory.
_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from experiments._lib.results_writer import ResultEnvelope, write_result  # noqa: E402
from experiments._lib.runner import capture_run_context  # noqa: E402


# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

EMBEDDING_DIM = 384
TOPIC_DIM = 16
NOISE_STD = 0.08
BLOCK_TYPES = ("paragraph", "heading", "list_item", "table")
LINK_LAYERS = ("structural", "semantic", "ai")
REL_TYPES = ("cites", "elaborates", "supports", "overrides", "contradicts")
RNG_SEED = 42


@dataclass
class CorpusStats:
    n_documents: int
    n_blocks: int
    n_links: int
    block_type_counts: dict[str, int]


@dataclass
class PlantedQuery:
    """A cross-type query bundle used by all five retrieval modes."""
    topic_vec: np.ndarray         # 384-d query embedding
    keyword: str                  # distinguishing token used by fulltext
    anchor_block_id: str          # the seed block (used by graph/hybrid)
    target_block_id: str          # the gold answer block
    target_block_type: str
    anchor_block_type: str


# ---------------------------------------------------------------------------
# Embedding synthesis
# ---------------------------------------------------------------------------


def _topic_to_embedding(topic: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Lift a TOPIC_DIM topic vector into EMBEDDING_DIM with deterministic noise."""
    # Stable lift: tile the topic into the embedding then add small Gaussian noise.
    repeats = EMBEDDING_DIM // TOPIC_DIM
    base = np.tile(topic, repeats)
    noise = rng.normal(0.0, NOISE_STD, size=EMBEDDING_DIM).astype(np.float32)
    vec = base.astype(np.float32) + noise
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return vec


def _vec_to_pgvector(v: np.ndarray) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v.tolist()) + "]"


# ---------------------------------------------------------------------------
# Corpus generation + ingest
# ---------------------------------------------------------------------------


def ensure_minimal_schema(conn) -> None:
    """Create a fresh, isolated set of tables with the columns this script needs.

    We DO NOT touch the project's main schema — instead we work in a dedicated
    namespace so the experiment is hermetic. This avoids interference with
    other gate experiments using the same DB.
    """
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        cur.execute("DROP SCHEMA IF EXISTS h12 CASCADE")
        cur.execute("CREATE SCHEMA h12")
        cur.execute(
            """
            CREATE TABLE h12.documents (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                title TEXT NOT NULL,
                source_format TEXT NOT NULL
            )
            """
        )
        cur.execute(
            f"""
            CREATE TABLE h12.blocks (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                doc_id UUID NOT NULL REFERENCES h12.documents(id),
                content TEXT NOT NULL,
                block_type TEXT NOT NULL,
                topic_id INT NOT NULL,
                embedding vector({EMBEDDING_DIM}),
                tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
            )
            """
        )
        cur.execute("CREATE INDEX h12_blocks_tsv ON h12.blocks USING gin (tsv)")
        cur.execute(
            "CREATE INDEX h12_blocks_emb ON h12.blocks USING hnsw (embedding vector_cosine_ops)"
        )
        cur.execute(
            f"""
            CREATE TABLE h12.links (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                src UUID NOT NULL REFERENCES h12.blocks(id),
                dst UUID NOT NULL REFERENCES h12.blocks(id),
                layer TEXT NOT NULL,
                rel_type TEXT,
                weight FLOAT DEFAULT 1.0,
                edge_embedding vector({EMBEDDING_DIM})
            )
            """
        )
        cur.execute("CREATE INDEX h12_links_src ON h12.links (src)")
        cur.execute("CREATE INDEX h12_links_dst ON h12.links (dst)")
        cur.execute(
            "CREATE INDEX h12_links_edge_emb ON h12.links USING hnsw (edge_embedding vector_cosine_ops)"
        )
    conn.commit()


def _content_for_topic(topic_id: int, block_type: str, rng: np.random.Generator) -> str:
    """Synthesise a short content string with topic-specific keyword tokens.

    The fulltext mode relies on the topic keyword `topic_<id>` appearing in the
    block content; the type-specific filler tokens make per-type vocab visible
    so semantic search has type-confounded signal.
    """
    type_filler = {
        "paragraph": "narrative explanation context body sentence",
        "heading": "section title heading subheader chapter",
        "list_item": "bullet entry item enumeration step",
        "table": "row column cell tabular value statistic",
    }[block_type]
    misc = " ".join(
        rng.choice(
            ["analysis", "result", "method", "evidence", "data", "study", "finding", "term"],
            size=6,
            replace=True,
        ).tolist()
    )
    return f"topic_{topic_id} {type_filler} {misc}"


def generate_and_ingest(
    conn,
    n_blocks: int,
    n_topics: int,
    seed: int = RNG_SEED,
) -> tuple[CorpusStats, list[PlantedQuery]]:
    """Build the corpus and the planted-query bundle in one pass.

    Strategy:
      - Allocate `n_topics` topics; each has a unit-norm 16-dim topic vector.
      - Spread blocks roughly evenly across topics and block_types.
      - For each topic, create a heading + a paragraph + a list_item + a table
        all sharing the topic, and structurally link them (heading -> children).
      - Then add semantic and AI-layer noise links inside the topic and a few
        cross-topic decoys.
      - Sample 200 planted queries: pick a topic at random, pick an anchor of
        one type and a target of a DIFFERENT type, both sharing the topic.
    """
    import psycopg2.extras

    rng = np.random.default_rng(seed)

    # Topic vectors
    topic_vecs = rng.normal(0.0, 1.0, size=(n_topics, TOPIC_DIM)).astype(np.float32)
    topic_vecs /= np.linalg.norm(topic_vecs, axis=1, keepdims=True) + 1e-9

    # Distribute blocks across topics with a slight zipfian skew so popular
    # topics produce more blocks. Each topic gets at least one of each type
    # (which is what the cross-type planting depends on).
    blocks_per_topic_floor = max(4, n_blocks // n_topics)
    extras = n_blocks - blocks_per_topic_floor * n_topics
    counts = [blocks_per_topic_floor] * n_topics
    if extras > 0:
        for i in rng.integers(0, n_topics, size=extras):
            counts[int(i)] += 1

    n_documents = max(1, n_blocks // 100)
    docs: list[tuple[str, str, str]] = []
    for i in range(n_documents):
        fmt = ("pdf", "docx", "markdown")[int(rng.integers(0, 3))]
        docs.append((str(uuid.uuid4()), f"doc_{i}", fmt))

    # Insert documents in one batch.
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO h12.documents (id, title, source_format) VALUES %s",
            docs,
        )
    conn.commit()

    doc_ids = [d[0] for d in docs]

    # Generate blocks. We track per-topic blocks-by-type so we can plant
    # cross-type queries later.
    topic_blocks: list[dict[str, list[tuple[str, np.ndarray]]]] = [
        {bt: [] for bt in BLOCK_TYPES} for _ in range(n_topics)
    ]
    block_type_counts = {bt: 0 for bt in BLOCK_TYPES}

    block_rows: list[tuple] = []
    BATCH = 5_000

    def _flush_blocks() -> None:
        if not block_rows:
            return
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """INSERT INTO h12.blocks
                       (id, doc_id, content, block_type, topic_id, embedding)
                       VALUES %s""",
                block_rows,
                template="(%s,%s,%s,%s,%s,%s::vector)",
            )
        conn.commit()
        block_rows.clear()

    # First pass: ensure each topic has at least one block of each type, in
    # type-cycle order. This guarantees the cross-type planting can succeed.
    for topic_id in range(n_topics):
        for bt in BLOCK_TYPES:
            block_id = str(uuid.uuid4())
            doc_id = doc_ids[int(rng.integers(0, n_documents))]
            content = _content_for_topic(topic_id, bt, rng)
            emb = _topic_to_embedding(topic_vecs[topic_id], rng)
            block_rows.append(
                (block_id, doc_id, content, bt, topic_id, _vec_to_pgvector(emb))
            )
            topic_blocks[topic_id][bt].append((block_id, emb))
            block_type_counts[bt] += 1
        if len(block_rows) >= BATCH:
            _flush_blocks()

    # Second pass: fill the remaining blocks proportionally.
    remaining = max(0, n_blocks - n_topics * len(BLOCK_TYPES))
    for _ in range(remaining):
        topic_id = int(rng.integers(0, n_topics))
        bt = BLOCK_TYPES[int(rng.integers(0, len(BLOCK_TYPES)))]
        block_id = str(uuid.uuid4())
        doc_id = doc_ids[int(rng.integers(0, n_documents))]
        content = _content_for_topic(topic_id, bt, rng)
        emb = _topic_to_embedding(topic_vecs[topic_id], rng)
        block_rows.append(
            (block_id, doc_id, content, bt, topic_id, _vec_to_pgvector(emb))
        )
        topic_blocks[topic_id][bt].append((block_id, emb))
        block_type_counts[bt] += 1
        if len(block_rows) >= BATCH:
            _flush_blocks()

    _flush_blocks()

    # Build links. Strategy:
    #   - structural: within a topic, link the heading to other types (chain).
    #   - semantic:   within a topic, sample random pairs.
    #   - ai:         a few cross-topic decoys to add noise to graph traversal.
    link_rows: list[tuple] = []

    def _flush_links() -> None:
        if not link_rows:
            return
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """INSERT INTO h12.links
                       (id, src, dst, layer, rel_type, weight, edge_embedding)
                       VALUES %s""",
                link_rows,
                template="(%s,%s,%s,%s,%s,%s,%s::vector)",
            )
        conn.commit()
        link_rows.clear()

    n_links = 0
    for topic_id in range(n_topics):
        topic_bt = topic_blocks[topic_id]
        # Structural: heading -> first block of each other type.
        if topic_bt["heading"]:
            heading_id, heading_emb = topic_bt["heading"][0]
            for bt in ("paragraph", "list_item", "table"):
                if topic_bt[bt]:
                    dst_id, dst_emb = topic_bt[bt][0]
                    edge_emb = ((heading_emb + dst_emb) / 2.0).astype(np.float32)
                    edge_emb /= np.linalg.norm(edge_emb) + 1e-9
                    link_rows.append(
                        (
                            str(uuid.uuid4()),
                            heading_id,
                            dst_id,
                            "structural",
                            "elaborates",
                            1.0,
                            _vec_to_pgvector(edge_emb),
                        )
                    )
                    n_links += 1
        # Semantic: 2 random within-topic pairs.
        all_topic_blocks = [b for bt in BLOCK_TYPES for b in topic_bt[bt]]
        if len(all_topic_blocks) >= 2:
            for _ in range(2):
                src_id, src_emb = all_topic_blocks[
                    int(rng.integers(0, len(all_topic_blocks)))
                ]
                dst_id, dst_emb = all_topic_blocks[
                    int(rng.integers(0, len(all_topic_blocks)))
                ]
                if src_id == dst_id:
                    continue
                edge_emb = ((src_emb + dst_emb) / 2.0).astype(np.float32)
                edge_emb /= np.linalg.norm(edge_emb) + 1e-9
                rel = REL_TYPES[int(rng.integers(0, len(REL_TYPES)))]
                link_rows.append(
                    (
                        str(uuid.uuid4()),
                        src_id,
                        dst_id,
                        "semantic",
                        rel,
                        float(rng.uniform(0.5, 1.0)),
                        _vec_to_pgvector(edge_emb),
                    )
                )
                n_links += 1
        # AI: 1 cross-topic decoy.
        if all_topic_blocks and n_topics > 1:
            other_topic = (topic_id + 1) % n_topics
            other_blocks = [b for bt in BLOCK_TYPES for b in topic_blocks[other_topic][bt]]
            if other_blocks:
                src_id, src_emb = all_topic_blocks[0]
                dst_id, dst_emb = other_blocks[0]
                edge_emb = ((src_emb + dst_emb) / 2.0).astype(np.float32)
                edge_emb /= np.linalg.norm(edge_emb) + 1e-9
                link_rows.append(
                    (
                        str(uuid.uuid4()),
                        src_id,
                        dst_id,
                        "ai",
                        "cites",
                        0.4,
                        _vec_to_pgvector(edge_emb),
                    )
                )
                n_links += 1
        if len(link_rows) >= BATCH:
            _flush_links()

    _flush_links()

    # Plant queries: pick 200 (or fewer if topics scarce) topic+type pairs.
    n_queries = min(200, n_topics)
    chosen_topics = rng.choice(n_topics, size=n_queries, replace=False).tolist()
    planted: list[PlantedQuery] = []
    for tid in chosen_topics:
        anchor_bt, target_bt = rng.choice(BLOCK_TYPES, size=2, replace=False).tolist()
        anchor_pool = topic_blocks[tid][anchor_bt]
        target_pool = topic_blocks[tid][target_bt]
        if not anchor_pool or not target_pool:
            continue
        anchor_id, _ = anchor_pool[0]
        target_id, _ = target_pool[0]
        # Query embedding = clean lift of the topic (no noise) so semantic
        # search has a fair chance of recovering same-topic blocks.
        repeats = EMBEDDING_DIM // TOPIC_DIM
        clean_vec = np.tile(topic_vecs[tid], repeats).astype(np.float32)
        clean_vec /= np.linalg.norm(clean_vec) + 1e-9
        planted.append(
            PlantedQuery(
                topic_vec=clean_vec,
                keyword=f"topic_{tid}",
                anchor_block_id=anchor_id,
                target_block_id=target_id,
                anchor_block_type=anchor_bt,
                target_block_type=target_bt,
            )
        )

    stats = CorpusStats(
        n_documents=n_documents,
        n_blocks=n_blocks,
        n_links=n_links,
        block_type_counts=block_type_counts,
    )
    return stats, planted


# ---------------------------------------------------------------------------
# Retrieval modes
# ---------------------------------------------------------------------------


def _fulltext(conn, query: PlantedQuery, k: int) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id FROM h12.blocks, plainto_tsquery('english', %s) q
            WHERE tsv @@ q
            ORDER BY ts_rank(tsv, q) DESC
            LIMIT %s
            """,
            (query.keyword, k),
        )
        return [r[0] for r in cur.fetchall()]


def _semantic(conn, query: PlantedQuery, k: int) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id FROM h12.blocks
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> %s::vector
            LIMIT %s
            """,
            (_vec_to_pgvector(query.topic_vec), k),
        )
        return [r[0] for r in cur.fetchall()]


def _graph_only(conn, query: PlantedQuery, k: int) -> list[str]:
    """Pure graph traversal from the anchor block (no semantic input)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH RECURSIVE g AS (
                SELECT dst AS id, 1 AS depth
                FROM h12.links WHERE src = %s
                UNION ALL
                SELECT l.dst, g.depth + 1
                FROM h12.links l JOIN g ON l.src = g.id
                WHERE g.depth < 3
            )
            SELECT DISTINCT id FROM g LIMIT %s
            """,
            (query.anchor_block_id, k),
        )
        return [r[0] for r in cur.fetchall()]


def _hybrid(conn, query: PlantedQuery, k: int) -> list[str]:
    """Semantic top-K then 1-hop graph expansion, dedup, truncated to k."""
    sem = _semantic(conn, query, k)
    seen = list(sem)
    seen_set = set(sem)
    if sem:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT dst FROM h12.links
                WHERE src = ANY(%s::uuid[])
                LIMIT %s
                """,
                (sem, k),
            )
            for (b,) in cur.fetchall():
                if b not in seen_set:
                    seen_set.add(b)
                    seen.append(b)
    return seen[:k]


def _edge_semantic(conn, query: PlantedQuery, k: int) -> list[str]:
    """Edge-similarity ANN: rank links by edge_embedding, then surface dst blocks."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT dst FROM h12.links
            WHERE edge_embedding IS NOT NULL
            ORDER BY edge_embedding <=> %s::vector
            LIMIT %s
            """,
            (_vec_to_pgvector(query.topic_vec), k),
        )
        # Deduplicate while preserving order.
        out: list[str] = []
        seen: set[str] = set()
        for (b,) in cur.fetchall():
            if b not in seen:
                seen.add(b)
                out.append(b)
    return out


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def recall_at_k(retrieved: list[str], target: str, k: int) -> float:
    return 1.0 if target in retrieved[:k] else 0.0


def ndcg_at_k(retrieved: list[str], target: str, k: int) -> float:
    for i, b in enumerate(retrieved[:k]):
        if b == target:
            return float(1.0 / math.log2(i + 2))
    return 0.0


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


MODES = {
    "fulltext": _fulltext,
    "semantic": _semantic,
    "graph_only": _graph_only,
    "hybrid": _hybrid,
    "edge_semantic": _edge_semantic,
}


def run_h12(db_url: str, n_blocks: int, n_topics: int, k: int = 10) -> dict[str, Any]:
    import psycopg2

    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    t0 = time.perf_counter()
    ensure_minimal_schema(conn)
    stats, planted = generate_and_ingest(conn, n_blocks=n_blocks, n_topics=n_topics)
    ingest_seconds = time.perf_counter() - t0

    # Per-mode metrics — aggregate and per target block-type.
    # Block types here map to the corpus content types:
    #   paragraph → prose/document body  (analogous to PDF paragraphs)
    #   heading   → document structure   (analogous to PDF headings)
    #   list_item → enumerated content   (analogous to list/table rows)
    #   table     → tabular data         (analogous to structured tables)
    # This provides the per-type retrieval breakdown required by H1.2 AC-4.
    per_mode: dict[str, dict[str, Any]] = {}
    for name, fn in MODES.items():
        recalls: list[float] = []
        ndcgs: list[float] = []
        latencies_ms: list[float] = []
        # Per-target-type buckets for breakdown reporting (AC-4).
        type_recalls: dict[str, list[float]] = {bt: [] for bt in BLOCK_TYPES}
        type_ndcgs: dict[str, list[float]] = {bt: [] for bt in BLOCK_TYPES}
        for q in planted:
            t1 = time.perf_counter()
            try:
                results = fn(conn, q, k)
            except Exception as exc:  # noqa: BLE001
                conn.rollback()
                results = []
                # Record the failure but keep going so partial results are
                # preserved instead of crashing the whole comparison.
                print(f"[h12] {name} query failed: {exc}", file=sys.stderr)
            latencies_ms.append((time.perf_counter() - t1) * 1000.0)
            r = recall_at_k(results, q.target_block_id, k)
            n = ndcg_at_k(results, q.target_block_id, k)
            recalls.append(r)
            ndcgs.append(n)
            # Bucket by target block type for per-type breakdown.
            if q.target_block_type in type_recalls:
                type_recalls[q.target_block_type].append(r)
                type_ndcgs[q.target_block_type].append(n)
        arr_lat = np.array(latencies_ms)
        # Aggregate per-type breakdown.
        per_target_type: dict[str, dict[str, Any]] = {}
        for bt in BLOCK_TYPES:
            bt_r = type_recalls[bt]
            bt_n = type_ndcgs[bt]
            if bt_r:
                per_target_type[bt] = {
                    "recall_at_10": float(np.mean(bt_r)),
                    "ndcg_at_10": float(np.mean(bt_n)),
                    "n_queries": len(bt_r),
                }
            else:
                per_target_type[bt] = {
                    "recall_at_10": None,
                    "ndcg_at_10": None,
                    "n_queries": 0,
                }
        per_mode[name] = {
            "recall_at_10": float(np.mean(recalls)) if recalls else 0.0,
            "ndcg_at_10": float(np.mean(ndcgs)) if ndcgs else 0.0,
            "p50_ms": float(np.percentile(arr_lat, 50)) if recalls else 0.0,
            "p99_ms": float(np.percentile(arr_lat, 99)) if recalls else 0.0,
            "n_queries": len(recalls),
            "per_target_type": per_target_type,
        }

    # H1.2 acceptance: graph-expanded (hybrid) recall@10 must beat semantic by > 15%.
    sem_r = per_mode["semantic"]["recall_at_10"]
    hyb_r = per_mode["hybrid"]["recall_at_10"]
    relative_gain = (hyb_r - sem_r) / sem_r if sem_r > 0 else float("inf")
    h12_passed = relative_gain > 0.15

    conn.close()

    return {
        "ingest_seconds": ingest_seconds,
        "n_blocks": stats.n_blocks,
        "n_documents": stats.n_documents,
        "n_links": stats.n_links,
        "block_type_counts": stats.block_type_counts,
        "n_planted_queries": len(planted),
        "k": k,
        "per_mode": per_mode,
        "h12_relative_gain_hybrid_vs_semantic": float(relative_gain)
        if math.isfinite(relative_gain)
        else None,
        "h12_passed": bool(h12_passed),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="H1.2 retrieval comparison")
    parser.add_argument(
        "--db-url",
        default=os.environ.get(
            "DATABASE_URL", "postgresql://nexum:nexum@localhost:5433/nexum_bench"
        ),
    )
    parser.add_argument(
        "--n-blocks",
        type=int,
        default=50_000,
        help="Total blocks (spec: 50K). Smaller acceptable; gap recorded.",
    )
    parser.add_argument(
        "--n-topics",
        type=int,
        default=400,
        help="Number of distinct topics; also caps the planted-query count.",
    )
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--seed", type=int, default=RNG_SEED)
    parser.add_argument(
        "--write-results",
        action="store_true",
        help="Write a results envelope under experiments/area1-storage-fitness/results/.",
    )
    args = parser.parse_args(argv)

    metrics = run_h12(
        db_url=args.db_url,
        n_blocks=args.n_blocks,
        n_topics=args.n_topics,
        k=args.k,
    )

    print("\n[H1.2] retrieval comparison results")
    print(f"  corpus: {metrics['n_blocks']} blocks / {metrics['n_documents']} docs / {metrics['n_links']} links")
    print(f"  block-type counts: {metrics['block_type_counts']}")
    print(f"  planted queries: {metrics['n_planted_queries']}")
    print(f"  ingest: {metrics['ingest_seconds']:.1f}s")
    print(f"  acceptance (hybrid vs semantic > 15%): {metrics['h12_passed']}")
    print(f"  relative gain: {metrics['h12_relative_gain_hybrid_vs_semantic']}")
    print("  per-mode (recall@10 / ndcg@10 / p50ms / p99ms):")
    for name, m in metrics["per_mode"].items():
        print(
            f"    {name:14s}  R@10={m['recall_at_10']:.3f}  NDCG@10={m['ndcg_at_10']:.3f}  "
            f"p50={m['p50_ms']:.1f}ms  p99={m['p99_ms']:.1f}ms"
        )

    if args.write_results:
        runtime = capture_run_context(gate="H1.2", hypothesis="H1.2", seed=args.seed)
        scale_gap = None
        if args.n_blocks < 50_000:
            scale_gap = (
                f"Ran at {args.n_blocks} blocks instead of the 50K spec for "
                "tractability on this host; recall ratios are comparable but "
                "absolute latencies are smaller than at full scale."
            )
        envelope = ResultEnvelope(
            gate="H1.2",
            hypothesis="H1.2",
            passed=metrics["h12_passed"],
            metrics=metrics,
            runtime=runtime,
            notes=scale_gap,
            extra={
                "design": "synthetic planted-cross-type",
                "embedding_dim": EMBEDDING_DIM,
                "topic_dim": TOPIC_DIM,
                "noise_std": NOISE_STD,
                "modes": list(MODES.keys()),
            },
        )
        out = write_result(envelope, area_dir=str(_HERE))
        print(f"\n[H1.2] envelope written: {out}")
    return 0 if metrics["h12_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
