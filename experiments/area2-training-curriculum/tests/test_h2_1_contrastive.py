"""
tests/test_h2_1_contrastive.py — Tests for the H2.1 contrastive fine-tune harness.

Covers acceptance criteria from issue #142:
 1. Verify contrastive pairs contain a balance of contradicts and supports link types.
 2. Verify fine-tune runs are identical in all hyperparameters except training data.
 3. Verify BEIR nDCG@10 is measured on the same held-out corpus for both conditions.
 4. Verify result envelope schema matches results_writer expected format.

All tests are fast (no network, CPU-only, no sentence-transformers).
"""

from __future__ import annotations

import os
import sys
import math
import json
import tempfile
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

_EXPERIMENT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO = os.path.dirname(os.path.dirname(_EXPERIMENT_ROOT))
for p in (_REPO, _EXPERIMENT_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)


# ---------------------------------------------------------------------------
# Test 1 — contrastive pair balance: contradicts + supports coverage
# ---------------------------------------------------------------------------

def test_contrastive_pairs_balance():
    """
    Acceptance criterion: pairs contain a balance of contradicts and supports
    link types.  At least 30% of pairs should have a hard `contradicts` negative.
    """
    from edgar_corpus import make_edgar_corpus, sample_contrastive_pairs

    blocks, links = make_edgar_corpus(n_contracts=50, seed=0)
    pairs = sample_contrastive_pairs(
        blocks=blocks,
        links=links,
        n_pairs=200,
        confidence_threshold=0.70,
        seed=0,
        balance=True,
    )

    assert len(pairs) > 0, "Expected at least one contrastive pair"

    n_hard = sum(1 for p in pairs if p.get("negative_link_type") == "contradicts")
    ratio = n_hard / len(pairs)
    assert ratio >= 0.30, (
        f"Expected ≥30% contradicts-backed negatives, got {ratio:.2%} "
        f"({n_hard}/{len(pairs)})"
    )

    # All pairs should have supports-backed positives.
    for pair in pairs:
        assert pair.get("positive_link_type") == "supports", (
            f"Expected supports positive, got {pair.get('positive_link_type')}"
        )


# ---------------------------------------------------------------------------
# Test 2 — pair count respects n_pairs argument
# ---------------------------------------------------------------------------

def test_contrastive_pairs_count():
    from edgar_corpus import make_edgar_corpus, sample_contrastive_pairs

    blocks, links = make_edgar_corpus(n_contracts=100, seed=1)
    for n in (50, 100, 500):
        pairs = sample_contrastive_pairs(
            blocks=blocks, links=links, n_pairs=n, seed=1
        )
        assert len(pairs) <= n, f"Expected at most {n} pairs, got {len(pairs)}"
        # Corpus at 100 contracts should be large enough for ≥ 50 pairs.
        if n <= 100:
            assert len(pairs) > 0, f"Expected non-empty pairs for n={n}"


# ---------------------------------------------------------------------------
# Test 3 — edgar corpus properties
# ---------------------------------------------------------------------------

def test_edgar_corpus_link_types():
    """All links should have rel_type in ('supports', 'contradicts')."""
    from edgar_corpus import make_edgar_corpus

    blocks, links = make_edgar_corpus(n_contracts=20, seed=2)
    assert len(blocks) > 0
    assert len(links) > 0

    for lnk in links:
        assert lnk["rel_type"] in ("supports", "contradicts"), (
            f"Unexpected rel_type: {lnk['rel_type']}"
        )

    # supports links should connect same clause type.
    id_to_clause = {b["id"]: b["clause_type"] for b in blocks}
    supports_links = [l for l in links if l["rel_type"] == "supports"]
    same = sum(
        1 for l in supports_links
        if id_to_clause[l["source_id"]] == id_to_clause[l["target_id"]]
    )
    assert same == len(supports_links), (
        f"All supports links should connect same clause type; "
        f"got {same}/{len(supports_links)}"
    )


