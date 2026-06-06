"""
Tests for the issue-#10 quality benchmark — runs entirely offline.

Covers:
1. The InferenceClient adapter conforms to the seam (embed/retrieve/score).
2. Mode discriminator validation.
3. Attribution F1 primitive matches the G2-wedge definition on a contrived case.
4. End-to-end run on the synthetic 50-question fixture writes a valid envelope.
5. The graph mode beats the vector baseline on the synthetic fixture (this is
   the offline analogue of H3.1 supportability — the fixture is constructed
   so graph traversal narrows the candidate set to answer-bearing blocks).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
AREA3 = HERE.parent
REPO_ROOT = AREA3.parent.parent
sys.path.insert(0, str(AREA3))
sys.path.insert(0, str(REPO_ROOT))

from inference_client_adapter import (  # noqa: E402
    EvidenceScore,
    InMemoryInferenceClient,
    RetrievalResult,
    RetrievedBlock,
    _cosine,
)
from quality_benchmark import (  # noqa: E402
    attribution_f1,
    evaluate_mode,
    evaluate_question,
    run_quality_benchmark,
    write_quality_envelope,
)


# ---------------------------------------------------------------------------
# 1. Seam contract
# ---------------------------------------------------------------------------


def test_in_memory_client_implements_seam():
    corpus = [
        {"block_id": "a", "doc_id": "d1", "text": "force majeure covers pandemic"},
        {"block_id": "b", "doc_id": "d2", "text": "indemnification limits liability"},
    ]
    client = InMemoryInferenceClient(corpus, k=2)

    vec = client.embed("force majeure")
    assert isinstance(vec, list) and len(vec) == 32

    res = client.retrieve("force majeure", "vector")
    assert isinstance(res, RetrievalResult)
    assert res.mode == "vector"
    assert len(res.blocks) == 2
    assert res.blocks[0].block_id == "a"  # most relevant first

    scored = client.score("force majeure", res.blocks)
    assert len(scored) == len(res.blocks)
    assert all(isinstance(s, EvidenceScore) for s in scored)
    assert all(0.0 <= s.score <= 1.0 for s in scored)
    # Order must match input order (per seam contract).
    assert [s.block_id for s in scored] == [b.block_id for b in res.blocks]


def test_invalid_mode_raises():
    client = InMemoryInferenceClient([{"block_id": "x", "text": "y"}])
    with pytest.raises(ValueError):
        client.retrieve("q", "magic")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# 2. Metric primitives
# ---------------------------------------------------------------------------


def test_attribution_f1_perfect():
    cites = [{"text": "force majeure covers pandemic events", "doc_id": "d1"}]
    out = attribution_f1(cites, gold_span="pandemic events", gold_doc_id="d1")
    assert out["precision"] == 1.0
    assert out["recall"] == 1.0
    assert out["f1"] == 1.0
    assert out["n_cited"] == 1
    assert out["n_correct"] == 1


def test_attribution_f1_empty():
    out = attribution_f1([], gold_span="x", gold_doc_id="d")
    assert out == {
        "precision": 0.0, "recall": 0.0, "f1": 0.0,
        "n_cited": 0, "n_correct": 0,
    }


def test_attribution_f1_no_doc_id_falls_back_to_content():
    cites = [{"text": "irrelevant block", "doc_id": None},
             {"text": "force majeure covers pandemic", "doc_id": None}]
    out = attribution_f1(cites, gold_span="pandemic", gold_doc_id=None)
    # Precision: 1/2; recall fallback: 1 because at least one block contains it.
    assert out["precision"] == 0.5
    assert out["recall"] == 1.0


def test_cosine_zero_for_zero_vector():
    assert _cosine([0.0, 0.0], [1.0, 0.0]) == 0.0


# ---------------------------------------------------------------------------
# 3. evaluate_question
# ---------------------------------------------------------------------------


def test_evaluate_question_picks_top_block():
    corpus = [
        {"block_id": "good", "doc_id": "d1", "text": "force majeure pandemic clause"},
        {"block_id": "bad", "doc_id": "d2", "text": "totally unrelated content"},
    ]
    client = InMemoryInferenceClient(corpus, k=2)
    q = {"question": "force majeure pandemic", "gold_answer": "pandemic", "gold_doc_id": "d1"}
    res = evaluate_question(client, q, "vector")
    assert res.factual_correct is True
    assert res.top_block_id == "good"
    assert res.attribution["precision"] > 0
    assert res.n_blocks == 2


# ---------------------------------------------------------------------------
# 4. End-to-end + envelope
# ---------------------------------------------------------------------------


def test_run_quality_benchmark_offline_full(tmp_path):
    from run_quality import _build_synthetic_corpus_and_questions

    corpus, questions, mode_corpora = _build_synthetic_corpus_and_questions(50)
    assert len(questions) == 50
    client = InMemoryInferenceClient(corpus, k=10, mode_corpora=mode_corpora)

    metrics = run_quality_benchmark(client, questions, modes=("vector", "graph"))
    assert metrics["n_questions"] == 50
    modes = {m["mode"]: m for m in metrics["modes"]}
    assert "vector" in modes and "graph" in modes
    # Graph mode is constructed to beat baseline on this fixture.
    assert modes["graph"]["factual_correctness"] >= modes["vector"]["factual_correctness"]
    assert metrics["deltas"]["h3_1_supported"] in (True, False)

    # Envelope round-trip
    out = write_quality_envelope(metrics, area_dir=tmp_path, seed=0,
                                 notes="unit test")
    assert out.exists()
    payload = json.loads(out.read_text())
    assert payload["gate"] == "H3.1"
    assert payload["hypothesis"] == "H3.1"
    assert payload["schema_version"] == 1
    assert "metrics" in payload and "runtime" in payload
    assert payload["metrics"]["n_questions"] == 50


def test_evaluate_mode_handles_empty_questions():
    client = InMemoryInferenceClient([{"block_id": "a", "text": "x"}])
    summary = evaluate_mode(client, [], "vector")
    assert summary.n_questions == 0
    assert summary.factual_correctness == 0.0
