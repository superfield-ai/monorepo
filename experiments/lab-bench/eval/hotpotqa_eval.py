"""
HotpotQA evaluation: multi-hop answer accuracy and Supporting Fact F1.

Supporting Fact F1 is the primary metric for Nexum's attribution claim:
given a multi-hop question, can Nexum return the specific supporting sentences
that the answer depends on?

This script:
1. Ingests HotpotQA Wikipedia paragraphs into a Nexum corpus
2. Issues each question as a Nexum graph-traversal query
3. Computes Answer EM/F1 and Supporting Fact F1 against gold labels

Usage:
  python eval/hotpotqa_eval.py \
    --nexum-url http://localhost:3000 \
    --questions data/hotpotqa/questions.jsonl \
    --corpus data/hotpotqa/corpus.jsonl \
    --output results/hotpotqa
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import string
from collections import Counter
from pathlib import Path

import requests

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Metric helpers (from HotpotQA official eval script)
# ---------------------------------------------------------------------------

def normalize_answer(s: str) -> str:
    def remove_articles(text: str) -> str:
        return re.sub(r"\b(a|an|the)\b", " ", text)

    def white_space_fix(text: str) -> str:
        return " ".join(text.split())

    def remove_punc(text: str) -> str:
        exclude = set(string.punctuation)
        return "".join(ch for ch in text if ch not in exclude)

    def lower(text: str) -> str:
        return text.lower()

    return white_space_fix(remove_articles(remove_punc(lower(s))))


def f1_score(prediction: str, ground_truth: str) -> tuple[float, float, float]:
    pred_tokens = normalize_answer(prediction).split()
    gold_tokens = normalize_answer(ground_truth).split()
    common = Counter(pred_tokens) & Counter(gold_tokens)
    n_same = sum(common.values())
    if n_same == 0:
        return 0.0, 0.0, 0.0
    precision = n_same / len(pred_tokens)
    recall = n_same / len(gold_tokens)
    f1 = 2 * precision * recall / (precision + recall)
    return f1, precision, recall


def exact_match(prediction: str, ground_truth: str) -> float:
    return float(normalize_answer(prediction) == normalize_answer(ground_truth))


def supporting_fact_f1(
    pred_titles: list[str],
    pred_sents: list[int],
    gold_titles: list[str],
    gold_sents: list[int],
) -> tuple[float, float, float]:
    pred_set = set(zip(pred_titles, pred_sents))
    gold_set = set(zip(gold_titles, gold_sents))
    if not pred_set or not gold_set:
        return 0.0, 0.0, 0.0
    n_common = len(pred_set & gold_set)
    precision = n_common / len(pred_set)
    recall = n_common / len(gold_set)
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return f1, precision, recall


# ---------------------------------------------------------------------------
# Nexum helpers
# ---------------------------------------------------------------------------

def ingest_corpus(nexum_url: str, corpus_path: Path, session: requests.Session) -> str:
    resp = session.post(
        f"{nexum_url}/corpora",
        json={"name": "hotpotqa-wikipedia", "description": "HotpotQA Wikipedia paragraphs"},
    )
    resp.raise_for_status()
    corpus_id: str = resp.json()["id"]
    logger.info("Created corpus %s", corpus_id)

    with corpus_path.open() as f:
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
            if (i + 1) % 1000 == 0:
                logger.info("Ingested %d paragraphs", i + 1)

    logger.info("Corpus ingestion complete")
    return corpus_id


def query_nexum(
    nexum_url: str,
    corpus_id: str,
    question: str,
    session: requests.Session,
    top_k: int = 10,
) -> list[dict]:
    resp = session.post(
        f"{nexum_url}/query",
        json={
            "corpus_id": corpus_id,
            "query": question,
            "mode": "graph",
            "limit": top_k,
        },
    )
    resp.raise_for_status()
    return resp.json().get("results", [])


# ---------------------------------------------------------------------------
# Main eval
# ---------------------------------------------------------------------------

def run_eval(
    nexum_url: str,
    questions_path: Path,
    corpus_path: Path,
    output_dir: Path,
    corpus_id: str | None = None,
    max_questions: int | None = None,
    top_k: int = 10,
) -> dict:
    session = requests.Session()
    output_dir.mkdir(parents=True, exist_ok=True)

    if corpus_id is None:
        corpus_id = ingest_corpus(nexum_url, corpus_path, session)

    questions = []
    with questions_path.open() as f:
        for line in f:
            questions.append(json.loads(line))
            if max_questions and len(questions) >= max_questions:
                break

    logger.info("Evaluating %d questions (corpus %s)…", len(questions), corpus_id)

    answer_em_scores: list[float] = []
    answer_f1_scores: list[float] = []
    sp_f1_scores: list[float] = []

    detail_path = output_dir / "hotpotqa_detail.jsonl"
    with detail_path.open("w") as detail_f:
        for q in questions:
            hits = query_nexum(nexum_url, corpus_id, q["question"], session, top_k=top_k)

            # Use the top hit's block text as the predicted answer (naïve extraction)
            pred_answer = hits[0]["text"] if hits else ""
            gold_answer = q["answer"]

            em = exact_match(pred_answer, gold_answer)
            f1, _, _ = f1_score(pred_answer, gold_answer)
            answer_em_scores.append(em)
            answer_f1_scores.append(f1)

            # Supporting fact evaluation: map returned blocks to (title, sent_idx)
            pred_titles = [h.get("document", {}).get("title", "") for h in hits]
            pred_sents = [0] * len(hits)  # block-level; sentence index approximated as 0

            gold_sf = q.get("supporting_facts", {})
            gold_titles = gold_sf.get("title", [])
            gold_sents = gold_sf.get("sent_id", [])

            sp_f1, _, _ = supporting_fact_f1(pred_titles, pred_sents, gold_titles, gold_sents)
            sp_f1_scores.append(sp_f1)

            detail_f.write(
                json.dumps(
                    {
                        "id": q["id"],
                        "answer_em": em,
                        "answer_f1": f1,
                        "sp_f1": sp_f1,
                        "pred_answer": pred_answer[:200],
                        "gold_answer": gold_answer,
                    }
                )
                + "\n"
            )

    n = len(questions)
    summary = {
        "n_questions": n,
        "corpus_id": corpus_id,
        "answer_em": sum(answer_em_scores) / n,
        "answer_f1": sum(answer_f1_scores) / n,
        "supporting_fact_f1": sum(sp_f1_scores) / n,
    }
    (output_dir / "hotpotqa_summary.json").write_text(json.dumps(summary, indent=2))

    logger.info(
        "Answer EM: %.4f  Answer F1: %.4f  Supporting Fact F1: %.4f",
        summary["answer_em"],
        summary["answer_f1"],
        summary["supporting_fact_f1"],
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="HotpotQA evaluation against Nexum")
    parser.add_argument("--nexum-url", default="http://localhost:3000")
    parser.add_argument("--questions", default="data/hotpotqa/questions.jsonl", type=Path)
    parser.add_argument("--corpus", default="data/hotpotqa/corpus.jsonl", type=Path)
    parser.add_argument("--corpus-id", default=None, help="Reuse an existing ingested corpus")
    parser.add_argument("--max-questions", type=int, default=500)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--output", default="results/hotpotqa", type=Path)
    args = parser.parse_args()

    run_eval(
        nexum_url=args.nexum_url,
        questions_path=args.questions,
        corpus_path=args.corpus,
        output_dir=args.output,
        corpus_id=args.corpus_id,
        max_questions=args.max_questions,
        top_k=args.top_k,
    )


if __name__ == "__main__":
    main()