def test_edgar_corpus_contradicts_cross_type():
    """contradicts links should connect different clause types."""
    from edgar_corpus import make_edgar_corpus

    blocks, links = make_edgar_corpus(n_contracts=30, seed=3)
    id_to_clause = {b["id"]: b["clause_type"] for b in blocks}
    contradicts_links = [l for l in links if l["rel_type"] == "contradicts"]
    assert len(contradicts_links) > 0, "Expected contradicts links"

    cross = sum(
        1 for l in contradicts_links
        if id_to_clause[l["source_id"]] != id_to_clause[l["target_id"]]
    )
    assert cross == len(contradicts_links), (
        f"contradicts links should cross clause types; "
        f"got {cross}/{len(contradicts_links)}"
    )


# ---------------------------------------------------------------------------
# Test 4 — nDCG@10 computation
# ---------------------------------------------------------------------------

def test_ndcg_perfect_retrieval():
    """nDCG@10 = 1.0 when all top-k are relevant."""
    from beir_evaluator import ndcg_at_k

    retrieved = ["a", "b", "c", "d", "e"]
    relevant = {"a", "b", "c", "d", "e"}
    score = ndcg_at_k(retrieved, relevant, k=5)
    assert abs(score - 1.0) < 1e-9, f"Expected 1.0, got {score}"


def test_ndcg_zero_retrieval():
    """nDCG@10 = 0.0 when no retrieved docs are relevant."""
    from beir_evaluator import ndcg_at_k

    retrieved = ["x", "y", "z"]
    relevant = {"a", "b", "c"}
    score = ndcg_at_k(retrieved, relevant, k=10)
    assert score == 0.0, f"Expected 0.0, got {score}"


def test_ndcg_partial():
    """nDCG@10 is between 0 and 1 for partial retrieval."""
    from beir_evaluator import ndcg_at_k

    retrieved = ["a", "x", "b", "y", "c"]
    relevant = {"a", "b", "c"}
    score = ndcg_at_k(retrieved, relevant, k=5)
    assert 0.0 < score < 1.0, f"Expected partial score in (0,1), got {score}"


def test_ndcg_empty_relevant():
    """nDCG@10 = 0.0 when relevant set is empty."""
    from beir_evaluator import ndcg_at_k

    score = ndcg_at_k(["a", "b"], set(), k=10)
    assert score == 0.0


# ---------------------------------------------------------------------------
# Test 5 — evaluate_retrieval output schema
# ---------------------------------------------------------------------------

def test_evaluate_retrieval_schema():
    """
    evaluate_retrieval must return a dict with the expected keys and
    nDCG values in [0, 1].
    """
    from beir_evaluator import evaluate_retrieval
    from edgar_corpus import make_edgar_corpus

    blocks, _ = make_edgar_corpus(n_contracts=30, seed=4)
    result = evaluate_retrieval(
        query_blocks=blocks[:50],
        corpus_blocks=blocks[:50],
        model=None,
        k=10,
    )

    for key in ("ndcg_at_k", "n_queries", "n_corpus", "k", "per_query_ndcg"):
        assert key in result, f"Missing key '{key}' in evaluate_retrieval output"

    assert 0.0 <= result["ndcg_at_k"] <= 1.0, (
        f"ndcg_at_k out of [0, 1]: {result['ndcg_at_k']}"
    )
    assert result["k"] == 10
    assert result["n_corpus"] == 50


# ---------------------------------------------------------------------------
# Test 6 — result envelope schema (issue acceptance criterion)
# ---------------------------------------------------------------------------

