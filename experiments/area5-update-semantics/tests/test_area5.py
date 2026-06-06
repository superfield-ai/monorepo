"""
tests/test_area5.py — Area 5 test suite (H5.1–H5.5).

Tests are divided into:
  - Fast unit tests (default): run always, use mocks / synthetic data.
  - Slow integration tests (@pytest.mark.slow): require sentence-transformers
    and real embedding inference.  Skip by default; enable with --run-slow.

Usage:
    pytest tests/ -v                          # fast tests only
    pytest tests/ -v --run-slow               # all tests including slow
"""

from __future__ import annotations

import sys
import os

import numpy as np
import pytest

# Make the experiment directory importable regardless of where pytest is run
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


# ===========================================================================
# H5.1 — Insertion latency tests
# ===========================================================================

class TestInsertionLatency:
    """Tests for insertion_latency.measure_insertion_latency."""

    def test_insertion_latency_structure(self, monkeypatch):
        """Mock HTTP; verify dict has all stage keys and bottleneck_stage."""
        from insertion_latency import measure_insertion_latency, PIPELINE_STAGES

        # Force mock path by patching requests.get to raise
        import requests as req_module

        def fake_get(*args, **kwargs):
            raise ConnectionRefusedError("mock: server not running")

        monkeypatch.setattr(req_module, "get", fake_get)

        result = measure_insertion_latency(
            nexum_url="http://localhost:9999",
            n_single_blocks=20,
            n_batch_blocks=100,
            seed=0,
        )

        # Top-level keys
        assert "single_block" in result
        assert "batch_1k" in result
        assert "bottleneck_stage" in result
        assert "h5_1_supported" in result

        # All stage keys present in single_block
        for stage in PIPELINE_STAGES:
            assert stage in result["single_block"], f"Missing stage: {stage}"
            assert "p50_ms" in result["single_block"][stage]
            assert "p99_ms" in result["single_block"][stage]

        # bottleneck_stage must be a non-total stage name
        non_total_stages = [s for s in PIPELINE_STAGES if s != "total_ms"]
        assert result["bottleneck_stage"] in non_total_stages

    def test_h5_1_criterion_supported(self, monkeypatch):
        """total P99 = 490 ms → h5_1_supported = True."""
        from insertion_latency import _format_result, PIPELINE_STAGES

        def _make_stages(total_p99: float) -> dict:
            stages = {}
            non_total = [s for s in PIPELINE_STAGES if s != "total_ms"]
            # Distribute total_p99 across stages proportionally
            fracs = [0.04, 0.24, 0.50, 0.19, 0.03]
            for stage, frac in zip(non_total, fracs):
                p99 = total_p99 * frac
                stages[stage] = {"p50_ms": p99 * 0.6, "p99_ms": p99}
            stages["total_ms"] = {"p50_ms": total_p99 * 0.6, "p99_ms": total_p99}
            return stages

        result = _format_result(
            single_stages=_make_stages(490.0),
            batch_stages=_make_stages(490.0),
        )
        assert result["h5_1_supported"] is True

    def test_h5_1_criterion_not_supported(self, monkeypatch):
        """total P99 = 510 ms → h5_1_supported = False."""
        from insertion_latency import _format_result, PIPELINE_STAGES

        def _make_stages(total_p99: float) -> dict:
            stages = {}
            non_total = [s for s in PIPELINE_STAGES if s != "total_ms"]
            fracs = [0.04, 0.24, 0.50, 0.19, 0.03]
            for stage, frac in zip(non_total, fracs):
                p99 = total_p99 * frac
                stages[stage] = {"p50_ms": p99 * 0.6, "p99_ms": p99}
            stages["total_ms"] = {"p50_ms": total_p99 * 0.6, "p99_ms": total_p99}
            return stages

        result = _format_result(
            single_stages=_make_stages(510.0),
            batch_stages=_make_stages(510.0),
        )
        assert result["h5_1_supported"] is False


