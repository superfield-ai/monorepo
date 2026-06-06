"""
throughput_comparison.py — H7.5: ONNX Runtime throughput vs. live graph traversal.

Measures ONNX Runtime inference speed on the exported model.
Compares against the Area 3 baseline (live graph P50 latency from area3 results,
or use a configurable default if not available).

Pass criterion (H7.5): throughput_ratio >= 10x.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

import numpy as np


def benchmark_throughput(
    onnx_path: str,
    n_queries: int = 1_000,
    k: int = 10,
    live_graph_latency_ms: float = 50.0,
    seed: int = 42,
) -> dict:
    """
    H7.5: ONNX Runtime throughput vs. live graph traversal.

    Measures ONNX Runtime inference speed on the exported model.
    Compares against the Area 3 baseline (live graph P50 latency from area3
    results, or uses `live_graph_latency_ms` default if not available).

    The ONNX model exported by Area 7 takes pair_index as input and returns
    logits. Each "query" consists of k pair predictions (simulating a
    top-k retrieval request over the frozen graph).

    Parameters
    ----------
    onnx_path : str
        Path to the exported .onnx model file.
    n_queries : int
        Number of inference calls to benchmark.
    k : int
        Pairs per query (simulates a k-NN retrieval request).
    live_graph_latency_ms : float
        Live graph P50 latency in ms. Used to compute throughput_ratio.
        Default: 50.0 ms (from Area 3 measurements).
    seed : int
        Random seed for generating synthetic query pairs.

    Returns
    -------
    dict with keys:
        onnx_p50_ms         : float
        onnx_p99_ms         : float
        onnx_throughput_qps : float   queries per second
        live_graph_p50_ms   : float
        throughput_ratio    : float   onnx_throughput / live_throughput
        h7_5_supported      : bool    True if throughput_ratio >= 10x
    """
    if not Path(onnx_path).exists():
        raise FileNotFoundError(
            f"ONNX model not found at {onnx_path!r}. "
            "Run run_area7.py or onnx_production.run_onnx_roundtrip() first."
        )

    # ------------------------------------------------------------------
    # 1. Load ONNX model and inspect it to determine the query shape.
    # ------------------------------------------------------------------
    import onnx
    onnx_model = onnx.load(onnx_path)
    input_names = [
        inp.name for inp in onnx_model.graph.input
        if inp.name not in {init.name for init in onnx_model.graph.initializer}
    ]

    # Detect the model variant.
    # Fallback model: input "pair_index" [P, 2]
    # Full model: inputs "x" [N, D] and "edge_confidence" [E]
    is_fallback = "pair_index" in input_names
    is_full = "x" in input_names

    # ------------------------------------------------------------------
    # 2. Set up ONNX Runtime session.
    # ------------------------------------------------------------------
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(
        onnx_path,
        sess_options=opts,
        providers=["CPUExecutionProvider"],
    )

    # ------------------------------------------------------------------
    # 3. Load node count from embedded constants if possible.
    #    Fall back to a small synthetic graph.
    # ------------------------------------------------------------------
    n_nodes = _detect_n_nodes(onnx_model)

    rng = np.random.default_rng(seed)

    # ------------------------------------------------------------------
    # 4. Warmup (discard first 10 queries).
    # ------------------------------------------------------------------
    n_warmup = min(10, n_queries // 10)
    for _ in range(n_warmup):
        feeds = _make_feeds(session, is_fallback, is_full, n_nodes, k, rng)
        session.run(None, feeds)

    # ------------------------------------------------------------------
    # 5. Benchmark loop.
    # ------------------------------------------------------------------
    latencies_ms: list[float] = []

    for _ in range(n_queries):
        feeds = _make_feeds(session, is_fallback, is_full, n_nodes, k, rng)
        t0 = time.perf_counter()
        session.run(None, feeds)
        elapsed_ms = (time.perf_counter() - t0) * 1_000.0
        latencies_ms.append(elapsed_ms)

    # ------------------------------------------------------------------
    # 6. Compute statistics.
    # ------------------------------------------------------------------
    latencies_arr = np.array(latencies_ms, dtype=np.float64)
    onnx_p50_ms = float(np.percentile(latencies_arr, 50))
    onnx_p99_ms = float(np.percentile(latencies_arr, 99))

    # Throughput: queries per second, using P50 latency as the cycle time.
    onnx_throughput_qps = 1_000.0 / onnx_p50_ms if onnx_p50_ms > 0 else float("inf")

    # Live graph throughput from its P50 latency.
    live_throughput_qps = 1_000.0 / live_graph_latency_ms if live_graph_latency_ms > 0 else 1.0

    throughput_ratio = onnx_throughput_qps / live_throughput_qps

    # H7.5 pass criterion: >= 10x throughput ratio.
    h7_5_supported = throughput_ratio >= 10.0

    return {
        "onnx_p50_ms": onnx_p50_ms,
        "onnx_p99_ms": onnx_p99_ms,
        "onnx_throughput_qps": onnx_throughput_qps,
        "live_graph_p50_ms": live_graph_latency_ms,
        "throughput_ratio": throughput_ratio,
        "h7_5_supported": h7_5_supported,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _detect_n_nodes(onnx_model) -> int:
    """
    Detect number of nodes from the node_embeddings_const initializer, if present.
    Falls back to 1000.
    """
    for init in onnx_model.graph.initializer:
        if init.name == "node_embeddings_const":
            # Shape is [n_nodes, out_dim]
            if len(init.dims) == 2:
                return int(init.dims[0])
    return 1000


def _make_feeds(
    session,
    is_fallback: bool,
    is_full: bool,
    n_nodes: int,
    k: int,
    rng: np.random.Generator,
) -> dict:
    """Build a feed_dict for one benchmark query."""
    if is_fallback:
        # Fallback model: pair_index [k, 2]
        pairs = rng.integers(0, n_nodes, size=(k, 2)).astype(np.int64)
        # Ensure no self-pairs.
        mask = pairs[:, 0] == pairs[:, 1]
        pairs[mask, 1] = (pairs[mask, 1] + 1) % n_nodes
        return {"pair_index": pairs}
    elif is_full:
        # Full model: x [n_nodes, D] and edge_confidence [E]
        # We don't have an easy way to know D and E without loading the graph.
        # Read from session input metadata.
        inp_meta = {inp.name: inp for inp in session.get_inputs()}
        d = inp_meta["x"].shape[1] if len(inp_meta["x"].shape) > 1 else 128
        e = inp_meta["edge_confidence"].shape[0] if inp_meta["edge_confidence"].shape else 50000
        # Use realistic shapes; the model has fixed topology so only edge_confidence varies.
        x = rng.standard_normal((n_nodes, d)).astype(np.float32)
        ec = rng.beta(5, 2, size=(e,)).astype(np.float32)
        return {"x": x, "edge_confidence": ec}
    else:
        # Unknown — try pair_index.
        pairs = rng.integers(0, n_nodes, size=(k, 2)).astype(np.int64)
        return {session.get_inputs()[0].name: pairs}
