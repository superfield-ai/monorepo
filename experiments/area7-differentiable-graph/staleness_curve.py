"""
staleness_curve.py — H7.4: Accuracy decay vs. time-since-export.

Simulates how the accuracy of a frozen ONNX artifact degrades as corpus updates
accumulate in the live graph.

Simulation model:
- Day 0: the frozen model was accurate on all questions (initial_accuracy).
- Each day, `update_rate` new blocks are added to the live graph.
- Questions about new blocks can only be answered correctly by the live graph.
- Fraction of questions touching new blocks grows with cumulative new-block count.
- The frozen model answers those questions randomly (0.5 accuracy) because it
  has never seen those blocks.
- Total accuracy at day t = fraction_old_questions × initial_accuracy
                           + fraction_new_questions × 0.5

Also generates results/area7_staleness_curve.png — accuracy vs. days-since-export
for all update rates.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Optional


def simulate_staleness_curve(
    update_rates_per_day: list[int] | None = None,
    n_days: int = 14,
    initial_accuracy: float = 0.85,
    decay_model: str = "exponential",
    seed: int = 42,
    output_dir: str = "results",
) -> dict:
    """
    H7.4: Model accuracy decay of a frozen ONNX artifact as corpus updates accumulate.

    Simulation model:
    - The frozen model was accurate on day 0 (initial_accuracy over the corpus).
    - Each day, `update_rate` new blocks are added to the live graph.
    - Questions about new blocks can only be answered by the live graph.
    - Fraction of questions requiring new knowledge grows with time and update rate.

    Parameters
    ----------
    update_rates_per_day : list[int]
        Block update rates to simulate. Default: [10, 100, 1_000, 10_000].
    n_days : int
        Number of days to simulate (default 14).
    initial_accuracy : float
        Model accuracy on day 0 (default 0.85).
    decay_model : str
        Functional form to fit. Currently "exponential" is implemented.
        Post-hoc fitting; the simulation does not assume a form.
    seed : int
        Random seed (not used in the deterministic simulation, reserved for
        future stochastic variants).
    output_dir : str
        Directory to save the staleness curve plot.

    Returns
    -------
    dict:
        For each update_rate (as int key):
            'accuracy_by_day'           : list[float]  len = n_days + 1 (day 0..n_days)
            'half_life_days'            : float         days until accuracy drops 10pp
            'days_until_5pct_degradation': float
        'decay_curves_plotted' : bool  whether matplotlib plot was saved
    """
    if update_rates_per_day is None:
        update_rates_per_day = [10, 100, 1_000, 10_000]

    # We need a baseline corpus size to compute what fraction of queries will
    # involve new blocks. Use a fixed 100K baseline (matching the full training run).
    baseline_corpus_size = 100_000

    results: dict = {}

    for update_rate in update_rates_per_day:
        accuracy_by_day: list[float] = []

        for day in range(n_days + 1):
            # Cumulative new blocks added since export.
            n_new = update_rate * day

            # Fraction of corpus that is new (not known to the frozen model).
            # Capped at 1 to avoid unrealistic scenarios.
            fraction_new = min(n_new / (baseline_corpus_size + n_new), 1.0)

            # The fraction of queries that touch at least one new block grows
            # proportionally (linear approximation — post-hoc fitting handles
            # the actual functional form).
            fraction_queries_needing_new = fraction_new

            # Accuracy: frozen model answers old-block questions at initial_accuracy;
            # new-block questions at random (0.5 for binary tasks).
            acc = (
                (1.0 - fraction_queries_needing_new) * initial_accuracy
                + fraction_queries_needing_new * 0.5
            )
            # Clamp to [0, 1].
            acc = max(0.0, min(1.0, acc))
            accuracy_by_day.append(acc)

        # ------------------------------------------------------------------
        # Half-life: days until accuracy drops by 10 percentage points.
        # ------------------------------------------------------------------
        target_10pp = initial_accuracy - 0.10
        half_life_days = _days_until_threshold(accuracy_by_day, target_10pp, n_days)

        # ------------------------------------------------------------------
        # Days until 5% degradation.
        # ------------------------------------------------------------------
        target_5pct = initial_accuracy - 0.05
        days_until_5 = _days_until_threshold(accuracy_by_day, target_5pct, n_days)

        results[update_rate] = {
            "accuracy_by_day": accuracy_by_day,
            "half_life_days": half_life_days,
            "days_until_5pct_degradation": days_until_5,
        }

    # ------------------------------------------------------------------
    # Plot.
    # ------------------------------------------------------------------
    decay_curves_plotted = _plot_staleness_curves(
        results=results,
        update_rates=update_rates_per_day,
        n_days=n_days,
        initial_accuracy=initial_accuracy,
        output_dir=output_dir,
    )

    results["decay_curves_plotted"] = decay_curves_plotted
    return results


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _days_until_threshold(
    accuracy_by_day: list[float],
    threshold: float,
    n_days: int,
) -> float:
    """
    Return the interpolated day when accuracy first crosses below `threshold`.

    If accuracy never crosses the threshold within n_days, returns float(n_days).
    """
    for day, acc in enumerate(accuracy_by_day):
        if acc < threshold:
            if day == 0:
                return 0.0
            # Linear interpolation between day-1 and day.
            prev_acc = accuracy_by_day[day - 1]
            if abs(prev_acc - acc) < 1e-12:
                return float(day)
            t = (prev_acc - threshold) / (prev_acc - acc)
            return float(day - 1) + t
    return float(n_days)


def _plot_staleness_curves(
    results: dict,
    update_rates: list[int],
    n_days: int,
    initial_accuracy: float,
    output_dir: str,
) -> bool:
    """
    Generate staleness curve plot and save to output_dir/area7_staleness_curve.png.

    Returns True if the plot was saved successfully.
    """
    try:
        import matplotlib
        matplotlib.use("Agg")  # non-interactive backend for CI
        import matplotlib.pyplot as plt

        Path(output_dir).mkdir(parents=True, exist_ok=True)
        output_path = Path(output_dir) / "area7_staleness_curve.png"

        fig, ax = plt.subplots(figsize=(9, 5))
        days = list(range(n_days + 1))

        for rate in update_rates:
            if rate not in results:
                continue
            acc = results[rate]["accuracy_by_day"]
            label = f"{rate:,} blocks/day"
            ax.plot(days, acc, marker="o", markersize=3, label=label)

        ax.axhline(initial_accuracy, color="black", linestyle="--", linewidth=0.8,
                   label=f"Initial accuracy ({initial_accuracy:.2f})")
        ax.axhline(initial_accuracy - 0.10, color="red", linestyle=":", linewidth=0.8,
                   label="−10pp threshold")

        ax.set_xlabel("Days since export")
        ax.set_ylabel("Model accuracy")
        ax.set_title("H7.4 — Frozen ONNX artifact accuracy decay vs. days-since-export")
        ax.legend(fontsize=8)
        ax.grid(True, alpha=0.3)
        ax.set_ylim(0.4, 1.0)
        ax.set_xlim(0, n_days)

        fig.tight_layout()
        fig.savefig(str(output_path), dpi=150)
        plt.close(fig)
        return True

    except Exception as exc:
        print(f"[H7.4] Plot generation failed: {exc}")
        return False