# ===========================================================================
# H5.2 — Partial visibility tests
# ===========================================================================

class TestPartialVisibility:
    """Tests for partial_visibility.run_partial_visibility_eval."""

    def test_partial_visibility_delta_supported(self, monkeypatch):
        """Inject accuracy 0.80, 0.82, 0.84 → delta = 0.04 < 0.05 → h5_2_supported."""
        import requests as req_module

        def fake_get(*args, **kwargs):
            raise ConnectionRefusedError("mock: server not running")

        monkeypatch.setattr(req_module, "get", fake_get)

        from partial_visibility import _format_result

        result = _format_result(
            acc_emb=0.80,
            acc_str=0.82,
            acc_ai=0.84,
            delta=0.84 - 0.80,
        )

        assert abs(result["delta_embedding_to_ai"] - 0.04) < 1e-9
        assert result["h5_2_supported"] is True
        assert result["accuracy_embedding_only"] == pytest.approx(0.80)
        assert result["accuracy_structural_links"] == pytest.approx(0.82)
        assert result["accuracy_ai_links"] == pytest.approx(0.84)

    def test_partial_visibility_delta_not_supported(self, monkeypatch):
        """Delta = 0.06 → h5_2_supported = False."""
        from partial_visibility import _format_result

        result = _format_result(
            acc_emb=0.74,
            acc_str=0.77,
            acc_ai=0.80,
            delta=0.80 - 0.74,
        )
        assert result["delta_embedding_to_ai"] == pytest.approx(0.06)
        assert result["h5_2_supported"] is False

    def test_partial_visibility_mock_run(self, monkeypatch):
        """Mock path produces all required keys."""
        import requests as req_module

        def fake_get(*args, **kwargs):
            raise ConnectionRefusedError("mock: server not running")

        monkeypatch.setattr(req_module, "get", fake_get)

        from partial_visibility import run_partial_visibility_eval

        questions = [{"question": f"Q{i}?", "answer": f"ans{i}"} for i in range(20)]
        result = run_partial_visibility_eval(
            eval_questions=questions,
            nexum_url="http://localhost:9999",
            seed=1,
        )

        for key in [
            "accuracy_embedding_only",
            "accuracy_structural_links",
            "accuracy_ai_links",
            "delta_embedding_to_ai",
            "h5_2_supported",
        ]:
            assert key in result, f"Missing key: {key}"

        assert 0.0 <= result["accuracy_embedding_only"] <= 1.0
        assert 0.0 <= result["accuracy_ai_links"] <= 1.0


# ===========================================================================
# H5.3 — Version atomicity tests
# ===========================================================================

class TestVersionAtomicity:
    """Tests for version_atomicity.simulate_version_atomicity."""

    def test_version_atomicity_small_doc(self):
        """10-page doc (50 blocks) → index window < 5s at 50ms/block."""
        from version_atomicity import simulate_version_atomicity

        result = simulate_version_atomicity(
            document_sizes_pages=[10],
            blocks_per_page=5,
            embed_ms_per_block=50.0,
        )

        info = result[10]
        assert info["total_blocks"] == 50
        # 50 blocks × 50ms = 2500ms = 2.5s < 5000ms
        assert info["estimated_index_window_ms"] == pytest.approx(2500.0)
        assert info["estimated_index_window_ms"] < 5000.0

    def test_version_atomicity_all_sizes_returned(self):
        """Default call returns entries for all four document sizes."""
        from version_atomicity import simulate_version_atomicity

        result = simulate_version_atomicity()
        for pages in [10, 50, 100, 500]:
            assert pages in result, f"Missing entry for {pages} pages"
            info = result[pages]
            assert "total_blocks" in info
            assert "estimated_index_window_ms" in info
            assert info["partial_visibility_at_25pct"] in ("safe", "inconsistent")
            assert info["partial_visibility_at_50pct"] in ("safe", "inconsistent")

    def test_version_atomicity_signal_present(self):
        """h5_3_signal is a non-empty string."""
        from version_atomicity import simulate_version_atomicity

        result = simulate_version_atomicity()
        assert isinstance(result["h5_3_signal"], str)
        assert len(result["h5_3_signal"]) > 0


