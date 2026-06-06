"""
sizing_memo.py — H1.3 arithmetic: embedding storage dominance.

Computes embedding storage fractions at various corpus scales.
This resolves H1.3 as a measurement (arithmetic), not an experiment.

Run standalone::

    python sizing_memo.py

or import and call :func:`compute_sizing_memo`.
"""

from __future__ import annotations

from typing import Any


# Empirical ratio: total DB size ÷ embedding-only size, derived from the
# Nexum schema structure:
#   - blocks table (content text ~200 bytes avg, metadata, UUIDs, indexes): ~0.8 GB / 1M blocks
#   - links table (~10 links/block, each ~250 bytes + indexes):             ~0.8 GB / 1M blocks
#   - embedding column itself (float32):                                     6.1 GB / 1M blocks
#   - HNSW index overhead:                                                  ~0.5 GB / 1M blocks
# Sum non-embedding: ~2.1 GB/1M; embedding: ~6.1 GB/1M; total ~8.2 GB/1M
# Ratio ≈ total / embedding = 8.2 / 6.1 ≈ 1.34
_TOTAL_TO_EMBEDDING_RATIO = 1.34


def compute_sizing_memo(
    embedding_dim: int = 1536,
    n_blocks_list: list[int] | None = None,
) -> dict[str, Any]:
    """Compute the H1.3 measurement: embedding storage fraction at various scales.

    Args:
        embedding_dim: Vector dimensionality (default 1536, text-embedding-3-small).
        n_blocks_list: Corpus sizes to compute for.  Defaults to
                       [1_000_000, 5_000_000, 20_000_000, 100_000_000].

    Returns:
        A dict with keys:
            ``embedding_dim``,
            ``rows``: list of per-scale dicts with keys
                ``n_blocks``, ``embedding_float32_bytes``,
                ``embedding_int8_bytes``, ``est_total_db_bytes``,
                ``embedding_fraction``.
    """
    if n_blocks_list is None:
        n_blocks_list = [1_000_000, 5_000_000, 20_000_000, 100_000_000]

    rows = []
    for n_blocks in n_blocks_list:
        float32_bytes = n_blocks * embedding_dim * 4       # 4 bytes per float32
        int8_bytes = n_blocks * embedding_dim * 1          # 1 byte per int8
        est_total_bytes = int(float32_bytes * _TOTAL_TO_EMBEDDING_RATIO)
        fraction = float32_bytes / est_total_bytes

        rows.append(
            {
                "n_blocks": n_blocks,
                "embedding_float32_bytes": float32_bytes,
                "embedding_int8_bytes": int8_bytes,
                "est_total_db_bytes": est_total_bytes,
                "embedding_fraction": round(fraction, 4),
            }
        )

    return {
        "embedding_dim": embedding_dim,
        "total_to_embedding_ratio": _TOTAL_TO_EMBEDDING_RATIO,
        "rows": rows,
    }


def _fmt_gb(n_bytes: int) -> str:
    return f"{n_bytes / 1e9:.1f} GB"


def _fmt_pct(fraction: float) -> str:
    return f"~{int(round(fraction * 100))}%"


def _fmt_n_blocks(n: int) -> str:
    if n >= 1_000_000:
        return f"{n // 1_000_000}M"
    return str(n)


def print_sizing_memo(embedding_dim: int = 1536) -> None:
    """Print the sizing memo in Markdown table format."""
    memo = compute_sizing_memo(embedding_dim)

    print("# H1.3 Sizing Memo — Embedding Storage Dominance")
    print()
    print(
        f"At {embedding_dim} embedding dimensions "
        f"(text-embedding-3-small default):"
    )
    print()
    print(
        "| n_blocks | Embedding (float32) | Embedding (int8) "
        "| Est. total DB | Embedding fraction |"
    )
    print("|---|---|---|---|---|")
    for row in memo["rows"]:
        print(
            f"| {_fmt_n_blocks(row['n_blocks']):<5}"
            f"| {_fmt_gb(row['embedding_float32_bytes']):<21}"
            f"| {_fmt_gb(row['embedding_int8_bytes']):<18}"
            f"| ~{_fmt_gb(row['est_total_db_bytes']):<12}"
            f"| {_fmt_pct(row['embedding_fraction']):<19}|"
        )
    print()
    print(
        "Conclusion: embedding storage dominates at > 70% of total DB size "
        "across all scales."
    )
    print(
        "This motivates quantization (int8 reduces embedding cost by 4x) and "
        "motivates"
    )
    print(
        "the GPU paging strategy in Area 6 (H6.5, H6.6)."
    )


if __name__ == "__main__":
    print_sizing_memo()
