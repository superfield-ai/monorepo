"""
tests/test_area1.py — Unit tests for the Area 1 storage fitness experiment.

Test inventory (7 tests per issue spec):
  1. test_scale_result_structure   — mock DB; verify result dict has all expected keys
  2. test_kuzu_in_memory           — Kuzu in-process 10 nodes/20 edges; 2-hop traversal
  3. test_pca_reduces_dims         — sklearn PCA on 50 × 384 vectors to 128 dims
  4. test_zero_pad_expands_dims    — zero-pad 384-dim to 768-dim
  5. test_recall_at_k              — unit test recall@k with synthetic ranked lists
  6. test_h11_verdict_logic        — P99 < 500ms at 20M → "supported"; > 500ms at 5M → "refuted"
  7. test_report_markdown_has_tables — generated markdown contains | table delimiters

Tests 1, 4–7 pass without DB.
Test 2 requires kuzu; skipped via pytest.importorskip if absent.
Test 3 requires sklearn; skipped via pytest.importorskip if absent.
"""

from __future__ import annotations

import sys
import types
import uuid
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# psycopg2 stub (if psycopg2 not installed)
# ---------------------------------------------------------------------------


def _ensure_psycopg2_stub() -> None:
    if "psycopg2" in sys.modules:
        return

    psycopg2_mod = types.ModuleType("psycopg2")
    extras_mod = types.ModuleType("psycopg2.extras")

    def execute_values(cur, sql, argslist, template=None, page_size=100, fetch=False):
        pass

    extras_mod.execute_values = execute_values
    psycopg2_mod.extras = extras_mod

    def connect(*args, **kwargs):
        return MagicMock()

    psycopg2_mod.connect = connect

    sys.modules["psycopg2"] = psycopg2_mod
    sys.modules["psycopg2.extras"] = extras_mod


_ensure_psycopg2_stub()

# ---------------------------------------------------------------------------
# Add G1 and area1 to sys.path so imports work without install
# ---------------------------------------------------------------------------

import os

_HERE = os.path.dirname(__file__)
_AREA1_DIR = os.path.abspath(os.path.join(_HERE, ".."))
_G1_DIR = os.path.abspath(os.path.join(_HERE, "..", "..", "g1-postgres-scale"))

for _p in (_AREA1_DIR, _G1_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)


# ---------------------------------------------------------------------------
# 1. test_scale_result_structure
# ---------------------------------------------------------------------------


def test_scale_result_structure():
    """Mock DB; verify run_scale_benchmark result dict has all expected keys."""
    scales = [1_000_000, 5_000_000, 20_000_000, 100_000_000]
    domain_mixes = [{"pdf": 1.0}]

    mock_bench = {
        "corpus_id": "1M_mix0",
        "n_blocks_in_corpus": 1_000_000,
        "semantic": {"p50_ms": 50.0, "p99_ms": 100.0, "mean_ms": 60.0},
        "fulltext": {"p50_ms": 30.0, "p99_ms": 80.0, "mean_ms": 40.0},
        "graph_traversal": {
            "2_hop": {"p50_ms": 40.0, "p99_ms": 90.0},
            "4_hop": {"p50_ms": 80.0, "p99_ms": 180.0},
            "6_hop": {"p50_ms": 120.0, "p99_ms": 250.0},
        },
        "pass_g1": True,
    }
    mock_ingest = {
        "n_blocks": 1_000_000,
        "n_links": 5_000_000,
        "storage_bytes": 6_000_000_000,
        "embedding_storage_bytes": 1_000_000 * 1536 * 4,
        "ingest_time_seconds": 1.0,
    }
    mock_stream = {
        **mock_ingest,
        "streaming": True,
        "n_chunks": 2,
        "chunk_size": 500_000,
    }

    with patch("scale_benchmark.psycopg2") as mock_pg, \
         patch("scale_benchmark.ensure_schema"), \
         patch("scale_benchmark._truncate_tables"), \
         patch("scale_benchmark.generate_and_ingest", return_value=mock_ingest), \
         patch("scale_benchmark._ingest_streaming", return_value=mock_stream), \
         patch("scale_benchmark.run_latency_benchmark", return_value=mock_bench), \
         patch("scale_benchmark._measure_hnsw_build_time", return_value=5.0), \
         patch("scale_benchmark._measure_vacuum_analyze", return_value=2.0):

        mock_pg.connect.return_value = MagicMock()

        from scale_benchmark import run_scale_benchmark

        result = run_scale_benchmark(
            db_url="postgresql://localhost/nexum_bench",
            scales=scales,
            domain_mixes=domain_mixes,
            n_queries=5,
        )

    # Top-level keys
    assert "scales_tested" in result, "Missing key: scales_tested"
    assert "domain_mixes" in result, "Missing key: domain_mixes"
    assert "results" in result, "Missing key: results"

    # One result entry per scale × mix combination
    assert len(result["results"]) == len(scales) * len(domain_mixes)

    # Each entry must have the required keys
    required_keys = {
        "scale_label",
        "n_blocks",
        "domain_mix",
        "ingest",
        "hnsw_build_time_seconds",
        "vacuum_analyze_time_seconds",
        "benchmark",
        "throughput_qps_p50",
        "p99_exceeds_threshold",
    }
    for entry in result["results"]:
        missing = required_keys - set(entry.keys())
        assert not missing, f"Result entry missing keys: {missing}"


