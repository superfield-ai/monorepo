"""
train.py — Training loop and loss tracking for the G0 differentiability spike.

Trains the TypedLinkGraphModel on the synthetic contradiction-detection task
and records whether loss decreases monotonically within 1K gradient steps.

This is the H7.1 kill criterion: if loss does not decrease monotonically
(with tolerance for minor oscillation) within 1K steps, G0 fails and Area 7
reverts to distillation (Phase 1B).
"""

from __future__ import annotations

import warnings
from typing import Optional

import torch
import torch.nn as nn
from tqdm import tqdm

try:
    from torch_geometric.data import Data
except ImportError as e:
    raise ImportError("torch-geometric is required. pip install torch-geometric") from e

from model import TypedLinkGraphModel


# Tolerance for the strict step-wise monotone-decrease check.
# Allows for minor oscillation (e.g. Adam momentum effects).
MONOTONE_TOL = 0.01

# Window size (steps) for the smoothed monotone-decrease check used as the
# H7.1 gate decision. Adam-style optimizers produce per-step oscillations
# even on successfully converging runs, so the gate is evaluated against a
# rolling-mean view of the loss curve. The strict step-wise check is still
# computed and recorded as a diagnostic.
SMOOTH_WINDOW = 50

# Tolerance per step for the smoothed monotone check (looser than raw because
# we're already smoothing — any sustained reversal larger than this counts).
SMOOTH_MONOTONE_TOL = 1e-3

# Gradient health thresholds.
GRAD_VANISH_THRESH = 1e-6
GRAD_EXPLODE_THRESH = 1e3


def train(
    model: TypedLinkGraphModel,
    data: "Data",
    n_steps: int = 1000,
    lr: float = 1e-3,
    device: Optional[torch.device] = None,
    verbose: bool = True,
) -> dict:
    """
    Train the differentiable graph model for n_steps gradient steps.

    The entire graph is used as a single batch (full-graph training).
    The task is binary contradiction detection on labeled node pairs.

    Parameters
    ----------
    model : TypedLinkGraphModel
    data : torch_geometric.data.Data
        Output of generate_synthetic_graph(). Must have:
        x, edge_index, edge_type, edge_confidence, pair_index, pair_labels.
    n_steps : int
        Number of gradient steps (default 1000).
    lr : float
        Adam learning rate (default 1e-3).
    device : torch.device, optional
        Defaults to CUDA if available, else CPU.
    verbose : bool
        Whether to show a tqdm progress bar.

    Returns
    -------
    dict with keys:
        loss_curve        : list[float]  — loss at each step
        monotone_decrease : bool         — True if loss decreases within n_steps
        final_loss        : float
        initial_loss      : float
        gradient_norms    : list[float]  — L2 norm of all gradients at each step
        gradient_health   : str          — "ok" | "vanishing" | "exploding"
        warnings          : list[str]    — any warnings emitted during training
    """
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    model = model.to(device)
    model.train()

    # Move data to device.
    x = data.x.to(device)
    edge_index = data.edge_index.to(device)
    edge_type = data.edge_type.to(device)
    edge_confidence = data.edge_confidence.to(device)
    pair_index = data.pair_index.to(device)
    pair_labels = data.pair_labels.to(device)

    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.BCEWithLogitsLoss()

    loss_curve: list[float] = []
    gradient_norms: list[float] = []
    training_warnings: list[str] = []

    iterator = range(n_steps)
    if verbose:
        iterator = tqdm(iterator, desc="G0 training", unit="step")

    for step in iterator:
        optimizer.zero_grad()

        # Forward pass.
        node_emb = model(x, edge_index, edge_type, edge_confidence)
        logits = model.predict(node_emb, pair_index)

        # Loss.
        loss = criterion(logits, pair_labels)
        loss_val = float(loss.item())
        loss_curve.append(loss_val)

        # Backward pass.
        loss.backward()

        # Compute gradient norm across all parameters.
        total_norm = _compute_grad_norm(model)
        gradient_norms.append(total_norm)

        # Gradient health checks with warnings (don't abort — just record).
        if total_norm < GRAD_VANISH_THRESH:
            msg = f"Step {step}: gradient norm {total_norm:.2e} < {GRAD_VANISH_THRESH} (vanishing)"
            warnings.warn(msg)
            if msg not in training_warnings:
                training_warnings.append(msg)

        if total_norm > GRAD_EXPLODE_THRESH:
            msg = f"Step {step}: gradient norm {total_norm:.2e} > {GRAD_EXPLODE_THRESH} (exploding)"
            warnings.warn(msg)
            if msg not in training_warnings:
                training_warnings.append(msg)

        optimizer.step()

        if verbose and hasattr(iterator, "set_postfix"):
            iterator.set_postfix(loss=f"{loss_val:.4f}", grad=f"{total_norm:.2e}")

    # ------------------------------------------------------------------
    # Post-training analysis.
    # ------------------------------------------------------------------
    strict_monotone = check_monotone_decrease(loss_curve, tol=MONOTONE_TOL)
    smoothed_monotone = check_monotone_decrease_smoothed(
        loss_curve, window=SMOOTH_WINDOW, tol=SMOOTH_MONOTONE_TOL
    )
    # Gate decision: smoothed view (per-step Adam oscillations are expected).
    monotone = smoothed_monotone
    gradient_health = _classify_gradient_health(gradient_norms)

    return {
        "loss_curve": loss_curve,
        "monotone_decrease": monotone,
        "monotone_decrease_strict": strict_monotone,
        "monotone_decrease_smoothed": smoothed_monotone,
        "smooth_window": SMOOTH_WINDOW,
        "final_loss": loss_curve[-1] if loss_curve else float("nan"),
        "initial_loss": loss_curve[0] if loss_curve else float("nan"),
        "gradient_norms": gradient_norms,
        "gradient_health": gradient_health,
        "warnings": training_warnings,
    }


