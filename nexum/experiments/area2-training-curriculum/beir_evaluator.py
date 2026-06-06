"""
beir_evaluator.py — Lightweight BEIR nDCG@10 evaluation harness for H2.1.

Implements a retrieval evaluation loop compatible with BEIR-style metrics
(nDCG@10) without requiring the full `beir` package or network access.

The evaluation corpus is drawn from the same synthetic EDGAR-like blocks used
for fine-tuning, held out during training.  A held-out query set is constructed
by sampling anchor blocks from the held-out portion; the relevant set is defined
as blocks of the *same clause type* (the true signal a well-trained encoder
should learn to group together).

This gives an honest proxy for BEIR nDCG@10 on the legal clause-retrieval task
without requiring an external dataset or GPU.

nDCG@10 formula (standard):
    DCG@k = Σ_{i=1}^{k} rel_i / log2(i + 1)
    IDCG@k = Σ_{i=1}^{min(k, |R|)} 1 / log2(i + 1)
    nDCG@k = DCG@k / IDCG@k

rel_i = 1 if the i-th retrieved document is in the relevant set, 0 otherwise.

Canonical references:
- docs/research/hypotheses/H2.1_contrastive-links-better-finetuning.md
- https://en.wikipedia.org/wiki/Discounted_cumulative_gain
"""

from __future__ import annotations

import math
import random
from typing import Callable

import numpy as np


# ---------------------------------------------------------------------------
# nDCG computation
# ---------------------------------------------------------------------------

def ndcg_at_k(
    retrieved: list[str],
    relevant: set[str],
    k: int = 10,
) -> float:
    """
    Compute nDCG@k for a single query.

    Parameters
    ----------
    retrieved : list[str]
        Retrieved document IDs in ranked order (best first).
    relevant : set[str]
        Set of relevant document IDs for this query.
    k : int
        Cutoff.

    Returns
    -------
    float in [0, 1].
    """
    if not relevant:
        return 0.0

    dcg = 0.0
    for i, doc_id in enumerate(retrieved[:k], start=1):
        if doc_id in relevant:
            dcg += 1.0 / math.log2(i + 1)

    # Ideal DCG: all relevant docs at top positions.
    n_relevant_in_k = min(len(relevant), k)
    idcg = sum(1.0 / math.log2(i + 1) for i in range(1, n_relevant_in_k + 1))

    return dcg / idcg if idcg > 0 else 0.0


# ---------------------------------------------------------------------------
# Corpus encoder (sentence-transformers or bag-of-tokens fallback)
# ---------------------------------------------------------------------------

def encode_corpus(
    texts: list[str],
    model=None,
    batch_size: int = 64,
) -> np.ndarray:
    """
    Encode a list of texts into dense vectors.

    Uses the provided sentence-transformers model if available,
    otherwise falls back to a deterministic bag-of-tokens featurizer.

    Returns np.ndarray of shape (n, dim).
    """
    if model is not None:
        embeddings = model.encode(
            texts,
            batch_size=batch_size,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        # Normalize to unit length for cosine similarity.
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1.0, norms)
        return embeddings / norms
    else:
        # Fallback: deterministic hashed bag-of-tokens.
        return _hashed_bow_encode(texts)


def _hash_tok(tok: str, n_buckets: int = 256) -> int:
    h = 1469598103934665603
    for c in tok.encode("utf-8"):
        h ^= c
        h = (h * 1099511628211) & ((1 << 64) - 1)
    return h % n_buckets


def _hashed_bow_encode(texts: list[str], n_buckets: int = 256) -> np.ndarray:
    out = np.zeros((len(texts), n_buckets), dtype=np.float32)
    for i, text in enumerate(texts):
        toks = text.split()
        if not toks:
            continue
        for t in toks:
            out[i, _hash_tok(t, n_buckets)] += 1.0
        out[i] /= len(toks)
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    return out / norms


# ---------------------------------------------------------------------------
# Retrieval evaluation
# ---------------------------------------------------------------------------

def evaluate_retrieval(
    query_blocks: list[dict],
    corpus_blocks: list[dict],
    model=None,
    k: int = 10,
    relevance_fn: Callable[[dict, dict], bool] | None = None,
    batch_size: int = 64,
) -> dict:
    """
    Evaluate retrieval quality on a held-out query/corpus split.

    Parameters
    ----------
    query_blocks : list[dict]
        Held-out query blocks (each with `id`, `text`, `clause_type`).
    corpus_blocks : list[dict]
        Corpus documents to retrieve from.  May overlap with query_blocks.
    model : sentence-transformers model or None
        If provided, used for encoding; otherwise uses bag-of-tokens fallback.
    k : int
        nDCG cutoff (default 10).
    relevance_fn : callable or None
        Function(query_block, corpus_block) -> bool defining relevance.
        Default: same clause_type.
    batch_size : int
        Encoding batch size.

    Returns
    -------
    dict with keys:
        ndcg_at_k (float) — macro-averaged nDCG@k across all queries,
        n_queries (int),
        n_corpus (int),
        k (int),
        per_query_ndcg (list[float]).
    """
    if relevance_fn is None:
        def relevance_fn(q, c):
            return (
                q.get("clause_type") == c.get("clause_type")
                and q["id"] != c["id"]
            )

    # Encode corpus.
    corpus_texts = [b["text"] for b in corpus_blocks]
    corpus_ids = [b["id"] for b in corpus_blocks]
    corpus_embs = encode_corpus(corpus_texts, model=model, batch_size=batch_size)

    # For each query: encode, compute cosine similarity, rank, compute nDCG@k.
    query_texts = [b["text"] for b in query_blocks]
    query_embs = encode_corpus(query_texts, model=model, batch_size=batch_size)

    per_query_ndcg: list[float] = []

    for qi, q_block in enumerate(query_blocks):
        relevant_ids = {
            c["id"] for c in corpus_blocks if relevance_fn(q_block, c)
        }
        if not relevant_ids:
            # Skip queries with no relevant docs.
            continue

        q_emb = query_embs[qi]  # shape (dim,)
        # Cosine similarity: already normalized, so dot product suffices.
        sims = corpus_embs @ q_emb  # shape (n_corpus,)

        # Rank by descending similarity (exclude self).
        ranked_pairs = sorted(
            [(corpus_ids[i], float(sims[i]))
             for i in range(len(corpus_ids)) if corpus_ids[i] != q_block["id"]],
            key=lambda x: -x[1],
        )
        retrieved = [doc_id for doc_id, _ in ranked_pairs]

        ndcg = ndcg_at_k(retrieved, relevant_ids, k=k)
        per_query_ndcg.append(ndcg)

    mean_ndcg = float(np.mean(per_query_ndcg)) if per_query_ndcg else 0.0
    return {
        "ndcg_at_k": round(mean_ndcg, 6),
        "n_queries": len(per_query_ndcg),
        "n_corpus": len(corpus_blocks),
        "k": k,
        "per_query_ndcg": [round(x, 6) for x in per_query_ndcg],
    }
