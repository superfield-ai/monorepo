"""
signal_measurement.py — Typed edge weight divergence analysis for G3.

Gate G3 / H7.2: Do `contradicts` and `supports` edge types develop statistically
distinct learned weight profiles during gradient descent?

Pass criterion: After training, the cosine distance between same-type edge weight
vectors is statistically significantly smaller than the distance between cross-type
edge weight vectors (p < 0.05, Mann-Whitney U test).
"""

from __future__ import annotations

import sys
from pathlib import Path
from itertools import combinations
from typing import Optional

import torch
import torch.nn as nn
import numpy as np
from scipy.stats import mannwhitneyu
from torch import Tensor

try:
    from torch_geometric.data import Data
except ImportError as e:
    raise ImportError("torch-geometric is required. pip install torch-geometric") from e

# Import G0 model and training utilities from the sibling experiment.
_G0_ROOT = Path(__file__).resolve().parent.parent / "g0-differentiability"
if str(_G0_ROOT) not in sys.path:
    sys.path.insert(0, str(_G0_ROOT))

from model import TypedLinkGraphModel, EDGE_TYPES  # noqa: E402
from untyped_model import UntypedGNNModel  # noqa: E402


def _cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Return cosine distance (1 - cosine_similarity) between two 1-D vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a < 1e-12 or norm_b < 1e-12:
        return 1.0
    return float(1.0 - np.dot(a, b) / (norm_a * norm_b))


def _extract_edge_attention_weights(
    model: TypedLinkGraphModel,
    data: Data,
    device: torch.device,
) -> dict[str, np.ndarray]:
    """
    Extract the learned attention weight scalar for each edge, grouped by type.

    For each conv layer we use the first layer's type embedding, then compute
    the attention logit (conf * w_attn(type_emb)) the same way the forward
    pass does — this is the scalar learned weight for each edge.

    Returns
    -------
    dict mapping edge_type_name -> np.ndarray of shape [n_edges_of_that_type]
        Each value is the attention logit for that edge.
    """
    model.eval()

    x = data.x.to(device)
    edge_index = data.edge_index.to(device)
    edge_type = data.edge_type.to(device)
    edge_confidence = data.edge_confidence.to(device)

    # Use the first conv layer's parameters to extract attention weights.
    conv = model.conv_layers[0]

    with torch.no_grad():
        t_emb = conv.type_embedding(edge_type)         # [E, type_emb_dim]
        conf = edge_confidence.clamp(min=1e-6, max=1.0)
        attn_logit = conf * conv.w_attn(t_emb).squeeze(-1)  # [E]

    attn_logit_np = attn_logit.cpu().numpy()
    edge_type_np = edge_type.cpu().numpy()

    result: dict[str, np.ndarray] = {}
    for type_id, type_name in enumerate(EDGE_TYPES):
        mask = edge_type_np == type_id
        result[type_name] = attn_logit_np[mask]

    return result


def _extract_type_embeddings(
    model: TypedLinkGraphModel,
) -> dict[str, np.ndarray]:
    """
    Extract the learned type embedding vectors from the first conv layer.

    Returns
    -------
    dict mapping edge_type_name -> np.ndarray of shape [type_emb_dim]
    """
    conv = model.conv_layers[0]
    weight = conv.type_embedding.weight.detach().cpu().numpy()  # [num_types, type_emb_dim]
    return {name: weight[i] for i, name in enumerate(EDGE_TYPES)}


