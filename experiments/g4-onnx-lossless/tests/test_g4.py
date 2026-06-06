"""
tests/test_g4.py — Unit tests for the G4 ONNX losslessness spike.

All tests run on CPU with tiny graphs (no GPU required).

Tests:
1. test_onnx_export_produces_file        — export a 5-node model; verify file exists
                                           and is a valid ONNX model.
2. test_onnx_inference_matches_pytorch   — on a tiny graph, verify logits from ONNX
                                           Runtime match PyTorch within 1e-4 tolerance.
3. test_accuracy_delta_below_threshold   — unit-test evaluate_losslessness_from_logits:
                                           delta=0.001 → pass; delta=0.02 → fail.
4. test_pass_criterion                   — pass_g4=True when accuracy_delta < 0.01.
5. test_fallback_numpy_inference         — NumPy fallback produces correct output shape.
6. test_onnx_model_size_reasonable       — 100-node graph export < 10 MB.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest
import torch

# ---------------------------------------------------------------------------
# sys.path setup — allow importing from g4 and g0 directories.
# ---------------------------------------------------------------------------
_G4_DIR = Path(__file__).resolve().parent.parent
_G0_DIR = _G4_DIR.parent / "g0-differentiability"

for _p in [str(_G4_DIR), str(_G0_DIR)]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

from model import TypedLinkGraphModel           # from g0
from data import generate_synthetic_graph       # from g0
from export import export_to_onnx               # from g4
from inference import ONNXGraphInference, NumpyFallbackInference  # from g4
from eval_losslessness import (                 # from g4
    evaluate_losslessness,
    evaluate_losslessness_from_logits,
    PASS_THRESHOLD,
)


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def tiny_data():
    """5-node, ~20-edge synthetic graph for fast testing."""
    return generate_synthetic_graph(
        n_nodes=5,
        n_edges=20,
        n_labeled_pairs=10,
        node_feat_dim=16,
        seed=7,
    )


@pytest.fixture(scope="module")
def tiny_model(tiny_data):
    """Small TypedLinkGraphModel matching the tiny graph."""
    model = TypedLinkGraphModel(
        node_feat_dim=tiny_data.x.shape[1],
        hidden_dim=8,
        out_dim=4,
        type_emb_dim=4,
        num_layers=2,
        dropout=0.0,  # no dropout for deterministic eval
    )
    model.eval()
    return model


@pytest.fixture(scope="module")
def medium_data():
    """100-node, ~500-edge synthetic graph for size test."""
    return generate_synthetic_graph(
        n_nodes=100,
        n_edges=500,
        n_labeled_pairs=50,
        node_feat_dim=32,
        seed=13,
    )


@pytest.fixture(scope="module")
def medium_model(medium_data):
    model = TypedLinkGraphModel(
        node_feat_dim=medium_data.x.shape[1],
        hidden_dim=16,
        out_dim=8,
        type_emb_dim=4,
        num_layers=2,
        dropout=0.0,
    )
    model.eval()
    return model


# ---------------------------------------------------------------------------
# Test 1: ONNX export produces a file and passes onnx.checker.check_model
# ---------------------------------------------------------------------------

def test_onnx_export_produces_file(tiny_model, tiny_data):
    """
    export_to_onnx() must produce a .onnx file that:
    - Exists on disk
    - Passes onnx.checker.check_model (is a structurally valid ONNX graph)
    """
    import onnx

    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = os.path.join(tmpdir, "tiny_model.onnx")
        result = export_to_onnx(
            model=tiny_model,
            sample_data=tiny_data,
            output_path=onnx_path,
            opset_version=17,
        )

        # File must exist.
        assert os.path.exists(onnx_path), "ONNX file was not created."
        assert result["onnx_path"] == onnx_path
        assert result["export_success"] is True

        # Must be a valid ONNX model (no checker exception).
        onnx_model = onnx.load(onnx_path)
        # Should not raise:
        onnx.checker.check_model(onnx_model)
        assert result["validation_passed"] is True

        # Size must be > 0 bytes.
        assert result["onnx_model_size_bytes"] > 0

        # Metadata.
        assert result["n_nodes"] == tiny_data.x.shape[0]
        assert result["n_edges"] == tiny_data.edge_index.shape[1]
        assert result["opset_version"] == 17


# ---------------------------------------------------------------------------
# Test 2: ONNX Runtime logits match PyTorch logits within 1e-4
# ---------------------------------------------------------------------------

def test_onnx_inference_matches_pytorch(tiny_model, tiny_data):
    """
    On a tiny graph, ONNX Runtime logits must match PyTorch forward pass
    within 1e-4 absolute tolerance.

    This verifies that serialization introduces no approximation beyond
    floating-point rounding — which is the central claim of H7.3.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = os.path.join(tmpdir, "tiny_model.onnx")
        result = export_to_onnx(
            model=tiny_model,
            sample_data=tiny_data,
            output_path=onnx_path,
            opset_version=17,
        )

        # --- PyTorch logits ---
        tiny_model.eval()
        with torch.no_grad():
            node_emb = tiny_model(
                tiny_data.x,
                tiny_data.edge_index,
                tiny_data.edge_type,
                tiny_data.edge_confidence,
            )
            logits_pt = tiny_model.predict(node_emb, tiny_data.pair_index)
        logits_pt_np = logits_pt.cpu().numpy()

        # --- ONNX or NumPy fallback logits ---
        x_np = tiny_data.x.cpu().numpy()
        ei_np = tiny_data.edge_index.cpu().numpy()
        et_np = tiny_data.edge_type.cpu().numpy()
        ec_np = tiny_data.edge_confidence.cpu().numpy()
        pairs_np = tiny_data.pair_index.cpu().numpy()

        if result["fallback_used"]:
            npz_path = result["fallback_npz_path"]
            infer = NumpyFallbackInference(npz_path)
            logits_onnx = infer.predict(
                edge_index=ei_np,
                edge_type=et_np,
                edge_confidence=ec_np,
                node_pairs=pairs_np,
                x=x_np,
            )
        else:
            infer = ONNXGraphInference(onnx_path=onnx_path)
            logits_onnx = infer.predict(
                edge_index=ei_np,
                edge_type=et_np,
                edge_confidence=ec_np,
                node_pairs=pairs_np,
                x=x_np,
            )

        logits_onnx = np.asarray(logits_onnx, dtype=np.float32).ravel()

        # Tolerance: 1e-4 absolute.
        max_diff = float(np.abs(logits_pt_np - logits_onnx).max())
        assert max_diff < 1e-4, (
            f"Max logit difference {max_diff:.6f} exceeds 1e-4 tolerance. "
            "ONNX export is not numerically lossless."
        )