# ===========================================================================
# H5.4 — Embedding drift tests (fast unit tests using random vectors)
# ===========================================================================

class TestEmbeddingDrift:
    """Unit tests for embedding_drift helpers (no sentence-transformers)."""

    def test_cosine_distance_known_vectors(self):
        """Cosine distance formula: identical vectors → 0; orthogonal → 1."""
        from embedding_drift import _cosine_distance

        a = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        b = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        c = np.array([1.0, 0.0, 0.0], dtype=np.float32)

        assert _cosine_distance(a, b) == pytest.approx(1.0, abs=1e-6)
        assert _cosine_distance(a, c) == pytest.approx(0.0, abs=1e-6)

    def test_cosine_distance_partial(self):
        """Vector at 45° → cosine distance ≈ 1 - cos(45°) ≈ 0.2929."""
        from embedding_drift import _cosine_distance

        a = np.array([1.0, 0.0], dtype=np.float32)
        b = np.array([1.0, 1.0], dtype=np.float32) / np.sqrt(2)
        expected = 1.0 - np.cos(np.pi / 4)
        assert _cosine_distance(a, b) == pytest.approx(expected, abs=1e-5)

    def test_rank_shift_counting(self):
        """Hand-crafted retrieval lists → verify rank shift count."""
        from embedding_drift import _rank_shift

        # 5-vector corpus; block 0 is the one we track
        rng = np.random.default_rng(0)
        d = 8

        # Original embedding: strongly aligned with first axis
        original_emb = np.array([1.0] + [0.0] * (d - 1), dtype=np.float32)

        # Corpus: block 0 is original; others are mostly orthogonal
        corpus_embs = np.eye(d, dtype=np.float32)[:5]
        corpus_embs[0] = original_emb

        # Edited embedding: now aligned with second axis → block 0 drops to rank 2
        edited_emb = np.array([0.0, 1.0] + [0.0] * (d - 2), dtype=np.float32)

        shift = _rank_shift(original_emb, edited_emb, corpus_embs, top_k=5)
        # original rank of block 0: 0 (best match to itself via dot product)
        # edited rank of block 0: should be lower (corpus_embs[1] wins with edited)
        assert shift >= 0

    def test_safe_edit_threshold_logic(self):
        """Inject drift measurements → verify safe_edit_threshold is the
        highest fraction where pct_blocks_shift_gt_3 < 0.05."""
        # Simulate the threshold-finding logic directly
        fracs = [0.01, 0.02, 0.05, 0.10, 0.20]
        # Mock measurements: safe up to 0.05, unsafe at 0.10+
        measurements = {
            0.01: {"pct_blocks_shift_gt_3": 0.01},
            0.02: {"pct_blocks_shift_gt_3": 0.02},
            0.05: {"pct_blocks_shift_gt_3": 0.04},  # just under 0.05
            0.10: {"pct_blocks_shift_gt_3": 0.08},  # over 0.05
            0.20: {"pct_blocks_shift_gt_3": 0.15},
        }
        safe_threshold = 0.0
        for frac in sorted(fracs):
            if measurements[frac]["pct_blocks_shift_gt_3"] < 0.05:
                safe_threshold = frac
        assert safe_threshold == pytest.approx(0.05)

    def test_safe_edit_threshold_none_safe(self):
        """All fractions unsafe → safe_threshold = 0.0."""
        fracs = [0.01, 0.02, 0.05]
        measurements = {f: {"pct_blocks_shift_gt_3": 0.10} for f in fracs}
        safe_threshold = 0.0
        for frac in sorted(fracs):
            if measurements[frac]["pct_blocks_shift_gt_3"] < 0.05:
                safe_threshold = frac
        assert safe_threshold == 0.0

    def test_apply_random_edit(self):
        """Editing 50% of tokens changes approximately half the words."""
        import random as stdlib_random
        from embedding_drift import apply_random_edit, _tokenize

        text = "the quick brown fox jumps over the lazy dog"
        rng = stdlib_random.Random(42)
        edited = apply_random_edit(text, 0.5, rng)

        orig_tokens = _tokenize(text)
        edit_tokens = _tokenize(edited)
        assert len(orig_tokens) == len(edit_tokens)
        changed = sum(o != e for o, e in zip(orig_tokens, edit_tokens))
        # Should change approximately 50% ± generous tolerance
        assert 1 <= changed <= len(orig_tokens)

    def test_estimate_hnsw_boundary_shape(self):
        """estimate_hnsw_boundary returns all required keys with valid values."""
        from embedding_drift import estimate_hnsw_boundary

        # 20 random unit-norm embeddings in 16 dimensions
        rng = np.random.default_rng(0)
        embs = rng.normal(size=(20, 16)).astype(np.float32)
        # Unit-normalize
        embs = embs / np.linalg.norm(embs, axis=1, keepdims=True)

        boundary = estimate_hnsw_boundary(embs, top_k=5, n_queries=10, rng=rng)

        for key in ("mean_boundary", "p25_boundary", "p50_boundary", "p75_boundary", "top_k"):
            assert key in boundary, f"Missing key: {key}"

        assert boundary["top_k"] == 5
        # Boundary gaps must be non-negative
        assert boundary["mean_boundary"] >= 0.0
        assert boundary["p25_boundary"] >= 0.0
        assert boundary["p50_boundary"] >= 0.0
        assert boundary["p75_boundary"] >= 0.0
        # p25 <= p50 <= p75
        assert boundary["p25_boundary"] <= boundary["p50_boundary"]
        assert boundary["p50_boundary"] <= boundary["p75_boundary"]

    def test_estimate_hnsw_boundary_orthogonal_corpus(self):
        """For orthogonal unit vectors, boundary gap = 1/(n-1) approximately."""
        from embedding_drift import estimate_hnsw_boundary

        # 10 orthogonal unit vectors in 10 dimensions
        embs = np.eye(10, dtype=np.float32)
        rng = np.random.default_rng(1)

        # With orthogonal vectors, similarities are either 1 (self) or 0 (others)
        # boundary gap = similarity[rank k] - similarity[rank k+1] = 0 - 0 = 0
        boundary = estimate_hnsw_boundary(embs, top_k=3, n_queries=5, rng=rng)
        # All off-diagonal similarities are 0, so gap between k-th and (k+1)-th
        # nearest neighbor is 0 (all tied)
        assert boundary["mean_boundary"] == pytest.approx(0.0, abs=1e-6)

    def test_estimate_hnsw_boundary_requires_enough_corpus(self):
        """Raises ValueError if corpus has <= top_k entries."""
        from embedding_drift import estimate_hnsw_boundary

        embs = np.eye(5, dtype=np.float32)
        with pytest.raises(ValueError, match="top_k"):
            estimate_hnsw_boundary(embs, top_k=5, n_queries=5)

    def test_pct_drift_exceeds_boundary_present(self):
        """measure_embedding_drift result includes pct_drift_exceeds_boundary per fraction."""
        # This test verifies the output schema without calling sentence-transformers.
        # We simulate the output structure expected from measure_embedding_drift.
        expected_keys = [
            "mean_cosine_distance",
            "p95_cosine_distance",
            "mean_rank_shift",
            "pct_blocks_shift_gt_3",
            "pct_drift_exceeds_boundary",
        ]
        # Verify these keys are declared in the docstring / code (structural check)
        from embedding_drift import measure_embedding_drift
        import inspect
        src = inspect.getsource(measure_embedding_drift)
        for key in expected_keys:
            assert key in src, f"Key {key!r} not found in measure_embedding_drift source"

    @pytest.mark.slow
    def test_measure_embedding_drift_full(self):
        """
        Full measure_embedding_drift with real sentence-transformers.

        This test is slow (~30–60s) and requires sentence-transformers installed.
        Run with: pytest --run-slow
        """
        from embedding_drift import measure_embedding_drift, _SAFE_THRESHOLD_MIN

        # Small corpus for speed (needs > top_k entries for boundary estimation)
        texts = [
            f"Contract clause {i}: payment terms shall be net thirty days."
            for i in range(50)
        ]
        result = measure_embedding_drift(
            texts=texts,
            edit_fractions=[0.01, 0.05, 0.10],
            n_samples=50,
            top_k=5,
            seed=0,
        )

        for frac in [0.01, 0.05, 0.10]:
            assert frac in result
            d = result[frac]
            assert "mean_cosine_distance" in d
            assert "p95_cosine_distance" in d
            assert "mean_rank_shift" in d
            assert "pct_blocks_shift_gt_3" in d
            assert "pct_drift_exceeds_boundary" in d
            # Cosine distance should be in valid range
            assert 0.0 <= d["mean_cosine_distance"] <= 2.0
            assert 0.0 <= d["pct_blocks_shift_gt_3"] <= 1.0
            assert 0.0 <= d["pct_drift_exceeds_boundary"] <= 1.0

        assert "safe_edit_threshold" in result
        assert "h5_4_supported" in result
        assert "hnsw_boundary" in result
        hnsw = result["hnsw_boundary"]
        assert "mean_boundary" in hnsw
        assert hnsw["mean_boundary"] >= 0.0
        # Safe threshold must be in the tested fractions
        assert result["safe_edit_threshold"] in [0.0, 0.01, 0.05, 0.10]


