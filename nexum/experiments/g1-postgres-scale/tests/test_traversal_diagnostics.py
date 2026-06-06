"""
tests/test_traversal_diagnostics.py — Unit tests for G1-OPT-2 diagnostics.

All tests are database-free. A small in-memory fake `conn` is provided
that satisfies just enough of the psycopg2 cursor interface for the
diagnostics module: ``cursor()``, ``execute(sql, params)``,
``fetchall()``, ``fetchone()``.

Tests cover:
- Step 1 EXPLAIN summary extraction (index name, seq scan detection,
  buffer / heap totals, recursive walk)
- Step 2 fan-out aggregation across multiple seeds
- Step 3 cycle-guard ablation speedup ratio + dominance flag
- All four fix benchmarks return one LatencyStats per reported hop
- ``run_full_diagnosis`` produces a complete envelope and picks the
  cheapest fix that meets the G1 threshold
- Fix-selection preference order (A → B → D → C) holds when multiple
  fixes pass
- ``bench_work_mem`` rejects values that aren't pure alphanumerics
"""

from __future__ import annotations

import sys
import types
import unittest
from typing import Any
from unittest.mock import MagicMock

import numpy as np


# --- minimal psycopg2 stub (mirrors test_g1.py) -----------------------------
def _ensure_psycopg2_stub() -> None:
    if "psycopg2" in sys.modules:
        return
    psycopg2_mod = types.ModuleType("psycopg2")
    extras_mod = types.ModuleType("psycopg2.extras")

    def execute_values(cur, sql, argslist, template=None, page_size=100, fetch=False):
        pass

    extras_mod.execute_values = execute_values
    psycopg2_mod.extras = extras_mod
    sys.modules["psycopg2"] = psycopg2_mod
    sys.modules["psycopg2.extras"] = extras_mod


_ensure_psycopg2_stub()

import traversal_diagnostics as td  # noqa: E402


# ---------------------------------------------------------------------------
# Fake cursor / connection
# ---------------------------------------------------------------------------


class FakeCursor:
    """Minimal cursor that returns scripted rows based on the SQL it sees."""

    def __init__(self, scripts: dict[str, Any]):
        # `scripts` maps a substring of SQL → callable(params)->rows or static rows.
        self._scripts = scripts
        self._last_rows: list[Any] = []
        self.executed: list[tuple[str, Any]] = []

    def execute(self, sql: str, params: Any | None = None) -> None:
        self.executed.append((sql, params))
        for substring, value in self._scripts.items():
            if substring in sql:
                rows = value(params) if callable(value) else value
                self._last_rows = list(rows)
                return
        self._last_rows = []

    def fetchall(self) -> list[Any]:
        return self._last_rows

    def fetchone(self) -> Any:
        return self._last_rows[0] if self._last_rows else None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeConn:
    def __init__(self, cursor_factory):
        self._cursor_factory = cursor_factory

    def cursor(self):
        return self._cursor_factory()


def _make_conn(scripts: dict[str, Any]) -> FakeConn:
    return FakeConn(lambda: FakeCursor(scripts))


# ---------------------------------------------------------------------------
# explain_analyze_traversal
# ---------------------------------------------------------------------------


def test_explain_summary_extracts_index_and_buffers():
    plan_envelope = {
        "Planning Time": 1.2,
        "Execution Time": 87.5,
        "Plan": {
            "Node Type": "Limit",
            "Plans": [
                {
                    "Node Type": "Index Only Scan",
                    "Index Name": "links_src_layer_cover_idx",
                    "Heap Fetches": 0,
                    "Shared Read Blocks": 12,
                    "Plans": [],
                },
                {
                    "Node Type": "Seq Scan",
                    "Relation Name": "links",
                    "Shared Read Blocks": 200,
                },
            ],
        },
    }
    conn = _make_conn({"EXPLAIN": [(plan_envelope,)]})
    summary = td.explain_analyze_traversal(conn, "seed-uuid")

    assert "links_src_layer_cover_idx" in summary["indexes_used"]
    assert summary["seq_scans_on_links"] == ["links"]
    assert summary["heap_fetches_total"] == 0
    assert summary["shared_read_blocks_total"] == 212
    assert summary["execution_time_ms"] == 87.5
    assert summary["planning_time_ms"] == 1.2