# ---------------------------------------------------------------------------
# Test 3: evaluate_losslessness_from_logits — delta thresholding
# ---------------------------------------------------------------------------

def test_accuracy_delta_below_threshold():
    """
    Construct matching logit scenarios:
      - accuracy_pytorch=0.85, accuracy_onnx=0.849 → delta=0.001 → PASS
      - accuracy_pytorch=0.85, accuracy_onnx=0.83  → delta=0.02  → FAIL
    """
    n = 200
    labels = np.array([1.0] * 100 + [0.0] * 100, dtype=np.float32)

    # --- Scenario A: near-identical accuracies (delta < 0.01) ---
    # PyTorch: correct on first 170 pairs (85 / 100 pos, 85 / 100 neg)
    logits_pt_a = np.array(
        [1.0] * 85 + [-1.0] * 15 + [-1.0] * 85 + [1.0] * 15, dtype=np.float32
    )
    # ONNX: correct on first 169 pairs (same +/- 1 pair)
    logits_onnx_a = np.array(
        [1.0] * 85 + [-1.0] * 15 + [-1.0] * 84 + [1.0] * 16, dtype=np.float32
    )
    result_a = evaluate_losslessness_from_logits(logits_pt_a, logits_onnx_a, labels)
    assert result_a["accuracy_delta"] < PASS_THRESHOLD, (
        f"Scenario A: expected delta < {PASS_THRESHOLD}, got {result_a['accuracy_delta']}"
    )
    assert result_a["pass_g4"] is True

    # --- Scenario B: larger gap (delta >= 0.01) ---
    # PyTorch: 85% accuracy
    logits_pt_b = np.array(
        [1.0] * 85 + [-1.0] * 15 + [-1.0] * 85 + [1.0] * 15, dtype=np.float32
    )
    # ONNX: 83% accuracy (4 fewer correct pairs)
    logits_onnx_b = np.array(
        [1.0] * 83 + [-1.0] * 17 + [-1.0] * 83 + [1.0] * 17, dtype=np.float32
    )
    result_b = evaluate_losslessness_from_logits(logits_pt_b, logits_onnx_b, labels)
    assert result_b["accuracy_delta"] >= PASS_THRESHOLD, (
        f"Scenario B: expected delta >= {PASS_THRESHOLD}, got {result_b['accuracy_delta']}"
    )
    assert result_b["pass_g4"] is False


