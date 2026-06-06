"""
CUAD evaluation: span F1 for contract clause extraction.

Tests Nexum's block-level precision on legal clause retrieval: given a
clause-type question (e.g., "Does this contract have a non-compete clause?"),
does Nexum return the specific span that answers it?

Usage:
  python eval/cuad_eval.py \
    --nexum-url http://localhost:3000 \
    --contracts data/cuad/contracts.jsonl \
    --qa data/cuad/qa.jsonl \
    --output results/cuad
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import string
from pathlib import Path

import requests

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Metric helpers
# ---------------------------------------------------------------------------

def normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"\b(a|an|the)\b", " ", text)
    text = "".join(c for c in text if c not in string.punctuation)
    return " ".join(text.split())


def token_f1(pred: str, gold: str) -> float:
    pred_toks = normalize(pred).split()
    gold_toks = normalize(gold).split()
    if not pred_toks or not gold_toks:
        return float(pred_toks == gold_toks)
    from collections import Counter
    common = Counter(pred_toks) & Counter(gold_toks)
    n_same = sum(common.values())
    if n_same == 0:
        return 0.0
    p = n_same / len(pred_toks)
    r = n_same / len(gold_toks)
    return 2 * p * r / (p + r)


def max_f1_over_answers(pred: str, answers: list[str]) -> float:
    """CUAD scoring: take max F1 over all gold answer spans."""
    if not answers:
        return float(normalize(pred) == "")
    return max(token_f1(pred, a) for a in answers)


# ---------------------------------------------------------------------------
# Nexum helpers
# ---------------------------------------------------------------------------

def ingest_contracts(
    nexum_url: str,
    contracts_path: Path,
    session: requests.Session,
) -> tuple[str, dict[str, str]]:
    """Returns (corpus_id, {contract_id → nexum_doc_id})."""
    resp = session.post(
        f"{nexum_url}/corpora",
        json={"name": "cuad-contracts", "description": "CUAD contract corpus"},
    )
    resp.raise_for_status()
    corpus_id: str = resp.json()["id"]
    logger.info("Created corpus %s", corpus_id)

    contract_map: dict[str, str] = {}
    with contracts_path.open() as f:
        for i, line in enumerate(f):
            doc = json.loads(line)
            r = session.post(
                f"{nexum_url}/documents",
                json={
                    "corpus_id": corpus_id,
                    "external_id": doc["id"],
                    "title": doc.get("title", ""),
                    "content": doc["text"],
                    "format": "text",
                },
            )
            r.raise_for_status()
            contract_map[doc["id"]] = r.json()["id"]
            if (i + 1) % 50 == 0:
                logger.info("Ingested %d contracts", i + 1)

    return corpus_id, contract_map


def query_contract(
    nexum_url: str,
    corpus_id: str,
    contract_id: str,
    question: str,
    session: requests.Session,
) -> str:
    """Query a specific contract for a clause. Returns top block text."""
    resp = session.post(
        f"{nexum_url}/query",
        json={
            "corpus_id": corpus_id,
            "query": question,
            "mode": "semantic",
            "limit": 5,
            "filter": {"external_document_id": contract_id},
        },
    )
    resp.raise_for_status()
    results = resp.json().get("results", [])
    return results[0]["text"] if results else ""


# ---------------------------------------------------------------------------
# Main eval
# ---------------------------------------------------------------------------

def run_eval(
    nexum_url: str,
    contracts_path: Path,
    qa_path: Path,
    output_dir: Path,
    corpus_id: str | None = None,
    max_questions: int | None = None,
) -> dict:
    session = requests.Session()
    output_dir.mkdir(parents=True, exist_ok=True)

    contract_map: dict[str, str] = {}
    if corpus_id is None:
        corpus_id, contract_map = ingest_contracts(nexum_url, contracts_path, session)
    else:
        # Load the map from a saved file if re-using a corpus
        map_path = output_dir / "contract_map.json"
        if map_path.exists():
            contract_map = json.loads(map_path.read_text())

    qa_pairs: list[dict] = []
    with qa_path.open() as f:
        for line in f:
            qa_pairs.append(json.loads(line))
            if max_questions and len(qa_pairs) >= max_questions:
                break

    logger.info("Evaluating %d QA pairs…", len(qa_pairs))

    f1_scores: list[float] = []
    has_answer_correct: list[float] = []  # whether system correctly answered yes/no

    detail_path = output_dir / "cuad_detail.jsonl"
    with detail_path.open("w") as df:
        for qa in qa_pairs:
            contract_id = qa["contract_id"]
            question = qa["question"]
            gold_answers = qa["answers"].get("text", [])

            pred_text = query_contract(nexum_url, corpus_id, contract_id, question, session)
            f1 = max_f1_over_answers(pred_text, gold_answers)
            f1_scores.append(f1)

            # Has-answer accuracy: gold is empty list when answer is "no"
            gold_has_answer = len(gold_answers) > 0
            pred_has_answer = len(pred_text.strip()) > 0
            has_answer_correct.append(float(gold_has_answer == pred_has_answer))

            df.write(
                json.dumps(
                    {
                        "id": qa["id"],
                        "f1": f1,
                        "has_answer_correct": has_answer_correct[-1],
                        "pred": pred_text[:300],
                        "gold": gold_answers[:3],
                    }
                )
                + "\n"
            )

    n = len(qa_pairs)
    summary = {
        "n_questions": n,
        "corpus_id": corpus_id,
        "mean_f1": sum(f1_scores) / n,
        "has_answer_accuracy": sum(has_answer_correct) / n,
    }
    (output_dir / "cuad_summary.json").write_text(json.dumps(summary, indent=2))
    logger.info(
        "Mean F1: %.4f  Has-answer accuracy: %.4f",
        summary["mean_f1"],
        summary["has_answer_accuracy"],
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="CUAD evaluation against Nexum")
    parser.add_argument("--nexum-url", default="http://localhost:3000")
    parser.add_argument("--contracts", default="data/cuad/contracts.jsonl", type=Path)
    parser.add_argument("--qa", default="data/cuad/qa.jsonl", type=Path)
    parser.add_argument("--corpus-id", default=None)
    parser.add_argument("--max-questions", type=int, default=1000)
    parser.add_argument("--output", default="results/cuad", type=Path)
    args = parser.parse_args()

    run_eval(
        nexum_url=args.nexum_url,
        contracts_path=args.contracts,
        qa_path=args.qa,
        output_dir=args.output,
        corpus_id=args.corpus_id,
        max_questions=args.max_questions,
    )


if __name__ == "__main__":
    main()
