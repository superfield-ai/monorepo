"""
report.py — Convert Area 1 results dict to a Markdown report.

Sections:
  1. Scale benchmark — P50/P99 latency table, HNSW build times, pass/fail.
  2. Schema comparison — Postgres vs. Kuzu traversal latency, crossover point.
  3. Embedding ablation — Recall@10 by dimension, minimum viable dimensionality.
  4. H1.1 verdict — supported / refuted / inconclusive.
"""

from __future__ import annotations

import os
from typing import Any


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fmt_ms(v: float | None) -> str:
    if v is None:
        return "N/A"
    return f"{v:.0f}ms"


def _status_emoji(pass_g1: bool | None, p99_exceeds: bool | None) -> str:
    if pass_g1 is True or p99_exceeds is False:
        return "PASS"
    if pass_g1 is False or p99_exceeds is True:
        return "FAIL"
    return "TBD"


# ---------------------------------------------------------------------------
# Section builders
# ---------------------------------------------------------------------------


def _scale_section(scale_results: dict | None) -> str:
    if not scale_results or not scale_results.get("results"):
        return "## Scale Benchmark\n\n_Not run._\n"

    lines = [
        "## Scale Benchmark",
        "",
        "| Scale | Domain Mix | Semantic P99 | Fulltext P99 | Graph 4-hop P99 | HNSW Build | Status |",
        "|-------|-----------|-------------|-------------|-----------------|-----------|--------|",
    ]
    for entry in scale_results["results"]:
        label = entry.get("scale_label", "?")
        mix_idx = entry.get("mix_index", 0)
        bench = entry.get("benchmark", {})
        sem_p99 = bench.get("semantic", {}).get("p99_ms")
        ft_p99 = bench.get("fulltext", {}).get("p99_ms")
        g4_p99 = bench.get("graph_traversal", {}).get("4_hop", {}).get("p99_ms")
        hnsw = entry.get("hnsw_build_time_seconds")
        p99_exceeds = entry.get("p99_exceeds_threshold", True)
        status = "PASS" if not p99_exceeds else "FAIL"

        hnsw_str = f"{hnsw:.0f}s" if hnsw is not None else "N/A"
        lines.append(
            f"| {label} | mix{mix_idx} | {_fmt_ms(sem_p99)} | {_fmt_ms(ft_p99)} "
            f"| {_fmt_ms(g4_p99)} | {hnsw_str} | {status} |"
        )
    lines.append("")
    return "\n".join(lines)


def _schema_section(schema_results: dict | None) -> str:
    if not schema_results:
        return "## Schema Comparison (Postgres vs. Kuzu)\n\n_Not run._\n"

    lines = ["## Schema Comparison (Postgres vs. Kuzu)", ""]

    pg = schema_results.get("postgres", {})
    kz = schema_results.get("kuzu", {})
    n_hops_list = schema_results.get("n_hops_list", [2, 4, 6])
    crossover = schema_results.get("crossover_hop")
    n_blocks = schema_results.get("n_blocks", "?")
    kuzu_sample = schema_results.get("kuzu_sample_size", "?")
    neo4j_note = schema_results.get("neo4j_note", "Neo4j: not tested.")

    lines.append(
        f"Postgres corpus: {n_blocks:,} blocks. "
        f"Kuzu sample: {kuzu_sample:,} blocks (in-process)."
    )
    lines.append("")
    lines.append(
        "| Hops | Postgres P50 | Postgres P99 | Kuzu P50 | Kuzu P99 | Winner |"
    )
    lines.append("|------|-------------|-------------|---------|---------|--------|")

    for n_hops in n_hops_list:
        key = f"{n_hops}_hop"
        pg_p50 = pg.get(key, {}).get("p50_ms")
        pg_p99 = pg.get(key, {}).get("p99_ms")
        kz_p50 = kz.get(key, {}).get("p50_ms") if kz else None
        kz_p99 = kz.get(key, {}).get("p99_ms") if kz else None

        if pg_p50 is not None and kz_p50 is not None:
            winner = "Kuzu" if kz_p50 < pg_p50 else "Postgres"
        else:
            winner = "N/A"

        lines.append(
            f"| {n_hops} | {_fmt_ms(pg_p50)} | {_fmt_ms(pg_p99)} "
            f"| {_fmt_ms(kz_p50)} | {_fmt_ms(kz_p99)} | {winner} |"
        )

    lines.append("")
    if crossover is not None:
        lines.append(
            f"**Crossover point:** Kuzu outperforms Postgres at {crossover}-hop traversal."
        )
    else:
        lines.append(
            "**Crossover point:** Postgres wins at all tested hop depths "
            "(Kuzu not faster on sampled corpus)."
        )
    lines.append("")
    lines.append(f"_{neo4j_note}_")
    lines.append("")
    return "\n".join(lines)


