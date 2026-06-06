"""
tests/test_g1.py — Unit tests for the G1 Postgres scale benchmark.

All tests must pass WITHOUT a running database (psycopg2 is mocked where
needed).
"""

from __future__ import annotations

import importlib
import json
import sys
import types
import unittest
from unittest.mock import MagicMock, call, patch, sentinel

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Provide a minimal psycopg2 stub so imports succeed without the real library
# installed, and without a database connection.  If psycopg2 is actually
# installed we use it normally (the stub is never activated).
# ---------------------------------------------------------------------------

def _ensure_psycopg2_stub() -> None:
    """Insert a minimal psycopg2 stub into sys.modules if not already present."""
    if "psycopg2" in sys.modules:
        return

    psycopg2_mod = types.ModuleType("psycopg2")
    extras_mod = types.ModuleType("psycopg2.extras")

    def execute_values(cur, sql, argslist, template=None, page_size=100, fetch=False):
        # Accumulate the call so tests can inspect it.
        pass

    extras_mod.execute_values = execute_values
    psycopg2_mod.extras = extras_mod

    sys.modules["psycopg2"] = psycopg2_mod
    sys.modules["psycopg2.extras"] = extras_mod


_ensure_psycopg2_stub()


# Now we can import our modules safely.
from sizing_memo import compute_sizing_memo, _TOTAL_TO_EMBEDDING_RATIO  # noqa: E402
from benchmark import run_latency_benchmark, G1_P99_THRESHOLD_MS  # noqa: E402
import ingest as ingest_module  # noqa: E402


# ===========================================================================
# 1. test_sizing_memo_arithmetic
# ===========================================================================

class TestSizingMemoArithmetic:
    """1M blocks × 1536 × 4 bytes = 6,144,000,000 bytes ≈ 6.1 GB float32."""

    def test_1m_float32_bytes(self):
        memo = compute_sizing_memo(embedding_dim=1536)
        row_1m = next(r for r in memo["rows"] if r["n_blocks"] == 1_000_000)
        assert row_1m["embedding_float32_bytes"] == 1_000_000 * 1536 * 4
        assert row_1m["embedding_float32_bytes"] == 6_144_000_000

    def test_1m_int8_bytes(self):
        memo = compute_sizing_memo(embedding_dim=1536)
        row_1m = next(r for r in memo["rows"] if r["n_blocks"] == 1_000_000)
        assert row_1m["embedding_int8_bytes"] == 1_000_000 * 1536 * 1
        assert row_1m["embedding_int8_bytes"] == 1_536_000_000

    def test_5m_float32_bytes(self):
        memo = compute_sizing_memo(embedding_dim=1536)
        row_5m = next(r for r in memo["rows"] if r["n_blocks"] == 5_000_000)
        assert row_5m["embedding_float32_bytes"] == 5_000_000 * 1536 * 4

    def test_int8_is_quarter_of_float32(self):
        memo = compute_sizing_memo(embedding_dim=1536)
        for row in memo["rows"]:
            assert row["embedding_int8_bytes"] == row["embedding_float32_bytes"] // 4

    def test_all_four_default_scales_present(self):
        memo = compute_sizing_memo()
        block_counts = {r["n_blocks"] for r in memo["rows"]}
        assert {1_000_000, 5_000_000, 20_000_000, 100_000_000} == block_counts


# ===========================================================================
# 2. test_embedding_fraction_gt_70pct
# ===========================================================================

