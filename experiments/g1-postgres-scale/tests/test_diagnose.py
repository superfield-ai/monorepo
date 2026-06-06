"""
tests/test_diagnose.py — Unit tests for diagnose.py, optimize.py, ef_search_sweep.py.

All tests pass WITHOUT a running database.
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import numpy as np


def _ensure_psycopg2_stub() -> None:
    if "psycopg2" in sys.modules:
        return
    psycopg2_mod = types.ModuleType("psycopg2")
    extras_mod = types.ModuleType("psycopg2.extras")
    extras_mod.execute_values = lambda *a, **kw: None
    psycopg2_mod.extras = extras_mod
    sys.modules["psycopg2"] = psycopg2_mod
    sys.modules["psycopg2.extras"] = extras_mod


_ensure_psycopg2_stub()

import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import diagnose
import optimize
import ef_search_sweep


# ── diagnose.py ──────────────────────────────────────────────────────────────

class TestParseBufferCount(unittest.TestCase):
    def test_extracts_hit(self):
        plan = "  Buffers: shared hit=1234 read=56"
        assert diagnose._extract_buffer_count(plan, "hit") == 1234

    def test_extracts_read(self):
        plan = "  Buffers: shared hit=10 read=999"
        assert diagnose._extract_buffer_count(plan, "read") == 999

    def test_missing_returns_zero(self):
        assert diagnose._extract_buffer_count("no buffers here", "hit") == 0


class TestExtractActualTime(unittest.TestCase):
    def test_parses_time(self):
        plan = "  (actual time=0.012..423.456 rows=20 loops=1)"
        assert diagnose._extract_actual_time(plan) == pytest.approx(423.456)

    def test_missing_returns_none(self):
        assert diagnose._extract_actual_time("no time here") is None


class TestParsePgSize(unittest.TestCase):
    def test_mb(self):
        assert diagnose._parse_pg_size("128MB") == 128 * 1024**2

    def test_gb(self):
        assert diagnose._parse_pg_size("1GB") == 1024**3

    def test_kb(self):
        assert diagnose._parse_pg_size("512kB") == 512 * 1024

    def test_lowercase(self):
        assert diagnose._parse_pg_size("256mb") == 256 * 1024**2


class TestVerdict(unittest.TestCase):
    def _size(self, index_mb, shared_mb):
        return {
            "hnsw_index_mb": index_mb,
            "shared_buffers_mb": shared_mb,
            "index_fits_in_cache": index_mb <= shared_mb,
            "overflow_mb": max(0, index_mb - shared_mb),
        }

    def _buffers(self, miss_ratio):
        total = 1000
        read = int(total * miss_ratio)
        hit = total - read
        return {"aggregate": {"cache_miss_ratio": miss_ratio, "total_shared_hit": hit, "total_shared_read": read}}

    def _warm(self, p99):
        return {"p99_ms": p99}

    def test_memory_verdict_when_index_larger_than_buffers(self):
        v = diagnose._verdict(
            self._size(1500, 128),
            self._buffers(0.95),
            self._warm(2000),
        )
        assert "MEMORY" in v

    def test_cpu_docker_verdict_when_index_fits_and_cache_warm(self):
        v = diagnose._verdict(
            self._size(300, 1024),
            self._buffers(0.05),
            self._warm(2000),
        )
        assert "CPU" in v or "DOCKER" in v

    def test_memory_confirmed_by_buffers_even_if_fits(self):
        # index nominally fits but cache-miss ratio is high (eviction)
        v = diagnose._verdict(
            self._size(900, 1024),
            self._buffers(0.75),
            self._warm(2000),
        )
        assert "MEMORY" in v


# ── optimize.py ──────────────────────────────────────────────────────────────

class TestOptimizePasses(unittest.TestCase):
    def _result(self, recall, p99):
        return {"recall_mean": recall, "p99_ms": p99}

    def test_passes_when_both_met(self):
        assert optimize._passes(self._result(0.95, 150)) is True

    def test_fails_on_low_recall(self):
        assert optimize._passes(self._result(0.85, 100)) is False

    def test_fails_on_high_p99(self):
        assert optimize._passes(self._result(0.92, 250)) is False

    def test_boundary_recall_passes(self):
        assert optimize._passes(self._result(0.90, 199)) is True

    def test_boundary_p99_fails(self):
        assert optimize._passes(self._result(0.90, 200)) is False


class TestParsePgSizeOptimize(unittest.TestCase):
    """_parse_pg_size is replicated in optimize via diagnose — test it standalone."""

    def test_parse_1gb(self):
        assert diagnose._parse_pg_size("1GB") == 1024**3


# ── ef_search_sweep.py ────────────────────────────────────────────────────────

class TestFindKnee(unittest.TestCase):
    def _row(self, ef, recall, p99):
        return {
            "ef_search": ef,
            "recall_mean": recall,
            "p99_ms": p99,
            "passes": recall >= 0.90 and p99 < 200,
        }

    def test_picks_lowest_passing_ef(self):
        results = [
            self._row(20, 0.80, 50),
            self._row(40, 0.91, 80),
            self._row(80, 0.95, 130),
            self._row(200, 0.97, 300),
        ]
        knee = ef_search_sweep._find_knee(results)
        assert knee["ef_search"] == 40

    def test_returns_none_when_nothing_passes(self):
        results = [
            self._row(20, 0.75, 50),
            self._row(40, 0.80, 80),
        ]
        knee = ef_search_sweep._find_knee(results)
        assert knee is None

    def test_fallback_to_best_recall_when_no_full_pass(self):
        results = [
            self._row(20, 0.80, 50),   # recall below floor
            self._row(40, 0.92, 250),  # recall ok, p99 too high
            self._row(80, 0.95, 400),
        ]
        # No row passes both criteria; best recall above floor is ef=40 (lowest p99)
        knee = ef_search_sweep._find_knee(results)
        assert knee["ef_search"] == 40


class TestAsciiTable(unittest.TestCase):
    def test_produces_header(self):
        results = [
            {"ef_search": 40, "recall_mean": 0.92, "p50_ms": 80.0, "p99_ms": 150.0, "passes": True}
        ]
        table = ef_search_sweep._ascii_table(results)
        assert "ef_search" in table
        assert "40" in table
        assert "0.920" in table


# ── random unit vector ────────────────────────────────────────────────────────

class TestRandomUnitVec(unittest.TestCase):
    def test_unit_norm(self):
        rng = np.random.default_rng(0)
        v = diagnose._random_unit_vec(384, rng)
        arr = np.array(v)
        assert abs(np.linalg.norm(arr) - 1.0) < 1e-5

    def test_length(self):
        rng = np.random.default_rng(0)
        v = diagnose._random_unit_vec(384, rng)
        assert len(v) == 384


import pytest  # noqa: E402 (needed for approx in TestExtractActualTime)

if __name__ == "__main__":
    unittest.main()
