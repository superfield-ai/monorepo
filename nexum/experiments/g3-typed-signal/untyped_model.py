"""
untyped_model.py — Untyped GNN baseline for the G3 typed-link gradient signal spike.

Gate G3 / H7.2: Comparison baseline for TypedLinkGraphModel.

UntypedGNNModel has the same architecture as TypedLinkGraphModel from G0
but treats all edges identically — no type embedding, no type-specific attention.
This is the control that lets us measure whether typed link structure carries
independent gradient signal.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor
from torch_geometric.nn import MessagePassing


class UntypedConv(MessagePassing):
    """
    Single untyped message-passing layer.

    For each target node v, computes:
        h_v = sum_{u in N(v)} conf_{u->v} * W_msg * h_u

    Edge confidence is the only weighting — no type embedding, no type-specific
    attention. This is the control baseline for H7.2.

    Parameters
    ----------
    in_dim : int
        Input node embedding dimension.
    out_dim : int
        Output node embedding dimension.
    """

    def __init__(self, in_dim: int, out_dim: int) -> None:
        super().__init__(aggr="add")

        self.in_dim = in_dim
        self.out_dim = out_dim

        # Linear projection for neighbor messages — same as TypedLinkConv.
        self.W_msg = nn.Linear(in_dim, out_dim, bias=False)

        # Output projection / layer norm for stability.
        self.layer_norm = nn.LayerNorm(out_dim)

        nn.init.xavier_uniform_(self.W_msg.weight)

    def forward(
        self,
        x: Tensor,               # [N, in_dim]
        edge_index: Tensor,       # [2, E]
        edge_confidence: Tensor,  # [E]  — float in [0, 1]; type info is ignored
    ) -> Tensor:
        """
        Forward pass.

        Returns
        -------
        Tensor of shape [N, out_dim] — updated node embeddings.
        """
        # Clamp confidence to (0, 1] for numeric safety.
        conf = edge_confidence.clamp(min=1e-6, max=1.0)  # [E]

        out = self.propagate(edge_index, x=x, edge_confidence=conf)  # [N, out_dim]
        return self.layer_norm(out)

    def message(
        self,
        x_j: Tensor,            # [E, in_dim]  — source node features
        edge_confidence: Tensor, # [E]
    ) -> Tensor:
        """
        Compute messages: confidence_weight × W_msg(h_neighbor).

        Uses sigmoid gate on confidence, mirroring TypedLinkConv.message()
        but without any type-embedding signal.
        """
        alpha = torch.sigmoid(edge_confidence)  # [E]
        return alpha.unsqueeze(-1) * self.W_msg(x_j)  # [E, out_dim]


class UntypedGNNModel(nn.Module):
    """
    Same as TypedLinkGraphModel but without edge type embeddings.
    Uses uniform attention weights over all neighbor edges — edge type is ignored.

    This is the comparison baseline for H7.2 (G3 gate):
    does typed-link structure carry independent gradient signal?

    Parameters
    ----------
    node_feat_dim : int
        Dimension of input node (block) embeddings.
    hidden_dim : int
        Hidden dimension for intermediate layers.
    out_dim : int
        Output node embedding dimension (used for classification head).
    num_layers : int
        Number of message-passing layers (default 2).
    dropout : float
        Dropout probability (default 0.1).
    """

    def __init__(
        self,
        node_feat_dim: int = 128,
        hidden_dim: int = 64,
        out_dim: int = 32,
        num_layers: int = 2,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()

        self.node_feat_dim = node_feat_dim
        self.hidden_dim = hidden_dim
        self.out_dim = out_dim
        self.num_layers = num_layers

        # Input projection — same as TypedLinkGraphModel.
        self.input_proj = nn.Linear(node_feat_dim, hidden_dim)

        # Stack of untyped conv layers.
        dims = [hidden_dim] + [hidden_dim] * (num_layers - 1) + [out_dim]
        self.conv_layers = nn.ModuleList(
            [
                UntypedConv(in_dim=dims[i], out_dim=dims[i + 1])
                for i in range(num_layers)
            ]
        )

        self.dropout = nn.Dropout(p=dropout)

        # Pairwise classification head: identical to TypedLinkGraphModel.
        self.pair_classifier = nn.Sequential(
            nn.Linear(out_dim * 2, out_dim),
            nn.ReLU(),
            nn.Dropout(p=dropout),
            nn.Linear(out_dim, 1),
        )

    def forward(
        self,
        x: Tensor,               # [N, node_feat_dim]
        edge_index: Tensor,       # [2, E]
        edge_type: Tensor,        # [E]  int64 — IGNORED; present for API parity
        edge_confidence: Tensor,  # [E]  float
    ) -> Tensor:
        """
        Run message-passing forward pass.

        edge_type is accepted but ignored — this is the untyped baseline.

        Returns
        -------
        node_embeddings : Tensor of shape [N, out_dim]
        """
        # Input projection + nonlinearity.
        h = F.relu(self.input_proj(x))  # [N, hidden_dim]
        h = self.dropout(h)

        # Message-passing layers (no type info passed).
        for i, conv in enumerate(self.conv_layers):
            h = conv(h, edge_index, edge_confidence)
            if i < self.num_layers - 1:
                h = F.relu(h)
                h = self.dropout(h)

        return h  # [N, out_dim]

    def predict(
        self,
        node_embeddings: Tensor,  # [N, out_dim]
        node_pairs: Tensor,        # [P, 2]  — pairs of node indices
    ) -> Tensor:
        """
        Predict link logits for a set of node pairs.

        Parameters
        ----------
        node_embeddings : Tensor [N, out_dim]
            Output of forward().
        node_pairs : Tensor [P, 2]
            Each row is (node_a_idx, node_b_idx).

        Returns
        -------
        logits : Tensor [P] — raw logits (use BCEWithLogitsLoss).
        """
        a_idx = node_pairs[:, 0]  # [P]
        b_idx = node_pairs[:, 1]  # [P]

        a_emb = node_embeddings[a_idx]  # [P, out_dim]
        b_emb = node_embeddings[b_idx]  # [P, out_dim]

        pair_feat = torch.cat([a_emb, b_emb], dim=-1)  # [P, out_dim*2]
        logits = self.pair_classifier(pair_feat).squeeze(-1)  # [P]
        return logits