class TestEmbeddingFractionGt70Pct:
    """Embedding storage must exceed 70% of estimated total DB size (H1.3)."""

    def test_fraction_gt_70pct_all_scales(self):
        memo = compute_sizing_memo(embedding_dim=1536)
        for row in memo["rows"]:
            frac = row["embedding_fraction"]
            assert frac > 0.70, (
                f"Embedding fraction {frac:.2%} ≤ 70% at "
                f"{row['n_blocks']:,} blocks — H1.3 fails"
            )

    def test_fraction_lt_100pct(self):
        """Sanity: fraction must be less than 1.0 (non-embedding content exists)."""
        memo = compute_sizing_memo(embedding_dim=1536)
        for row in memo["rows"]:
            assert row["embedding_fraction"] < 1.0

    def test_fraction_consistent_with_ratio(self):
        """fraction = 1 / total_to_embedding_ratio."""
        memo = compute_sizing_memo(embedding_dim=1536)
        expected = 1.0 / _TOTAL_TO_EMBEDDING_RATIO
        for row in memo["rows"]:
            assert abs(row["embedding_fraction"] - expected) < 0.001


# ===========================================================================
# 3. test_latency_benchmark_structure
# ===========================================================================

class TestLatencyBenchmarkStructure:
    """Mock the DB connection; verify run_latency_benchmark returns the expected structure."""

    def _make_mock_conn(self, n_blocks: int = 1000):
        """Build a mock psycopg2 connection whose cursor returns plausible data."""
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)

        # Responses for the series of SQL calls made by run_latency_benchmark:
        #   1. COUNT(*) → n_blocks
        #   2. TABLESAMPLE → sample of block IDs
        #   3–N. individual query latency measurements (fetchall → [])
        block_ids = [str(i) for i in range(min(100, n_blocks))]

        def fetchone_side_effect():
            return (n_blocks,)

        def fetchall_side_effect():
            # Return block IDs for TABLESAMPLE, empty for query results
            if cur._tablesample_call:
                cur._tablesample_call = False
                return [(bid,) for bid in block_ids]
            return []

        cur._tablesample_call = False

        def execute_side_effect(sql, params=None):
            sql_upper = sql.upper()
            if "COUNT" in sql_upper:
                cur.fetchone = MagicMock(side_effect=fetchone_side_effect)
            elif "TABLESAMPLE" in sql_upper or "LIMIT" in sql_upper and "FROM BLOCKS" in sql_upper:
                cur._tablesample_call = True
                cur.fetchall = MagicMock(side_effect=fetchall_side_effect)
            else:
                cur.fetchall = MagicMock(return_value=[])

        cur.execute = MagicMock(side_effect=execute_side_effect)
        # Default fetchone / fetchall
        cur.fetchone = MagicMock(return_value=(n_blocks,))
        cur.fetchall = MagicMock(return_value=[])

        return conn

    def test_returns_dict(self):
        conn = self._make_mock_conn()
        result = run_latency_benchmark(conn, corpus_id="test", n_queries=5)
        assert isinstance(result, dict)

    def test_required_top_level_keys(self):
        conn = self._make_mock_conn()
        result = run_latency_benchmark(conn, corpus_id="test", n_queries=5)
        required = {
            "corpus_id", "n_blocks_in_corpus", "semantic", "fulltext",
            "graph_traversal", "pass_g1",
        }
        assert required == set(result.keys())

    def test_semantic_keys(self):
        conn = self._make_mock_conn()
        result = run_latency_benchmark(conn, corpus_id="test", n_queries=5)
        assert set(result["semantic"].keys()) == {"p50_ms", "p99_ms", "mean_ms"}

    def test_fulltext_keys(self):
        conn = self._make_mock_conn()
        result = run_latency_benchmark(conn, corpus_id="test", n_queries=5)
        assert set(result["fulltext"].keys()) == {"p50_ms", "p99_ms", "mean_ms"}

    def test_graph_traversal_keys(self):
        conn = self._make_mock_conn()
        result = run_latency_benchmark(conn, corpus_id="test", n_queries=5)
        gt = result["graph_traversal"]
        assert set(gt.keys()) == {"2_hop", "4_hop", "6_hop"}
        for hop_key in ("2_hop", "4_hop", "6_hop"):
            assert set(gt[hop_key].keys()) == {"p50_ms", "p99_ms"}

    def test_pass_g1_is_bool(self):
        conn = self._make_mock_conn()
        result = run_latency_benchmark(conn, corpus_id="test", n_queries=5)
        assert isinstance(result["pass_g1"], bool)

    def test_n_blocks_in_corpus_is_int(self):
        conn = self._make_mock_conn(n_blocks=42_000)
        result = run_latency_benchmark(conn, corpus_id="test", n_queries=5)
        assert isinstance(result["n_blocks_in_corpus"], int)