# ---------------------------------------------------------------------------
# Test 4: pass_g4 reflects accuracy_delta < 0.01
# ---------------------------------------------------------------------------

def test_pass_criterion():
    """
    pass_g4 must be True exactly when accuracy_delta < 0.01.
    """
    n = 100
    labels = np.ones(n, dtype=np.float32)

    # All correct for both → delta = 0 → pass.
    logits = np.ones(n, dtype=np.float32)
    result_pass = evaluate_losslessness_from_logits(logits, logits, labels)
    assert result_pass["pass_g4"] is True
    assert result_pass["accuracy_delta"] == pytest.approx(0.0, abs=1e-9)

    # One model all-correct, other all-wrong → delta = 1.0 → fail.
    logits_wrong = -np.ones(n, dtype=np.float32)
    result_fail = evaluate_losslessness_from_logits(logits, logits_wrong, labels)
    assert result_fail["pass_g4"] is False
    assert result_fail["accuracy_delta"] == pytest.approx(1.0, abs=1e-6)

    # Edge: delta exactly at threshold — should fail (not strictly less than).
    # Construct delta = 0.01 exactly: 1 disagreement in 100 pairs.
    logits_close = logits.copy()
    logits_close[0] = -1.0  # flip one prediction
    result_edge = evaluate_losslessness_from_logits(logits, logits_close, labels)
    assert result_edge["accuracy_delta"] == pytest.approx(0.01, abs=1e-6)
    # 0.01 is NOT < 0.01, so should fail.
    assert result_edge["pass_g4"] is False


# ---------------------------------------------------------------------------
# Test 5: NumPy fallback inference — output shape
# ---------------------------------------------------------------------------

def test_fallback_numpy_inference(tiny_model, tiny_data):
    """
    The NumPy fallback inference path must produce logits of the correct shape [P]
    where P = number of eval pairs.

    This test exercises the fallback path directly by forcing .npz export.
    """
    import numpy as np
    from export import _export_fallback

    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = os.path.join(tmpdir, "fallback.onnx")
        npz_path = os.path.join(tmpdir, "fallback_weights.npz")

        # Force the fallback export path.
        _export_fallback(
            model=tiny_model,
            x=tiny_data.x,
            edge_index=tiny_data.edge_index,
            edge_type=tiny_data.edge_type,
            edge_confidence=tiny_data.edge_confidence,
            output_path=onnx_path,
            npz_path=npz_path,
            opset_version=17,
        )

        assert os.path.exists(npz_path), ".npz weight archive was not created."

        infer = NumpyFallbackInference(npz_path)

        x_np = tiny_data.x.cpu().numpy()
        ei_np = tiny_data.edge_index.cpu().numpy()
        et_np = tiny_data.edge_type.cpu().numpy()
        ec_np = tiny_data.edge_confidence.cpu().numpy()
        pairs_np = tiny_data.pair_index.cpu().numpy()

        logits = infer.predict(
            edge_index=ei_np,
            edge_type=et_np,
            edge_confidence=ec_np,
            node_pairs=pairs_np,
            x=x_np,
        )
        logits = np.asarray(logits).ravel()

        expected_n_pairs = pairs_np.shape[0]
        assert logits.shape == (expected_n_pairs,), (
            f"Expected logits shape ({expected_n_pairs},), got {logits.shape}"
        )
        assert logits.dtype == np.float32, f"Expected float32, got {logits.dtype}"
        # Logits should be finite.
        assert np.all(np.isfinite(logits)), "Some logits are NaN or Inf."


# ---------------------------------------------------------------------------
# Test 6: ONNX model size < 10 MB for a 100-node graph
# ---------------------------------------------------------------------------

def test_onnx_model_size_reasonable(medium_model, medium_data):
    """
    The exported ONNX model for a 100-node graph must be < 10 MB.

    This is a sanity check for the "no parameter reduction" claim:
    if the model is larger than 10 MB for a tiny graph, something is
    wrong with the export (e.g., redundant constant expansion).
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = os.path.join(tmpdir, "medium_model.onnx")
        result = export_to_onnx(
            model=medium_model,
            sample_data=medium_data,
            output_path=onnx_path,
            opset_version=17,
        )

        size_bytes = result["onnx_model_size_bytes"]
        size_mb = size_bytes / (1024 * 1024)
        assert size_mb < 10.0, (
            f"ONNX model for 100-node graph is {size_mb:.2f} MB, "
            "expected < 10 MB."
        )
        assert result["export_success"] is True
