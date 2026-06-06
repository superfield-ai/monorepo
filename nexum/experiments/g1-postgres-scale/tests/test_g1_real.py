"""Unit tests for the real-embedding G1 modules.

These tests must pass without a Postgres connection AND without
sentence-transformers installed (the model loader is mocked).
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import numpy as np

# psycopg2 stub (mirrors test_g1.py)
if "psycopg2" not in sys.modules:
    psycopg2_mod = types.ModuleType("psycopg2")
    extras_mod = types.ModuleType("psycopg2.extras")

    def execute_values(cur, sql, argslist, template=None, page_size=100,
                       fetch=False):
        pass

    extras_mod.execute_values = execute_values
    psycopg2_mod.extras = extras_mod
    sys.modules["psycopg2"] = psycopg2_mod
    sys.modules["psycopg2.extras"] = extras_mod

# Make the g1 module importable
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

import ingest_real  # noqa: E402
import bench_real  # noqa: E402


class TestGenerateBlockText(unittest.TestCase):
    def test_topic_index_in_range(self) -> None:
        rng = np.random.default_rng(0)
        for _ in range(50):
            t = int(rng.integers(0, len(ingest_real._TOPICS)))
            text = ingest_real._generate_block_text(rng, t)
            self.assertIsInstance(text, str)
            self.assertGreater(len(text), 10)

    def test_per_block_variation(self) -> None:
        """Same topic should produce DIFFERENT sentences across calls."""
        rng = np.random.default_rng(0)
        seen = {ingest_real._generate_block_text(rng, 0) for _ in range(20)}
        # 20 random suffixes ⇒ very high uniqueness
        self.assertGreater(len(seen), 10)


class TestModelLoader(unittest.TestCase):
    def test_load_model_caches(self) -> None:
        # Patch SentenceTransformer at the import site
        ingest_real._MODEL_CACHE.clear()
        fake = MagicMock()
        fake_st_module = types.ModuleType("sentence_transformers")
        fake_st_module.SentenceTransformer = MagicMock(return_value=fake)
        with patch.dict(sys.modules,
                        {"sentence_transformers": fake_st_module}):
            m1 = ingest_real._load_model("dummy/model")
            m2 = ingest_real._load_model("dummy/model")
        self.assertIs(m1, m2)
        self.assertEqual(
            fake_st_module.SentenceTransformer.call_count, 1,
            "Loader should cache and not re-instantiate the model.",
        )


class TestQueryVectors(unittest.TestCase):
    def test_generate_query_vectors_shape(self) -> None:
        ingest_real._MODEL_CACHE.clear()
        fake_model = MagicMock()
        fake_model.encode.return_value = np.zeros((5, 384), dtype=np.float32)
        with patch.object(bench_real, "_load_model",
                          return_value=fake_model):
            rng = np.random.default_rng(0)
            vecs, texts = bench_real._generate_query_vectors(
                rng, 5, "dummy/model"
            )
        self.assertEqual(vecs.shape, (5, 384))
        self.assertEqual(len(texts), 5)


class TestRecallMeasurement(unittest.TestCase):
    def test_recall_perfect_when_ann_equals_exact(self) -> None:
        # Build a fake cursor where the exact KNN returns the same IDs the
        # ANN top-10 captured.
        ann_top10 = [["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]]
        qvecs = np.zeros((1, 384), dtype=np.float32)

        cursor = MagicMock()
        # Cursor must support __enter__/__exit__ for `with conn.cursor() as`
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        cursor.fetchall.return_value = [(c,) for c in ann_top10[0]]
        conn = MagicMock()
        conn.cursor.return_value = cursor

        result = bench_real._measure_recall_at_10(
            conn, qvecs, ann_top10, n_recall_queries=1
        )
        self.assertEqual(result["mean_recall_at_10"], 1.0)
        self.assertEqual(result["n_queries_used"], 1)

    def test_recall_zero_when_disjoint(self) -> None:
        ann_top10 = [["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]]
        exact = [["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]]
        qvecs = np.zeros((1, 384), dtype=np.float32)

        cursor = MagicMock()
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        cursor.fetchall.return_value = [(c,) for c in exact[0]]
        conn = MagicMock()
        conn.cursor.return_value = cursor

        result = bench_real._measure_recall_at_10(
            conn, qvecs, ann_top10, n_recall_queries=1
        )
        self.assertEqual(result["mean_recall_at_10"], 0.0)


if __name__ == "__main__":
    unittest.main()
