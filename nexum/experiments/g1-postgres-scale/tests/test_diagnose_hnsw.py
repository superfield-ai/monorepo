"""
tests/test_diagnose_hnsw.py — Unit tests for diagnose_hnsw.py.

Covers helpers that do not require a live database. The full diagnosis path is
exercised by integration runs (see experiments/g1-postgres-scale/results/).
"""

from __future__ import annotations

import importlib
import sys
import types
from unittest.mock import MagicMock

import pytest


def _ensure_psycopg2_stub() -> None:
    if "psycopg2" in sys.modules:
        return
    mod = types.ModuleType("psycopg2")
    mod.connect = lambda *a, **kw: MagicMock()
    extras = types.ModuleType("psycopg2.extras")
    extras.execute_values = lambda *a, **kw: None
    mod.extras = extras
    sys.modules["psycopg2"] = mod
    sys.modules["psycopg2.extras"] = extras


_ensure_psycopg2_stub()

# Import after stubbing
diagnose_hnsw = importlib.import_module(
    "experiments.g1-postgres-scale.diagnose_hnsw".replace("g1-postgres-scale", "g1_postgres_scale")
) if False else None  # the dashed dirname blocks normal import — load by path

import importlib.util
import pathlib

_HERE = pathlib.Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "diagnose_hnsw", _HERE / "diagnose_hnsw.py"
)
diagnose_hnsw = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
sys.modules["diagnose_hnsw"] = diagnose_hnsw  # required for dataclass introspection
_SPEC.loader.exec_module(diagnose_hnsw)


# ---------------------------------------------------------------------------
# _parse_size — Postgres size string parser
# ---------------------------------------------------------------------------

class TestParseSize:
    def test_kb(self):
        assert diagnose_hnsw._parse_size("8192kB") == 8192 * 1024

    def test_mb(self):
        assert diagnose_hnsw._parse_size("128MB") == 128 * 1024**2

    def test_gb(self):
        assert diagnose_hnsw._parse_size("1GB") == 1024**3

    def test_plain_int(self):
        assert diagnose_hnsw._parse_size("16384") == 16384


# ---------------------------------------------------------------------------
# CONFIGS sanity
# ---------------------------------------------------------------------------

class TestConfigs:
    def test_named_configs_present(self):
        assert "hnsw_m16_full" in diagnose_hnsw.CONFIGS
        assert "hnsw_m8_full" in diagnose_hnsw.CONFIGS
        assert "hnsw_m16_halfvec" in diagnose_hnsw.CONFIGS
        assert "ivfflat_1000" in diagnose_hnsw.CONFIGS

    def test_halfvec_uses_halfvec_opclass(self):
        cfg = diagnose_hnsw.CONFIGS["hnsw_m16_halfvec"]
        assert cfg.column_type == "halfvec"
        assert cfg.opclass == "halfvec_cosine_ops"

    def test_ivfflat_has_lists(self):
        cfg = diagnose_hnsw.CONFIGS["ivfflat_1000"]
        assert cfg.kind == "ivfflat"
        assert cfg.params.get("lists") == 1000
