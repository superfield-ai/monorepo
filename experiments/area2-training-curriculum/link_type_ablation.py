"""
link_type_ablation.py — H2.3: link type signal comparison.

Train separate models using only structural / only semantic / only AI links.
Compare performance on reasoning (MultiHop-style) and retrieval (clause extraction) tasks.

Link type taxonomy in Nexum:
    structural — cites, elaborates, is-exception-to  (explicit document structure)
    semantic   — supports, contradicts               (meaning-level relationships)
    ai         — LLM-classified links with a confidence score

Each link dict carries a 'link_layer' field: "structural" | "semantic" | "ai".
If absent, 'rel_type' is used to infer the layer:
    cites / elaborates / is-exception-to → structural
    supports / contradicts               → semantic
    anything else                        → ai
"""

from __future__ import annotations

from typing import Callable

from curriculum_builder import build_contrastive_curriculum, build_flat_random_curriculum

# Mapping from rel_type to default link layer.
_REL_TYPE_TO_LAYER: dict[str, str] = {
    "cites": "structural",
    "elaborates": "structural",
    "is-exception-to": "structural",
    "supports": "semantic",
    "contradicts": "semantic",
}


def _infer_layer(link: dict) -> str:
    """Infer link_layer from link_layer field or rel_type."""
    if "link_layer" in link:
        return link["link_layer"]
    return _REL_TYPE_TO_LAYER.get(link.get("rel_type", ""), "ai")


def run_link_type_ablation(
    blocks: list[dict],
    links: list[dict],
    link_types_to_test: list[str] = None,
    eval_fn: Callable[[list[dict], str], dict] = None,
    seed: int = 42,
) -> dict:
    """
    H2.3: train separate models with only structural / only semantic / only AI links.

    Parameters
    ----------
    blocks : list[dict]
        Block dicts with keys: id, text, domain.
    links : list[dict]
        Link dicts with keys: source_id, target_id, rel_type, confidence.
        Optional 'link_layer' field overrides rel_type-based inference.
    link_types_to_test : list[str]
        Link layers to test. Default: ["structural", "semantic", "ai"].
    eval_fn : callable
        Callable(curriculum: list[dict], task: str) -> float.
        ``task`` is either "reasoning" or "retrieval".
        Returns a scalar accuracy in [0, 1].
    seed : int
        Random seed.

    Returns
    -------
    dict with one key per link_type:
        {
            link_type: {
                'reasoning_accuracy': float,
                'retrieval_accuracy': float,
            }
        }
    Plus a top-level 'h2_3_signal' key: str summary.
    """
    if link_types_to_test is None:
        link_types_to_test = ["structural", "semantic", "ai"]

    if eval_fn is None:
        def eval_fn(curriculum: list[dict], task: str) -> float:
            return 0.0

    # Partition links by layer.
    layer_links: dict[str, list[dict]] = {lt: [] for lt in link_types_to_test}
    for link in links:
        layer = _infer_layer(link)
        if layer in layer_links:
            layer_links[layer].append(link)

    results: dict = {}

    for link_type in link_types_to_test:
        subset_links = layer_links[link_type]

        # Build a curriculum from these links.
        curriculum = build_contrastive_curriculum(
            blocks=blocks,
            links=subset_links,
            link_types=["contradicts", "supports"],
            confidence_threshold=0.5,
        )

        # Fall back to flat random if no typed pairs available.
        if not curriculum:
            curriculum = build_flat_random_curriculum(
                blocks=blocks,
                n_pairs=min(500, len(blocks) * (len(blocks) - 1) // 2),
                seed=seed,
            )

        reasoning_acc = eval_fn(curriculum, "reasoning")
        retrieval_acc = eval_fn(curriculum, "retrieval")

        results[link_type] = {
            "reasoning_accuracy": reasoning_acc,
            "retrieval_accuracy": retrieval_acc,
        }

    # Summarise the H2.3 signal.
    results["h2_3_signal"] = _summarise_signal(results, link_types_to_test)

    return results


def _summarise_signal(results: dict, link_types: list[str]) -> str:
    """
    Produce a one-line signal summary for H2.3.

    Checks whether 'ai' layer outperforms 'structural' on reasoning.
    Returns a human-readable conclusion string.
    """
    if "ai" not in results or "structural" not in results:
        return "inconclusive"

    ai_reasoning = results["ai"]["reasoning_accuracy"]
    structural_reasoning = results["structural"]["reasoning_accuracy"]

    if ai_reasoning > structural_reasoning:
        return "ai > structural for reasoning"
    elif structural_reasoning > ai_reasoning:
        return "structural > ai for reasoning"
    else:
        return "inconclusive"