# ===========================================================================
# 4. test_pass_criterion
# ===========================================================================

class TestPassCriterion:
    """Unit test the pass/fail logic: P99 = 499 ms → pass, P99 = 501 ms → fail."""

    def test_threshold_value(self):
        assert G1_P99_THRESHOLD_MS == 500.0

    def test_499ms_is_pass(self):
        """Simulate a benchmark result where all P99 values are 499 ms."""
        with patch("benchmark._count_blocks", return_value=1000), \
             patch("benchmark._measure_semantic", return_value={"p50_ms": 100.0, "p99_ms": 499.0, "mean_ms": 120.0}), \
             patch("benchmark._measure_fulltext", return_value={"p50_ms": 50.0, "p99_ms": 499.0, "mean_ms": 60.0}), \
             patch("benchmark._sample_block_ids", return_value=["id1", "id2"]), \
             patch("benchmark._measure_graph_traversal", return_value={
                 "2_hop": {"p50_ms": 80.0, "p99_ms": 499.0},
                 "4_hop": {"p50_ms": 100.0, "p99_ms": 499.0},
                 "6_hop": {"p50_ms": 120.0, "p99_ms": 499.0},
             }):
            result = run_latency_benchmark(MagicMock(), corpus_id="test", n_queries=5)
        assert result["pass_g1"] is True

    def test_501ms_semantic_is_fail(self):
        """P99 = 501 ms on semantic → fail."""
        with patch("benchmark._count_blocks", return_value=1000), \
             patch("benchmark._measure_semantic", return_value={"p50_ms": 100.0, "p99_ms": 501.0, "mean_ms": 120.0}), \
             patch("benchmark._measure_fulltext", return_value={"p50_ms": 50.0, "p99_ms": 400.0, "mean_ms": 60.0}), \
             patch("benchmark._sample_block_ids", return_value=["id1"]), \
             patch("benchmark._measure_graph_traversal", return_value={
                 "2_hop": {"p50_ms": 80.0, "p99_ms": 400.0},
                 "4_hop": {"p50_ms": 100.0, "p99_ms": 400.0},
                 "6_hop": {"p50_ms": 120.0, "p99_ms": 400.0},
             }):
            result = run_latency_benchmark(MagicMock(), corpus_id="test", n_queries=5)
        assert result["pass_g1"] is False

    def test_501ms_fulltext_is_fail(self):
        with patch("benchmark._count_blocks", return_value=1000), \
             patch("benchmark._measure_semantic", return_value={"p50_ms": 10.0, "p99_ms": 400.0, "mean_ms": 20.0}), \
             patch("benchmark._measure_fulltext", return_value={"p50_ms": 50.0, "p99_ms": 501.0, "mean_ms": 60.0}), \
             patch("benchmark._sample_block_ids", return_value=["id1"]), \
             patch("benchmark._measure_graph_traversal", return_value={
                 "2_hop": {"p50_ms": 80.0, "p99_ms": 400.0},
                 "4_hop": {"p50_ms": 100.0, "p99_ms": 400.0},
                 "6_hop": {"p50_ms": 120.0, "p99_ms": 400.0},
             }):
            result = run_latency_benchmark(MagicMock(), corpus_id="test", n_queries=5)
        assert result["pass_g1"] is False

    def test_501ms_graph_6hop_is_fail(self):
        with patch("benchmark._count_blocks", return_value=1000), \
             patch("benchmark._measure_semantic", return_value={"p50_ms": 10.0, "p99_ms": 400.0, "mean_ms": 20.0}), \
             patch("benchmark._measure_fulltext", return_value={"p50_ms": 50.0, "p99_ms": 400.0, "mean_ms": 60.0}), \
             patch("benchmark._sample_block_ids", return_value=["id1"]), \
             patch("benchmark._measure_graph_traversal", return_value={
                 "2_hop": {"p50_ms": 80.0, "p99_ms": 400.0},
                 "4_hop": {"p50_ms": 100.0, "p99_ms": 400.0},
                 "6_hop": {"p50_ms": 120.0, "p99_ms": 501.0},
             }):
            result = run_latency_benchmark(MagicMock(), corpus_id="test", n_queries=5)
        assert result["pass_g1"] is False

    def test_exactly_500ms_is_fail(self):
        """Boundary: exactly 500 ms is not < 500 ms → fail."""
        with patch("benchmark._count_blocks", return_value=1000), \
             patch("benchmark._measure_semantic", return_value={"p50_ms": 10.0, "p99_ms": 500.0, "mean_ms": 20.0}), \
             patch("benchmark._measure_fulltext", return_value={"p50_ms": 50.0, "p99_ms": 400.0, "mean_ms": 60.0}), \
             patch("benchmark._sample_block_ids", return_value=["id1"]), \
             patch("benchmark._measure_graph_traversal", return_value={
                 "2_hop": {"p50_ms": 80.0, "p99_ms": 400.0},
                 "4_hop": {"p50_ms": 100.0, "p99_ms": 400.0},
                 "6_hop": {"p50_ms": 120.0, "p99_ms": 400.0},
             }):
            result = run_latency_benchmark(MagicMock(), corpus_id="test", n_queries=5)
        assert result["pass_g1"] is False


