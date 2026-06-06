"""
Lab-bench tests for the four new components:
  - NexumEmbedder (MTEB adapter)
  - freshqa_eval.normalize_answer
  - legalbench_eval task loading
  - ogb_eval MRR computation
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

# Make sure the lab-bench root is on sys.path so imports work from any cwd.
LAB_BENCH_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LAB_BENCH_ROOT))


# ---------------------------------------------------------------------------
# 1. NexumEmbedder — encode() returns correct numpy shape; mocked HTTP
# ---------------------------------------------------------------------------

class TestNexumEmbedder:
    def test_encode_returns_numpy_array(self):
        """encode() should return np.ndarray with shape (n_sentences, dim)."""
        from adapters.nexum_embedder import NexumEmbedder

        fake_embedding = [0.1] * 384
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "embeddings": [fake_embedding, fake_embedding, fake_embedding]
        }
        mock_response.raise_for_status = MagicMock()

        with patch("requests.Session.post", return_value=mock_response):
            embedder = NexumEmbedder(nexum_url="http://fake:3000", local_fallback=False)
            sentences = ["hello world", "foo bar", "test sentence"]
            result = embedder.encode(sentences, batch_size=32)

        assert isinstance(result, np.ndarray)
        assert result.shape == (3, 384)

    def test_encode_connection_error_falls_back_to_local(self):
        """When the HTTP call fails and local_fallback=True, encode() still returns an array."""
        from adapters.nexum_embedder import NexumEmbedder

        # Patch the local sentence-transformers model
        fake_embeddings = np.random.rand(2, 384).astype(np.float32)
        mock_st_model = MagicMock()
        mock_st_model.encode.return_value = fake_embeddings

        import requests

        with patch("requests.Session.post", side_effect=requests.ConnectionError("down")):
            with patch("adapters.nexum_embedder.SentenceTransformer", return_value=mock_st_model):
                embedder = NexumEmbedder(nexum_url="http://fake:3000", local_fallback=True)
                result = embedder.encode(["a", "b"])

        assert isinstance(result, np.ndarray)
        assert result.shape[0] == 2

    def test_encode_batching(self):
        """encode() should split large input into batches."""
        from adapters.nexum_embedder import NexumEmbedder

        dim = 128
        call_count = []

        def fake_post(url, json=None, **kwargs):
            n = len(json["sentences"])
            call_count.append(n)
            resp = MagicMock()
            resp.json.return_value = {"embeddings": [[0.0] * dim] * n}
            resp.raise_for_status = MagicMock()
            return resp

        with patch("requests.Session.post", side_effect=fake_post):
            embedder = NexumEmbedder(nexum_url="http://fake:3000", local_fallback=False)
            sentences = [f"sentence {i}" for i in range(10)]
            result = embedder.encode(sentences, batch_size=4)

        assert result.shape == (10, dim)
        # 10 sentences with batch_size=4 → 3 batches (4, 4, 2)
        assert len(call_count) == 3
        assert call_count == [4, 4, 2]


# ---------------------------------------------------------------------------
# 2. FreshQA — normalize_answer unit tests
# ---------------------------------------------------------------------------

class TestFreshQANormalize:
    def test_lowercase(self):
        from eval.freshqa_eval import normalize_answer
        assert normalize_answer("Hello World") == "hello world"

    def test_strip_punctuation(self):
        from eval.freshqa_eval import normalize_answer
        assert normalize_answer("Yes!") == "yes"
        assert normalize_answer("New York, N.Y.") == "new york ny"

    def test_strip_articles(self):
        from eval.freshqa_eval import normalize_answer
        # Articles should be removed when surrounded by word boundaries
        result = normalize_answer("The United States")
        assert "the" not in result.split()

    def test_whitespace_normalization(self):
        from eval.freshqa_eval import normalize_answer
        assert normalize_answer("  foo   bar  ") == "foo bar"

    def test_empty_string(self):
        from eval.freshqa_eval import normalize_answer
        assert normalize_answer("") == ""

    def test_exact_match_logic(self):
        from eval.freshqa_eval import normalize_answer, exact_match
        assert exact_match("The Eiffel Tower", "eiffel tower") == 1.0
        assert exact_match("Paris", "London") == 0.0


# ---------------------------------------------------------------------------
# 3. LegalBench — task loading (mocked HuggingFace)
# ---------------------------------------------------------------------------

class TestLegalBenchTaskLoading:
    def test_default_20_tasks_defined(self):
        from eval.legalbench_eval import DEFAULT_20_TASKS
        assert isinstance(DEFAULT_20_TASKS, list)
        assert len(DEFAULT_20_TASKS) == 20

    def test_load_task_returns_examples(self):
        """load_task() should return a list of dicts with 'text' and 'label' keys."""
        from eval.legalbench_eval import load_task

        # Build a minimal mock dataset
        mock_example = {"text": "This agreement shall be governed by...", "answer": "Yes"}
        mock_dataset = MagicMock()
        mock_dataset.__iter__ = MagicMock(return_value=iter([mock_example]))
        mock_dataset.__len__ = MagicMock(return_value=1)

        mock_ds_dict = {"test": mock_dataset}

        with patch("eval.legalbench_eval.load_dataset", return_value=mock_ds_dict):
            examples = load_task("contract_nli_confidentiality_of_agreement", split="test")

        assert isinstance(examples, list)
        assert len(examples) == 1
        assert "text" in examples[0]
        assert "label" in examples[0]

    def test_resolve_tasks_default20(self):
        from eval.legalbench_eval import resolve_tasks, DEFAULT_20_TASKS
        tasks = resolve_tasks("default20")
        assert tasks == DEFAULT_20_TASKS

    def test_resolve_tasks_custom(self):
        from eval.legalbench_eval import resolve_tasks
        tasks = resolve_tasks("task_a,task_b")
        assert tasks == ["task_a", "task_b"]


# ---------------------------------------------------------------------------
# 4. OGB eval — MRR computation unit tests
# ---------------------------------------------------------------------------

class TestOGBMetrics:
    def test_mrr_perfect(self):
        """If the true entity is always rank 1, MRR = 1.0."""
        from eval.ogb_eval import compute_mrr_and_hits
        # ranks: list of rank of the true entity (1-indexed)
        ranks = [1, 1, 1, 1]
        mrr, h1, h3, h10 = compute_mrr_and_hits(ranks)
        assert mrr == pytest.approx(1.0)
        assert h1 == pytest.approx(1.0)
        assert h3 == pytest.approx(1.0)
        assert h10 == pytest.approx(1.0)

    def test_mrr_worst(self):
        """If the true entity is always rank 100, MRR = 0.01 and Hits@{1,3,10} = 0."""
        from eval.ogb_eval import compute_mrr_and_hits
        ranks = [100, 100, 100]
        mrr, h1, h3, h10 = compute_mrr_and_hits(ranks)
        assert mrr == pytest.approx(1 / 100)
        assert h1 == pytest.approx(0.0)
        assert h3 == pytest.approx(0.0)
        assert h10 == pytest.approx(0.0)

    def test_mrr_mixed(self):
        from eval.ogb_eval import compute_mrr_and_hits
        # ranks: 1, 2, 10, 11
        ranks = [1, 2, 10, 11]
        mrr, h1, h3, h10 = compute_mrr_and_hits(ranks)
        expected_mrr = (1/1 + 1/2 + 1/10 + 1/11) / 4
        assert mrr == pytest.approx(expected_mrr, rel=1e-5)
        assert h1 == pytest.approx(1 / 4)   # only rank 1
        assert h3 == pytest.approx(2 / 4)   # rank 1 and 2
        assert h10 == pytest.approx(3 / 4)  # rank 1, 2, 10

    def test_hits_at_k(self):
        from eval.ogb_eval import hits_at_k
        ranks = [1, 5, 11, 20]
        assert hits_at_k(ranks, k=1) == pytest.approx(0.25)
        assert hits_at_k(ranks, k=10) == pytest.approx(0.5)
        assert hits_at_k(ranks, k=20) == pytest.approx(1.0)