def measure_edge_type_divergence(
    model: TypedLinkGraphModel,
    data: Data,
    device: Optional[torch.device] = None,
) -> dict:
    """
    After training, extract the learned weight vectors for each edge type
    and measure whether same-type edges have more similar weights than cross-type.

    Method:
    1. For each edge in the graph, extract the learned attention weight
       (the scalar output of the attention function for that edge).
    2. Group edges by type.
    3. Compute all pairwise cosine distances within each type group
       and across type groups.
    4. Run a two-sample statistical test:
       H0: same-type and cross-type distances come from the same distribution.
       HA: same-type distances are significantly smaller.

    Parameters
    ----------
    model : TypedLinkGraphModel
        A trained (or partially trained) typed-link graph model.
    data : Data
        PyG Data object with edge_index, edge_type, edge_confidence, x.
    device : torch.device, optional
        Defaults to CPU.

    Returns
    -------
    dict with keys:
        type_embeddings          : dict[str, list[float]]   learned type embedding vectors
        within_type_distances    : dict[str, list[float]]   pairwise cosine distances per type
        cross_type_distances     : list[float]              pairwise cosine distances across types
        mean_within_type_distance: float
        mean_cross_type_distance : float
        separation_ratio         : float  mean_cross / mean_within (>1 means separation)
        mannwhitney_statistic    : float
        mannwhitney_p_value      : float
        pass_g3                  : bool   True if p_value < 0.05
    """
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # -- 1. Extract type embedding vectors ------------------------------------
    type_embeddings = _extract_type_embeddings(model)

    # -- 2. Extract per-edge attention weights grouped by type ----------------
    edge_weights_by_type = _extract_edge_attention_weights(model, data, device)

    # -- 3. Compute within-type cosine distances ------------------------------
    # We compare type embedding vectors (not individual edge scalars) because
    # the hypothesis is about the *learned representation* of each type, not
    # per-edge noise.  Per-edge scalars are scalars so cosine distance is 0 or 1;
    # instead we build a "weight profile" vector for each type using the concat
    # of (type_embedding, mean_attn_weight, std_attn_weight) and compute cosine
    # distances between those profiles.
    #
    # For within-type distances we sample pairs from the same type's edges.
    # For cross-type distances we compare profiles across different types.

    # Build a representative vector for each edge type.
    # Concatenate type embedding + [mean, std] of attention logits for the type.
    type_profiles: dict[str, np.ndarray] = {}
    for type_name in EDGE_TYPES:
        emb = type_embeddings[type_name]       # [type_emb_dim]
        weights = edge_weights_by_type[type_name]
        if len(weights) > 0:
            stats = np.array([weights.mean(), weights.std()], dtype=np.float32)
        else:
            stats = np.array([0.0, 0.0], dtype=np.float32)
        type_profiles[type_name] = np.concatenate([emb, stats])

    # Within-type distances: we compare the profile against itself projected
    # with noise — but since we have a single profile per type, within-type
    # distances are defined using individual edge attention logit vectors
    # (each edge has a scalar; we treat it as a 1-D vector for cosine distance).
    #
    # Better approach: within-type = pairwise cosine distances between the
    # type embedding vectors of edges belonging to the same type.  Since each
    # edge maps to the same type embedding, within-type cosine distance is always
    # 0 — which means typed signal is *perfectly* consistent within a type.
    # Cross-type cosine distance is between different type embedding vectors.
    #
    # To make the statistical test meaningful we compute:
    #   within-type sample: cosine distances between pairs of same-type EDGE
    #     attention logit SCALARS (treated as 1-element vectors, i.e. |a-b|/|a||b|).
    #   cross-type sample: cosine distances between pairs of cross-type attention
    #     logit scalars.
    # This measures whether same-type edges attend more uniformly than cross-type.

    within_type_distances: dict[str, list[float]] = {}
    within_all: list[float] = []

    _MAX_SAMPLE = 500  # cap to keep runtime bounded

    for type_name in EDGE_TYPES:
        w = edge_weights_by_type[type_name]
        if len(w) < 2:
            within_type_distances[type_name] = []
            continue
        # Sample pairs
        rng = np.random.default_rng(seed=0)
        n = min(len(w), _MAX_SAMPLE)
        idx = rng.choice(len(w), size=n, replace=False)
        sampled = w[idx]
        dists = []
        for i in range(len(sampled)):
            for j in range(i + 1, min(i + 20, len(sampled))):
                # Cosine distance between 1-D scalars is 0 if same sign, 1 if different.
                # Use abs-normalized difference as distance proxy for scalars.
                a, b = float(sampled[i]), float(sampled[j])
                denom = max(abs(a), abs(b), 1e-12)
                dists.append(abs(a - b) / denom)
        within_type_distances[type_name] = dists
        within_all.extend(dists)

    # Cross-type distances: compare edges from different type groups.
    cross_type_distances: list[float] = []
    type_names = list(EDGE_TYPES)
    rng = np.random.default_rng(seed=1)

    for t1, t2 in combinations(range(len(type_names)), 2):
        w1 = edge_weights_by_type[type_names[t1]]
        w2 = edge_weights_by_type[type_names[t2]]
        if len(w1) == 0 or len(w2) == 0:
            continue
        n1 = min(len(w1), _MAX_SAMPLE)
        n2 = min(len(w2), _MAX_SAMPLE)
        s1 = w1[rng.choice(len(w1), size=n1, replace=False)]
        s2 = w2[rng.choice(len(w2), size=n2, replace=False)]
        # Sample pairs across types
        n_pairs = min(n1 * n2, 200)
        for _ in range(n_pairs):
            a = float(s1[rng.integers(0, n1)])
            b = float(s2[rng.integers(0, n2)])
            denom = max(abs(a), abs(b), 1e-12)
            cross_type_distances.append(abs(a - b) / denom)

    # -- 4. Statistical test --------------------------------------------------
    if len(within_all) == 0:
        within_all = [0.0]
    if len(cross_type_distances) == 0:
        cross_type_distances = [1.0]

    mean_within = float(np.mean(within_all))
    mean_cross = float(np.mean(cross_type_distances))

    if mean_within > 1e-12:
        separation_ratio = mean_cross / mean_within
    else:
        separation_ratio = float("inf") if mean_cross > 0 else 1.0

    stat, p_value = mannwhitneyu(
        within_all,
        cross_type_distances,
        alternative="less",  # H_A: within < cross
    )

    return {
        "type_embeddings": {k: v.tolist() for k, v in type_embeddings.items()},
        "within_type_distances": {k: v for k, v in within_type_distances.items()},
        "cross_type_distances": cross_type_distances,
        "mean_within_type_distance": mean_within,
        "mean_cross_type_distance": mean_cross,
        "separation_ratio": separation_ratio,
        "mannwhitney_statistic": float(stat),
        "mannwhitney_p_value": float(p_value),
        "pass_g3": bool(p_value < 0.05),
    }