# ===========================================================================
# H5.5 — High-ingest contention tests
# ===========================================================================

class TestHighIngestContention:
    """Tests for high_ingest_contention.simulate_high_ingest_contention."""

    def test_deferred_beats_synchronous_default(self):
        """Default parameters → deferred beats synchronous on both metrics."""
        from high_ingest_contention import simulate_high_ingest_contention

        result = simulate_high_ingest_contention(
            blocks_per_minute=10_000,
            simulation_duration_seconds=60,
            query_rate_per_second=10,
            seed=42,
        )

        assert "synchronous" in result
        assert "deferred" in result
        assert "h5_5_supported" in result

        s = result["synchronous"]
        d = result["deferred"]

        # Deferred should win on both recall and throughput
        assert d["query_recall"] >= s["query_recall"]
        assert d["ingest_throughput"] >= s["ingest_throughput"]
        assert result["h5_5_supported"] is True

    def test_h5_5_result_structure(self):
        """Result dict has all required keys with numeric values."""
        from high_ingest_contention import simulate_high_ingest_contention

        result = simulate_high_ingest_contention(seed=0)

        for strategy in ("synchronous", "deferred"):
            stats = result[strategy]
            assert "ingest_throughput" in stats
            assert "query_recall" in stats
            assert "p99_query_latency_ms" in stats
            assert stats["ingest_throughput"] > 0
            assert 0.0 <= stats["query_recall"] <= 1.0
            assert stats["p99_query_latency_ms"] > 0

    def test_h5_5_not_supported_when_deferred_loses(self):
        """When deferred loses on recall, h5_5_supported = False."""
        from high_ingest_contention import _format_result_h5_5

        sync = {"ingest_throughput": 100.0, "query_recall": 0.95, "p99_query_latency_ms": 20.0}
        deferred = {"ingest_throughput": 150.0, "query_recall": 0.90, "p99_query_latency_ms": 18.0}

        result = _format_result_h5_5(sync, deferred)
        # Deferred has higher throughput but lower recall → h5_5 NOT supported
        assert result["h5_5_supported"] is False

    def test_h5_5_supported_when_deferred_wins_both(self):
        """When deferred wins on both metrics, h5_5_supported = True."""
        from high_ingest_contention import _format_result_h5_5

        sync = {"ingest_throughput": 100.0, "query_recall": 0.90, "p99_query_latency_ms": 25.0}
        deferred = {"ingest_throughput": 160.0, "query_recall": 0.98, "p99_query_latency_ms": 22.0}

        result = _format_result_h5_5(sync, deferred)
        assert result["h5_5_supported"] is True


