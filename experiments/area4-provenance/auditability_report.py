"""
H4.1: Auditability comparison — Nexum block-level citations vs. vanilla RAG.

Measures auditability operationally across four metrics:
    1. Citation specificity  — avg length of cited passage (shorter = more precise)
    2. Citation count        — how many sources cited per answer
    3. Source diversity      — how many distinct documents cited
    4. Block traceable       — can the citation be traced to a specific paragraph?
                               (Nexum: yes; vanilla: document-level only)

Nexum is considered more auditable if it wins on >= 3 of 4 metrics.
"""

from __future__ import annotations


def _avg_citation_length(results: list[dict], key: str) -> float:
    """Compute the average character length of cited passages."""
    lengths: list[int] = []
    for r in results:
        for node in r.get(key, []):
            text = node.get("text", "")
            lengths.append(len(text))
    return sum(lengths) / len(lengths) if lengths else 0.0


def _avg_citation_count(results: list[dict], key: str) -> float:
    """Compute the average number of citations per answer."""
    counts = [len(r.get(key, [])) for r in results]
    return sum(counts) / len(counts) if counts else 0.0


def _avg_source_diversity(results: list[dict], key: str) -> float:
    """Compute the average number of distinct doc_ids cited per answer."""
    diversities: list[int] = []
    for r in results:
        doc_ids = {node.get("doc_id", "") for node in r.get(key, [])}
        diversities.append(len(doc_ids))
    return sum(diversities) / len(diversities) if diversities else 0.0


def _block_traceable(results: list[dict], key: str) -> bool:
    """Return True if at least one citation in the result set has a ``block_id``."""
    for r in results:
        for node in r.get(key, []):
            if node.get("block_id"):
                return True
    return False


def generate_auditability_comparison(
    nexum_results: list[dict],
    vanilla_results: list[dict],
    questions: list[dict],
) -> dict:
    """H4.1: Measure auditability of Nexum vs. vanilla RAG.

    Parameters
    ----------
    nexum_results:
        List of Nexum answer dicts.  Each must contain:
            - ``answer``    : generated text
            - ``citations`` : list of ``{"block_id": str, "text": str, "doc_id": str}``
    vanilla_results:
        List of vanilla RAG answer dicts.  Each must contain:
            - ``answer``      : generated text
            - ``source_nodes``: list of ``{"text": str, "doc_id": str}``
              (no ``block_id`` — document-level citation only)
    questions:
        The question list (used for ordering / metadata).

    Returns
    -------
    dict with keys:
        nexum   : dict with specificity, count, diversity, block_traceable
        vanilla : dict with specificity, count, diversity, block_traceable
        nexum_more_auditable : bool  (True if nexum wins >= 3 of 4 metrics)
        h4_1_signal          : str   (human-readable summary)
    """
    # --- Nexum metrics ---
    nexum_specificity = _avg_citation_length(nexum_results, "citations")
    nexum_count = _avg_citation_count(nexum_results, "citations")
    nexum_diversity = _avg_source_diversity(nexum_results, "citations")
    nexum_traceable = _block_traceable(nexum_results, "citations")

    # --- Vanilla metrics ---
    vanilla_specificity = _avg_citation_length(vanilla_results, "source_nodes")
    vanilla_count = _avg_citation_count(vanilla_results, "source_nodes")
    vanilla_diversity = _avg_source_diversity(vanilla_results, "source_nodes")
    vanilla_traceable = _block_traceable(vanilla_results, "source_nodes")

    # --- Compute wins ---
    # Specificity: lower avg length = more precise citation = Nexum wins if lower
    nexum_wins_specificity = nexum_specificity < vanilla_specificity

    # Count: higher citation count = more sourcing = win
    nexum_wins_count = nexum_count > vanilla_count

    # Diversity: more distinct docs = more auditable
    nexum_wins_diversity = nexum_diversity > vanilla_diversity

    # Block traceable: structural advantage of Nexum (has block_id)
    nexum_wins_traceable = nexum_traceable and not vanilla_traceable

    wins = sum([
        nexum_wins_specificity,
        nexum_wins_count,
        nexum_wins_diversity,
        nexum_wins_traceable,
    ])
    nexum_more_auditable = wins >= 3

    # Build signal string
    metric_labels = {
        "specificity": nexum_wins_specificity,
        "count": nexum_wins_count,
        "diversity": nexum_wins_diversity,
        "block_traceable": nexum_wins_traceable,
    }
    won = [k for k, v in metric_labels.items() if v]
    lost = [k for k, v in metric_labels.items() if not v]
    h4_1_signal = (
        f"Nexum wins {wins}/4 auditability metrics "
        f"(won: {', '.join(won) or 'none'}; "
        f"lost: {', '.join(lost) or 'none'}). "
        f"nexum_more_auditable={nexum_more_auditable}."
    )

    return {
        "nexum": {
            "specificity": round(nexum_specificity, 2),
            "count": round(nexum_count, 2),
            "diversity": round(nexum_diversity, 2),
            "block_traceable": nexum_traceable,
        },
        "vanilla": {
            "specificity": round(vanilla_specificity, 2),
            "count": round(vanilla_count, 2),
            "diversity": round(vanilla_diversity, 2),
            "block_traceable": vanilla_traceable,
        },
        "nexum_more_auditable": nexum_more_auditable,
        "h4_1_signal": h4_1_signal,
    }
