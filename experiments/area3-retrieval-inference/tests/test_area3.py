"""
tests/test_area3.py — Area 3 test suite.

All tests run without live services (no Nexum, no Anthropic API).

Tests
-----
1. test_graph_client_handles_connection_error
2. test_two_tier_cache_hit_rate
3. test_two_tier_cache_zipf_pattern
4. test_latency_benchmark_structure
5. test_recency_test_structure
6. test_lm_judge_score_parsing
7. test_sparse_ablation_returns_all_k
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

# Make the experiment package importable regardless of invocation directory.
_AREA3_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(_AREA3_DIR))

from graph_inference_client import GraphInferenceClient
from latency_benchmark import TwoTierBlockCache, run_latency_benchmark
from recency_test import run_recency_test
from sparse_attention_ablation import parse_judge_score, run_sparse_attention_ablation


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_client(
    retrieval_ms: float = 5.0,
    generation_ms: float = 50.0,
    n_blocks: int = 5,
) -> GraphInferenceClient:
    """Return a GraphInferenceClient whose query() method is mocked to return
    fixed latency values without any network calls.
    """
    client = GraphInferenceClient(
        nexum_url="http://localhost:9999",
        anthropic_key=None,
    )

    def _mock_query(query: str, k: int = 10, model: str = "claude-haiku-4-5-20251001") -> dict:
        blocks = [
            {
                "block_id": f"block-{i:04d}",
                "text": f"Mock text for block {i}.",
                "score": round(1.0 - i * 0.05, 3),
                "links": [],
            }
            for i in range(min(k, n_blocks))
        ]
        t0 = time.perf_counter()
        time.sleep(retrieval_ms / 1000.0)
        retr_ms = (time.perf_counter() - t0) * 1000.0
        t1 = time.perf_counter()
        time.sleep(generation_ms / 1000.0)
        gen_ms = (time.perf_counter() - t1) * 1000.0
        total_ms = retr_ms + gen_ms
        return {
            "answer": f"Mock answer for: {query}",
            "blocks": blocks,
            "latency_ms": total_ms,
            "retrieval_ms": retr_ms,
            "generation_ms": gen_ms,
            "is_mock": True,
        }

    client.query = _mock_query  # type: ignore[method-assign]
    return client


# ---------------------------------------------------------------------------
# 1. GraphInferenceClient handles ConnectionError gracefully
# ---------------------------------------------------------------------------


def test_graph_client_handles_connection_error():
    """query() with a mocked ConnectionError returns a mock dict, never raises."""
    import requests

    client = GraphInferenceClient(
        nexum_url="http://localhost:9999",
        anthropic_key=None,
    )

    with patch("requests.post", side_effect=requests.ConnectionError("refused")):
        result = client.query("What is the governing law?")

    assert isinstance(result, dict), "query() must return a dict on ConnectionError"
    assert "answer" in result, "result must have 'answer' key"
    assert "blocks" in result, "result must have 'blocks' key"
    assert "latency_ms" in result, "result must have 'latency_ms' key"
    assert result.get("is_mock") is True, "is_mock must be True when Nexum is unreachable"
    # Must not raise — this is the primary correctness criterion.


# ---------------------------------------------------------------------------
# 2. TwoTierBlockCache: hot cache hit rate > 60% for top-5% blocks
# ---------------------------------------------------------------------------


def test_two_tier_cache_hit_rate():
    """Access 100 blocks with Zipfian pattern; hot cache hits > 60% for top-5% blocks."""
    rng = np.random.default_rng(42)
    n_blocks = 100
    hot_fraction = 0.05  # top 5% = 5 blocks

    cache = TwoTierBlockCache(hot_fraction=hot_fraction, cold_latency_ms=0.0)

    # Register all blocks
    blocks = [
        {"block_id": f"block-{i:04d}", "text": f"Block text {i}."}
        for i in range(n_blocks)
    ]
    for b in blocks:
        cache.register(b)

    # Generate Zipfian access distribution: block 0 is most popular
    # P(block i) ∝ 1/(i+1)
    weights = np.array([1.0 / (i + 1) for i in range(n_blocks)])
    weights /= weights.sum()

    n_accesses = 1000
    chosen_indices = rng.choice(n_blocks, size=n_accesses, p=weights)

    # First pass: warm the access counts so the hot set is populated correctly.
    # Access each block proportionally to Zipfian weights to seed the counters.
    for idx in chosen_indices[:200]:
        block_id = f"block-{idx:04d}"
        cache.get(block_id)

    # Now measure hit rate for subsequent accesses
    top_block_ids = {f"block-{i:04d}" for i in range(int(n_blocks * hot_fraction))}

    hot_hits = 0
    top_accesses = 0

    for idx in chosen_indices[200:]:
        block_id = f"block-{idx:04d}"
        if block_id in top_block_ids:
            top_accesses += 1
            _, latency = cache.get(block_id)
            if latency == 0.0:
                hot_hits += 1

    if top_accesses > 0:
        hit_rate = hot_hits / top_accesses
        assert hit_rate > 0.60, (
            f"Hot cache hit rate for top-5% blocks should be > 60%, got {hit_rate:.2%}"
        )
    else:
        pytest.skip("No top-block accesses in sample — increase n_accesses or n_blocks")


# ---------------------------------------------------------------------------
# 3. TwoTierBlockCache: Zipfian access pattern
# ---------------------------------------------------------------------------


def test_two_tier_cache_zipf_pattern():
    """After many Zipfian accesses, top blocks have much higher hit rates than bottom blocks."""
    rng = np.random.default_rng(7)
    n_blocks = 200

    cache = TwoTierBlockCache(hot_fraction=0.05, cold_latency_ms=0.0)

    blocks = [{"block_id": f"b-{i:04d}", "text": f"text {i}"} for i in range(n_blocks)]
    for b in blocks:
        cache.register(b)

    # Zipfian weights
    weights = np.array([1.0 / (i + 1) for i in range(n_blocks)])
    weights /= weights.sum()

    # Warmup accesses to seed counters
    n_warmup = 2000
    warmup_indices = rng.choice(n_blocks, size=n_warmup, p=weights)
    for idx in warmup_indices:
        cache.get(f"b-{idx:04d}")

    stats = cache.access_pattern_stats()

    # Top blocks should have many more accesses than bottom blocks
    top_id = "b-0000"
    bottom_id = f"b-{n_blocks - 1:04d}"

    top_count = cache._access_counts.get(top_id, 0)
    bottom_count = cache._access_counts.get(bottom_id, 0)

    assert top_count > bottom_count, (
        f"Top block ({top_count}) should have more accesses than bottom block ({bottom_count})"
    )
    assert stats["hot_hit_rate"] > stats["cold_hit_rate"], (
        "Hot hit rate should exceed cold hit rate under Zipfian access"
    )
    # Zipf fit should be present and positive
    alpha = stats["zipf_alpha_estimate"]
    assert alpha is not None, "Zipf alpha estimate should not be None after many accesses"
    assert alpha > 0, f"Zipf alpha should be positive; got {alpha}"


# ---------------------------------------------------------------------------
# 4. Latency benchmark output structure
# ---------------------------------------------------------------------------


def test_latency_benchmark_structure():
    """Mock client with fixed latencies; verify output has all k_values and P50/P99 keys."""
    k_values = [1, 5, 10]
    queries = ["Question A?", "Question B?"]
    client = _make_mock_client(retrieval_ms=2.0, generation_ms=10.0)

    results = run_latency_benchmark(
        client=client,
        queries=queries,
        k_values=k_values,
        n_reps=2,
    )

    assert set(results.keys()) == set(k_values), (
        f"Result must have exactly k_values as keys; got {set(results.keys())}"
    )

    required_keys = {
        "p50_total_ms",
        "p99_total_ms",
        "p50_retrieval_ms",
        "p99_retrieval_ms",
        "p50_generation_ms",
        "p99_generation_ms",
        "mean_total_ms",
        "tokens_per_sec_estimate",
        "n_samples",
    }

    for k in k_values:
        assert required_keys.issubset(set(results[k].keys())), (
            f"k={k}: missing keys {required_keys - set(results[k].keys())}"
        )
        assert results[k]["p50_total_ms"] >= 0.0
        assert results[k]["p99_total_ms"] >= results[k]["p50_total_ms"]
        assert results[k]["n_samples"] == len(queries) * 2  # n_reps=2


# ---------------------------------------------------------------------------
# 5. Recency test output structure
# ---------------------------------------------------------------------------


def test_recency_test_structure():
    """Mock both clients; verify output has all required keys."""
    required_keys = {
        "nexum_accuracy_after_amendment",
        "vanilla_accuracy_after_amendment",
        "accuracy_delta",
        "h3_1_supported",
        "n_questions",
        "n_recency_questions",
        "per_question",
    }

    # Mock nexum client
    nexum_client = GraphInferenceClient(
        nexum_url="http://localhost:9999",
        anthropic_key=None,
    )

    def _mock_nexum_query(query: str, k: int = 10, **kwargs) -> dict:
        return {
            "answer": "The amendment now covers pandemic events.",
            "blocks": [],
            "latency_ms": 10.0,
            "retrieval_ms": 5.0,
            "generation_ms": 5.0,
            "is_mock": True,
        }

    nexum_client.query = _mock_nexum_query  # type: ignore[method-assign]

    # Mock vanilla client
    vanilla_client = MagicMock()
    vanilla_client.query.return_value = {
        "answer": "The contract does not mention pandemic events.",
        "citations": [],
    }

    corpus = [{"block_id": "b-001", "text": "Original contract text."}]
    amendments = [{"block_id": "amend-001", "text": "Force majeure now covers pandemics."}]
    questions = [
        {
            "question": "Does the force majeure clause cover pandemics?",
            "gold_answer": "pandemic",
            "requires_amendment": True,
        },
        {
            "question": "What is the notice period?",
            "gold_answer": "30 days",
            "requires_amendment": False,
        },
    ]

    with patch("requests.post", side_effect=__import__("requests").ConnectionError("offline")):
        result = run_recency_test(
            nexum_client=nexum_client,
            vanilla_client=vanilla_client,
            corpus=corpus,
            amendments=amendments,
            questions=questions,
        )

    assert required_keys.issubset(set(result.keys())), (
        f"Missing keys: {required_keys - set(result.keys())}"
    )
    assert isinstance(result["nexum_accuracy_after_amendment"], float)
    assert isinstance(result["vanilla_accuracy_after_amendment"], float)
    assert isinstance(result["h3_1_supported"], bool)
    assert isinstance(result["per_question"], list)


# ---------------------------------------------------------------------------
# 6. LM-as-judge score parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        # Direct float strings
        ("0.85", 0.85),
        ("1.0", 1.0),
        ("0", 0.0),
        ("0.0", 0.0),
        # Prose with embedded float
        ("The answer is good, score: 0.7", 0.7),
        ("I would rate this 0.6 out of 1.", 0.6),
        ("Score: 0.92", 0.92),
        # Edge cases in range
        ("0.5", 0.5),
        ("1", 1.0),
        # Unparseable / out-of-range → fallback 0.5
        ("", 0.5),
        ("The answer is great!", 0.5),
        ("2.5", 0.5),   # out of [0, 1]
        ("-0.1", 0.5),  # out of [0, 1]
        ("N/A", 0.5),
    ],
)
def test_lm_judge_score_parsing(raw: str, expected: float):
    """parse_judge_score returns the correct float for various output formats."""
    result = parse_judge_score(raw)
    assert abs(result - expected) < 1e-9, (
        f"parse_judge_score({raw!r}) = {result}, expected {expected}"
    )


# ---------------------------------------------------------------------------
# 7. Sparse ablation returns all k values
# ---------------------------------------------------------------------------


def test_sparse_ablation_returns_all_k():
    """Mock client; verify output has an entry for each k in k_values."""
    k_values = [1, 5, 10, 50, 100]
    eval_questions = [
        {"question": "What is the governing law?", "gold_answer": "Delaware"},
        {"question": "What is the notice period?", "gold_answer": "30 days"},
    ]

    client = _make_mock_client(retrieval_ms=1.0, generation_ms=5.0)

    results = run_sparse_attention_ablation(
        client=client,
        eval_questions=eval_questions,
        k_values=k_values,
    )

    assert set(results.keys()) == set(k_values), (
        f"Result must have exactly k_values as keys; got {set(results.keys())}"
    )

    required_keys = {"mean_judge_score", "p50_latency_ms", "p99_latency_ms", "n_questions"}

    for k in k_values:
        assert required_keys.issubset(set(results[k].keys())), (
            f"k={k}: missing keys {required_keys - set(results[k].keys())}"
        )
        score = results[k]["mean_judge_score"]
        assert 0.0 <= score <= 1.0, f"k={k}: mean_judge_score {score} out of [0, 1]"
        assert results[k]["n_questions"] == len(eval_questions)
        assert results[k]["p50_latency_ms"] >= 0.0
        assert results[k]["p99_latency_ms"] >= results[k]["p50_latency_ms"]
