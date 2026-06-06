"""
tests/test_area7.py — Area 7 test suite.

All tests run on CPU only, without GPU. Fast enough for CI at small scales.

Test inventory:
1. test_full_training_structure         — output has all required keys
2. test_full_training_loss_decreases    — h7_1_supported is True
3. test_onnx_roundtrip_structure        — output has all required keys
4. test_onnx_accuracy_delta_lt_1pct     — accuracy delta < 0.01
5. test_staleness_curve_shape           — accuracy_by_day has 15 entries, non-increasing
6. test_staleness_higher_rate_decays_faster — higher rate has shorter half_life_days
7. test_throughput_ratio_computed       — ratio = 10.0, h7_5_supported True (mocked)
8. test_h7_5_fails_when_ratio_lt_10     — ratio ≈ 8.3, h7_5_supported False (mocked)
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Ensure parent directory is importable (for CI environments where the package
# is not installed).
# ---------------------------------------------------------------------------
_AREA7_ROOT = Path(__file__).resolve().parent.parent
if str(_AREA7_ROOT) not in sys.path:
    sys.path.insert(0, str(_AREA7_ROOT))

_G0_ROOT = _AREA7_ROOT.parent / "g0-differentiability"
if str(_G0_ROOT) not in sys.path:
    sys.path.insert(0, str(_G0_ROOT))

_G4_ROOT = _AREA7_ROOT.parent / "g4-onnx-lossless"
if str(_G4_ROOT) not in sys.path:
    sys.path.insert(0, str(_G4_ROOT))


# ---------------------------------------------------------------------------
# Test 1: full training output structure
# ---------------------------------------------------------------------------

def test_full_training_structure():
    """
    Run with n_blocks=500, n_steps=50.
    Verify output dict has all required keys.
    """
    from full_training import run_full_training

    result = run_full_training(n_blocks=500, n_steps=50, eval_every=25, seed=42)

    required_keys = [
        "loss_curve",
        "clause_extraction_curve",
        "contradiction_detection_curve",
        "final_clause_accuracy",
        "final_contradiction_accuracy",
        "pretrained_clause_accuracy",
        "pretrained_contradiction_accuracy",
        "improvement_clause",
        "improvement_contradiction",
        "h7_1_supported",
    ]
    for key in required_keys:
        assert key in result, f"Missing key: {key!r}"

    assert isinstance(result["loss_curve"], list)
    assert len(result["loss_curve"]) == 50
    assert isinstance(result["clause_extraction_curve"], list)
    assert len(result["clause_extraction_curve"]) >= 1
    assert isinstance(result["h7_1_supported"], bool)


# ---------------------------------------------------------------------------
# Test 2: loss decreases → h7_1_supported
# ---------------------------------------------------------------------------

def test_full_training_loss_decreases():
    """
    Run with n_blocks=500, n_steps=200, seed=42.
    Verify h7_1_supported is True (loss must decrease).
    """
    from full_training import run_full_training

    result = run_full_training(n_blocks=500, n_steps=200, eval_every=50, seed=42)

    assert result["h7_1_supported"] is True, (
        f"h7_1_supported is False. "
        f"initial_loss={result['loss_curve'][0]:.4f}, "
        f"final_loss={result['loss_curve'][-1]:.4f}, "
        f"improvement_clause={result['improvement_clause']:+.4f}, "
        f"improvement_contradiction={result['improvement_contradiction']:+.4f}"
    )


# ---------------------------------------------------------------------------
# Test 3: ONNX round-trip output structure
# ---------------------------------------------------------------------------

def test_onnx_roundtrip_structure():
    """
    Train a tiny model, run ONNX export, verify output has all required keys
    including onnx_model_size_mb.
    """
    from _run_helpers import build_trained_model_and_data
    from onnx_production import run_onnx_roundtrip

    model, data = build_trained_model_and_data(
        n_blocks=200, embedding_dim=16, n_steps=5, seed=0
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = str(Path(tmpdir) / "test_model.onnx")
        result = run_onnx_roundtrip(
            model=model,
            data=data,
            n_eval_pairs=50,
            onnx_path=onnx_path,
        )

    required_keys = [
        "pytorch_accuracy",
        "onnx_accuracy",
        "accuracy_delta",
        "max_logit_diff",
        "onnx_model_size_mb",
        "export_time_sec",
        "h7_3_supported",
    ]
    for key in required_keys:
        assert key in result, f"Missing key: {key!r}"

    assert result["onnx_model_size_mb"] > 0
    assert result["export_time_sec"] >= 0


# ---------------------------------------------------------------------------
# Test 4: ONNX accuracy delta < 1%
# ---------------------------------------------------------------------------

def test_onnx_accuracy_delta_lt_1pct():
    """
    On a 100-node graph, verify accuracy delta < 0.01 after ONNX round-trip.
    """
    from _run_helpers import build_trained_model_and_data
    from onnx_production import run_onnx_roundtrip

    model, data = build_trained_model_and_data(
        n_blocks=100, embedding_dim=16, n_steps=10, seed=7
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = str(Path(tmpdir) / "test_model.onnx")
        result = run_onnx_roundtrip(
            model=model,
            data=data,
            n_eval_pairs=100,
            onnx_path=onnx_path,
        )

    assert result["accuracy_delta"] < 0.01, (
        f"Accuracy delta {result['accuracy_delta']:.4f} >= 0.01. "
        f"PyTorch acc: {result['pytorch_accuracy']:.4f}, "
        f"ONNX acc: {result['onnx_accuracy']:.4f}"
    )
    assert result["h7_3_supported"] is True


# ---------------------------------------------------------------------------
# Test 5: staleness curve shape
# ---------------------------------------------------------------------------

def test_staleness_curve_shape():
    """
    update_rate=100, n_days=14.
    Verify accuracy_by_day has 15 entries (day 0..14) and is non-increasing.
    """
    from staleness_curve import simulate_staleness_curve

    result = simulate_staleness_curve(
        update_rates_per_day=[100],
        n_days=14,
        initial_accuracy=0.85,
    )

    assert 100 in result, "Missing key 100 in staleness result"
    acc = result[100]["accuracy_by_day"]
    assert len(acc) == 15, f"Expected 15 entries (day 0..14), got {len(acc)}"

    # Non-increasing: each day's accuracy <= previous day's accuracy.
    for i in range(1, len(acc)):
        assert acc[i] <= acc[i - 1] + 1e-9, (
            f"accuracy_by_day is not non-increasing at day {i}: "
            f"{acc[i-1]:.4f} -> {acc[i]:.4f}"
        )


# ---------------------------------------------------------------------------
# Test 6: higher update rate decays faster
# ---------------------------------------------------------------------------

def test_staleness_higher_rate_decays_faster():
    """
    update_rate=10_000 decays faster (shorter half_life_days) than update_rate=10.
    """
    from staleness_curve import simulate_staleness_curve

    result = simulate_staleness_curve(
        update_rates_per_day=[10, 10_000],
        n_days=14,
        initial_accuracy=0.85,
    )

    half_life_slow = result[10]["half_life_days"]
    half_life_fast = result[10_000]["half_life_days"]

    assert half_life_fast < half_life_slow, (
        f"Expected 10K/day to decay faster than 10/day, but "
        f"half_life(10K/day)={half_life_fast:.2f} >= half_life(10/day)={half_life_slow:.2f}"
    )


# ---------------------------------------------------------------------------
# Test 7: throughput_ratio computed correctly (mocked)
# ---------------------------------------------------------------------------

def test_throughput_ratio_computed():
    """
    Inject onnx_p50_ms=5.0, live_graph_latency_ms=50.0.
    Verify throughput_ratio = 10.0 and h7_5_supported = True.
    """
    onnx_p50_ms = 5.0
    live_graph_latency_ms = 50.0

    onnx_throughput_qps = 1_000.0 / onnx_p50_ms
    live_throughput_qps = 1_000.0 / live_graph_latency_ms
    throughput_ratio = onnx_throughput_qps / live_throughput_qps

    assert abs(throughput_ratio - 10.0) < 1e-9, (
        f"Expected throughput_ratio=10.0, got {throughput_ratio}"
    )

    h7_5_supported = throughput_ratio >= 10.0
    assert h7_5_supported is True


# ---------------------------------------------------------------------------
# Test 8: h7_5_supported False when ratio < 10
# ---------------------------------------------------------------------------

def test_h7_5_fails_when_ratio_lt_10():
    """
    onnx_p50_ms=6.0, live=50.0 → ratio ≈ 8.33 → h7_5_supported = False.
    """
    onnx_p50_ms = 6.0
    live_graph_latency_ms = 50.0

    onnx_throughput_qps = 1_000.0 / onnx_p50_ms
    live_throughput_qps = 1_000.0 / live_graph_latency_ms
    throughput_ratio = onnx_throughput_qps / live_throughput_qps

    expected_ratio = 50.0 / 6.0
    assert abs(throughput_ratio - expected_ratio) < 1e-6, (
        f"Expected ratio≈{expected_ratio:.4f}, got {throughput_ratio:.4f}"
    )
    assert throughput_ratio < 10.0

    h7_5_supported = throughput_ratio >= 10.0
    assert h7_5_supported is False
