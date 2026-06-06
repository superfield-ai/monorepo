"""
Attribution F1 measurement for the G2 wedge demo.

The key metric for H4.4: given a question with a known gold answer span (from
CUAD QA pairs), what fraction of the cited source blocks actually contain the
gold answer?

Definitions
-----------
Precision  — of the cited blocks, what fraction contain the gold span?
Recall     — was *any* cited block from the correct document?
F1         — harmonic mean of precision and recall.

False attribution rate = 1 - precision.

The < 5% false attribution rate target from H4.4 means precision > 0.95.
"""

from __future__ import annotations


def _normalize(s: str) -> str:
    """Normalize for substring matching: lowercase, collapse whitespace."""
    import re

    return re.sub(r"\s+", " ", s.strip().lower())


def _contains_span(text: str, gold_span: str) -> bool:
    """Case- and whitespace-insensitive substring check.

    CUAD's gold spans are extracted with the source's idiosyncratic
    whitespace (multiple spaces, embedded newlines). Normalize both sides
    so attribution F1 measures *content* overlap, not surface formatting.
    """
    return _normalize(gold_span) in _normalize(text)


def attribution_f1(
    citations: list[dict],
    gold_span: str,
    gold_doc_id: str,
) -> dict:
    """Compute attribution precision, recall, and F1.

    Parameters
    ----------
    citations:
        List of citation dicts.  Each dict must contain at least a ``"text"``
        key with the block's text content.  Optionally ``"doc_id"`` for the
        document the block came from.
    gold_span:
        The gold answer text from the QA dataset.
    gold_doc_id:
        Which document the answer comes from.

    Returns
    -------
    dict with keys:
        ``precision``, ``recall``, ``f1``, ``false_attribution_rate``,
        ``n_cited``, ``n_correct``, ``correct_doc_cited``
    """
    if not citations:
        return {
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
            "false_attribution_rate": 1.0,
            "n_cited": 0,
            "n_correct": 0,
            "correct_doc_cited": False,
        }

    n_cited = len(citations)

    # Precision: fraction of cited blocks that contain the gold span
    n_correct = sum(
        1 for c in citations if _contains_span(c.get("text", ""), gold_span)
    )
    precision = n_correct / n_cited if n_cited > 0 else 0.0

    # Recall: was any cited block from the correct document?
    correct_doc_cited = any(
        c.get("doc_id", "") == gold_doc_id for c in citations
    )
    recall = 1.0 if correct_doc_cited else 0.0

    # F1
    if precision + recall > 0:
        f1 = 2 * precision * recall / (precision + recall)
    else:
        f1 = 0.0

    false_attribution_rate = 1.0 - precision

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "false_attribution_rate": round(false_attribution_rate, 4),
        "n_cited": n_cited,
        "n_correct": n_correct,
        "correct_doc_cited": correct_doc_cited,
    }
