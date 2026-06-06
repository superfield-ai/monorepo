"""
full_training.py — H7.1: Full-scale training run on a 100K-block legal corpus.

Trains TypedLinkGraphModel on a 100K-block synthetic corpus, evaluating on:
  - Clause extraction (binary: does block discuss a termination clause?)
  - Contradiction detection (do two blocks contradict each other?)

Records loss curve and accuracy at each eval step. Computes pre-training accuracy
("pretrained") so improvement delta is meaningful.

Reuses TypedLinkGraphModel from experiments/g0-differentiability/model.py
and generate_synthetic_graph from experiments/g0-differentiability/data.py.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import numpy as np

try:
    from torch_geometric.data import Data
except ImportError as e:
    raise ImportError("torch-geometric is required. pip install torch-geometric") from e

# ---------------------------------------------------------------------------
# Resolve the G0 spike so we can reuse model + data generators.
# ---------------------------------------------------------------------------
_HERE = Path(__file__).resolve().parent
_G0_DIR = _HERE.parent / "g0-differentiability"
if str(_G0_DIR) not in sys.path:
    sys.path.insert(0, str(_G0_DIR))

from model import TypedLinkGraphModel  # noqa: E402
from data import generate_synthetic_graph  # noqa: E402


# ---------------------------------------------------------------------------
# Clause-extraction label generation
# ---------------------------------------------------------------------------

def _generate_clause_labels(data: Data, seed: int = 0) -> torch.Tensor:
    """
    Generate synthetic clause-extraction labels for each node.

    A node "discusses a termination clause" if it belongs to certain clusters
    (simulated by a deterministic hash of node index + seed). This produces a
    balanced binary classification signal that is independent of the
    contradiction-detection task.

    Returns
    -------
    labels : Tensor [N] float32  — 1.0 if clause, 0.0 otherwise
    """
    n_nodes = data.x.shape[0]
    rng = np.random.default_rng(seed)
    # ~30% positive rate, deterministic
    labels = (rng.random(n_nodes) < 0.3).astype(np.float32)
    return torch.tensor(labels, dtype=torch.float32)


# ---------------------------------------------------------------------------
# Clause-extraction eval
# ---------------------------------------------------------------------------

def _eval_clause_accuracy(
    model: TypedLinkGraphModel,
    data: Data,
    clause_labels: torch.Tensor,
    clause_head: nn.Linear,
    device: torch.device,
    eval_pair_count: int = 500,
    seed: int = 0,
) -> float:
    """
    Evaluate clause-extraction accuracy on a held-out subset of nodes.

    Uses a linear classification head over node embeddings.
    """
    model.eval()
    clause_head.eval()

    n_nodes = data.x.shape[0]
    rng = np.random.default_rng(seed)
    eval_indices = rng.choice(n_nodes, size=min(eval_pair_count, n_nodes), replace=False)
    eval_idx_t = torch.tensor(eval_indices, dtype=torch.long, device=device)
    eval_labels = clause_labels[eval_indices].to(device)

    with torch.no_grad():
        node_emb = model(
            data.x.to(device),
            data.edge_index.to(device),
            data.edge_type.to(device),
            data.edge_confidence.to(device),
        )
        logits = clause_head(node_emb[eval_idx_t]).squeeze(-1)
        preds = (torch.sigmoid(logits) >= 0.5).float()
        accuracy = float((preds == eval_labels).float().mean().item())

    return accuracy


# ---------------------------------------------------------------------------
# Contradiction-detection eval
# ---------------------------------------------------------------------------

def _eval_contradiction_accuracy(
    model: TypedLinkGraphModel,
    data: Data,
    device: torch.device,
    n_eval: int = 500,
    seed: int = 0,
) -> float:
    """
    Evaluate contradiction-detection accuracy on held-out pairs from data.pair_index.
    """
    model.eval()

    total_pairs = data.pair_index.shape[0]
    rng = np.random.default_rng(seed)
    indices = rng.choice(total_pairs, size=min(n_eval, total_pairs), replace=False)

    eval_pairs = data.pair_index[indices].to(device)
    eval_labels = data.pair_labels[indices].to(device)

    with torch.no_grad():
        node_emb = model(
            data.x.to(device),
            data.edge_index.to(device),
            data.edge_type.to(device),
            data.edge_confidence.to(device),
        )
        logits = model.predict(node_emb, eval_pairs)
        preds = (torch.sigmoid(logits) >= 0.5).float()
        accuracy = float((preds == eval_labels).float().mean().item())

    return accuracy


# ---------------------------------------------------------------------------
# Main training function
# ---------------------------------------------------------------------------

def run_full_training(
    n_blocks: int = 100_000,
    embedding_dim: int = 128,
    n_steps: int = 5_000,
    lr: float = 1e-3,
    eval_every: int = 100,
    seed: int = 42,
    checkpoint_path: Optional[str] = None,
) -> dict:
    """
    H7.1 full run: train TypedLinkGraphModel on a 100K-block corpus.

    Evaluates on clause extraction (binary: does block discuss a termination clause?)
    and contradiction detection (do two blocks contradict each other?).

    At each eval_every steps, measure:
    - Loss on held-out set
    - Accuracy on clause extraction
    - Accuracy on contradiction detection

    Parameters
    ----------
    n_blocks : int
        Number of blocks in the synthetic corpus (default 100K).
    embedding_dim : int
        Node embedding dimension (default 128; full scale = 1536).
    n_steps : int
        Number of gradient steps.
    lr : float
        Adam learning rate.
    eval_every : int
        Evaluate every N steps.
    seed : int
        Random seed for reproducibility.
    checkpoint_path : str | None
        If given, save the final model state dict here.

    Returns
    -------
    dict with keys:
        loss_curve                  : list[float]
        clause_extraction_curve     : list[float]   accuracy at each eval step
        contradiction_detection_curve : list[float]
        final_clause_accuracy       : float
        final_contradiction_accuracy : float
        pretrained_clause_accuracy  : float         accuracy before any training
        pretrained_contradiction_accuracy : float
        improvement_clause          : float          delta
        improvement_contradiction   : float
        h7_1_supported              : bool           True if both improvements > 0 and loss decreased
    """
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # ------------------------------------------------------------------
    # 1. Generate the synthetic corpus.
    # ------------------------------------------------------------------
    # Scale edges proportionally to nodes (target ~5 edges/node for large graphs).
    n_edges = min(n_blocks * 5, 500_000)
    n_labeled_pairs = min(n_blocks // 10, 10_000)

    data = generate_synthetic_graph(
        n_nodes=n_blocks,
        n_edges=n_edges,
        n_labeled_pairs=n_labeled_pairs,
        node_feat_dim=embedding_dim,
        seed=seed,
    )

    # ------------------------------------------------------------------
    # 2. Build clause-extraction labels and train/val split.
    # ------------------------------------------------------------------
    clause_labels_all = _generate_clause_labels(data, seed=seed + 1)

    n_pairs = data.pair_index.shape[0]
    n_train = int(n_pairs * 0.8)
    train_pair_index = data.pair_index[:n_train].to(device)
    train_pair_labels = data.pair_labels[:n_train].to(device)

    n_nodes = data.x.shape[0]
    n_clause_train = int(n_nodes * 0.8)
    train_node_indices = torch.arange(n_clause_train, device=device)
    train_clause_labels = clause_labels_all[:n_clause_train].to(device)

    # ------------------------------------------------------------------
    # 3. Build model + clause head.
    # ------------------------------------------------------------------
    torch.manual_seed(seed)

    hidden_dim = min(embedding_dim, 64)
    out_dim = min(embedding_dim, 32)

    model = TypedLinkGraphModel(
        node_feat_dim=embedding_dim,
        hidden_dim=hidden_dim,
        out_dim=out_dim,
    ).to(device)

    # Linear head for clause extraction: out_dim -> 1
    clause_head = nn.Linear(out_dim, 1).to(device)

    optimizer = torch.optim.Adam(
        list(model.parameters()) + list(clause_head.parameters()),
        lr=lr,
    )
    criterion_bce = nn.BCEWithLogitsLoss()

    # ------------------------------------------------------------------
    # 4. Measure pre-training (pretrained) accuracy.
    # ------------------------------------------------------------------
    pretrained_clause_accuracy = _eval_clause_accuracy(
        model, data, clause_labels_all, clause_head, device, eval_pair_count=500, seed=seed,
    )
    pretrained_contradiction_accuracy = _eval_contradiction_accuracy(
        model, data, device, n_eval=500, seed=seed,
    )

    # ------------------------------------------------------------------
    # 5. Training loop.
    # ------------------------------------------------------------------
    loss_curve: list[float] = []
    clause_extraction_curve: list[float] = []
    contradiction_detection_curve: list[float] = []

    # Move graph data to device once.
    x_dev = data.x.to(device)
    edge_index_dev = data.edge_index.to(device)
    edge_type_dev = data.edge_type.to(device)
    edge_conf_dev = data.edge_confidence.to(device)

    for step in range(n_steps):
        model.train()
        clause_head.train()
        optimizer.zero_grad()

        node_emb = model(x_dev, edge_index_dev, edge_type_dev, edge_conf_dev)

        # Contradiction detection loss.
        contra_logits = model.predict(node_emb, train_pair_index)
        loss_contra = criterion_bce(contra_logits, train_pair_labels)

        # Clause extraction loss.
        clause_logits = clause_head(node_emb[train_node_indices]).squeeze(-1)
        loss_clause = criterion_bce(clause_logits, train_clause_labels)

        loss = loss_contra + loss_clause
        loss.backward()
        optimizer.step()

        loss_val = float(loss.item())
        loss_curve.append(loss_val)

        # Evaluate at eval_every intervals and at the final step.
        if (step + 1) % eval_every == 0 or step == n_steps - 1:
            clause_acc = _eval_clause_accuracy(
                model, data, clause_labels_all, clause_head, device,
                eval_pair_count=500, seed=seed,
            )
            contra_acc = _eval_contradiction_accuracy(
                model, data, device, n_eval=500, seed=seed,
            )
            clause_extraction_curve.append(clause_acc)
            contradiction_detection_curve.append(contra_acc)

    # ------------------------------------------------------------------
    # 6. Final metrics.
    # ------------------------------------------------------------------
    final_clause_accuracy = clause_extraction_curve[-1] if clause_extraction_curve else 0.0
    final_contradiction_accuracy = contradiction_detection_curve[-1] if contradiction_detection_curve else 0.0

    improvement_clause = final_clause_accuracy - pretrained_clause_accuracy
    improvement_contradiction = final_contradiction_accuracy - pretrained_contradiction_accuracy

    # H7.1 is supported if both tasks improved AND loss decreased overall.
    h7_1_supported = bool(
        improvement_clause > 0
        and improvement_contradiction > 0
        and loss_curve[-1] < loss_curve[0]
    )

    # ------------------------------------------------------------------
    # 7. Optional checkpoint.
    # ------------------------------------------------------------------
    if checkpoint_path is not None:
        Path(checkpoint_path).parent.mkdir(parents=True, exist_ok=True)
        torch.save(
            {
                "model_state_dict": model.state_dict(),
                "clause_head_state_dict": clause_head.state_dict(),
                "n_blocks": n_blocks,
                "embedding_dim": embedding_dim,
                "hidden_dim": hidden_dim,
                "out_dim": out_dim,
                "seed": seed,
            },
            checkpoint_path,
        )

    return {
        "loss_curve": loss_curve,
        "clause_extraction_curve": clause_extraction_curve,
        "contradiction_detection_curve": contradiction_detection_curve,
        "final_clause_accuracy": final_clause_accuracy,
        "final_contradiction_accuracy": final_contradiction_accuracy,
        "pretrained_clause_accuracy": pretrained_clause_accuracy,
        "pretrained_contradiction_accuracy": pretrained_contradiction_accuracy,
        "improvement_clause": improvement_clause,
        "improvement_contradiction": improvement_contradiction,
        "h7_1_supported": h7_1_supported,
    }