def _embedding_section(ablation_results: dict | None) -> str:
    if not ablation_results or not ablation_results.get("results"):
        return "## Embedding Dimension Ablation\n\n_Not run._\n"

    lines = ["## Embedding Dimension Ablation", ""]
    baseline_dim = ablation_results.get("baseline_dim", 384)
    baseline_recall = ablation_results.get("baseline_recall_at_10", 0.0)
    min_dim = ablation_results.get("min_dim_within_5pct")

    lines.append(
        f"Model: all-MiniLM-L6-v2 (384-dim base) — projected to target dimensions "
        f"via sklearn PCA (lower dims) / zero-pad (higher dims)."
    )
    lines.append(f"Baseline: {baseline_dim} dims → Recall@10 = {baseline_recall:.4f}.")
    lines.append("")
    lines.append(
        "| Dimension | Recall@10 | Delta vs. baseline | Within 5%? |"
    )
    lines.append("|-----------|-----------|-------------------|------------|")

    for entry in ablation_results["results"]:
        dim = entry["dimension"]
        r = entry["recall_at_10"]
        delta = r - baseline_recall
        within = "YES" if abs(delta / (baseline_recall + 1e-9)) <= 0.05 else "NO"
        delta_str = f"{delta:+.4f}"
        lines.append(
            f"| {dim} | {r:.4f} | {delta_str} | {within} |"
        )

    lines.append("")
    if min_dim is not None:
        lines.append(
            f"**Minimum viable dimension:** {min_dim} (Recall@10 within 5% of "
            f"{baseline_dim}-dim baseline)."
        )
    else:
        lines.append(
            "**Minimum viable dimension:** No dimension meets the 5% threshold."
        )
    lines.append("")
    return "\n".join(lines)


def _h11_verdict(scale_results: dict | None) -> str:
    """Derive H1.1 verdict from scale benchmark results.

    H1.1: Postgres + pgvector is sufficient for corpora < 20M blocks.
    Supported = P99 < 500ms at 20M; Refuted = P99 >= 500ms at any scale <= 20M.
    """
    if not scale_results or not scale_results.get("results"):
        return "## H1.1 Verdict\n\n**Inconclusive** — scale benchmark not run.\n"

    max_pass_scale = 0
    first_fail_scale: int | None = None

    for entry in scale_results["results"]:
        n_blocks = entry.get("n_blocks", 0)
        p99_exceeds = entry.get("p99_exceeds_threshold", True)

        if not p99_exceeds:
            max_pass_scale = max(max_pass_scale, n_blocks)
        else:
            if first_fail_scale is None or n_blocks < first_fail_scale:
                first_fail_scale = n_blocks

    threshold_20m = 20_000_000

    lines = ["## H1.1 Verdict — Postgres Fitness for < 20M Blocks", ""]

    if first_fail_scale is None:
        verdict = "**SUPPORTED**"
        explanation = (
            f"P99 < 500ms at all tested scales up to "
            f"{max_pass_scale // 1_000_000}M blocks."
        )
    elif first_fail_scale <= threshold_20m:
        verdict = "**REFUTED**"
        explanation = (
            f"P99 exceeds 500ms at {first_fail_scale // 1_000_000}M blocks. "
            "Consequence: graph DB migration required (Kuzu or Neptune). "
            "Areas 3, 5, 6 are blocked until storage is resolved."
        )
    else:
        verdict = "**SUPPORTED (partially)**"
        explanation = (
            f"P99 < 500ms at all scales up to {max_pass_scale // 1_000_000}M blocks. "
            f"First failure at {first_fail_scale // 1_000_000}M blocks (above 20M threshold)."
        )

    lines.append(f"{verdict} — {explanation}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def generate_report(results: dict) -> str:
    """Convert the Area 1 results dict to a Markdown report.

    Args:
        results: Dict produced by ``run_area1.py`` with optional keys:
                 ``scale_benchmark``, ``schema_comparison``, ``embedding_ablation``.

    Returns:
        Markdown string.
    """
    scale = results.get("scale_benchmark")
    schema = results.get("schema_comparison")
    ablation = results.get("embedding_ablation")

    sections = [
        "# Area 1 — Storage Architecture Fitness Report",
        "",
        "Generated by `report.py`. "
        "See `experiments/area1-storage-fitness/` for source data.",
        "",
    ]

    sections.append(_scale_section(scale))
    sections.append(_schema_section(schema))
    sections.append(_embedding_section(ablation))
    sections.append(_h11_verdict(scale))

    return "\n".join(sections)


def write_report(results: dict, output_path: str = "results/area1_report.md") -> None:
    """Write the Markdown report to *output_path*."""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    report_md = generate_report(results)
    with open(output_path, "w", encoding="utf-8") as fh:
        fh.write(report_md)
    print(f"[Area1] Report written to {output_path}")