# ---------------------------------------------------------------------------
# 2. test_kuzu_in_memory
# ---------------------------------------------------------------------------


def test_kuzu_in_memory(tmp_path):
    """Create Kuzu in-process DB with 10 nodes and 20 edges; verify 2-hop traversal."""
    kuzu = pytest.importorskip("kuzu")

    db = kuzu.Database(str(tmp_path / "kuzu_test"))
    conn = kuzu.Connection(db)

    conn.execute("CREATE NODE TABLE Block(id STRING, PRIMARY KEY(id))")
    conn.execute(
        "CREATE REL TABLE Link(FROM Block TO Block, rel_type STRING, confidence DOUBLE)"
    )

    # Insert 10 nodes
    block_ids = [str(uuid.uuid4()) for _ in range(10)]
    for bid in block_ids:
        conn.execute(f"CREATE (:Block {{id: '{bid}'}})")

    # Insert 20 edges — two per node, cycling through the ring
    for i in range(20):
        src = block_ids[i % 10]
        dst = block_ids[(i + 1) % 10]
        conn.execute(
            f"MATCH (a:Block {{id: '{src}'}}), (b:Block {{id: '{dst}'}})"
            f" CREATE (a)-[:Link {{rel_type: 'cites', confidence: 0.8}}]->(b)"
        )

    # 2-hop traversal from first block should return at least one result
    seed = block_ids[0]
    result = conn.execute(
        f"""
        MATCH (a:Block)-[r:Link*1..2]->(b:Block)
        WHERE a.id = '{seed}'
        RETURN b.id
        LIMIT 100
        """
    )
    rows = []
    while result.has_next():
        rows.append(result.get_next())

    assert len(rows) > 0, (
        "2-hop traversal from the seed node should return at least one reachable node"
    )


# ---------------------------------------------------------------------------
# 3. test_pca_reduces_dims
# ---------------------------------------------------------------------------


def test_pca_reduces_dims():
    """sklearn PCA on 50 random 384-dim vectors to 128 dims; output shape correct."""
    pytest.importorskip("sklearn")

    from embedding_ablation import pca_reduce

    rng = np.random.default_rng(0)
    vectors = rng.standard_normal((50, 384)).astype(np.float32)
    projected = pca_reduce(vectors, 128)

    assert projected.shape == (50, 128), (
        f"Expected shape (50, 128), got {projected.shape}"
    )
    # Output should be float32
    assert projected.dtype == np.float32, (
        f"Expected float32 output, got {projected.dtype}"
    )


# ---------------------------------------------------------------------------
# 4. test_zero_pad_expands_dims
# ---------------------------------------------------------------------------


def test_zero_pad_expands_dims():
    """Zero-padding 384-dim vectors to 768-dim; output shape and dtype correct."""
    from embedding_ablation import zero_pad

    rng = np.random.default_rng(1)
    vectors = rng.standard_normal((20, 384)).astype(np.float32)
    padded = zero_pad(vectors, 768)

    assert padded.shape == (20, 768), (
        f"Expected shape (20, 768), got {padded.shape}"
    )
    assert padded.dtype == np.float32, (
        f"Expected float32 output, got {padded.dtype}"
    )
    # The first 384 dims of each padded vector correspond to the original
    # (after L2-normalisation, they scale proportionally)
    # At minimum, the last 384 dims of a zero-padded normalised vector should
    # shrink (they're padded zeros scaled by 1/||[v, 0]||) — not strictly zero
    # after normalisation, but the padded section was originally zeros.
    # Just verify no NaNs.
    assert not np.any(np.isnan(padded)), "Padded output contains NaN values"


# ---------------------------------------------------------------------------
# 5. test_recall_at_k
# ---------------------------------------------------------------------------


