"""
data.py — Synthetic corpus generator for the G0 differentiability spike.

Generates a 10K-block corpus with a known typed-link structure.
The dataset is deterministic given a seed.

Node features: 128-dim random embeddings (reduced from 1536 for speed).
Edges: ~50K edges distributed across 5 link types.
Labels: 1K labeled (block_a, block_b, label) pairs for contradiction detection.
        label=1 if a `contradicts` edge exists, 0 otherwise.

The synthetic structure is designed so that the contradiction detection task
has a learnable signal: contradicts edges connect nodes in clusters, making
the graph topology informative.
"""

from __future__ import annotations

import torch
import numpy as np
from torch import Tensor

# Lazy import — torch_geometric may not always be installed (e.g. CI without GPU).
try:
    from torch_geometric.data import Data
except ImportError as e:
    raise ImportError(
        "torch-geometric is required for data.py. "
        "Install with: pip install torch-geometric"
    ) from e

# Edge type ids matching model.EDGE_TYPES order.
EDGE_TYPE_CITES = 0
EDGE_TYPE_CONTRADICTS = 1
EDGE_TYPE_SUPPORTS = 2
EDGE_TYPE_ELABORATES = 3
EDGE_TYPE_IS_EXCEPTION_TO = 4

# Distribution of edges across types (must sum to 1.0).
EDGE_TYPE_PROBS = [0.35, 0.10, 0.25, 0.20, 0.10]


