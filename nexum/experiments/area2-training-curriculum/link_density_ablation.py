"""
link_density_ablation.py — H2.1 confidence threshold sweep.

Vary the AI link confidence threshold and measure downstream task performance
as a function of the threshold. This tests whether higher-confidence links
produce better contrastive training pairs.
"""

from __future__ import annotations

from typing import Callable

from curriculum_builder import build_contrastive_curriculum


def run_link_density_ablation(
    blocks: list[dict],
    links: list[dict],
    confidence_thresholds: list[float] = None,
    eval_fn: Callable[[list[dict]], float] = None,
    n_pairs: int = 1_000,
    seed: int = 42,
) -> dict:
    """
    H2.1 variant: vary AI link confidence threshold.

    For each threshold, include only links with confidence > threshold.
    Build the contrastive curriculum from the filtered links, then evaluate.

    Parameters
    ----------
    blocks : list[dict]
        Block dicts with keys: id, text, domain.
    links : list[dict]
        Link dicts with keys: source_id, target_id, rel_type, confidence.
    confidence_thresholds : list[float]
        Confidence thresholds to sweep. Default: [0.5, 0.7, 0.9].
    eval_fn : callable
        Callable(curriculum: list[dict]) -> float.
        Given a curriculum (list of triplets), returns a scalar accuracy score.
    n_pairs : int
        Maximum number of pairs to pass to eval_fn.
    seed : int
        Random seed for curriculum construction.

    Returns
    -------
    dict mapping threshold -> {
        'n_links_included': int,
        'n_pairs_generated': int,
        'eval_accuracy': float,
    }
    """
    if confidence_thresholds is None:
        confidence_thresholds = [0.5, 0.7, 0.9]

    if eval_fn is None:
        # Default no-op evaluator.
        def eval_fn(curriculum: list[dict]) -> float:
            return 0.0

    results: dict[float, dict] = {}

    for threshold in confidence_thresholds:
        # Filter links to those with confidence strictly greater than threshold.
        filtered_links = [
            link for link in links
            if float(link.get("confidence", 0.0)) > threshold
        ]

        n_links_included = len(filtered_links)

        curriculum = build_contrastive_curriculum(
            blocks=blocks,
            links=filtered_links,
            link_types=["contradicts", "supports"],
            confidence_threshold=0.0,  # already filtered above
        )

        # Cap at n_pairs for eval.
        eval_curriculum = curriculum[:n_pairs]
        n_pairs_generated = len(curriculum)

        accuracy = eval_fn(eval_curriculum)

        results[threshold] = {
            "n_links_included": n_links_included,
            "n_pairs_generated": n_pairs_generated,
            "eval_accuracy": accuracy,
        }

    return results
