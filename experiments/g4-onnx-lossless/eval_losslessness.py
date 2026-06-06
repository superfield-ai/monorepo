"""
eval_losslessness.py — Round-trip accuracy comparison for G4.

Compares PyTorch model outputs vs. ONNX Runtime (or NumPy fallback) outputs
on a held-out eval set.

Pass criterion (H7.3 / G4 issue #5):
    accuracy_delta < 0.01      (< 1% accuracy delta)
    AND
    f1_delta       < 0.01      (< 1% attribution F1 delta)

The accuracy threshold restates the issue body's pass criterion. The F1
threshold tracks the orchestrator's "attribution F1" framing — for the
binary contradiction-detection task here, predicted positives constitute
the model's attribution set, so binary F1 of the positive class is the
natural attribution-F1 surrogate.

This is NOT a distillation comparison. The ONNX model contains the same
parameters as the live PyTorch model. The only possible deviation is:
  - Floating-point arithmetic differences between PyTorch and ONNX Runtime
  - Numerical differences in layer normalization / sigmoid implementation

Both are expected to be < 0.1% by construction.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional, Union

import numpy as np
import torch

# Allow running from the g4 directory or from the repo root.
_HERE = Path(__file__).resolve().parent
_G0_DIR = _HERE.parent / "g0-differentiability"
if str(_G0_DIR) not in sys.path:
    sys.path.insert(0, str(_G0_DIR))

from model import TypedLinkGraphModel  # noqa: E402
from inference import ONNXGraphInference, NumpyFallbackInference  # noqa: E402

try:
    from torch_geometric.data import Data
except ImportError as e:
    raise ImportError("torch-geometric is required. pip install torch-geometric") from e


# Pass threshold: < 1% accuracy delta and < 1% F1 delta.
PASS_THRESHOLD = 0.01
F1_PASS_THRESHOLD = 0.01


def _binary_f1(preds: np.ndarray, labels: np.ndarray) -> float:
    """
    Binary F1 of the positive class (label==1).

    Returns 0.0 if there are no predicted positives AND no actual positives
    (degenerate case; a perfectly empty prediction on an empty positive set
    has no F1 defined — we report 0.0 by convention to avoid NaN-poisoning
    the delta).
    """
    preds_b = preds.astype(bool)
    labels_b = labels.astype(bool)
    tp = float(np.sum(preds_b & labels_b))
    fp = float(np.sum(preds_b & ~labels_b))
    fn = float(np.sum(~preds_b & labels_b))
    if tp + fp == 0.0 or tp + fn == 0.0:
        return 0.0
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    if precision + recall == 0.0:
        return 0.0
    return float(2.0 * precision * recall / (precision + recall))


def evaluate_losslessness(
    pytorch_model: TypedLinkGraphModel,
    onnx_inference: Union[ONNXGraphInference, NumpyFallbackInference],
    data: "Data",
    n_eval_pairs: int = 500,
    seed: int = 0,
) -> dict:
    """
    Compare PyTorch model outputs vs. ONNX Runtime outputs on held-out eval set.

    Uses the labeled node pairs from `data` (or a random subset of them)
    as the held-out eval set.

    Parameters
    ----------
    pytorch_model : TypedLinkGraphModel
        Trained PyTorch model (will be set to eval mode).
    onnx_inference : ONNXGraphInference | NumpyFallbackInference
        ONNX or NumPy inference object (from inference.py).
    data : Data
        PyG Data object with x, edge_index, edge_type, edge_confidence,
        pair_index, pair_labels.
    n_eval_pairs : int
        Maximum number of pairs to evaluate (subset of data.pair_index).
    seed : int
        Random seed for reproducible subset selection.

    Returns
    -------
    dict with keys:
        accuracy_pytorch  : float   — accuracy on the PyTorch model
        accuracy_onnx     : float   — accuracy on the ONNX / NumPy model
        accuracy_delta    : float   — |pytorch - onnx|
        max_logit_diff    : float   — max absolute difference in logits
        mean_logit_diff   : float   — mean absolute difference in logits
        pass_g4           : bool    — True if accuracy_delta < 0.01 (< 1%)
        n_eval_pairs      : int     — actual number of pairs evaluated
    """
    pytorch_model.eval()

    # ------------------------------------------------------------------
    # 1. Select eval pairs (subset of labeled pairs).
    # ------------------------------------------------------------------
    total_pairs = data.pair_index.shape[0]
    rng = np.random.default_rng(seed)

    if total_pairs <= n_eval_pairs:
        eval_indices = np.arange(total_pairs)
    else:
        eval_indices = rng.choice(total_pairs, size=n_eval_pairs, replace=False)

    pair_index_np = data.pair_index[eval_indices].cpu().numpy()  # [P, 2]
    pair_labels_np = data.pair_labels[eval_indices].cpu().numpy()  # [P]
    actual_n = len(eval_indices)

    # ------------------------------------------------------------------
    # 2. PyTorch forward pass (ground truth).
    # ------------------------------------------------------------------
    with torch.no_grad():
        node_emb_pt = pytorch_model(
            data.x,
            data.edge_index,
            data.edge_type,
            data.edge_confidence,
        )
        pair_idx_t = data.pair_index[eval_indices]
        logits_pt = pytorch_model.predict(node_emb_pt, pair_idx_t)

    logits_pt_np = logits_pt.cpu().numpy()  # [P]
    preds_pt = (logits_pt_np > 0.0).astype(np.float32)
    accuracy_pytorch = float(np.mean(preds_pt == pair_labels_np))

    # ------------------------------------------------------------------
    # 3. ONNX / NumPy inference.
    # ------------------------------------------------------------------
    x_np = data.x.cpu().numpy()
    ei_np = data.edge_index.cpu().numpy()
    et_np = data.edge_type.cpu().numpy()
    ec_np = data.edge_confidence.cpu().numpy()

    if isinstance(onnx_inference, NumpyFallbackInference):
        logits_onnx = onnx_inference.predict(
            edge_index=ei_np,
            edge_type=et_np,
            edge_confidence=ec_np,
            node_pairs=pair_index_np,
            x=x_np,
        )
    else:
        logits_onnx = onnx_inference.predict(
            edge_index=ei_np,
            edge_type=et_np,
            edge_confidence=ec_np,
            node_pairs=pair_index_np,
            x=x_np,
        )

    logits_onnx = np.asarray(logits_onnx, dtype=np.float32).ravel()
    preds_onnx = (logits_onnx > 0.0).astype(np.float32)
    accuracy_onnx = float(np.mean(preds_onnx == pair_labels_np))

    # ------------------------------------------------------------------
    # 4. Compute comparison metrics.
    # ------------------------------------------------------------------
    # Align shapes (defensive: both should be [P]).
    min_len = min(len(logits_pt_np), len(logits_onnx))
    logit_diff = np.abs(logits_pt_np[:min_len] - logits_onnx[:min_len])
    max_logit_diff = float(logit_diff.max())
    mean_logit_diff = float(logit_diff.mean())

    accuracy_delta = abs(accuracy_pytorch - accuracy_onnx)

    # Attribution F1 (binary positive-class F1) on each runtime.
    f1_pytorch = _binary_f1(preds_pt, pair_labels_np)
    f1_onnx = _binary_f1(preds_onnx, pair_labels_np)
    f1_delta = abs(f1_pytorch - f1_onnx)

    pass_g4 = (accuracy_delta < PASS_THRESHOLD) and (f1_delta < F1_PASS_THRESHOLD)

    return {
        "accuracy_pytorch": accuracy_pytorch,
        "accuracy_onnx": accuracy_onnx,
        "accuracy_delta": accuracy_delta,
        "f1_pytorch": f1_pytorch,
        "f1_onnx": f1_onnx,
        "f1_delta": f1_delta,
        "max_logit_diff": max_logit_diff,
        "mean_logit_diff": mean_logit_diff,
        "pass_g4": pass_g4,
        "pass_threshold_accuracy": PASS_THRESHOLD,
        "pass_threshold_f1": F1_PASS_THRESHOLD,
        "n_eval_pairs": actual_n,
    }


def evaluate_losslessness_from_logits(
    logits_pytorch: np.ndarray,
    logits_onnx: np.ndarray,
    labels: np.ndarray,
) -> dict:
    """
    Compute losslessness metrics from pre-computed logit arrays.

    Utility for unit tests that want to construct artificial scenarios.

    Parameters
    ----------
    logits_pytorch : np.ndarray [P]
    logits_onnx : np.ndarray [P]
    labels : np.ndarray [P]

    Returns
    -------
    Same dict as evaluate_losslessness().
    """
    preds_pt = (logits_pytorch > 0.0).astype(np.float32)
    preds_onnx = (logits_onnx > 0.0).astype(np.float32)

    accuracy_pytorch = float(np.mean(preds_pt == labels))
    accuracy_onnx = float(np.mean(preds_onnx == labels))
    accuracy_delta = abs(accuracy_pytorch - accuracy_onnx)

    logit_diff = np.abs(logits_pytorch - logits_onnx)

    f1_pytorch = _binary_f1(preds_pt, labels)
    f1_onnx = _binary_f1(preds_onnx, labels)
    f1_delta = abs(f1_pytorch - f1_onnx)

    return {
        "accuracy_pytorch": accuracy_pytorch,
        "accuracy_onnx": accuracy_onnx,
        "accuracy_delta": accuracy_delta,
        "f1_pytorch": f1_pytorch,
        "f1_onnx": f1_onnx,
        "f1_delta": f1_delta,
        "max_logit_diff": float(logit_diff.max()),
        "mean_logit_diff": float(logit_diff.mean()),
        "pass_g4": (accuracy_delta < PASS_THRESHOLD) and (f1_delta < F1_PASS_THRESHOLD),
        "pass_threshold_accuracy": PASS_THRESHOLD,
        "pass_threshold_f1": F1_PASS_THRESHOLD,
        "n_eval_pairs": len(labels),
    }