def generate_synthetic_graph(
    n_nodes: int = 10_000,
    n_edges: int = 50_000,
    n_labeled_pairs: int = 1_000,
    node_feat_dim: int = 128,
    seed: int = 42,
) -> "Data":
    """
    Generate a synthetic Nexum block graph for G0 differentiability spike.

    Parameters
    ----------
    n_nodes : int
        Number of block nodes (default 10,000).
    n_edges : int
        Target number of directed edges (default 50,000).
    n_labeled_pairs : int
        Number of labeled node pairs for the binary classification task.
    node_feat_dim : int
        Dimension of each node's feature vector (default 128).
    seed : int
        Random seed for full reproducibility.

    Returns
    -------
    torch_geometric.data.Data with attributes:
        x               : [n_nodes, node_feat_dim]  float32  — node features
        edge_index      : [2, n_edges]              int64    — directed edges
        edge_type       : [n_edges]                 int64    — type id in [0, 4]
        edge_confidence : [n_edges]                 float32  — confidence in (0, 1]
        pair_index      : [n_labeled_pairs, 2]      int64    — (a, b) pairs
        pair_labels     : [n_labeled_pairs]         float32  — 1 if contradicts edge, 0 otherwise
        n_nodes         : int scalar
        n_edges         : int scalar (actual count, may differ slightly from target)
    """
    rng = np.random.default_rng(seed)
    torch.manual_seed(seed)

    # ------------------------------------------------------------------
    # 1. Node features — clustered so the graph structure is meaningful.
    # ------------------------------------------------------------------
    # Assign nodes to clusters; within-cluster nodes have similar embeddings.
    n_clusters = max(10, n_nodes // 100)
    cluster_centers = rng.standard_normal((n_clusters, node_feat_dim)).astype(np.float32)
    # Each node belongs to one cluster.
    node_cluster = rng.integers(0, n_clusters, size=n_nodes)
    # Add per-node noise around cluster center.
    node_noise = rng.standard_normal((n_nodes, node_feat_dim)).astype(np.float32) * 0.3
    x_np = cluster_centers[node_cluster] + node_noise
    # L2 normalize for stability.
    norms = np.linalg.norm(x_np, axis=1, keepdims=True).clip(min=1e-8)
    x_np = x_np / norms
    x = torch.tensor(x_np, dtype=torch.float32)

    # ------------------------------------------------------------------
    # 2. Edges — random with bias toward same-cluster pairs for realism.
    # ------------------------------------------------------------------
    edge_types_list = []
    src_list = []
    dst_list = []

    # Assign edges per type.
    type_counts = _distribute_edges(n_edges, EDGE_TYPE_PROBS, rng)

    for type_id, count in enumerate(type_counts):
        if type_id == EDGE_TYPE_CONTRADICTS:
            # Contradicts edges: cross-cluster (different cluster ids) for signal.
            srcs, dsts = _sample_cross_cluster_edges(
                count, n_nodes, node_cluster, rng, same_cluster=False
            )
        elif type_id == EDGE_TYPE_SUPPORTS:
            # Supports edges: same-cluster pairs (complementary signal).
            srcs, dsts = _sample_cross_cluster_edges(
                count, n_nodes, node_cluster, rng, same_cluster=True
            )
        else:
            # Random edges for other types.
            srcs = rng.integers(0, n_nodes, size=count)
            dsts = rng.integers(0, n_nodes, size=count)
            # Remove self-loops.
            mask = srcs != dsts
            srcs, dsts = srcs[mask], dsts[mask]

        src_list.append(srcs)
        dst_list.append(dsts)
        edge_types_list.append(np.full(len(srcs), type_id, dtype=np.int64))

    src_all = np.concatenate(src_list)
    dst_all = np.concatenate(dst_list)
    edge_type_all = np.concatenate(edge_types_list)

    # Edge confidences: Beta(alpha, beta) — skewed toward 0.7–0.9.
    edge_confidence_all = rng.beta(a=5, b=2, size=len(src_all)).astype(np.float32)
    edge_confidence_all = edge_confidence_all.clip(0.01, 0.99)

    edge_index = torch.tensor(
        np.stack([src_all, dst_all], axis=0), dtype=torch.long
    )
    edge_type = torch.tensor(edge_type_all, dtype=torch.long)
    edge_confidence = torch.tensor(edge_confidence_all, dtype=torch.float32)

    # ------------------------------------------------------------------
    # 3. Labeled pairs for contradiction detection.
    # ------------------------------------------------------------------
    # Build a set of known contradicts edges for fast lookup.
    contradicts_mask = edge_type_all == EDGE_TYPE_CONTRADICTS
    contradicts_srcs = src_all[contradicts_mask]
    contradicts_dsts = dst_all[contradicts_mask]
    contradicts_set = set(zip(contradicts_srcs.tolist(), contradicts_dsts.tolist()))

    pair_a_list = []
    pair_b_list = []
    pair_label_list = []

    # Positive pairs: sample from contradicts edges.
    n_pos = n_labeled_pairs // 2
    pos_indices = rng.choice(len(contradicts_srcs), size=min(n_pos, len(contradicts_srcs)), replace=False)
    for idx in pos_indices:
        pair_a_list.append(int(contradicts_srcs[idx]))
        pair_b_list.append(int(contradicts_dsts[idx]))
        pair_label_list.append(1.0)

    # Negative pairs: random pairs known NOT to be contradicts edges.
    n_neg = n_labeled_pairs - len(pair_a_list)
    attempts = 0
    while len(pair_label_list) - len(pos_indices) < n_neg and attempts < n_neg * 20:
        a = int(rng.integers(0, n_nodes))
        b = int(rng.integers(0, n_nodes))
        if a != b and (a, b) not in contradicts_set:
            pair_a_list.append(a)
            pair_b_list.append(b)
            pair_label_list.append(0.0)
        attempts += 1

    pair_index = torch.tensor(
        list(zip(pair_a_list, pair_b_list)), dtype=torch.long
    )
    pair_labels = torch.tensor(pair_label_list, dtype=torch.float32)

    # ------------------------------------------------------------------
    # 4. Assemble PyG Data object.
    # ------------------------------------------------------------------
    data = Data(
        x=x,
        edge_index=edge_index,
        edge_type=edge_type,
        edge_confidence=edge_confidence,
        pair_index=pair_index,
        pair_labels=pair_labels,
    )
    data.n_nodes = n_nodes
    data.n_edges = int(edge_index.shape[1])

    return data


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _distribute_edges(
    total: int,
    probs: list[float],
    rng: np.random.Generator,
) -> list[int]:
    """Distribute `total` edges according to `probs`, summing to total."""
    counts = [int(round(p * total)) for p in probs]
    # Adjust rounding error on the first bucket.
    counts[0] += total - sum(counts)
    return counts


def _sample_cross_cluster_edges(
    count: int,
    n_nodes: int,
    node_cluster: np.ndarray,
    rng: np.random.Generator,
    same_cluster: bool,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Sample directed edges that are within the same cluster (same_cluster=True)
    or across different clusters (same_cluster=False).

    Falls back to random sampling if the cluster structure makes the
    target impossible (e.g. single cluster).
    """
    srcs = rng.integers(0, n_nodes, size=count * 3)
    dsts = rng.integers(0, n_nodes, size=count * 3)

    # Filter by cluster constraint.
    if same_cluster:
        mask = (node_cluster[srcs] == node_cluster[dsts]) & (srcs != dsts)
    else:
        mask = (node_cluster[srcs] != node_cluster[dsts])

    srcs_filtered = srcs[mask][:count]
    dsts_filtered = dsts[mask][:count]

    # If not enough, pad with random edges.
    shortfall = count - len(srcs_filtered)
    if shortfall > 0:
        extra_src = rng.integers(0, n_nodes, size=shortfall)
        extra_dst = rng.integers(0, n_nodes, size=shortfall)
        no_self = extra_src != extra_dst
        extra_src = extra_src[no_self][:shortfall]
        extra_dst = extra_dst[no_self][:shortfall]
        srcs_filtered = np.concatenate([srcs_filtered, extra_src])
        dsts_filtered = np.concatenate([dsts_filtered, extra_dst])

    return srcs_filtered, dsts_filtered