# ===========================================================================
# 5. test_percentile_computation
# ===========================================================================

class TestPercentileComputation:
    """Unit test P50/P99 computation with hand-crafted latency lists."""

    def test_p50_of_sorted_list(self):
        """P50 of [1..100] = 50.5 (numpy interpolation)."""
        arr = np.array(list(range(1, 101)), dtype=float)
        p50 = float(np.percentile(arr, 50))
        assert abs(p50 - 50.5) < 0.1

    def test_p99_of_sorted_list(self):
        """P99 of [1..100] = 99.01 (numpy interpolation)."""
        arr = np.array(list(range(1, 101)), dtype=float)
        p99 = float(np.percentile(arr, 99))
        assert 98.0 < p99 < 100.0

    def test_all_same_value(self):
        arr = np.array([42.0] * 50)
        assert float(np.percentile(arr, 50)) == pytest.approx(42.0)
        assert float(np.percentile(arr, 99)) == pytest.approx(42.0)

    def test_two_values(self):
        arr = np.array([100.0, 500.0])
        assert float(np.percentile(arr, 50)) == pytest.approx(300.0)
        assert float(np.percentile(arr, 99)) > 490.0

    def test_single_outlier_dominates_p99(self):
        """10 values at 10 ms and one at 1000 ms (11 items) — P99 > 900 ms.

        Numpy linear interpolation: P99 index = 0.99*(11-1) = 9.9 →
        interpolates between index 9 (10ms) and index 10 (1000ms) at 90%
        weight toward the outlier, giving ~901ms.
        """
        arr = np.array([10.0] * 10 + [1000.0])
        p99 = float(np.percentile(arr, 99))
        assert p99 > 900.0

    def test_pass_criterion_uses_percentile(self):
        """Verify that a list where most values are fast but one is slow
        correctly produces a high P99."""
        latencies = [5.0] * 98 + [600.0, 700.0]
        arr = np.array(latencies)
        p99 = float(np.percentile(arr, 99))
        assert p99 >= G1_P99_THRESHOLD_MS


# ===========================================================================
# 6. test_ingest_batch_size
# ===========================================================================

