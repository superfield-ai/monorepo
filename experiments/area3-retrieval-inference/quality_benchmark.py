"""
quality_benchmark.py — Small-scale retrieval-augmented inference quality
benchmark for issue #10 (Area 3, H3.1 quality slice).

Measures **attribution F1** and **factual correctness** of the Nexum
graph-resident retrieval substrate against a flat-vector baseline RAG, on a
50-100 question subset (CUAD or synthetic). Both systems use the same
:class:`~inference_client_adapter.InferenceClient` seam; the only difference
is the ``mode`` argument:

  - baseline RAG  -> mode="vector"  (flat ANN over block embeddings)
  - graph RAG     -> mode="graph"   (typed-link traversal)

The benchmark answers the issue's quality question without coupling to any
particular LLM provider: factual correctness is measured by gold-span
containment in the retrieved-and-scored evidence (the ``score()`` half of the
seam picks the top-scoring block as the "answer-bearing" block). This keeps
the benchmark reproducible in CI and honest when no API key is present —
LLM-as-judge can be swapped in later by replacing
:func:`_judge_factual_correctness`.

The result is written through :mod:`experiments._lib.results_writer` so the
auto orchestrator and ``scripts/update-hypothesis-status.sh`` can find the
artefact under the canonical envelope shape.

Canonical references:
- src/inference/client.ts                            (Phase-2 seam)
- docs/research/hypotheses/H3.1_*.md                 (target hypothesis)
- docs/research/methodology.md                       (envelope shape)
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Metric primitives
# ---------------------------------------------------------------------------


def _normalize(s: str) -> str:
    """Lowercase + collapse whitespace; matches g2-wedge attribution_eval."""
    return re.sub(r"\s+", " ", s.strip().lower())


def _contains(text: str, needle: str) -> bool:
    return _normalize(needle) in _normalize(text)


def attribution_f1(
    citations: list[dict],
    gold_span: str,
    gold_doc_id: str | None = None,
) -> dict[str, Any]:
    """Compute attribution precision, recall, and F1 for one question.

    Definitions match the G2 wedge demo so cross-area numbers are comparable:
        precision = |cited blocks containing gold span| / |cited blocks|
        recall    = 1 if any cited block is from gold_doc_id else 0
        f1        = harmonic mean (0 when either is 0)
    When ``gold_doc_id`` is None, recall falls back to "any cited block
    contains the gold span" so the metric is well-defined on synthetic
    fixtures that lack document identity.
    """
    if not citations:
        return {
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
            "n_cited": 0,
            "n_correct": 0,
        }

    n_cited = len(citations)
    n_correct = sum(1 for c in citations if _contains(c.get("text", ""), gold_span))
    precision = n_correct / n_cited

    if gold_doc_id is not None:
        recall = 1.0 if any(c.get("doc_id") == gold_doc_id for c in citations) else 0.0
    else:
        recall = 1.0 if n_correct > 0 else 0.0

    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "n_cited": n_cited,
        "n_correct": n_correct,
    }


def _judge_factual_correctness(
    answer_text: str, gold_span: str
) -> bool:
    """Substring judge: True iff the gold span appears in the answer text.

    The "answer text" is the top-1 scored evidence block's text — i.e. the
    block the seam's ``score()`` ranks highest. This is a deliberately
    conservative, LLM-free judge so the benchmark stays reproducible in CI.
    Replace with an LLM-as-judge call in higher-fidelity follow-ups.
    """
    return _contains(answer_text, gold_span)


# ---------------------------------------------------------------------------
# Per-question evaluation
# ---------------------------------------------------------------------------


@dataclass
class QuestionResult:
    question: str
    gold_answer: str
    mode: str
    n_blocks: int
    top_block_id: str | None
    top_block_text: str
    factual_correct: bool
    attribution: dict[str, Any]
    retrieval_latency_ms: float
    score_latency_ms: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "gold_answer": self.gold_answer,
            "mode": self.mode,
            "n_blocks": self.n_blocks,
            "top_block_id": self.top_block_id,
            "top_block_text": self.top_block_text[:240],
            "factual_correct": self.factual_correct,
            "attribution": self.attribution,
            "retrieval_latency_ms": round(self.retrieval_latency_ms, 3),
            "score_latency_ms": round(self.score_latency_ms, 3),
        }


def evaluate_question(
    client: Any,
    question: dict,
    mode: str,
) -> QuestionResult:
    """Run one question through the InferenceClient seam and score it.

    Parameters
    ----------
    client:
        Anything implementing the :class:`InferenceClient` protocol (the
        in-memory client for tests/CI; the HTTP client for live runs).
    question:
        ``{question, gold_answer, [gold_doc_id]}``.
    mode:
        One of ``"vector" | "graph" | "hybrid"`` — passed verbatim to the seam.
    """
    q_text = question["question"]
    gold = question.get("gold_answer", "")
    gold_doc = question.get("gold_doc_id")

    t_r = time.perf_counter()
    rresult = client.retrieve(q_text, mode)
    retrieval_ms = (time.perf_counter() - t_r) * 1000.0

    blocks = list(rresult.blocks)
    if not blocks:
        return QuestionResult(
            question=q_text,
            gold_answer=gold,
            mode=mode,
            n_blocks=0,
            top_block_id=None,
            top_block_text="",
            factual_correct=False,
            attribution={"precision": 0.0, "recall": 0.0, "f1": 0.0,
                         "n_cited": 0, "n_correct": 0},
            retrieval_latency_ms=retrieval_ms,
            score_latency_ms=0.0,
        )

    t_s = time.perf_counter()
    scores = client.score(q_text, blocks)
    score_ms = (time.perf_counter() - t_s) * 1000.0

    # Pick the top-scoring block as the "answer-bearing" evidence.
    score_by_id = {s.block_id: s.score for s in scores}
    blocks.sort(key=lambda b: score_by_id.get(b.block_id, b.score), reverse=True)
    top = blocks[0]

    citations = [{"text": b.text, "doc_id": b.doc_id} for b in blocks]
    attr = attribution_f1(citations, gold_span=gold, gold_doc_id=gold_doc)
    correct = _judge_factual_correctness(top.text, gold)

    return QuestionResult(
        question=q_text,
        gold_answer=gold,
        mode=mode,
        n_blocks=len(blocks),
        top_block_id=top.block_id,
        top_block_text=top.text,
        factual_correct=correct,
        attribution=attr,
        retrieval_latency_ms=retrieval_ms,
        score_latency_ms=score_ms,
    )


# ---------------------------------------------------------------------------
# Mode-level aggregation
# ---------------------------------------------------------------------------


@dataclass
class ModeSummary:
    mode: str
    n_questions: int
    factual_correctness: float
    mean_attribution_f1: float
    mean_attribution_precision: float
    mean_attribution_recall: float
    p50_retrieval_ms: float
    per_question: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "n_questions": self.n_questions,
            "factual_correctness": round(self.factual_correctness, 4),
            "mean_attribution_f1": round(self.mean_attribution_f1, 4),
            "mean_attribution_precision": round(self.mean_attribution_precision, 4),
            "mean_attribution_recall": round(self.mean_attribution_recall, 4),
            "p50_retrieval_ms": round(self.p50_retrieval_ms, 3),
            "per_question": self.per_question,
        }


def _p50(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[len(s) // 2]


def evaluate_mode(
    client: Any,
    questions: Iterable[dict],
    mode: str,
) -> ModeSummary:
    """Run the whole question set under a single retrieval mode."""
    results: list[QuestionResult] = []
    for q in questions:
        results.append(evaluate_question(client, q, mode))

    n = len(results)
    if n == 0:
        return ModeSummary(mode=mode, n_questions=0, factual_correctness=0.0,
                           mean_attribution_f1=0.0,
                           mean_attribution_precision=0.0,
                           mean_attribution_recall=0.0,
                           p50_retrieval_ms=0.0, per_question=[])

    correctness = sum(1 for r in results if r.factual_correct) / n
    mean_f1 = sum(r.attribution["f1"] for r in results) / n
    mean_p = sum(r.attribution["precision"] for r in results) / n
    mean_r = sum(r.attribution["recall"] for r in results) / n
    p50 = _p50([r.retrieval_latency_ms for r in results])

    return ModeSummary(
        mode=mode,
        n_questions=n,
        factual_correctness=correctness,
        mean_attribution_f1=mean_f1,
        mean_attribution_precision=mean_p,
        mean_attribution_recall=mean_r,
        p50_retrieval_ms=p50,
        per_question=[r.to_dict() for r in results],
    )


# ---------------------------------------------------------------------------
# Comparative (graph vs baseline) entrypoint
# ---------------------------------------------------------------------------


def run_quality_benchmark(
    client: Any,
    questions: list[dict],
    *,
    modes: tuple[str, ...] = ("vector", "graph"),
) -> dict[str, Any]:
    """Run the small-scale quality benchmark across modes and emit a summary.

    The default modes pair compares flat-vector ANN ("baseline RAG") against
    the typed-link graph traversal that is Area 3's substrate. ``hybrid`` is
    accepted but optional — H3.1 is satisfied if either ``graph`` or
    ``hybrid`` shows a positive delta on factual correctness.

    Returns a dict ready to drop into a ResultEnvelope's ``metrics`` field.
    """
    by_mode: dict[str, ModeSummary] = {}
    for mode in modes:
        by_mode[mode] = evaluate_mode(client, questions, mode)

    baseline = by_mode.get("vector")
    treatment = by_mode.get("graph") or by_mode.get("hybrid")

    deltas: dict[str, Any] = {}
    if baseline is not None and treatment is not None:
        deltas = {
            "treatment_mode": treatment.mode,
            "factual_correctness_delta": round(
                treatment.factual_correctness - baseline.factual_correctness, 4
            ),
            "attribution_f1_delta": round(
                treatment.mean_attribution_f1 - baseline.mean_attribution_f1, 4
            ),
            "h3_1_supported": (
                treatment.factual_correctness > baseline.factual_correctness
            ),
        }

    return {
        "n_questions": len(questions),
        "modes": [m.to_dict() for m in by_mode.values()],
        "deltas": deltas,
    }


# ---------------------------------------------------------------------------
# Result envelope writer
# ---------------------------------------------------------------------------


def write_quality_envelope(
    metrics: dict[str, Any],
    *,
    area_dir: str | Path = "experiments/area3-retrieval-inference",
    seed: int = 0,
    notes: str | None = None,
) -> Path:
    """Persist the benchmark result through the canonical envelope.

    Importing the writer is deferred so this module stays importable in
    minimal environments that lack the repo-root layout (e.g. when copied
    into a notebook).
    """
    from experiments._lib.results_writer import ResultEnvelope, write_result
    from experiments._lib.runner import capture_run_context

    deltas = metrics.get("deltas") or {}
    passed = bool(deltas.get("h3_1_supported", False))

    envelope = ResultEnvelope(
        gate="H3.1",
        hypothesis="H3.1",
        passed=passed,
        metrics=metrics,
        runtime=capture_run_context(gate="H3.1", hypothesis="H3.1", seed=seed),
        notes=notes,
    )
    return write_result(envelope, area_dir=area_dir)
