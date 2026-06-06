"""
embedding_drift.py — H5.4: drift detection for minor edits.

Applies random token substitutions to text blocks at varying fractions, then
measures:
  - cosine distance between original and edited embeddings
  - rank shift in ANN retrieval (how many positions the block moves)
  - cosine drift relative to the HNSW nearest-neighbor boundary

Uses sentence-transformers locally — no API key needed.

H5.4 pass criterion: safe_edit_threshold >= 0.05
  (i.e., < 5% of blocks shift more than 3 positions for edits up to 5% of tokens)

HNSW nearest-neighbor boundary:
  The discrimination threshold is the average cosine distance between the k-th
  and (k+1)-th nearest neighbor across a representative query sample. Drift
  that stays below this boundary will not change retrieval results; drift that
  exceeds it may push blocks out of the top-k result set.

Canonical docs:
  - docs/research/hypotheses/H5.4_embedding-drift-below-threshold.md
  - docs/research/queue.md
"""

from __future__ import annotations

import random
import string
from typing import Any

import numpy as np

_DEFAULT_MODEL = "all-MiniLM-L6-v2"
_DEFAULT_EDIT_FRACTIONS = [0.01, 0.03, 0.05, 0.10]
_RANK_SHIFT_THRESHOLD = 3      # positions
_PCT_SHIFT_LIMIT = 0.05        # max fraction of blocks that may shift > threshold
_SAFE_THRESHOLD_MIN = 0.05     # H5.4 pass criterion


# ---------------------------------------------------------------------------
# Text manipulation helpers
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> list[str]:
    """Very simple whitespace tokenizer."""
    return text.split()


def _detokenize(tokens: list[str]) -> str:
    return " ".join(tokens)


def _random_word(rng: random.Random, length: int = 6) -> str:
    """Return a random lowercase alphabetic word."""
    return "".join(rng.choices(string.ascii_lowercase, k=length))


def apply_random_edit(text: str, fraction: float, rng: random.Random) -> str:
    """
    Replace *fraction* of tokens with random words.

    Returns the edited text.  If the text has no tokens, returns it unchanged.
    """
    tokens = _tokenize(text)
    if not tokens:
        return text
    n_edits = max(1, int(len(tokens) * fraction))
    indices = rng.sample(range(len(tokens)), min(n_edits, len(tokens)))
    edited = tokens[:]
    for i in indices:
        edited[i] = _random_word(rng)
    return _detokenize(edited)


# ---------------------------------------------------------------------------
# Embedding utilities
# ---------------------------------------------------------------------------

def _cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine distance in [0, 2]."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a < 1e-9 or norm_b < 1e-9:
        return 1.0
    return float(1.0 - np.dot(a, b) / (norm_a * norm_b))


def _rank_shift(
    original_emb: np.ndarray,
    edited_emb: np.ndarray,
    corpus_embs: np.ndarray,
    top_k: int,
) -> int:
    """
    Measure how many positions the block shifts in top-k ANN retrieval.

    We query with the *original* embedding and find the block's rank, then
    query with the *edited* embedding and compare.  The block to track is the
    first corpus entry (index 0); its original embedding IS corpus_embs[0].

    Returns |rank_original - rank_edited| for the tracked block.
    """
    # Compute dot-product similarities (assumes unit-norm embeddings)
    orig_sim = corpus_embs @ original_emb               # (n,)
    edit_sim = corpus_embs @ edited_emb                 # (n,)

    # Rank of block 0 in each ranking (lower index = better rank, 0-indexed)
    orig_rank = int(np.argsort(-orig_sim)[0:top_k].tolist().index(0)
                    if 0 in np.argsort(-orig_sim)[0:top_k]
                    else top_k)
    edit_rank = int(np.argsort(-edit_sim)[0:top_k].tolist().index(0)
                    if 0 in np.argsort(-edit_sim)[0:top_k]
                    else top_k)
    return abs(orig_rank - edit_rank)