def test_recall_at_k():
    """Unit test recall@k computation with synthetic ranked lists."""
    from embedding_ablation import compute_recall_at_k

    # Construct a trivial case: 5 queries, each with 1 relevant doc.
    # Corpus: 10 L2-normalised unit vectors.
    rng = np.random.default_rng(42)
    n_corpus = 10
    n_queries = 5
    k = 3

    corpus = rng.standard_normal((n_corpus, 8)).astype(np.float32)
    corpus /= np.linalg.norm(corpus, axis=1, keepdims=True)

    # Each query is a copy of a corpus vector — perfect recall expected
    query_indices = [0, 2, 4, 6, 8]
    queries = corpus[query_indices].copy()
    relevant_ids = [[idx] for idx in query_indices]

    recall = compute_recall_at_k(queries, corpus, relevant_ids, k=k)

    # With perfect queries (identical to corpus vectors), recall@k = 1.0
    assert recall == 1.0, (
        f"Expected recall=1.0 for perfect queries, got {recall}"
    )

    # Edge case: no relevant docs → recall should be 0.0 or skip gracefully
    recall_empty = compute_recall_at_k(queries, corpus, [[] for _ in range(n_queries)], k=k)
    assert recall_empty == 0.0, (
        f"Expected recall=0.0 for empty relevant sets, got {recall_empty}"
    )

    # Sanity: recall ∈ [0, 1]
    recall_random = compute_recall_at_k(
        rng.standard_normal((n_queries, 8)).astype(np.float32),
        corpus,
        relevant_ids,
        k=k,
    )
    assert 0.0 <= recall_random <= 1.0, (
        f"Recall out of [0, 1] range: {recall_random}"
    )


# ---------------------------------------------------------------------------
# 6. test_h11_verdict_logic
# ---------------------------------------------------------------------------


def test_h11_verdict_logic():
    """P99 < 500ms at 20M → 'SUPPORTED'; > 500ms at 5M → 'REFUTED'."""
    from report import _h11_verdict

    def _make_scale_result(entries: list[tuple[int, bool]]) -> dict:
        """Build a minimal scale_benchmark results dict.

        Args:
            entries: List of (n_blocks, p99_exceeds_threshold) tuples.
        """
        results = []
        for n_blocks, p99_exceeds in entries:
            label = f"{n_blocks // 1_000_000}M"
            results.append(
                {
                    "scale_label": label,
                    "n_blocks": n_blocks,
                    "domain_mix": {"pdf": 1.0},
                    "mix_index": 0,
                    "ingest": {},
                    "hnsw_build_time_seconds": 5.0,
                    "vacuum_analyze_time_seconds": 1.0,
                    "benchmark": {
                        "semantic": {
                            "p50_ms": 50.0,
                            "p99_ms": 100.0 if not p99_exceeds else 600.0,
                            "mean_ms": 60.0,
                        },
                        "fulltext": {"p50_ms": 30.0, "p99_ms": 80.0, "mean_ms": 40.0},
                        "graph_traversal": {
                            "2_hop": {"p50_ms": 40.0, "p99_ms": 90.0},
                            "4_hop": {"p50_ms": 80.0, "p99_ms": 180.0},
                            "6_hop": {"p50_ms": 120.0, "p99_ms": 250.0},
                        },
                        "pass_g1": not p99_exceeds,
                    },
                    "throughput_qps_p50": 20.0,
                    "p99_exceeds_threshold": p99_exceeds,
                }
            )
        return {
            "experiment": "area1_scale_benchmark",
            "scales_tested": [e["scale_label"] for e in results],
            "domain_mixes": [{"pdf": 1.0}],
            "results": results,
        }

    # P99 < 500ms at 1M, 5M, 20M → H1.1 SUPPORTED
    scale_pass_20m = _make_scale_result(
        [(1_000_000, False), (5_000_000, False), (20_000_000, False)]
    )
    verdict_supported = _h11_verdict(scale_pass_20m)
    assert "SUPPORTED" in verdict_supported, (
        f"Expected SUPPORTED, got: {verdict_supported!r}"
    )

    # P99 > 500ms at 5M → H1.1 REFUTED
    scale_fail_5m = _make_scale_result(
        [(1_000_000, False), (5_000_000, True)]
    )
    verdict_refuted = _h11_verdict(scale_fail_5m)
    assert "REFUTED" in verdict_refuted, (
        f"Expected REFUTED, got: {verdict_refuted!r}"
    )

    # No results → INCONCLUSIVE
    verdict_inconclusive = _h11_verdict({"results": []})
    assert "inconclusive" in verdict_inconclusive.lower(), (
        f"Expected inconclusive, got: {verdict_inconclusive!r}"
    )

    # None → INCONCLUSIVE
    verdict_none = _h11_verdict(None)
    assert "inconclusive" in verdict_none.lower(), (
        f"Expected inconclusive for None, got: {verdict_none!r}"
    )


