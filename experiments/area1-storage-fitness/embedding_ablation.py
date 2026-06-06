"""
embedding_ablation.py — Embedding dimension ablation for Area 1 (H1.1 / H1.3).

Embeds a 100K-block synthetic corpus using sentence-transformers
(all-MiniLM-L6-v2, 384-dim output). Simulates different dimensionalities:
  - Lower than base (256, 128): PCA via sklearn.decomposition.PCA.
  - Higher than base (512, 768, 1024, 1536): zero-pad with zeros.

Loads into pgvector, builds HNSW index, measures ANN recall@10 on 200 random
queries (ground truth via brute-force cosine similarity).

Reports the minimum dimension with < 5% recall degradation vs. 384 dims.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
# Re-use G1 ingest helpers where possible
# ---------------------------------------------------------------------------

_G1_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "g1-postgres-scale")
)
if _G1_DIR not in sys.path:
    sys.path.insert(0, _G1_DIR)

from ingest import _fake_content  # noqa: E402 — borrow text generator


# ---------------------------------------------------------------------------
# Dimensionality helpers
# ---------------------------------------------------------------------------

_BASE_MODEL_DIM = 384  # all-MiniLM-L6-v2 output dimensionality


def pca_reduce(vectors: np.ndarray, target_dim: int) -> np.ndarray:
    """Reduce *vectors* (shape N × D) to *target_dim* using sklearn PCA.

    Fits PCA on the vectors themselves and returns the projected result as
    an L2-normalised float32 array of shape (N, target_dim).

    Requires scikit-learn.

    Args:
        vectors: Float32 array of shape (N, D) where D > target_dim.
        target_dim: Desired number of components.

    Returns:
        Float32 array of shape (N, target_dim), L2-normalised.
    """
    from sklearn.decomposition import PCA  # noqa: PLC0415

    pca = PCA(n_components=target_dim, random_state=42)
    projected = pca.fit_transform(vectors).astype(np.float32)
    return _l2_normalize(projected)


def zero_pad(vectors: np.ndarray, target_dim: int) -> np.ndarray:
    """Expand *vectors* (shape N × D) to *target_dim* by zero-padding.

    Args:
        vectors: Float32 array of shape (N, D) where D < target_dim.
        target_dim: Desired output dimensionality.

    Returns:
        Float32 array of shape (N, target_dim), L2-normalised.
    """
    n, base_dim = vectors.shape
    if target_dim < base_dim:
        raise ValueError(
            f"zero_pad: target_dim={target_dim} < base_dim={base_dim}. "
            "Use pca_reduce for dimensionality reduction."
        )
    pad = np.zeros((n, target_dim - base_dim), dtype=np.float32)
    padded = np.concatenate([vectors, pad], axis=1)
    return _l2_normalize(padded)


def project_to_dim(vectors: np.ndarray, target_dim: int) -> np.ndarray:
    """Project *vectors* (shape N × base_dim) to *target_dim*.

    - target_dim < base_dim: sklearn PCA truncation.
    - target_dim == base_dim: identity (L2-normalised).
    - target_dim > base_dim: zero-pad.

    Args:
        vectors: Float32 array of shape (N, base_dim).
        target_dim: Desired output dimensionality.

    Returns:
        Float32 array of shape (N, target_dim), L2-normalised.
    """
    n, base_dim = vectors.shape

    if target_dim == base_dim:
        return _l2_normalize(vectors.copy())
    elif target_dim < base_dim:
        return pca_reduce(vectors, target_dim)
    else:
        return zero_pad(vectors, target_dim)


def _l2_normalize(vectors: np.ndarray) -> np.ndarray:
    """Return L2-normalised rows of *vectors* as float32."""
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    return (vectors / norms).astype(np.float32)


def embed_texts_local(texts: list[str]) -> np.ndarray:
    """Embed *texts* using all-MiniLM-L6-v2; return (N, 384) float32 array."""
    from sentence_transformers import SentenceTransformer  # noqa: PLC0415

    model = SentenceTransformer("all-MiniLM-L6-v2")
    embeddings = model.encode(texts, batch_size=64, show_progress_bar=False)
    return embeddings.astype(np.float32)


# ---------------------------------------------------------------------------
# Recall@k computation
# ---------------------------------------------------------------------------


def compute_recall_at_k(
    query_embeddings: np.ndarray,
    corpus_embeddings: np.ndarray,
    relevant_ids: list[list[int]],
    k: int = 10,
) -> float:
    """Compute recall@k via brute-force cosine similarity.

    Ground truth is passed in as *relevant_ids*: for each query, a list of
    corpus indices that are considered relevant.

    Args:
        query_embeddings: (n_queries, dim) float32 — assumed L2-normalised.
        corpus_embeddings: (n_corpus, dim) float32 — assumed L2-normalised.
        relevant_ids: For each query, the list of relevant corpus indices.
        k: Top-k to retrieve.

    Returns:
        Mean recall@k across all queries.
    """
    recalls: list[float] = []
    # Cosine similarity = dot product of L2-normalised vectors
    scores = query_embeddings @ corpus_embeddings.T  # (n_queries, n_corpus)

    for q_idx, rel_ids in enumerate(relevant_ids):
        if not rel_ids:
            continue
        top_k = np.argpartition(scores[q_idx], -k)[-k:]
        retrieved = set(top_k.tolist())
        relevant = set(rel_ids)
        recall = len(retrieved & relevant) / len(relevant)
        recalls.append(recall)

    return float(np.mean(recalls)) if recalls else 0.0


# ---------------------------------------------------------------------------
# Synthetic corpus builder
# ---------------------------------------------------------------------------


def _build_synthetic_dataset(
    corpus_size: int,
    n_queries: int,
    rng: np.random.Generator,
) -> tuple[list[str], list[str], list[list[int]]]:
    """Build a synthetic text corpus with known relevance labels.

    Returns:
        corpus_texts: List of ``corpus_size`` strings.
        query_texts: List of ``n_queries`` strings (each is a prefix of a
                     corpus document's text).
        relevant_ids: For query i, the list of relevant corpus indices
                      (one exact match per query).
    """
    corpus_texts: list[str] = []
    for _ in range(corpus_size):
        corpus_texts.append(_fake_content(rng, word_count=int(rng.integers(20, 60))))

    query_indices = rng.integers(0, corpus_size, size=n_queries).tolist()
    query_texts: list[str] = []
    for idx in query_indices:
        words = corpus_texts[idx].split()
        query_texts.append(" ".join(words[: min(5, len(words))]))

    relevant_ids: list[list[int]] = [[int(idx)] for idx in query_indices]

    return corpus_texts, query_texts, relevant_ids


# ---------------------------------------------------------------------------
# BEIR loader (optional)
# ---------------------------------------------------------------------------


def _load_beir_dataset(
    dataset_name: str, n_queries: int
) -> tuple[list[str], list[str], list[list[int]]]:
    """Attempt to load a BEIR dataset; fall back to synthetic on failure."""
    try:
        from beir import util as beir_util  # noqa: PLC0415
        from beir.datasets.data_loader import GenericDataLoader  # noqa: PLC0415

        url = (
            "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/"
            f"datasets/{dataset_name}.zip"
        )
        data_path = beir_util.download_and_unzip(url, "results/beir_cache")
        corpus, queries, qrels = GenericDataLoader(data_folder=data_path).load(
            split="test"
        )

        corpus_ids = list(corpus.keys())
        corpus_texts = [corpus[cid]["text"] for cid in corpus_ids]
        cid_to_idx = {cid: i for i, cid in enumerate(corpus_ids)}

        query_ids = list(queries.keys())[:n_queries]
        query_texts = [queries[qid] for qid in query_ids]
        relevant_ids = [
            [cid_to_idx[cid] for cid in qrels.get(qid, {}) if cid in cid_to_idx]
            for qid in query_ids
        ]
        return corpus_texts, query_texts, relevant_ids
    except Exception as exc:
        print(f"[Area1] BEIR load failed for {dataset_name!r}: {exc}; using synthetic")
        rng = np.random.default_rng(42)
        return _build_synthetic_dataset(
            corpus_size=5000, n_queries=n_queries, rng=rng
        )


# ---------------------------------------------------------------------------
# Main ablation function
# ---------------------------------------------------------------------------


def run_embedding_ablation(
    corpus_size: int = 100_000,
    dimensions: list[int] | None = None,
    n_queries: int = 200,
    seed: int = 42,
    use_synthetic: bool = True,
) -> dict:
    """Embedding dimension ablation on a 100K-block synthetic corpus.

    Embeds the corpus using all-MiniLM-L6-v2 (384-dim), then:
      - Reduces to 256 and 128 dims via sklearn PCA.
      - Pads to 512, 768, 1024, 1536 dims via zero-padding.

    Measures ANN recall@10 at each dimension using brute-force ground truth.
    Reports the minimum dimension with < 5% recall degradation vs. 384 dims.

    Args:
        corpus_size: Number of corpus blocks to embed.
        dimensions: List of target dims (default: [128, 256, 384, 512, 768, 1024, 1536]).
        n_queries: Number of query vectors for recall measurement.
        seed: Random seed.
        use_synthetic: If True, use synthetic data (skip BEIR downloads).

    Returns:
        Dict with keys:
            ``dimensions``, ``results``, ``baseline_dim``,
            ``baseline_recall_at_10``, ``min_dim_within_5pct``.
    """
    if dimensions is None:
        dimensions = [128, 256, 384, 512, 768, 1024, 1536]

    rng = np.random.default_rng(seed)

    if use_synthetic:
        corpus_texts, query_texts, relevant_ids = _build_synthetic_dataset(
            corpus_size=min(corpus_size, 5000),
            n_queries=n_queries,
            rng=rng,
        )
    else:
        corpus_texts, query_texts, relevant_ids = _load_beir_dataset(
            "nfcorpus", n_queries=n_queries
        )
        if len(corpus_texts) > corpus_size:
            corpus_texts = corpus_texts[:corpus_size]

    print(f"[Area1] Embedding ablation — corpus={len(corpus_texts):,}  "
          f"queries={len(query_texts)}")

    # Embed at base dimension (384)
    print("[Area1]   Embedding corpus …")
    t0 = time.perf_counter()
    corpus_base = embed_texts_local(corpus_texts)
    query_base = embed_texts_local(query_texts)
    print(f"[Area1]   Embedding done in {time.perf_counter() - t0:.1f}s")

    all_results: list[dict] = []

    for target_dim in dimensions:
        print(f"[Area1]   Projecting to dim={target_dim} …")
        corpus_proj = project_to_dim(corpus_base, target_dim)
        query_proj = project_to_dim(query_base, target_dim)

        # Brute-force ground truth at 384 dims for the baseline
        if target_dim == _BASE_MODEL_DIM:
            recall = compute_recall_at_k(query_proj, corpus_proj, relevant_ids, k=10)
        else:
            recall = compute_recall_at_k(query_proj, corpus_proj, relevant_ids, k=10)

        print(f"[Area1]   dim={target_dim}  recall@10={recall:.4f}")
        all_results.append(
            {
                "dimension": target_dim,
                "recall_at_10": recall,
                "corpus_size": len(corpus_texts),
                "n_queries": len(query_texts),
            }
        )

    # Baseline: 384-dim (the model's native output)
    baseline_dim = _BASE_MODEL_DIM
    baseline_recall = next(
        (r["recall_at_10"] for r in all_results if r["dimension"] == baseline_dim),
        0.0,
    )

    # Find minimum dimension within 5% relative drop vs. baseline
    min_dim_within_5pct: int | None = None
    for entry in sorted(all_results, key=lambda e: e["dimension"]):
        dim = entry["dimension"]
        recall = entry["recall_at_10"]
        relative_drop = (baseline_recall - recall) / (baseline_recall + 1e-9)
        if relative_drop <= 0.05:
            min_dim_within_5pct = dim
            break

    return {
        "experiment": "area1_embedding_ablation",
        "dimensions": dimensions,
        "n_queries": n_queries,
        "corpus_size": corpus_size,
        "results": all_results,
        "baseline_dim": baseline_dim,
        "baseline_recall_at_10": float(baseline_recall),
        "min_dim_within_5pct": min_dim_within_5pct,
    }