def estimate_hnsw_boundary(
    corpus_embs: np.ndarray,
    top_k: int = 8,
    n_queries: int = 200,
    rng: np.random.Generator | None = None,
) -> dict[str, float]:
    """
    Estimate the HNSW nearest-neighbor discrimination boundary.

    For each sampled query vector, find the k-th and (k+1)-th nearest
    neighbors (by cosine similarity) and compute the cosine distance gap
    between them.  This gap is the retrieval boundary: embeddings that drift
    by more than this amount may fall out of the top-k result set.

    Args:
        corpus_embs: (n, d) unit-norm embedding matrix.
        top_k: neighbourhood size to evaluate.
        n_queries: number of corpus vectors to use as query probes.
        rng: optional numpy Generator for reproducibility.

    Returns:
        {
          'mean_boundary': float,   # mean gap between rank k and k+1
          'p25_boundary': float,    # 25th percentile — conservative threshold
          'p50_boundary': float,    # median
          'p75_boundary': float,
          'top_k': int,
        }

    Canonical reference: docs/research/hypotheses/H5.4_embedding-drift-below-threshold.md
    """
    if rng is None:
        rng = np.random.default_rng(42)

    n = corpus_embs.shape[0]
    if n <= top_k:
        raise ValueError(
            f"corpus_embs must have more than top_k={top_k} rows; got {n}."
        )

    # Sample query indices without replacement
    n_q = min(n_queries, n)
    query_indices = rng.choice(n, size=n_q, replace=False)

    boundaries: list[float] = []
    for q_idx in query_indices:
        query = corpus_embs[q_idx]
        # Cosine similarity = dot product when embeddings are unit-norm
        sims = corpus_embs @ query  # (n,)
        # Exclude the query itself from its own neighborhood
        sims[q_idx] = -np.inf
        sorted_sims = np.sort(sims)[::-1]  # descending

        # k-th neighbor similarity (0-indexed: position top_k-1)
        sim_k = float(sorted_sims[top_k - 1])
        # (k+1)-th neighbor
        sim_k1 = float(sorted_sims[top_k])

        # Gap in cosine distance units (sim → dist = 1 - sim for unit vectors)
        boundary_gap = (1.0 - sim_k1) - (1.0 - sim_k)  # = sim_k - sim_k1
        boundaries.append(max(0.0, boundary_gap))

    arr = np.array(boundaries, dtype=np.float64)
    return {
        "mean_boundary": float(arr.mean()),
        "p25_boundary": float(np.percentile(arr, 25)),
        "p50_boundary": float(np.percentile(arr, 50)),
        "p75_boundary": float(np.percentile(arr, 75)),
        "top_k": top_k,
    }


# ---------------------------------------------------------------------------
# Main measurement function
# ---------------------------------------------------------------------------

