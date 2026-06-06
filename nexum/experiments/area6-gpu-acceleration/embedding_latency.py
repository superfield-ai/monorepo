"""
embedding_latency.py — H6.2: GPU vs CPU embedding latency comparison.

Compares three embedding backends:
  - openai_mock:  simulates OpenAI API latency (base 80ms + 2ms/token, no API call)
  - cpu_local:    sentence-transformers on CPU (runs if installed)
  - gpu_local:    sentence-transformers on GPU (runs if CUDA available)

Area 5 identified embed_ms as the second-highest latency stage in single-block
insertion (after HNSW index_insert_ms).  H6.2 tests whether in-process GPU
embedding can push embed latency below 5ms, making index insertion the new
binding constraint.
"""

from __future__ import annotations

import time

import numpy as np

# H6.2 pass criterion: GPU local p50 < 5ms per block at batch_size=1
H6_2_GPU_THRESHOLD_MS = 5.0
# Approximate tokens per word (rough)
_TOKENS_PER_WORD = 1.3


def _count_tokens(text: str) -> int:
    """Estimate token count from whitespace-split word count."""
    return max(1, int(len(text.split()) * _TOKENS_PER_WORD))


def _measure_backend(
    texts: list[str],
    batch_sizes: list[int],
    backend: str,
) -> dict[int, dict[str, float]]:
    """Return {batch_size: {p50_ms, p99_ms, throughput_tokens_per_sec}}."""
    results: dict[int, dict[str, float]] = {}

    for bs in batch_sizes:
        latencies_ms: list[float] = []
        total_tokens = 0

        # Slice texts into batches of size bs
        batches = [texts[i : i + bs] for i in range(0, len(texts), bs)]
        if not batches:
            batches = [texts[:bs]]

        # Cap to a reasonable number of batches for benchmarking speed
        max_batches = min(len(batches), 20)
        batches = batches[:max_batches]

        for batch in batches:
            n_tokens = sum(_count_tokens(t) for t in batch)
            total_tokens += n_tokens

            if backend == "openai_mock":
                # Simulate OpenAI API: base 80ms + 2ms/token (no actual call)
                base_ms = 80.0
                per_token_ms = 2.0
                simulated_ms = base_ms + per_token_ms * n_tokens
                # Add small jitter
                jitter = np.random.default_rng().normal(0, simulated_ms * 0.05)
                elapsed_ms = max(1.0, simulated_ms + jitter)
                latencies_ms.append(elapsed_ms)

            elif backend == "cpu_local":
                try:
                    from sentence_transformers import SentenceTransformer  # type: ignore[import]
                    # Lazy-load a small model for benchmarking
                    _model = _get_st_model("cpu")
                    t0 = time.perf_counter()
                    _model.encode(batch, show_progress_bar=False)
                    latencies_ms.append((time.perf_counter() - t0) * 1000.0)
                except ImportError:
                    # Fall back to mock CPU timing: ~20ms + 0.5ms/token
                    simulated_ms = 20.0 + 0.5 * n_tokens
                    jitter = np.random.default_rng().normal(0, simulated_ms * 0.08)
                    latencies_ms.append(max(1.0, simulated_ms + jitter))

            elif backend == "gpu_local":
                cuda_available = _cuda_available()
                if not cuda_available:
                    latencies_ms.append(float("nan"))
                else:
                    try:
                        from sentence_transformers import SentenceTransformer  # type: ignore[import]
                        _model = _get_st_model("cuda")
                        t0 = time.perf_counter()
                        _model.encode(batch, show_progress_bar=False)
                        latencies_ms.append((time.perf_counter() - t0) * 1000.0)
                    except Exception:
                        latencies_ms.append(float("nan"))

        arr = np.array(latencies_ms)
        valid = arr[~np.isnan(arr)]

        if len(valid) == 0:
            results[bs] = {
                "p50_ms": None,
                "p99_ms": None,
                "throughput_tokens_per_sec": None,
                "note": "CUDA not available" if backend == "gpu_local" else "no data",
            }
        else:
            total_s = valid.sum() / 1000.0
            results[bs] = {
                "p50_ms": float(np.percentile(valid, 50)),
                "p99_ms": float(np.percentile(valid, 99)),
                "throughput_tokens_per_sec": total_tokens / total_s if total_s > 0 else 0.0,
            }

    return results


_st_model_cache: dict[str, object] = {}


def _get_st_model(device: str) -> object:
    """Lazy-load a small sentence-transformers model."""
    if device not in _st_model_cache:
        from sentence_transformers import SentenceTransformer  # type: ignore[import]
        _st_model_cache[device] = SentenceTransformer(
            "all-MiniLM-L6-v2", device=device
        )
    return _st_model_cache[device]


def _cuda_available() -> bool:
    try:
        import torch  # type: ignore[import]
        return torch.cuda.is_available()
    except ImportError:
        return False


def measure_embedding_latency(
    texts: list[str],
    batch_sizes: list[int] = None,
    backends: list[str] = None,
) -> dict:
    """
    H6.2: compare embedding latency across backends.

    backends:
    - "openai_mock": simulate OpenAI API round-trip (base 80ms + 2ms/token)
    - "cpu_local": sentence-transformers on CPU (or mock if not installed)
    - "gpu_local": sentence-transformers on GPU (None values if no CUDA)

    Returns:
        {
            backend: {
                batch_size: {'p50_ms', 'p99_ms', 'throughput_tokens_per_sec'}
            }
            ...
            'h6_2_signal': str
        }
    """
    if batch_sizes is None:
        batch_sizes = [1, 8, 32, 128, 512]
    if backends is None:
        backends = ["openai_mock", "cpu_local", "gpu_local"]

    output: dict = {}

    for backend in backends:
        output[backend] = _measure_backend(texts, batch_sizes, backend)

    # Build h6_2_signal interpretation
    gpu_data = output.get("gpu_local", {})
    mock_data = output.get("openai_mock", {})

    bs1_gpu = gpu_data.get(1, {}) if gpu_data else {}
    bs1_mock = mock_data.get(1, {}) if mock_data else {}

    gpu_p50 = bs1_gpu.get("p50_ms") if bs1_gpu else None
    mock_p50 = bs1_mock.get("p50_ms") if bs1_mock else None

    if gpu_p50 is None:
        signal = (
            "GPU not available — cannot confirm H6.2. "
            f"OpenAI mock p50 at batch=1: {mock_p50:.1f}ms. "
            "Run on CUDA hardware to test H6.2 threshold of <5ms."
        )
    elif gpu_p50 < H6_2_GPU_THRESHOLD_MS:
        signal = (
            f"H6.2 SUPPORTED: GPU local p50={gpu_p50:.2f}ms < 5ms threshold at batch=1. "
            "HNSW index insertion is now the binding constraint."
        )
    else:
        signal = (
            f"H6.2 NOT SUPPORTED: GPU local p50={gpu_p50:.2f}ms >= 5ms threshold at batch=1. "
            "Embedding remains a co-binding constraint with HNSW insertion."
        )

    output["h6_2_signal"] = signal
    return output