def _train_model(
    model: nn.Module,
    data: Data,
    n_steps: int,
    lr: float,
    device: torch.device,
    verbose: bool = False,
) -> tuple[list[float], float]:
    """
    Train model (typed or untyped) on the contradiction-detection task.

    Returns
    -------
    (loss_curve, final_accuracy_on_held_out_pairs)
    """
    model = model.to(device)
    model.train()

    x = data.x.to(device)
    edge_index = data.edge_index.to(device)
    edge_type = data.edge_type.to(device)
    edge_confidence = data.edge_confidence.to(device)
    pair_index = data.pair_index.to(device)
    pair_labels = data.pair_labels.to(device)

    # Train / val split: use first 80% for training, last 20% for eval.
    n_pairs = pair_index.shape[0]
    n_train = int(n_pairs * 0.8)
    train_pair_index = pair_index[:n_train]
    train_pair_labels = pair_labels[:n_train]
    val_pair_index = pair_index[n_train:]
    val_pair_labels = pair_labels[n_train:]

    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.BCEWithLogitsLoss()

    loss_curve: list[float] = []

    for step in range(n_steps):
        optimizer.zero_grad()
        node_emb = model(x, edge_index, edge_type, edge_confidence)
        logits = model.predict(node_emb, train_pair_index)
        loss = criterion(logits, train_pair_labels)
        loss.backward()
        optimizer.step()
        loss_curve.append(float(loss.item()))

    # Compute accuracy on validation pairs.
    model.eval()
    with torch.no_grad():
        node_emb = model(x, edge_index, edge_type, edge_confidence)
        val_logits = model.predict(node_emb, val_pair_index)
        val_preds = (torch.sigmoid(val_logits) >= 0.5).float()
        accuracy = float((val_preds == val_pair_labels).float().mean().item())

    return loss_curve, accuracy


def compare_typed_vs_untyped(
    data: Data,
    n_steps: int = 500,
    seed: int = 42,
    lr: float = 1e-3,
    device: Optional[torch.device] = None,
    node_feat_dim: int = 128,
    hidden_dim: int = 64,
    out_dim: int = 32,
    type_emb_dim: int = 16,
    verbose: bool = False,
) -> dict:
    """
    Train two models on the same data:
    1. TypedLinkGraphModel (uses edge type embeddings)
    2. UntypedGNNModel (same architecture but all edges treated identically)

    Compare final task accuracy on held-out labeled pairs.

    Parameters
    ----------
    data : Data
        PyG Data object from generate_synthetic_graph().
    n_steps : int
        Number of gradient steps for each model (default 500).
    seed : int
        Random seed for model initialisation reproducibility.
    lr : float
        Adam learning rate (default 1e-3).
    device : torch.device, optional
        Defaults to CPU.
    node_feat_dim : int
        Node feature dimension (must match data.x).
    hidden_dim : int
        Hidden dimension (same for both models).
    out_dim : int
        Output dimension (same for both models).
    type_emb_dim : int
        Type embedding dimension for typed model.
    verbose : bool
        Whether to print progress.

    Returns
    -------
    dict with keys:
        typed_accuracy    : float
        untyped_accuracy  : float
        typed_final_loss  : float
        untyped_final_loss: float
        typed_better      : bool
        accuracy_delta    : float   typed_accuracy - untyped_accuracy
    """
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Auto-detect node feature dimension from data if not explicitly provided.
    actual_node_feat_dim = int(data.x.shape[1])

    torch.manual_seed(seed)
    typed_model = TypedLinkGraphModel(
        node_feat_dim=actual_node_feat_dim,
        hidden_dim=hidden_dim,
        out_dim=out_dim,
        type_emb_dim=type_emb_dim,
    )

    torch.manual_seed(seed)
    untyped_model = UntypedGNNModel(
        node_feat_dim=actual_node_feat_dim,
        hidden_dim=hidden_dim,
        out_dim=out_dim,
    )

    typed_loss_curve, typed_accuracy = _train_model(
        typed_model, data, n_steps=n_steps, lr=lr, device=device, verbose=verbose
    )
    untyped_loss_curve, untyped_accuracy = _train_model(
        untyped_model, data, n_steps=n_steps, lr=lr, device=device, verbose=verbose
    )

    typed_final_loss = typed_loss_curve[-1] if typed_loss_curve else float("nan")
    untyped_final_loss = untyped_loss_curve[-1] if untyped_loss_curve else float("nan")
    accuracy_delta = typed_accuracy - untyped_accuracy

    return {
        "typed_accuracy": typed_accuracy,
        "untyped_accuracy": untyped_accuracy,
        "typed_final_loss": typed_final_loss,
        "untyped_final_loss": untyped_final_loss,
        "typed_better": bool(typed_accuracy > untyped_accuracy),
        "accuracy_delta": accuracy_delta,
    }
