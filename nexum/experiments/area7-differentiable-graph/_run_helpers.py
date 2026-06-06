"""
_run_helpers.py — Internal helpers for run_area7.py.

Provides build_trained_model_and_data() which trains (or re-runs) the full
TypedLinkGraphModel and returns the live model + data objects for downstream
ONNX export and benchmarking.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING

import torch
import torch.nn as nn

try:
    from torch_geometric.data import Data
except ImportError as e:
    raise ImportError("torch-geometric is required. pip install torch-geometric") from e

_HERE = Path(__file__).resolve().parent
_G0_DIR = _HERE.parent / "g0-differentiability"
if str(_G0_DIR) not in sys.path:
    sys.path.insert(0, str(_G0_DIR))

from model import TypedLinkGraphModel  # noqa: E402
from data import generate_synthetic_graph  # noqa: E402


def build_trained_model_and_data(
    n_blocks: int = 10_000,
    embedding_dim: int = 128,
    n_steps: int = 500,
    lr: float = 1e-3,
    seed: int = 42,
) -> tuple[TypedLinkGraphModel, "Data"]:
    """
    Train a TypedLinkGraphModel and return (model, data).

    This is a thin wrapper that mirrors the training done in full_training.py
    but returns the live model and data objects (not just metrics) so they
    can be passed to onnx_production.run_onnx_roundtrip() and
    throughput_comparison.benchmark_throughput().
    """
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Generate corpus.
    n_edges = min(n_blocks * 5, 500_000)
    n_labeled_pairs = min(n_blocks // 10, 10_000)

    data = generate_synthetic_graph(
        n_nodes=n_blocks,
        n_edges=n_edges,
        n_labeled_pairs=n_labeled_pairs,
        node_feat_dim=embedding_dim,
        seed=seed,
    )

    hidden_dim = min(embedding_dim, 64)
    out_dim = min(embedding_dim, 32)

    torch.manual_seed(seed)
    model = TypedLinkGraphModel(
        node_feat_dim=embedding_dim,
        hidden_dim=hidden_dim,
        out_dim=out_dim,
    ).to(device)

    # Clause head (needed to match full_training.py combined loss).
    clause_head = nn.Linear(out_dim, 1).to(device)

    # Generate clause labels (same as full_training.py).
    import numpy as np
    _rng = np.random.default_rng(seed + 1)
    clause_labels_np = (_rng.random(n_blocks) < 0.3).astype("float32")
    clause_labels = torch.tensor(clause_labels_np, dtype=torch.float32)

    optimizer = torch.optim.Adam(
        list(model.parameters()) + list(clause_head.parameters()),
        lr=lr,
    )
    criterion = nn.BCEWithLogitsLoss()

    n_pairs = data.pair_index.shape[0]
    n_train = int(n_pairs * 0.8)
    n_nodes = data.x.shape[0]
    n_clause_train = int(n_nodes * 0.8)

    train_pair_index = data.pair_index[:n_train].to(device)
    train_pair_labels = data.pair_labels[:n_train].to(device)
    train_node_indices = torch.arange(n_clause_train, device=device)
    train_clause_labels = clause_labels[:n_clause_train].to(device)

    x_dev = data.x.to(device)
    edge_index_dev = data.edge_index.to(device)
    edge_type_dev = data.edge_type.to(device)
    edge_conf_dev = data.edge_confidence.to(device)

    for _ in range(n_steps):
        model.train()
        clause_head.train()
        optimizer.zero_grad()

        node_emb = model(x_dev, edge_index_dev, edge_type_dev, edge_conf_dev)
        contra_logits = model.predict(node_emb, train_pair_index)
        loss_contra = criterion(contra_logits, train_pair_labels)
        clause_logits = clause_head(node_emb[train_node_indices]).squeeze(-1)
        loss_clause = criterion(clause_logits, train_clause_labels)
        loss = loss_contra + loss_clause
        loss.backward()
        optimizer.step()

    model.eval()
    # Return model on CPU (ONNX export expects CPU tensors).
    model = model.cpu()
    # Move data back to CPU for export.
    data.x = data.x.cpu()
    data.edge_index = data.edge_index.cpu()
    data.edge_type = data.edge_type.cpu()
    data.edge_confidence = data.edge_confidence.cpu()
    data.pair_index = data.pair_index.cpu()
    data.pair_labels = data.pair_labels.cpu()

    return model, data