def test_explain_handles_list_envelope():
    # Some psycopg2 / Postgres combinations return the JSON plan as a
    # list of dicts rather than a single dict in the outer envelope.
    plan = [{"Plan": {"Node Type": "Result"}, "Execution Time": 1.0}]
    conn = _make_conn({"EXPLAIN": [(plan,)]})
    summary = td.explain_analyze_traversal(conn, "seed-uuid")
    assert summary["execution_time_ms"] == 1.0


def test_explain_empty_plan_returns_error():
    conn = _make_conn({"EXPLAIN": []})
    summary = td.explain_analyze_traversal(conn, "seed-uuid")
    assert summary == {"error": "empty plan"}


# ---------------------------------------------------------------------------
# measure_fanout
# ---------------------------------------------------------------------------


def test_measure_fanout_aggregates_across_seeds():
    # Each call to the recursive CTE returns three depth rows.
    rows = [(1, 10, 8), (2, 80, 45), (3, 600, 220)]
    conn = _make_conn({"WITH RECURSIVE traversal": rows})
    out = td.measure_fanout(conn, ["s1", "s2", "s3"], max_depth=3)

    assert [d["depth"] for d in out] == [1, 2, 3]
    # Each seed contributes once per depth, so n_seeds == 3 everywhere.
    for d in out:
        assert d["n_seeds"] == 3
    # depth=2 raw_count summed across 3 seeds.
    depth_2 = next(d for d in out if d["depth"] == 2)
    assert depth_2["raw_count"] == 80 * 3
    assert depth_2["distinct_count"] == 45 * 3


# ---------------------------------------------------------------------------
# cycle_guard_ablation
# ---------------------------------------------------------------------------


def test_cycle_guard_ablation_flags_dominant_guard():
    # Use a script that returns rows quickly; we focus on the logic
    # branch, not raw timings, so we manipulate the LatencyStats path
    # via a custom cursor that injects sleeps. Easier: monkey-patch
    # _percentiles to return known values.
    conn = _make_conn({"WITH RECURSIVE traversal": [("uuid-1", 1, "cites")]})

    real_percentiles = td._percentiles
    calls = {"i": 0}

    def fake_percentiles(latencies_ms, hop_depth):
        # First call = with_guard (slow), second = without_guard (fast).
        calls["i"] += 1
        if calls["i"] == 1:
            return td.LatencyStats(hop_depth, 5, 1000.0, 5000.0, 1500.0)
        return td.LatencyStats(hop_depth, 5, 100.0, 200.0, 120.0)

    td._percentiles = fake_percentiles
    try:
        out = td.cycle_guard_ablation(conn, ["s1", "s2"], max_depth=6)
    finally:
        td._percentiles = real_percentiles

    assert out["max_depth"] == 6
    assert out["with_guard"]["p99_ms"] == 5000.0
    assert out["without_guard"]["p99_ms"] == 200.0
    assert out["p99_speedup_x"] == 25.0
    assert out["guard_is_dominant"] is True


def test_cycle_guard_ablation_handles_zero_p99():
    conn = _make_conn({"WITH RECURSIVE traversal": []})
    real_percentiles = td._percentiles
    td._percentiles = lambda latencies_ms, hop_depth: td.LatencyStats(
        hop_depth, 0, 0.0, 0.0, 0.0
    )
    try:
        out = td.cycle_guard_ablation(conn, ["s1"], max_depth=6)
    finally:
        td._percentiles = real_percentiles
    assert out["p99_speedup_x"] == 0.0
    assert out["guard_is_dominant"] is False


