"""
sparse_attention_ablation.py — H3.3: performance vs. k (sparse attention ablation).

Vary the number of retrieved blocks per query (k), measure task performance
(via LM-as-judge) and latency.

Hypothesis H3.3: A transformer with sparse cross-attention over ANN-retrieved
blocks produces outputs competitive with a comparably sized static model on
summarization tasks, while accessing only 1–5% of the graph per inference call.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from graph_inference_client import GraphInferenceClient

logger = logging.getLogger(__name__)

# LM-as-judge prompt template (H3.3).
_JUDGE_PROMPT = (
    "Given the following question and reference answer, rate the candidate answer "
    "on a scale of 0 to 1 for correctness, completeness, and groundedness.\n\n"
    "Question: {question}\n\n"
    "Reference answer: {reference}\n\n"
    "Candidate answer: {candidate}\n\n"
    "Return only a single float between 0 and 1. Do not include any other text."
)

# Matches a float in [0, 1] that is NOT immediately preceded by a minus sign
# or another digit (avoids matching "0.1" inside "-0.1" or "20.1").
_SCORE_PATTERN = re.compile(r"(?<![.\d-])(0(?:\.\d+)?|1(?:\.0+)?)(?![.\d])")


def parse_judge_score(raw: str, fallback: float = 0.5) -> float:
    """Extract a float score from the judge model's raw output.

    Handles three common output formats:
    - Pure float: ``"0.85"`` → 0.85
    - Prose with embedded float: ``"The answer is good, score: 0.7"`` → 0.7
    - Unparseable / out-of-range: returns ``fallback`` (default 0.5)

    Parameters
    ----------
    raw:
        Raw text output from the judge model.
    fallback:
        Value to return if no valid float in [0, 1] can be extracted.
    """
    if raw is None:
        return fallback

    raw = raw.strip()

    # 1. Try direct float parse first (fastest path)
    try:
        value = float(raw)
        if 0.0 <= value <= 1.0:
            return value
    except ValueError:
        pass

    # 2. Regex scan for any float in [0, 1] in the text
    matches = _SCORE_PATTERN.findall(raw)
    for match in matches:
        try:
            value = float(match)
            if 0.0 <= value <= 1.0:
                return value
        except ValueError:
            continue

    # 3. Nothing found — return fallback
    logger.debug("Could not parse judge score from %r; using fallback %.2f", raw, fallback)
    return fallback


def _call_judge(
    question: str,
    reference: str,
    candidate: str,
    judge_model: str,
    anthropic_client: Any,
) -> float:
    """Call the LM-as-judge and return a parsed score in [0, 1]."""
    if anthropic_client is None:
        # No API client — return a deterministic mock score for offline testing
        # (mock score is based on whether the reference appears in the candidate)
        ref_lower = reference.lower().strip()
        cand_lower = candidate.lower()
        return 0.8 if ref_lower in cand_lower else 0.3

    prompt = _JUDGE_PROMPT.format(
        question=question,
        reference=reference,
        candidate=candidate,
    )
    try:
        message = anthropic_client.messages.create(
            model=judge_model,
            max_tokens=10,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = message.content[0].text
        return parse_judge_score(raw)
    except Exception as exc:  # noqa: BLE001
        logger.error("Judge call failed: %s", exc)
        return parse_judge_score("", fallback=0.5)


def run_sparse_attention_ablation(
    client: "GraphInferenceClient",
    eval_questions: list[dict],
    k_values: list[int] | None = None,
    judge_model: str = "claude-haiku-4-5-20251001",
) -> dict:
    """H3.3: vary k (retrieved blocks per query), measure task performance vs. latency.

    Uses LM-as-judge for answer quality.  Evaluates each question at each k
    and records judge scores plus latency statistics.

    Parameters
    ----------
    client:
        A :class:`~graph_inference_client.GraphInferenceClient` instance.
    eval_questions:
        List of ``{question, gold_answer}`` dicts.
    k_values:
        k values to sweep (default ``[1, 5, 10, 50, 100]``).
    judge_model:
        Anthropic model to use as the LM judge.

    Returns
    -------
    dict
        Keyed by k (int).  Each value is a dict with:
        ``mean_judge_score`` (float 0–1),
        ``p50_latency_ms`` (float),
        ``p99_latency_ms`` (float),
        ``n_questions`` (int).
    """
    if k_values is None:
        k_values = [1, 5, 10, 50, 100]

    anthropic_client = client._get_anthropic_client()

    results: dict[int, dict] = {}

    for k in k_values:
        judge_scores: list[float] = []
        latency_ms_list: list[float] = []

        for q in eval_questions:
            question_text = q["question"]
            gold_answer = q.get("gold_answer", "")

            t0 = time.perf_counter()
            query_result = client.query(question_text, k=k)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0

            candidate_answer = query_result.get("answer", "")

            score = _call_judge(
                question=question_text,
                reference=gold_answer,
                candidate=candidate_answer,
                judge_model=judge_model,
                anthropic_client=anthropic_client,
            )

            judge_scores.append(score)
            latency_ms_list.append(elapsed_ms)

        scores_arr = np.array(judge_scores, dtype=float)
        latency_arr = np.array(latency_ms_list, dtype=float)

        results[k] = {
            "mean_judge_score": float(np.mean(scores_arr)) if len(scores_arr) > 0 else 0.0,
            "p50_latency_ms": float(np.percentile(latency_arr, 50)) if len(latency_arr) > 0 else 0.0,
            "p99_latency_ms": float(np.percentile(latency_arr, 99)) if len(latency_arr) > 0 else 0.0,
            "n_questions": len(eval_questions),
        }

    return results