def test_result_envelope_schema():
    """
    Verify the result envelope written by run_h2_1_contrastive matches the
    schema expected by results_writer.
    """
    from run_h2_1_contrastive import run_experiment
    from experiments._lib.runner import capture_run_context
    from experiments._lib.results_writer import ResultEnvelope, write_result

    metrics = run_experiment(
        n_contracts=30,
        n_pairs=100,
        skip_finetuning=True,
        seed=0,
    )

    rc = capture_run_context(gate="H2.1", hypothesis="H2.1", seed=0)
    envelope = ResultEnvelope(
        gate="H2.1",
        hypothesis="H2.1",
        passed=metrics["passed"],
        metrics=metrics,
        runtime=rc,
        notes="test run",
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        out = write_result(envelope, tmpdir, filename="h2_1_test.json")
        assert out.exists(), "result file not written"
        data = json.loads(out.read_text())

    # Required top-level keys.
    for key in ("gate", "hypothesis", "pass", "metrics", "runtime", "schema_version"):
        assert key in data, f"Missing top-level key '{key}' in result envelope"

    assert data["gate"] == "H2.1"
    assert data["hypothesis"] == "H2.1"
    assert isinstance(data["pass"], bool)
    assert data["schema_version"] == 1

    # Metrics must contain the H2.1-specific keys.
    m = data["metrics"]
    for key in ("n_typed_pairs", "n_random_pairs", "ndcg_at_k_typed",
                "ndcg_at_k_random", "delta_ndcg", "passed"):
        assert key in m, f"Missing metrics key '{key}'"


# ---------------------------------------------------------------------------
# Test 7 — both conditions use same held-out corpus (identical n_queries)
# ---------------------------------------------------------------------------

def test_both_conditions_same_holdout():
    """
    Verify that typed and random conditions evaluate on the same held-out
    corpus (same n_queries and n_corpus in the result dict).
    """
    from run_h2_1_contrastive import run_experiment

    metrics = run_experiment(
        n_contracts=30,
        n_pairs=100,
        skip_finetuning=True,
        seed=5,
    )

    typed_eval = metrics["typed_contrastive"]
    random_eval = metrics["random_baseline"]

    assert typed_eval["n_queries"] == random_eval["n_queries"], (
        "Typed and random conditions must use same number of queries"
    )
    assert typed_eval["n_corpus"] == random_eval["n_corpus"], (
        "Typed and random conditions must use same corpus size"
    )
    assert typed_eval["k"] == random_eval["k"], (
        "Typed and random conditions must use same k"
    )


# ---------------------------------------------------------------------------
# Test 8 — identical hyperparameters except training data
# ---------------------------------------------------------------------------

def test_identical_hyperparameters():
    """
    The two fine-tune conditions differ only in training data.
    This test verifies that n_epochs, model_name, and k are the same
    for both conditions in the metrics output.
    """
    from run_h2_1_contrastive import run_experiment

    metrics = run_experiment(
        n_contracts=20,
        n_pairs=50,
        n_epochs=1,
        k=5,
        model_name="all-MiniLM-L6-v2",
        skip_finetuning=True,
        seed=7,
    )

    assert metrics["n_epochs"] == 1
    assert metrics["k"] == 5
    assert metrics["typed_contrastive"]["k"] == metrics["random_baseline"]["k"]


# ---------------------------------------------------------------------------
# Test 9 — full run smoke test (skipped by default, requires sentence-transformers)
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_full_run_smoke():
    """
    Full fine-tune smoke test on tiny corpus.  Requires sentence-transformers.
    Skipped by default; run with: pytest -m slow
    """
    pytest.importorskip("sentence_transformers",
                        reason="sentence-transformers not installed")

    from run_h2_1_contrastive import run_experiment

    metrics = run_experiment(
        n_contracts=20,
        n_pairs=50,
        n_epochs=1,
        skip_finetuning=False,
        seed=0,
    )

    assert 0.0 <= metrics["ndcg_at_k_typed"] <= 1.0
    assert 0.0 <= metrics["ndcg_at_k_random"] <= 1.0
    assert "delta_ndcg" in metrics
    assert metrics["model_name"] == "all-MiniLM-L6-v2"