# ---------------------------------------------------------------------------
# 7. test_report_markdown_has_tables
# ---------------------------------------------------------------------------


def test_report_markdown_has_tables():
    """Generated markdown report contains | table delimiters."""
    from report import generate_report

    synthetic_results = {
        "scale_benchmark": {
            "experiment": "area1_scale_benchmark",
            "scales_tested": ["1M", "5M", "20M", "100M"],
            "domain_mixes": [{"pdf": 1.0}],
            "results": [
                {
                    "scale_label": "1M",
                    "n_blocks": 1_000_000,
                    "domain_mix": {"pdf": 1.0},
                    "mix_index": 0,
                    "ingest": {"n_blocks": 1_000_000, "ingest_time_seconds": 1.0},
                    "hnsw_build_time_seconds": 10.0,
                    "vacuum_analyze_time_seconds": 2.0,
                    "benchmark": {
                        "semantic": {"p50_ms": 50.0, "p99_ms": 120.0, "mean_ms": 60.0},
                        "fulltext": {"p50_ms": 30.0, "p99_ms": 80.0, "mean_ms": 40.0},
                        "graph_traversal": {
                            "2_hop": {"p50_ms": 40.0, "p99_ms": 100.0},
                            "4_hop": {"p50_ms": 80.0, "p99_ms": 200.0},
                            "6_hop": {"p50_ms": 120.0, "p99_ms": 300.0},
                        },
                        "pass_g1": True,
                    },
                    "throughput_qps_p50": 20.0,
                    "p99_exceeds_threshold": False,
                },
                {
                    "scale_label": "20M",
                    "n_blocks": 20_000_000,
                    "domain_mix": {"pdf": 1.0},
                    "mix_index": 0,
                    "ingest": {},
                    "hnsw_build_time_seconds": None,
                    "vacuum_analyze_time_seconds": None,
                    "benchmark": {
                        "semantic": {"p50_ms": None, "p99_ms": None, "mean_ms": None},
                        "fulltext": {"p50_ms": None, "p99_ms": None, "mean_ms": None},
                        "graph_traversal": {
                            "2_hop": {"p50_ms": None, "p99_ms": None},
                            "4_hop": {"p50_ms": None, "p99_ms": None},
                            "6_hop": {"p50_ms": None, "p99_ms": None},
                        },
                        "pass_g1": None,
                    },
                    "throughput_qps_p50": None,
                    "p99_exceeds_threshold": True,
                },
            ],
        },
        "schema_comparison": {
            "n_blocks": 1_000_000,
            "kuzu_sample_size": 10_000,
            "n_hops_list": [2, 4, 6],
            "n_queries": 50,
            "postgres": {
                "2_hop": {"p50_ms": 10.0, "p99_ms": 25.0},
                "4_hop": {"p50_ms": 40.0, "p99_ms": 100.0},
                "6_hop": {"p50_ms": 120.0, "p99_ms": 300.0},
            },
            "kuzu": {
                "2_hop": {"p50_ms": 5.0, "p99_ms": 15.0},
                "4_hop": {"p50_ms": 20.0, "p99_ms": 60.0},
                "6_hop": {"p50_ms": 50.0, "p99_ms": 150.0},
            },
            "kuzu_available": True,
            "neo4j_available": False,
            "neo4j_note": "Neo4j: not available.",
            "crossover_hop": 2,
        },
        "embedding_ablation": {
            "dimensions": [128, 256, 384, 512, 768, 1024, 1536],
            "n_queries": 200,
            "corpus_size": 100_000,
            "results": [
                {"dimension": 128, "recall_at_10": 0.38},
                {"dimension": 256, "recall_at_10": 0.41},
                {"dimension": 384, "recall_at_10": 0.43},
                {"dimension": 512, "recall_at_10": 0.44},
                {"dimension": 1536, "recall_at_10": 0.45},
            ],
            "baseline_dim": 384,
            "baseline_recall_at_10": 0.43,
            "min_dim_within_5pct": 384,
        },
    }

    md = generate_report(synthetic_results)

    assert isinstance(md, str), "generate_report should return a string"
    assert "|" in md, "Markdown report should contain | table delimiters"

    # Verify at least 3 table rows (header + separator + data)
    table_lines = [line for line in md.splitlines() if "|" in line]
    assert len(table_lines) >= 3, (
        f"Expected at least 3 table lines, found {len(table_lines)}"
    )

    # Verify key section headings are present
    assert "Scale Benchmark" in md, "Missing Scale Benchmark section"
    assert "Schema Comparison" in md, "Missing Schema Comparison section"
    assert "Embedding" in md, "Missing Embedding section"
    assert "H1.1" in md, "Missing H1.1 verdict section"