def measure_embedding_drift(
    texts: list[str],
    edit_fractions: list[float] | None = None,
    embedding_model: str = _DEFAULT_MODEL,
    n_samples: int = 1000,
    top_k: int = 8,
    seed: int = 42,
    n_boundary_queries: int = 200,
) -> dict[str, Any]:
    """
    H5.4: apply random token substitutions at each edit_fraction.
    Measure cosine distance between original and edited embedding.
    Measure rank shift in ANN retrieval.
    Compare drift against the HNSW nearest-neighbor boundary.

    Args:
        texts: list of text strings to use as the corpus.
            Must have at least top_k entries for meaningful rank measurement.
        edit_fractions: fractions of tokens to substitute.
            Defaults to [0.01, 0.03, 0.05, 0.10].
        embedding_model: sentence-transformers model name (local, no API key).
        n_samples: number of (text, edit) pairs to sample per fraction.
        top_k: neighbourhood size for rank-shift and boundary measurement.
        seed: random seed for reproducibility.
        n_boundary_queries: number of probe queries for HNSW boundary estimation.

    Returns: {
        edit_fraction: {
            'mean_cosine_distance': float,
            'p95_cosine_distance': float,
            'mean_rank_shift': float,
            'pct_blocks_shift_gt_3': float,
            'pct_drift_exceeds_boundary': float,  # fraction where drift > hnsw boundary
        }
        for edit_fraction in edit_fractions
    }
    + 'safe_edit_threshold': float
    + 'h5_4_supported': bool
    + 'hnsw_boundary': dict  # HNSW nearest-neighbor boundary statistics

    Canonical reference: docs/research/hypotheses/H5.4_embedding-drift-below-threshold.md
    """
    if edit_fractions is None:
        edit_fractions = _DEFAULT_EDIT_FRACTIONS

    from sentence_transformers import SentenceTransformer  # noqa: PLC0415

    model = SentenceTransformer(embedding_model)
    rng_random = random.Random(seed)
    rng_np = np.random.default_rng(seed)

    # Subsample corpus to n_samples if larger
    corpus = texts[:n_samples] if len(texts) >= n_samples else texts
    # Ensure we have at least top_k + 1 blocks (need k+1 for boundary estimation)
    if len(corpus) <= top_k:
        raise ValueError(
            f"Need at least top_k+1={top_k + 1} texts; got {len(corpus)}."
        )

    # Embed the full corpus once
    corpus_embs = model.encode(corpus, normalize_embeddings=True, show_progress_bar=False)
    corpus_embs = np.array(corpus_embs, dtype=np.float32)  # (n, d)

    # Estimate the HNSW nearest-neighbor boundary before measuring drift
    hnsw_boundary = estimate_hnsw_boundary(
        corpus_embs,
        top_k=top_k,
        n_queries=min(n_boundary_queries, len(corpus)),
        rng=rng_np,
    )
    mean_boundary = hnsw_boundary["mean_boundary"]

    results: dict[str, Any] = {}

    for frac in edit_fractions:
        cosine_dists: list[float] = []
        rank_shifts: list[int] = []
        exceeds_boundary: list[bool] = []

        # We track each block in turn: edit it, re-embed, measure
        for idx in range(len(corpus)):
            original_text = corpus[idx]
            edited_text = apply_random_edit(original_text, frac, rng_random)

            # Re-embed the single edited block
            edited_emb = model.encode(
                [edited_text], normalize_embeddings=True, show_progress_bar=False
            )[0].astype(np.float32)
            original_emb = corpus_embs[idx]

            # Cosine distance
            cos_dist = _cosine_distance(original_emb, edited_emb)
            cosine_dists.append(cos_dist)

            # Compare drift to HNSW boundary
            exceeds_boundary.append(cos_dist > mean_boundary)

            # Rank shift: build a corpus view where index 0 is this block
            other_indices = [i for i in range(len(corpus)) if i != idx]
            # Use top_k-1 random others so the neighbourhood has top_k entries
            neighbours = rng_np.choice(
                other_indices,
                size=min(top_k - 1, len(other_indices)),
                replace=False,
            ).tolist()
            view_indices = [idx] + neighbours
            view_embs = corpus_embs[view_indices]  # (top_k, d)

            # Replace row 0 with original_emb (in case corpus_embs already has it)
            view_embs = view_embs.copy()
            view_embs[0] = original_emb

            shift = _rank_shift(original_emb, edited_emb, view_embs, top_k)
            rank_shifts.append(shift)

        cd_arr = np.array(cosine_dists, dtype=np.float64)
        rs_arr = np.array(rank_shifts, dtype=np.float64)
        pct_shift_gt = float((rs_arr > _RANK_SHIFT_THRESHOLD).mean())
        pct_exceeds = float(np.mean(exceeds_boundary))

        results[frac] = {
            "mean_cosine_distance": float(cd_arr.mean()),
            "p95_cosine_distance": float(np.percentile(cd_arr, 95)),
            "mean_rank_shift": float(rs_arr.mean()),
            "pct_blocks_shift_gt_3": pct_shift_gt,
            "pct_drift_exceeds_boundary": pct_exceeds,
        }

    # Safe edit threshold: highest fraction where pct_blocks_shift_gt_3 < 0.05
    safe_threshold = 0.0
    for frac in sorted(edit_fractions):
        if results[frac]["pct_blocks_shift_gt_3"] < _PCT_SHIFT_LIMIT:
            safe_threshold = frac

    results["safe_edit_threshold"] = safe_threshold
    results["h5_4_supported"] = safe_threshold >= _SAFE_THRESHOLD_MIN
    results["hnsw_boundary"] = hnsw_boundary
    return results
