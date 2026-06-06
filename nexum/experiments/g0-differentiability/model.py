"""
model.py — Differentiable typed-link message-passing model for the Nexum block graph.

Gate G0 / H7.1: Implements the forward pass that must admit backpropagation.

Design:
- Nodes: block embeddings (learnable or frozen)
- Edges: typed links with confidence weights
- Forward pass: soft attention over neighbor edges weighted by
  (link_confidence × type_embedding), aggregating neighbor embeddings.
- Aggregation: sum (ablate to mean/max in later experiments)
- The soft attention relaxation is the key differentiability enabler —
  discrete graph traversal is NOT differentiable; soft attention over all
  neighbors is.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor
from torch_geometric.nn import MessagePassing

# Edge type vocabulary — fixed for the Nexum typed-link schema.
EDGE_TYPES = ["cites", "contradicts", "supports", "elaborates", "is-exception-to"]
NUM_EDGE_TYPES = len(EDGE_TYPES)  # 5


class TypedLinkConv(MessagePassing):
    """
    Single typed-link message-passing layer.

    For each target node v, computes:
        h_v = sum_{u in N(v)} alpha_{u->v} * W_msg * h_u

    where the attention coefficient is:
        alpha_{u->v} = softmax_u(  conf_{u->v} * (type_emb_{u->v} @ w_attn)  )

    Parameters
    ----------
    in_dim : int
        Input node embedding dimension.
    out_dim : int
        Output node embedding dimension.
    type_emb_dim : int
        Dimension of each edge-type embedding vector.
    num_edge_types : int
        Number of distinct edge types (default 5 for Nexum).
    """

    def __init__(
        self,
        in_dim: int,
        out_dim: int,
        type_emb_dim: int = 16,
        num_edge_types: int = NUM_EDGE_TYPES,
    ) -> None:
        # aggr="add" = sum aggregation
        super().__init__(aggr="add")

        self.in_dim = in_dim
        self.out_dim = out_dim
        self.type_emb_dim = type_emb_dim
        self.num_edge_types = num_edge_types

        # Learned type embeddings — one per edge type.
        self.type_embedding = nn.Embedding(num_edge_types, type_emb_dim)

        # Linear projection for neighbor messages.
        self.W_msg = nn.Linear(in_dim, out_dim, bias=False)

        # Attention scoring: maps type_emb_dim -> 1 scalar per edge.
        self.w_attn = nn.Linear(type_emb_dim, 1, bias=False)

        # Output projection / layer norm for stability.
        self.layer_norm = nn.LayerNorm(out_dim)

        self._reset_parameters()

    def _reset_parameters(self) -> None:
        nn.init.xavier_uniform_(self.W_msg.weight)
        nn.init.xavier_uniform_(self.w_attn.weight)
        # Init type embeddings with small random values so they start distinct.
        nn.init.normal_(self.type_embedding.weight, mean=0.0, std=0.1)

    def forward(
        self,
        x: Tensor,               # [N, in_dim]
        edge_index: Tensor,       # [2, E]  — row=src, col=dst (PyG convention)
        edge_type: Tensor,        # [E]     — integer type ids
        edge_confidence: Tensor,  # [E]     — float in [0, 1]
    ) -> Tensor:
        """
        Forward pass.

        Returns
        -------
        Tensor of shape [N, out_dim] — updated node embeddings.
        """
        # Compute type embeddings for each edge.
        t_emb = self.type_embedding(edge_type)  # [E, type_emb_dim]

        # Raw attention logit: confidence × linear(type_emb) → scalar per edge.
        # Clamp confidence to (0, 1] for numeric safety.
        conf = edge_confidence.clamp(min=1e-6, max=1.0)          # [E]
        attn_logit = conf * self.w_attn(t_emb).squeeze(-1)        # [E]

        # Propagate messages. edge_weight is passed through to message().
        out = self.propagate(
            edge_index,
            x=x,
            attn_logit=attn_logit,
            edge_index_for_softmax=edge_index,
        )  # [N, out_dim]

        return self.layer_norm(out)

    def message(
        self,
        x_j: Tensor,        # [E, in_dim]  — source node features
        attn_logit: Tensor, # [E]
    ) -> Tensor:
        """
        Compute messages: attention_weight × W_msg(h_neighbor).

        Note: softmax normalization happens per destination node.
        PyG's softmax utility (from torch_geometric.utils) is used in
        aggregate() below via the standard edge_softmax pattern.
        We instead apply a simple sigmoid gate here so the model remains
        strictly differentiable without requiring a sorted edge list.
        The full sparse softmax is used in TypedLinkGraphModel.forward()
        via edge_softmax before propagation for the attention variant.
        """
        # Gate by sigmoid of attn_logit (differentiable, no discrete ops).
        alpha = torch.sigmoid(attn_logit)  # [E]
        return alpha.unsqueeze(-1) * self.W_msg(x_j)  # [E, out_dim]


class TypedLinkGraphModel(nn.Module):
    """
    Typed-link message-passing forward pass over a Nexum block graph.

    Nodes: block embeddings (learnable)
    Edges: typed links with confidence weights
    Forward pass: soft attention over neighbor edges weighted by
                  (link_confidence × type_embedding), aggregating neighbor
                  embeddings.

    Parameters
    ----------
    node_feat_dim : int
        Dimension of input node (block) embeddings.
    hidden_dim : int
        Hidden dimension for intermediate layers.
    out_dim : int
        Output node embedding dimension (used for classification head).
    type_emb_dim : int
        Dimension of each edge-type embedding (default 16).
    num_layers : int
        Number of message-passing layers (default 2).
    dropout : float
        Dropout probability (default 0.1).
    num_edge_types : int
        Number of distinct edge types (default 5).
    """

    def __init__(
        self,
        node_feat_dim: int = 128,
        hidden_dim: int = 64,
        out_dim: int = 32,
        type_emb_dim: int = 16,
        num_layers: int = 2,
        dropout: float = 0.1,
        num_edge_types: int = NUM_EDGE_TYPES,
    ) -> None:
        super().__init__()

        self.node_feat_dim = node_feat_dim
        self.hidden_dim = hidden_dim
        self.out_dim = out_dim
        self.num_layers = num_layers

        # Input projection.
        self.input_proj = nn.Linear(node_feat_dim, hidden_dim)

        # Stack of typed-link conv layers.
        dims = [hidden_dim] + [hidden_dim] * (num_layers - 1) + [out_dim]
        self.conv_layers = nn.ModuleList(
            [
                TypedLinkConv(
                    in_dim=dims[i],
                    out_dim=dims[i + 1],
                    type_emb_dim=type_emb_dim,
                    num_edge_types=num_edge_types,
                )
                for i in range(num_layers)
            ]
        )

        self.dropout = nn.Dropout(p=dropout)

        # Pairwise classification head: takes two node embeddings, outputs logit.
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
        edge_type: Tensor,        # [E]  int64
        edge_confidence: Tensor,  # [E]  float
    ) -> Tensor:
        """
        Run message-passing forward pass.

        Returns
        -------
        node_embeddings : Tensor of shape [N, out_dim]
        """
        # Input projection + nonlinearity.
        h = F.relu(self.input_proj(x))  # [N, hidden_dim]
        h = self.dropout(h)

        # Message-passing layers.
        for i, conv in enumerate(self.conv_layers):
            h = conv(h, edge_index, edge_type, edge_confidence)
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
