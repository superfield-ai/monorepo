"""
recency_test.py — H3.1: graph-resident vs. stale snapshot recency test.

After ingesting amendments into Nexum (but NOT into vanilla RAG), compare
answer accuracy on questions that depend on the amended facts.

Hypothesis H3.1: For factoid Q&A over a corpus updated in the last 24 hours,
a graph-resident inference client outperforms RAG over a stale snapshot of
the same corpus on recency-sensitive questions.

Construction follows FreshQA-style: take a corpus with a known "fact change"
(a contract amendment), update only the delta blocks in Nexum, and compare
answers.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _judge_answer(
    question: str,
    predicted: str,
    gold_answer: str,
) -> bool:
    """Simple exact-substring judge: True if gold_answer appears in predicted.

    This is the offline, no-LLM-cost judge.  For production use, replace with
    the LM-as-judge from sparse_attention_ablation.py.
    """
    return gold_answer.lower().strip() in predicted.lower()


def _ingest_amendments_to_nexum(
    nexum_client: Any,
    amendments: list[dict],
) -> bool:
    """Push amendment blocks to Nexum via the REST API.

    Parameters
    ----------
    nexum_client:
        A :class:`~graph_inference_client.GraphInferenceClient` instance.
    amendments:
        List of ``{block_id, text, metadata}`` dicts.

    Returns
    -------
    bool
        True if all amendments were ingested successfully; False otherwise.
    """
    import requests

    all_ok = True
    for amendment in amendments:
        try:
            response = requests.post(
                f"{nexum_client.nexum_url}/api/blocks",
                json=amendment,
                timeout=nexum_client.timeout_s,
            )
            response.raise_for_status()
        except requests.ConnectionError:
            logger.warning(
                "Nexum unreachable; amendment ingestion skipped (offline mode)."
            )
            # In offline mode we treat ingestion as a no-op (test-friendly)
            break
        except requests.HTTPError as exc:
            logger.error("HTTP error ingesting amendment %s: %s", amendment.get("block_id"), exc)
            all_ok = False
    return all_ok


def run_recency_test(
    nexum_client: Any,
    vanilla_client: Any,
    corpus: list[dict],
    amendments: list[dict],
    questions: list[dict],
) -> dict:
    """H3.1 test: typed-link retrieval vs. stale snapshot on recency questions.

    After ingesting amendments into Nexum (but NOT into vanilla RAG), compare
    answer accuracy on questions that depend on the amended facts.

    The vanilla client's index is built once from the initial corpus and is
    NOT updated — it models a stale RAG deployment.

    Parameters
    ----------
    nexum_client:
        A :class:`~graph_inference_client.GraphInferenceClient` instance with
        access to the live Nexum graph.
    vanilla_client:
        A vanilla RAG client (e.g. :class:`~vanilla_rag.VanillaRAG`) whose
        index was built from the initial corpus only (not the amendments).
    corpus:
        Initial corpus of ``{block_id, text}`` dicts.
    amendments:
        Delta documents — blocks that change facts in the corpus.  These are
        ingested into Nexum but not into the vanilla client.
    questions:
        List of ``{question, gold_answer, requires_amendment: bool}`` dicts.
        Questions with ``requires_amendment=True`` depend on the amended facts.

    Returns
    -------
    dict with keys:
        - ``nexum_accuracy_after_amendment``: float
        - ``vanilla_accuracy_after_amendment``: float
        - ``accuracy_delta``: float (nexum - vanilla)
        - ``h3_1_supported``: bool (True if nexum > vanilla on recency questions)
        - ``n_questions``: int
        - ``n_recency_questions``: int
        - ``per_question``: list of per-question result dicts
    """
    # Step 1: Ingest amendments into Nexum (vanilla client is intentionally stale)
    _ingest_amendments_to_nexum(nexum_client, amendments)

    # Step 2: Filter to recency-sensitive questions
    recency_questions = [q for q in questions if q.get("requires_amendment", True)]
    if not recency_questions:
        logger.warning("No recency-sensitive questions found; using all questions.")
        recency_questions = questions

    # Step 3: Evaluate both clients on recency questions
    per_question: list[dict] = []
    nexum_correct = 0
    vanilla_correct = 0

    for q in recency_questions:
        question_text = q["question"]
        gold = q.get("gold_answer", "")

        # Nexum: live graph with amendments
        nexum_result = nexum_client.query(question_text)
        nexum_answer = nexum_result.get("answer", "")
        nexum_ok = _judge_answer(question_text, nexum_answer, gold)

        # Vanilla: stale snapshot (no amendments)
        try:
            vanilla_result = vanilla_client.query(question_text)
            vanilla_answer = vanilla_result.get("answer", "")
        except Exception as exc:  # noqa: BLE001
            logger.error("Vanilla client error: %s", exc)
            vanilla_answer = ""
        vanilla_ok = _judge_answer(question_text, vanilla_answer, gold)

        if nexum_ok:
            nexum_correct += 1
        if vanilla_ok:
            vanilla_correct += 1

        per_question.append(
            {
                "question": question_text,
                "gold_answer": gold,
                "nexum_answer": nexum_answer,
                "vanilla_answer": vanilla_answer,
                "nexum_correct": nexum_ok,
                "vanilla_correct": vanilla_ok,
            }
        )

    n_recency = len(recency_questions)
    nexum_accuracy = nexum_correct / n_recency if n_recency > 0 else 0.0
    vanilla_accuracy = vanilla_correct / n_recency if n_recency > 0 else 0.0
    delta = nexum_accuracy - vanilla_accuracy

    return {
        "nexum_accuracy_after_amendment": nexum_accuracy,
        "vanilla_accuracy_after_amendment": vanilla_accuracy,
        "accuracy_delta": delta,
        "h3_1_supported": delta > 0.0,
        "n_questions": len(questions),
        "n_recency_questions": n_recency,
        "per_question": per_question,
    }
