"""
FreshQA evaluation: accuracy on time-sensitive questions.

FreshQA (https://github.com/freshllms/freshqa) is a benchmark of ~600
questions whose answers may change over time.  Each question has a gold
answer and a type label (single-hop / multi-hop / false-premise / ...).

This script:
1. Downloads the FreshQA dataset from HuggingFace (``freshllms/freshqa``).
2. For each question, queries Nexum and extracts the predicted answer from
   the top returned block.
3. Computes exact-match accuracy (normalised: lowercase + strip punctuation).
4. Reports accuracy broken down by question type and by whether the gold
   answer has changed since the original annotation.

Usage::

    python eval/freshqa_eval.py \\
        --nexum-url http://localhost:3000 \\
        --corpus-id <id> \\
        --max-questions 200 \\
        --output results/freshqa

The output directory will contain:
    freshqa_detail.jsonl  — per-question results
    freshqa_summary.json  — aggregate and by-type accuracy
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import string
from pathlib import Path
from typing import Any

import requests

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# HuggingFace dataset identifier
_HF_DATASET = "freshllms/freshqa"


# ---------------------------------------------------------------------------
# Normalisation & metric helpers
# ---------------------------------------------------------------------------

def normalize_answer(text: str) -> str:
    """
    Normalise an answer string for exact-match comparison.

    Steps:
    1. Lowercase
    2. Remove punctuation
    3. Remove leading/trailing whitespace and collapse internal whitespace
    4. Remove articles (a, an, the) as whole words
    """
    text = text.lower()
    # Remove punctuation
    text = "".join(ch for ch in text if ch not in string.punctuation)
    # Remove articles at word boundaries
    text = re.sub(r"\b(a|an|the)\b", " ", text)
    # Collapse whitespace
    return " ".join(text.split())


def exact_match(prediction: str, gold: str) -> float:
    """Return 1.0 if normalised prediction equals normalised gold, else 0.0."""
    return float(normalize_answer(prediction) == normalize_answer(gold))


def best_exact_match(prediction: str, gold_answers: list[str]) -> float:
    """Return max exact match over a list of acceptable gold answers."""
    if not gold_answers:
        return float(normalize_answer(prediction) == "")
    return max(exact_match(prediction, g) for g in gold_answers)


# ---------------------------------------------------------------------------
# Dataset loading
# ---------------------------------------------------------------------------

def load_freshqa(max_questions: int | None = None) -> list[dict[str, Any]]:
    """
    Load FreshQA from HuggingFace datasets.

    Returns a list of dicts with keys:
        question (str), answer (str | list[str]), type (str),
        answer_changed (bool)
    """
    from datasets import load_dataset  # lazy import

    ds = load_dataset(_HF_DATASET, split="train")
    examples: list[dict[str, Any]] = []

    for row in ds:
        # Normalise the gold answer(s) field — FreshQA uses 'answer' which may
        # be a string or a list of strings.
        raw_answer = row.get("answer", row.get("answers", ""))
        if isinstance(raw_answer, list):
            gold_answers = [str(a) for a in raw_answer if a]
        else:
            gold_answers = [str(raw_answer)] if raw_answer else []

        examples.append(
            {
                "question": row.get("question", ""),
                "answers": gold_answers,
                # question_type: single-hop / multi-hop / false-premise / ...
                "type": str(row.get("question_type", row.get("type", "unknown"))),
                # answer_changed: True if the answer has changed since annotation
                "answer_changed": bool(row.get("answer_changed", False)),
            }
        )
        if max_questions and len(examples) >= max_questions:
            break

    logger.info("Loaded %d FreshQA questions", len(examples))
    return examples


# ---------------------------------------------------------------------------
# Nexum query
# ---------------------------------------------------------------------------

def query_nexum(
    nexum_url: str,
    corpus_id: str | None,
    question: str,
    session: requests.Session,
    top_k: int = 5,
) -> str:
    """
    Issue a question to Nexum.  Returns the text of the top-ranked block.

    If *corpus_id* is None, the query is issued without a corpus filter (uses
    the default corpus configured in Nexum).
    """
    payload: dict[str, Any] = {
        "query": question,
        "mode": "semantic",
        "limit": top_k,
    }
    if corpus_id:
        payload["corpus_id"] = corpus_id

    resp = session.post(f"{nexum_url}/query", json=payload)
    resp.raise_for_status()
    results = resp.json().get("results", [])
    return results[0].get("text", "") if results else ""


# ---------------------------------------------------------------------------
# Main eval loop
# ---------------------------------------------------------------------------

def run_eval(
    nexum_url: str,
    output_dir: Path,
    corpus_id: str | None = None,
    max_questions: int | None = None,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()

    questions = load_freshqa(max_questions)

    detail_path = output_dir / "freshqa_detail.jsonl"
    by_type: dict[str, list[float]] = {}
    changed_scores: list[float] = []
    all_scores: list[float] = []

    with detail_path.open("w") as df:
        for q in questions:
            pred = query_nexum(nexum_url, corpus_id, q["question"], session)
            score = best_exact_match(pred, q["answers"])
            all_scores.append(score)

            qtype = q["type"]
            by_type.setdefault(qtype, []).append(score)

            if q["answer_changed"]:
                changed_scores.append(score)

            df.write(
                json.dumps(
                    {
                        "question": q["question"],
                        "type": qtype,
                        "answer_changed": q["answer_changed"],
                        "gold_answers": q["answers"][:3],
                        "prediction": pred[:300],
                        "exact_match": score,
                    }
                )
                + "\n"
            )

    n = len(all_scores)
    accuracy = sum(all_scores) / n if n else 0.0
    by_type_accuracy = {t: sum(v) / len(v) for t, v in by_type.items()}
    changed_accuracy = sum(changed_scores) / len(changed_scores) if changed_scores else 0.0

    summary: dict[str, Any] = {
        "n_questions": n,
        "corpus_id": corpus_id,
        "accuracy": accuracy,
        "accuracy_by_type": by_type_accuracy,
        "accuracy_on_changed_answers": changed_accuracy,
        "n_changed_answers": len(changed_scores),
    }
    (output_dir / "freshqa_summary.json").write_text(json.dumps(summary, indent=2))
    logger.info(
        "FreshQA accuracy: %.4f  (changed answers: %.4f on %d questions)",
        accuracy,
        changed_accuracy,
        len(changed_scores),
    )
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="FreshQA evaluation against Nexum")
    parser.add_argument("--nexum-url", default="http://localhost:3000")
    parser.add_argument(
        "--corpus-id",
        default=None,
        help="Nexum corpus ID to query. If omitted, uses the Nexum default.",
    )
    parser.add_argument(
        "--max-questions",
        type=int,
        default=None,
        help="Cap the number of questions evaluated (useful for quick runs).",
    )
    parser.add_argument("--output", default="results/freshqa", type=Path)
    args = parser.parse_args()

    run_eval(
        nexum_url=args.nexum_url,
        output_dir=args.output,
        corpus_id=args.corpus_id,
        max_questions=args.max_questions,
    )


if __name__ == "__main__":
    main()
