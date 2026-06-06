"""
run_h2_1_headtohead.py — Execute the H2.1 curriculum-vs-random trainer
and emit a canonical result envelope under results/.

This is the honest measurement that backs the H2.1 verdict in the issue,
distinct from the broader scaffolded `run_area2.py` which still uses mock
accuracy for the four-hypothesis fan-out.

Usage::

    python run_h2_1_headtohead.py \\
        --n-blocks 800 \\
        --seeds 0,1,2,3,4 \\
        --output results/h2_1_headtohead.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Allow running from anywhere by inserting the experiment root and the repo
# root on sys.path so `experiments._lib.*` imports resolve.
_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parents[1]
for p in (str(_REPO), str(_HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

from experiments._lib.runner import capture_run_context  # noqa: E402
from experiments._lib.results_writer import ResultEnvelope, write_result  # noqa: E402

from h2_1_curriculum_trainer import compare_curriculum_vs_random  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--n-blocks", type=int, default=800)
    p.add_argument("--seeds", type=str, default="0,1,2,3,4",
                   help="Comma-separated integer seeds (default: 0,1,2,3,4)")
    p.add_argument("--n-epochs", type=int, default=6)
    p.add_argument("--target-acc", type=float, default=0.80)
    p.add_argument("--output", default=None,
                   help="Optional explicit output JSON path (overrides default envelope path)")
    args = p.parse_args(argv)

    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]
    print(f"[H2.1] n_blocks={args.n_blocks}  seeds={seeds}  n_epochs={args.n_epochs}")

    t0 = time.perf_counter()
    cmp = compare_curriculum_vs_random(
        n_blocks=args.n_blocks,
        seeds=seeds,
        n_epochs=args.n_epochs,
        target_acc=args.target_acc,
    )
    elapsed = time.perf_counter() - t0

    print(f"[H2.1] bfs         mean eval_acc = {cmp.curriculum_bfs['final_eval_acc_mean']:.4f} "
          f"(stdev {cmp.curriculum_bfs['final_eval_acc_stdev']:.4f})")
    print(f"[H2.1] interleaved mean eval_acc = {cmp.curriculum_interleaved['final_eval_acc_mean']:.4f} "
          f"(stdev {cmp.curriculum_interleaved['final_eval_acc_stdev']:.4f})")
    print(f"[H2.1] random      mean eval_acc = {cmp.random['final_eval_acc_mean']:.4f} "
          f"(stdev {cmp.random['final_eval_acc_stdev']:.4f})")
    print(f"[H2.1] delta_eval_acc bfs={cmp.delta_eval_acc_bfs:+.4f}  "
          f"interleaved={cmp.delta_eval_acc_interleaved:+.4f}")
    print(f"[H2.1] epochs_to_target bfs={cmp.curriculum_bfs['epochs_to_target_mean']}  "
          f"interleaved={cmp.curriculum_interleaved['epochs_to_target_mean']}  "
          f"random={cmp.random['epochs_to_target_mean']}")
    print(f"[H2.1] verdict = {cmp.verdict}  basis={cmp.verdict_basis}  (elapsed {elapsed:.2f}s)")

    metrics = {
        "n_blocks": args.n_blocks,
        "seeds": seeds,
        "n_epochs": args.n_epochs,
        "target_eval_acc": args.target_acc,
        "elapsed_sec": round(elapsed, 3),
        "curriculum_bfs": cmp.curriculum_bfs,
        "curriculum_interleaved": cmp.curriculum_interleaved,
        "random": cmp.random,
        "delta_eval_acc_bfs": cmp.delta_eval_acc_bfs,
        "delta_eval_acc_interleaved": cmp.delta_eval_acc_interleaved,
        "delta_epochs_to_target_bfs": cmp.delta_epochs_to_target_bfs,
        "delta_epochs_to_target_interleaved": cmp.delta_epochs_to_target_interleaved,
        "verdict": cmp.verdict,
        "verdict_basis": cmp.verdict_basis,
    }

    rc = capture_run_context(gate="H2.1", hypothesis="H2.1", seed=seeds[0])
    envelope = ResultEnvelope(
        gate="H2.1",
        hypothesis="H2.1",
        passed=(cmp.verdict == "curriculum_better"),
        metrics=metrics,
        runtime=rc,
        notes=(
            "Head-to-head over the SAME training examples in three orderings: "
            "(a) bfs = naive BFS over high-confidence `supports` links seeded by "
            "in-degree; (b) interleaved = round-robin across per-domain BFS "
            "streams; (c) random = uniform shuffle. Same linear hashed-bag-of-"
            "tokens classifier on a synthetic structured corpus where `supports` "
            "links connect same-domain blocks. verdict picks max(d_bfs, d_intl) "
            "vs random; 'curriculum_better' iff that delta > 0.01 or "
            "epochs_to_target advantage > 0.5."
        ),
    )

    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(envelope.to_dict(results_path=str(out.as_posix())),
                       indent=2, sort_keys=True),
            encoding="utf-8",
        )
    else:
        out = write_result(envelope, _HERE)

    print(f"[H2.1] envelope written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