# ---------------------------------------------------------------------------
# Fix benchmarks
# ---------------------------------------------------------------------------


def test_bench_baseline_returns_one_stat_per_reported_hop():
    conn = _make_conn({"WITH RECURSIVE traversal": [("uuid", 1, "cites")]})
    rng = np.random.default_rng(0)
    stats = td.bench_baseline(conn, ["s1", "s2"], rng, n_queries=3)
    assert [s.hop_depth for s in stats] == list(td._REPORT_HOPS)
    assert all(s.n_queries == 3 for s in stats)


def test_bench_baseline_empty_seeds_returns_zero_stats():
    conn = _make_conn({})
    rng = np.random.default_rng(0)
    stats = td.bench_baseline(conn, [], rng, n_queries=10)
    assert all(s.n_queries == 0 and s.p99_ms == 0.0 for s in stats)


def test_bench_covering_index_creates_index_then_runs():
    executed: list[str] = []

    class CapturingCursor(FakeCursor):
        def execute(self, sql, params=None):
            executed.append(sql)
            super().execute(sql, params)

    conn = FakeConn(
        lambda: CapturingCursor({"WITH RECURSIVE traversal": [("u", 1, "c")]})
    )
    rng = np.random.default_rng(0)
    td.bench_covering_index(conn, ["s1"], rng, n_queries=2)
    assert any("CREATE INDEX" in s and "links_src_layer_cover_idx" in s for s in executed)


def test_bench_work_mem_rejects_unsafe_value():
    conn = _make_conn({})
    rng = np.random.default_rng(0)
    try:
        td.bench_work_mem(conn, ["s1"], rng, n_queries=1, work_mem="1; DROP TABLE")
    except ValueError as err:
        assert "invalid work_mem" in str(err)
    else:
        raise AssertionError("expected ValueError for unsafe work_mem")


def test_bench_topk_fanout_passes_topk_param():
    captured: list[Any] = []

    class CapturingCursor(FakeCursor):
        def execute(self, sql, params=None):
            captured.append(params)
            super().execute(sql, params)

    conn = FakeConn(
        lambda: CapturingCursor({"WITH RECURSIVE traversal": [("u", 1, "c")]})
    )
    rng = np.random.default_rng(0)
    td.bench_topk_fanout(conn, ["s1"], rng, n_queries=1, topk=7)
    assert any(
        isinstance(p, dict) and p.get("topk") == 7 for p in captured
    )


def test_bench_topk_fanout_rejects_zero():
    conn = _make_conn({})
    rng = np.random.default_rng(0)
    try:
        td.bench_topk_fanout(conn, ["s1"], rng, n_queries=1, topk=0)
    except ValueError as err:
        assert "topk" in str(err)
    else:
        raise AssertionError("expected ValueError for topk=0")


def test_bench_iterative_bfs_stops_when_frontier_empty():
    # Returning no rows on the first hop should short-circuit the loop
    # for every hop depth, producing zero-time frontiers but still one
    # latency sample per hop.
    conn = _make_conn({"SELECT DISTINCT dst, rel_type FROM links": []})
    rng = np.random.default_rng(0)
    stats = td.bench_iterative_bfs(conn, ["s1"], rng, n_queries=3)
    assert [s.hop_depth for s in stats] == list(td._REPORT_HOPS)
    assert all(s.n_queries == 3 for s in stats)


# ---------------------------------------------------------------------------
# run_full_diagnosis
# ---------------------------------------------------------------------------


