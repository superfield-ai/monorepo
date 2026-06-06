"""
H4.4: Attribution audit — < 5% false attribution rate.

For each question, Nexum returns cited source blocks.  Measure what fraction of
cited blocks actually contain the gold answer span.

Target: false attribution rate < 5% (precision > 0.95).

Reuses the attribution_f1() function from experiments/g2-wedge-demo/attribution_eval.py.
"""

from __future__ import annotations

import os
import sys

# Add the g2-wedge-demo directory so we can reuse attribution_f1()
_WEDGE_DEMO = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "g2-wedge-demo",
)
if _WEDGE_DEMO not in sys.path:
    sys.path.insert(0, _WEDGE_DEMO)

from attribution_eval import attribution_f1  # noqa: E402


def run_attribution_audit(
    nexum_client,
    eval_questions: list[dict],
    expert_sample_size: int = 50,
) -> dict:
    """H4.4: Measure false attribution rate on the eval question set.

    For each question, ``nexum_client.query(question)`` is expected to return a
    dict with at least:
        ``{"answer": str, "citations": [{"block_id": str, "text": str, "doc_id": str}, ...]}``

    Parameters
    ----------
    nexum_client:
        Client with a ``query(question: str) -> dict`` method.
    eval_questions:
        List of evaluation items.  Each item must contain:
            - ``question``         : the question text
            - ``gold_answer_span`` : the gold answer string
            - ``gold_doc_id``      : which document the answer comes from
            - ``gold_block_hint``  : free-text hint (logged but not used in scoring)
    expert_sample_size:
        How many questions to evaluate (automated check against gold spans).
        Capped at len(eval_questions).

    Returns
    -------
    dict with keys:
        precision             : fraction of cited blocks containing gold span
        recall                : fraction of gold spans found in any cited block
        f1                    : harmonic mean of precision and recall
        false_attribution_rate: 1 - precision (aggregated across all citations)
        h4_4_supported        : True if false_attribution_rate <= 0.05
        per_question          : list of per-question result dicts
    """
    n = min(expert_sample_size, len(eval_questions))
    sample = eval_questions[:n]

    per_question: list[dict] = []
    total_cited = 0
    total_correct = 0
    recall_hits = 0

    for item in sample:
        question = item["question"]
        gold_span = item["gold_answer_span"]
        gold_doc_id = item["gold_doc_id"]

        response = nexum_client.query(question)
        citations = response.get("citations", [])

        metrics = attribution_f1(citations, gold_span, gold_doc_id)

        total_cited += metrics["n_cited"]
        total_correct += metrics["n_correct"]
        recall_hits += int(metrics["correct_doc_cited"])

        per_question.append(
            {
                "question": question,
                "gold_doc_id": gold_doc_id,
                "gold_block_hint": item.get("gold_block_hint", ""),
                "n_cited": metrics["n_cited"],
                "n_correct": metrics["n_correct"],
                "precision": metrics["precision"],
                "recall": metrics["recall"],
                "f1": metrics["f1"],
                "false_attribution_rate": metrics["false_attribution_rate"],
            }
        )

    # Aggregate across all citations in the sample
    if total_cited > 0:
        precision = total_correct / total_cited
    else:
        precision = 0.0

    recall = recall_hits / n if n > 0 else 0.0

    if precision + recall > 0:
        f1 = 2 * precision * recall / (precision + recall)
    else:
        f1 = 0.0

    false_attribution_rate = 1.0 - precision
    far_rounded = round(false_attribution_rate, 4)

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "false_attribution_rate": far_rounded,
        "h4_4_supported": far_rounded <= 0.05,
        "per_question": per_question,
    }