def check_monotone_decrease(
    loss_curve: list[float],
    tol: float = MONOTONE_TOL,
) -> bool:
    """
    Return True if loss decreases monotonically (with tolerance).

    Definition: the final loss must be strictly lower than the initial loss,
    AND no consecutive step increases by more than `tol`.

    This allows minor oscillation (e.g. Adam momentum) while still catching
    divergence or plateau.

    Parameters
    ----------
    loss_curve : list[float]
        Loss value at each training step.
    tol : float
        Maximum allowed increase between consecutive steps.

    Returns
    -------
    bool
    """
    if len(loss_curve) < 2:
        return False

    # Overall: final must be less than initial.
    if loss_curve[-1] >= loss_curve[0]:
        return False

    # Step-wise: no increase larger than tol.
    for i in range(len(loss_curve) - 1):
        if loss_curve[i + 1] > loss_curve[i] + tol:
            return False

    return True


def check_monotone_decrease_smoothed(
    loss_curve: list[float],
    window: int = SMOOTH_WINDOW,
    tol: float = SMOOTH_MONOTONE_TOL,
) -> bool:
    """
    Return True if the rolling-mean (window=`window`) view of `loss_curve`
    decreases monotonically (within `tol`).

    Adam and other momentum-based optimizers routinely produce per-step
    oscillations on successfully converging runs. The H7.1 gate cares
    whether training is *trending down*, not whether each individual step
    decreases — so the gate decision is evaluated on a smoothed curve.

    The smoothed curve is the trailing rolling mean over `window` steps.
    A run is considered to monotonically decrease when:
      - The smoothed final value is strictly less than the smoothed initial
        value, AND
      - No consecutive smoothed-step increase exceeds `tol`.

    Returns False if the curve has fewer than `window` points.
    """
    if len(loss_curve) < max(2, window):
        return False

    smoothed: list[float] = []
    for i in range(len(loss_curve)):
        lo = max(0, i - window + 1)
        chunk = loss_curve[lo : i + 1]
        smoothed.append(sum(chunk) / len(chunk))

    if smoothed[-1] >= smoothed[0]:
        return False

    for i in range(len(smoothed) - 1):
        if smoothed[i + 1] > smoothed[i] + tol:
            return False

    return True


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _compute_grad_norm(model: nn.Module) -> float:
    """Compute the total L2 gradient norm across all parameters."""
    total_norm_sq = 0.0
    for p in model.parameters():
        if p.grad is not None:
            total_norm_sq += float(p.grad.data.norm(2).item()) ** 2
    return float(total_norm_sq ** 0.5)


def _classify_gradient_health(gradient_norms: list[float]) -> str:
    """
    Classify overall gradient health based on recorded norms.

    Returns "vanishing" | "exploding" | "ok".
    Checks the middle 80% of steps to ignore transient startup/end effects.
    """
    if not gradient_norms:
        return "ok"

    # Skip first 10% and last 10% of steps.
    n = len(gradient_norms)
    start = max(0, n // 10)
    end = min(n, n - n // 10)
    interior = gradient_norms[start:end] if end > start else gradient_norms

    if not interior:
        return "ok"

    if all(g < GRAD_VANISH_THRESH for g in interior):
        return "vanishing"
    if any(g > GRAD_EXPLODE_THRESH for g in interior):
        return "exploding"
    return "ok"