class TestIngestBatchSize:
    """Verify generate_and_ingest calls execute_values with batches, not one per row."""

    def _make_ingest_conn_mock(self):
        """Return a mock connection suitable for the ingest module."""
        conn = MagicMock()
        cur = MagicMock()
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        conn.autocommit = False

        # pg_total_relation_size query → return fake size tuples
        cur.fetchone = MagicMock(return_value=(
            100_000_000,  # blocks_total
            50_000_000,   # links_total
            1_000_000,    # docs_total
            500_000,      # versions_total
            2_000_000,    # vb_total
        ))
        return conn, cur

    def test_blocks_inserted_in_batches_not_one_per_row(self):
        """With n_blocks=500 and batch_size=100, execute_values must be called
        fewer times than n_blocks."""
        conn, cur = self._make_ingest_conn_mock()

        execute_values_calls: list[tuple] = []

        def mock_execute_values(cursor, sql, argslist, template=None, **kwargs):
            execute_values_calls.append((sql.strip()[:60], len(list(argslist))))

        import psycopg2.extras as extras_mod
        original_ev = extras_mod.execute_values
        extras_mod.execute_values = mock_execute_values

        try:
            ingest_module.generate_and_ingest(
                conn=conn,
                n_blocks=500,
                domain_mix={"pdf": 1.0},
                embedding_dim=64,  # small dim for speed
                seed=0,
                batch_size=100,
            )
        finally:
            extras_mod.execute_values = original_ev

        # Count execute_values calls that inserted blocks (SQL contains 'BLOCKS')
        block_insert_calls = [
            (sql, n) for sql, n in execute_values_calls
            if "INSERT INTO BLOCKS" in sql.upper()
        ]

        # There should be multiple batched calls, not 500 individual calls
        assert len(block_insert_calls) >= 1, "No block inserts found"
        assert len(block_insert_calls) < 500, (
            f"Expected batched inserts (< 500 calls), got {len(block_insert_calls)}"
        )
        # Each batch should not exceed batch_size
        for sql, n in block_insert_calls:
            assert n <= 100, f"Batch of {n} exceeds batch_size=100"

    def test_batch_size_respected_exactly(self):
        """With n_blocks=250 and batch_size=100, we expect ceil(250/100)=3 block batches."""
        conn, cur = self._make_ingest_conn_mock()

        block_batch_sizes: list[int] = []

        def mock_execute_values(cursor, sql, argslist, template=None, **kwargs):
            items = list(argslist)
            if "INSERT INTO BLOCKS" in sql.upper():
                block_batch_sizes.append(len(items))

        import psycopg2.extras as extras_mod
        original_ev = extras_mod.execute_values
        extras_mod.execute_values = mock_execute_values

        try:
            ingest_module.generate_and_ingest(
                conn=conn,
                n_blocks=250,
                domain_mix={"pdf": 1.0},
                embedding_dim=32,
                seed=1,
                batch_size=100,
            )
        finally:
            extras_mod.execute_values = original_ev

        assert len(block_batch_sizes) == 3, (
            f"Expected 3 batches for 250 blocks at batch_size=100, "
            f"got {len(block_batch_sizes)}: {block_batch_sizes}"
        )
        assert sum(block_batch_sizes) == 250
        assert block_batch_sizes[0] == 100
        assert block_batch_sizes[1] == 100
        assert block_batch_sizes[2] == 50

    def test_links_also_batched(self):
        """Links should also be inserted via execute_values in batches."""
        conn, cur = self._make_ingest_conn_mock()

        link_batch_count = 0

        def mock_execute_values(cursor, sql, argslist, template=None, **kwargs):
            nonlocal link_batch_count
            items = list(argslist)
            if "INSERT INTO LINKS" in sql.upper():
                link_batch_count += 1

        import psycopg2.extras as extras_mod
        original_ev = extras_mod.execute_values
        extras_mod.execute_values = mock_execute_values

        try:
            ingest_module.generate_and_ingest(
                conn=conn,
                n_blocks=100,
                domain_mix={"pdf": 1.0},
                embedding_dim=32,
                seed=2,
                batch_size=50,
            )
        finally:
            extras_mod.execute_values = original_ev

        # 100 blocks × 10 links ≈ 1000 links at batch_size=50 → ≥ 1 batch
        assert link_batch_count >= 1, "Links should be inserted via execute_values"