def _full_scripts() -> dict[str, Any]:
    """Scripts wired so each diagnostic step finds rows it expects."""
    return {
        "SELECT COUNT(*) FROM blocks": [(1_000_000,)],
        "SELECT COUNT(*) FROM links": [(10_000_000,)],
        "EXPLAIN": [
            (
                {
                    "Plan": {
                        "Node Type": "Index Scan",
                        "Index Name": "links_src_layer_idx",
                        "Plans": [],
                    },
                    "Execution Time": 50.0,
                    "Planning Time": 1.0,
                },
            )
        ],
        # Step 2 fan-out and Step 3 ablation both query the recursive CTE.
        "WITH RECURSIVE traversal": [(1, 10, 8), (2, 80, 50), (3, 500, 200)],
        "CREATE INDEX": [],
        "SET work_mem": [],
        "SELECT DISTINCT dst, rel_type FROM links": [],
    }


def test_run_full_diagnosis_returns_complete_envelope():
    conn = _make_conn(_full_scripts())
    rng = np.random.default_rng(7)
    report = td.run_full_diagnosis(
        conn, seed_ids=["s1", "s2"], n_queries=2, rng=rng
    )
    out = report.to_dict()

    assert out["n_blocks"] == 1_000_000
    assert out["n_links"] == 10_000_000
    assert out["seed_count"] == 2
    assert "indexes_used" in out["explain_summary"]
    assert out["fanout_per_hop"]
    assert out["cycle_guard_ablation"]["max_depth"] == 6
    for key in ("baseline_stats", "fix_a_stats", "fix_b_stats", "fix_c_stats", "fix_d_stats"):
        assert len(out[key]) == len(td._REPORT_HOPS)
    # rationale should always be set
    assert out["chosen_fix_rationale"]


def test_run_full_diagnosis_skips_when_no_seeds():
    conn = _make_conn(_full_scripts())
    report = td.run_full_diagnosis(conn, seed_ids=[], n_queries=2)
    out = report.to_dict()
    assert out["seed_count"] == 0
    assert out["chosen_fix"] is None
    assert "no seed ids" in out["chosen_fix_rationale"]


# ---------------------------------------------------------------------------
# Fix selection preference order
# ---------------------------------------------------------------------------


def _stats(p99: float, hop: int = 6) -> td.LatencyStats:
    return td.LatencyStats(hop, 10, p99 / 2, p99, p99 * 0.6)


def test_choose_fix_prefers_a_when_all_pass():
    baseline = [_stats(10000.0)]
    cands = {
        "fix_a": [_stats(100.0)],
        "fix_b": [_stats(100.0)],
        "fix_c": [_stats(100.0)],
        "fix_d": [_stats(100.0)],
    }
    name, _ = td._choose_fix(baseline, cands)
    assert name == "fix_a"


def test_choose_fix_prefers_d_over_c_when_only_c_or_d_pass():
    baseline = [_stats(10000.0)]
    cands = {
        "fix_a": [_stats(800.0)],
        "fix_b": [_stats(700.0)],
        "fix_c": [_stats(50.0)],
        "fix_d": [_stats(150.0)],
    }
    name, rationale = td._choose_fix(baseline, cands)
    # D is preferred over C because C trades recall for latency.
    assert name == "fix_d"
    assert "fix_d" in rationale


def test_choose_fix_returns_none_with_fallback_rationale():
    baseline = [_stats(10000.0)]
    cands = {
        "fix_a": [_stats(800.0)],
        "fix_b": [_stats(700.0)],
        "fix_c": [_stats(600.0)],
        "fix_d": [_stats(900.0)],
    }
    name, rationale = td._choose_fix(baseline, cands)
    assert name is None
    assert "hard-capped at 4 hops" in rationale


# ---------------------------------------------------------------------------
# LatencyStats.passes_g1
# ---------------------------------------------------------------------------


def test_latency_stats_passes_g1_threshold():
    assert td.LatencyStats(6, 10, 100, 499.9, 200).passes_g1() is True
    assert td.LatencyStats(6, 10, 100, 500.0, 200).passes_g1() is False
    assert td.LatencyStats(6, 10, 100, 10000, 5000).passes_g1() is False


if __name__ == "__main__":
    unittest.main()
