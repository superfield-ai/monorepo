"""
inference.py — ONNX Runtime inference for the exported TypedLinkGraphModel.

Gate G4 / H7.3: Verify that ONNX Runtime produces the same outputs as
the live PyTorch model, within floating-point rounding tolerance.

Two inference paths are provided:
1. ONNXGraphInference  — uses the ONNX Runtime session on the exported .onnx.
2. NumpyFallbackInference — pure-NumPy path over the .npz weight archive.
   This is the fallback for environments where ONNX Runtime is unavailable
   or when torch.onnx.export failed the full model export.

Both paths are mathematically equivalent to the PyTorch forward pass.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import numpy as np

# Allow running from the g4 directory or from the repo root.
_HERE = Path(__file__).resolve().parent
_G0_DIR = _HERE.parent / "g0-differentiability"
if str(_G0_DIR) not in sys.path:
    sys.path.insert(0, str(_G0_DIR))


# ---------------------------------------------------------------------------
# ONNX Runtime inference
# ---------------------------------------------------------------------------

class ONNXGraphInference:
    """
    Run inference on the exported ONNX model using ONNX Runtime (CPU).

    Mimics the interface of TypedLinkGraphModel.predict():
        node_emb = model(x, edge_index, edge_type, edge_confidence)
        logits   = model.predict(node_emb, node_pairs)

    The ONNX model internally stores the frozen node embeddings (computed
    by the PyTorch model at export time) and the pair_classifier weights.
    It accepts pair_index as input and returns logits directly.

    For the full-model ONNX path (if torch.onnx.export succeeded):
        The model accepts (x, edge_confidence) and returns node_embeddings.
        In that case, we run two sessions: one for the GNN, one for the
        pairwise classifier (or we chain them).

    This class auto-detects which ONNX variant was exported.
    """

    def __init__(self, onnx_path: str, npz_path: Optional[str] = None) -> None:
        """
        Parameters
        ----------
        onnx_path : str
            Path to the .onnx file produced by export_to_onnx().
        npz_path : str, optional
            Path to the .npz weight archive (used by the fallback path).
            If None, the fallback path is unavailable from this class.
        """
        import onnxruntime as ort

        self.onnx_path = onnx_path
        self.npz_path = npz_path

        # Detect ONNX model variant by inspecting input names.
        import onnx
        onnx_model = onnx.load(onnx_path)
        self._input_names = [inp.name for inp in onnx_model.graph.input
                             if inp.name not in {init.name for init in onnx_model.graph.initializer}]
        self._output_names = [out.name for out in onnx_model.graph.output]

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            onnx_path,
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )

        # Detect model variant.
        # Full model: inputs are ["x", "edge_confidence"]
        # Fallback model: input is ["pair_index"]
        self._is_full_model = "x" in self._input_names
        self._is_fallback_model = "pair_index" in self._input_names

        # Load .npz if provided (for the fallback numpy path).
        self._weights: Optional[dict] = None
        if npz_path is not None and Path(npz_path).exists():
            self._weights = dict(np.load(npz_path, allow_pickle=False))

    def predict(
        self,
        edge_index: np.ndarray,
        edge_type: np.ndarray,
        edge_confidence: np.ndarray,
        node_pairs: np.ndarray,
        x: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """
        Returns logits for node pair classification, same shape as PyTorch model.

        Parameters
        ----------
        edge_index : np.ndarray [2, E] int64
        edge_type : np.ndarray [E] int64
        edge_confidence : np.ndarray [E] float32
        node_pairs : np.ndarray [P, 2] int64
        x : np.ndarray [N, D] float32, optional
            Node features (required for full-model ONNX).

        Returns
        -------
        logits : np.ndarray [P] float32
        """
        if self._is_full_model:
            return self._predict_full_model(x, edge_confidence, node_pairs)
        elif self._is_fallback_model:
            return self._predict_fallback_model(node_pairs)
        else:
            raise RuntimeError(
                f"Unknown ONNX model variant. Inputs: {self._input_names}"
            )

    def _predict_full_model(
        self,
        x: np.ndarray,
        edge_confidence: np.ndarray,
        node_pairs: np.ndarray,
    ) -> np.ndarray:
        """
        Full ONNX model path: run GNN forward pass then pairwise classification.
        The ONNX model outputs node_embeddings; we apply the classifier in NumPy.
        """
        if x is None:
            raise ValueError("x (node features) is required for full ONNX model.")

        feeds = {
            "x": x.astype(np.float32),
            "edge_confidence": edge_confidence.astype(np.float32),
        }
        outputs = self._session.run(None, feeds)
        node_emb = outputs[0]  # [N, out_dim]

        # Apply pair_classifier using NumPy (the ONNX model exports the GNN only).
        return _numpy_pair_classify(node_emb, node_pairs, self._weights)

    def _predict_fallback_model(self, node_pairs: np.ndarray) -> np.ndarray:
        """
        Fallback ONNX model: already includes the pair classifier + frozen embeddings.
        """
        feeds = {"pair_index": node_pairs.astype(np.int64)}
        outputs = self._session.run(None, feeds)
        return outputs[0].squeeze(-1) if outputs[0].ndim > 1 else outputs[0]


# ---------------------------------------------------------------------------
# Pure-NumPy fallback inference (no ONNX Runtime required)
# ---------------------------------------------------------------------------

class NumpyFallbackInference:
    """
    Pure-NumPy inference path that replicates the TypedLinkGraphModel forward pass.

    Loads weights from the .npz archive produced by export.py's fallback path.
    This is identical in parameter count to the live PyTorch model — no reduction.

    Used when:
    - ONNX Runtime is unavailable (e.g., in a test environment without it).
    - torch.onnx.export failed and only the .npz weights were produced.
    - As a cross-check against the ONNX Runtime results.
    """

    def __init__(self, npz_path: str) -> None:
        self.npz_path = npz_path
        data = np.load(npz_path, allow_pickle=False)
        self._weights = dict(data)

        # Load fixed graph topology embedded in the .npz.
        self._x = self._weights.get("_graph__x")
        self._edge_index = self._weights.get("_graph__edge_index")
        self._edge_type = self._weights.get("_graph__edge_type")
        self._edge_confidence = self._weights.get("_graph__edge_confidence")

    def predict(
        self,
        edge_index: Optional[np.ndarray] = None,
        edge_type: Optional[np.ndarray] = None,
        edge_confidence: Optional[np.ndarray] = None,
        node_pairs: Optional[np.ndarray] = None,
        x: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """
        Run the NumPy inference path.

        If edge_index / x are None, uses the topology embedded at export time.
        """
        x_np = x if x is not None else self._x
        ei = edge_index if edge_index is not None else self._edge_index
        et = edge_type if edge_type is not None else self._edge_type
        ec = edge_confidence if edge_confidence is not None else self._edge_confidence

        if x_np is None or ei is None or et is None or ec is None:
            raise RuntimeError(
                "Graph topology not available. Provide explicit inputs or load "
                "a .npz archive that includes _graph__ keys."
            )

        node_emb = _numpy_forward_pass(x_np, ei, et, ec, self._weights)
        return _numpy_pair_classify(node_emb, node_pairs, self._weights)

    @property
    def output_shape(self) -> tuple[int, int]:
        """Return (n_nodes, out_dim) of the embedded forward pass output."""
        node_emb = _numpy_forward_pass(
            self._x, self._edge_index, self._edge_type,
            self._edge_confidence, self._weights,
        )
        return node_emb.shape


# ---------------------------------------------------------------------------
# Internal NumPy forward pass (replicates TypedLinkGraphModel exactly)
# ---------------------------------------------------------------------------

def _numpy_forward_pass(
    x: np.ndarray,
    edge_index: np.ndarray,
    edge_type: np.ndarray,
    edge_confidence: np.ndarray,
    weights: dict,
) -> np.ndarray:
    """
    NumPy implementation of TypedLinkGraphModel.forward().

    Replicates:
      1. input_proj linear + relu + dropout=0 (eval mode)
      2. For each conv layer i:
           a. TypedLinkConv forward (message-passing)
           b. relu (if not last layer)
      3. Returns node embeddings [N, out_dim]

    Parameters match the .npz weight keys produced by export.py.
    """
    w = weights

    # ------------------------------------------------------------------
    # 1. Input projection: linear(x) + relu
    # ------------------------------------------------------------------
    W_in = w["input_proj__weight"]   # [hidden_dim, node_feat_dim]
    b_in = w["input_proj__bias"]     # [hidden_dim]
    h = x @ W_in.T + b_in           # [N, hidden_dim]
    h = np.maximum(h, 0.0)           # relu; no dropout in eval mode

    # ------------------------------------------------------------------
    # 2. Message-passing layers
    # ------------------------------------------------------------------
    # Detect number of layers by counting conv_layers keys.
    n_layers = sum(1 for k in w if k.startswith("conv_layers__") and "__type_embedding__weight" in k)

    src = edge_index[0]  # [E]
    dst = edge_index[1]  # [E]
    ec_clamp = np.clip(edge_confidence, 1e-6, 1.0)  # [E]

    for i in range(n_layers):
        prefix = f"conv_layers__{i}__"

        # Type embedding lookup.
        type_emb_W = w[f"{prefix}type_embedding__weight"]  # [num_types, type_emb_dim]
        t_emb = type_emb_W[edge_type]                       # [E, type_emb_dim]

        # Attention logit: conf * w_attn(t_emb)
        w_attn = w[f"{prefix}w_attn__weight"]  # [1, type_emb_dim]
        attn_logit = ec_clamp * (t_emb @ w_attn.T).squeeze(-1)  # [E]

        # Sigmoid gate.
        alpha = _sigmoid(attn_logit)  # [E]

        # Message: alpha * W_msg * h_src
        W_msg = w[f"{prefix}W_msg__weight"]  # [out_dim_i, in_dim_i]
        msg_feat = h[src] @ W_msg.T          # [E, out_dim_i]
        messages = alpha[:, None] * msg_feat  # [E, out_dim_i]

        # Aggregate: scatter sum over dst.
        out_dim_i = W_msg.shape[0]
        n_nodes = h.shape[0]
        agg = np.zeros((n_nodes, out_dim_i), dtype=np.float32)
        np.add.at(agg, dst, messages)

        # Layer norm.
        gamma = w[f"{prefix}layer_norm__weight"]  # [out_dim_i]
        beta = w[f"{prefix}layer_norm__bias"]      # [out_dim_i]
        agg = _layer_norm(agg, gamma, beta)

        h = agg

        # ReLU between layers (not on last).
        if i < n_layers - 1:
            h = np.maximum(h, 0.0)

    return h.astype(np.float32)


def _numpy_pair_classify(
    node_emb: np.ndarray,
    node_pairs: np.ndarray,
    weights: dict,
) -> np.ndarray:
    """
    NumPy implementation of TypedLinkGraphModel.predict().

    Applies the pair_classifier MLP to (a_emb || b_emb) pairs.
    """
    w = weights

    a_emb = node_emb[node_pairs[:, 0]]  # [P, out_dim]
    b_emb = node_emb[node_pairs[:, 1]]  # [P, out_dim]
    pair_feat = np.concatenate([a_emb, b_emb], axis=-1)  # [P, out_dim*2]

    # Layer 0: linear + relu
    W0 = w["pair_classifier__0__weight"]  # [out_dim, out_dim*2]
    b0 = w["pair_classifier__0__bias"]    # [out_dim]
    h = pair_feat @ W0.T + b0             # [P, out_dim]
    h = np.maximum(h, 0.0)                # relu; no dropout in eval mode

    # Layer 1: linear
    W1 = w["pair_classifier__3__weight"]  # [1, out_dim]
    b1 = w["pair_classifier__3__bias"]    # [1]
    logits = (h @ W1.T + b1).squeeze(-1)  # [P]

    return logits.astype(np.float32)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x.clip(-88, 88))).astype(np.float32)


def _layer_norm(
    x: np.ndarray,
    gamma: np.ndarray,
    beta: np.ndarray,
    eps: float = 1e-5,
) -> np.ndarray:
    mean = x.mean(axis=-1, keepdims=True)
    var = x.var(axis=-1, keepdims=True)
    x_norm = (x - mean) / np.sqrt(var + eps)
    return (gamma * x_norm + beta).astype(np.float32)