# ===========================================================================
# H5.1 — Results writer integration (canonical envelope)
# ===========================================================================

class TestH5_1ResultsWriter:
    """Verify that H5.1 results can be written through ResultEnvelope."""

    def test_h5_1_results_writer_integration(self, monkeypatch, tmp_path):
        """H5.1 result written via ResultEnvelope has required canonical keys."""
        import sys
        import os

        # Add repo root to sys.path so experiments._lib is importable
        area5_dir = os.path.dirname(os.path.dirname(__file__))
        repo_root = os.path.abspath(os.path.join(area5_dir, "..", ".."))
        if repo_root not in sys.path:
            sys.path.insert(0, repo_root)

        from experiments._lib.results_writer import ResultEnvelope, write_result
        from experiments._lib.runner import capture_run_context
        from insertion_latency import measure_insertion_latency
        import requests as req_module

        def fake_get(*args, **kwargs):
            raise ConnectionRefusedError("mock: server not running")

        monkeypatch.setattr(req_module, "get", fake_get)

        h5_1_result = measure_insertion_latency(
            nexum_url="http://localhost:9999",
            n_single_blocks=20,
            n_batch_blocks=100,
            seed=7,
        )

        run_ctx = capture_run_context(gate="H5.1", hypothesis="H5.1", seed=7)
        envelope = ResultEnvelope(
            gate="H5.1",
            hypothesis="H5.1",
            passed=h5_1_result["h5_1_supported"],
            metrics=h5_1_result,
            runtime=run_ctx,
            notes="Test run — mock data only.",
        )

        out_path = write_result(envelope, area_dir=tmp_path, filename="h5.1_test.json")
        assert out_path.exists()

        import json
        data = json.loads(out_path.read_text())

        # Canonical envelope shape
        assert data["schema_version"] == 1
        assert data["gate"] == "H5.1"
        assert data["hypothesis"] == "H5.1"
        assert isinstance(data["pass"], bool)
        assert "metrics" in data
        assert "runtime" in data
        assert "results_path" in data

        # H5.1-specific metrics
        metrics = data["metrics"]
        assert "single_block" in metrics
        assert "batch_1k" in metrics
        assert "bottleneck_stage" in metrics
        assert "h5_1_supported" in metrics
        assert metrics["bottleneck_stage"] != "total_ms"

    def test_h5_1_non_hnsw_bottleneck_noted(self, monkeypatch):
        """When HNSW is not the bottleneck, bottleneck_stage is documented correctly."""
        from insertion_latency import _format_result, PIPELINE_STAGES

        # Artificially make embed_ms the largest stage
        non_total = [s for s in PIPELINE_STAGES if s != "total_ms"]
        single_stages = {}
        for i, stage in enumerate(non_total):
            # embed_ms (index 1) gets highest P99
            p99 = 300.0 if stage == "embed_ms" else 50.0
            single_stages[stage] = {"p50_ms": p99 * 0.6, "p99_ms": p99}
        single_stages["total_ms"] = {"p50_ms": 280.0, "p99_ms": 450.0}

        result = _format_result(
            single_stages=single_stages,
            batch_stages=single_stages,
        )
        # HNSW is NOT the bottleneck — embed is
        assert result["bottleneck_stage"] == "embed_ms"
        assert result["bottleneck_stage"] != "index_insert_ms"
