"""
LegalBench evaluation over a 20-task sample.

LegalBench (Guha et al., 2023) contains 162 legal reasoning tasks on
HuggingFace (``nguha/legalbench``).  Each task has a test split with
examples in the form::

    {"text": "<legal text>", "answer": "<label>"}

This script:
1. Loads a configurable set of tasks (default: DEFAULT_20_TASKS).
2. For each example, formats the text as a Nexum query.
3. Collects Nexum's answer from the top retrieved block.
4. Computes per-task exact-match accuracy and a macro-averaged accuracy.

Usage::

    python eval/legalbench_eval.py \\
        --nexum-url http://localhost:3000 \\
        --tasks default20 \\
        --output results/legalbench

    # Or specify tasks explicitly:
    python eval/legalbench_eval.py \\
        --tasks "abercrombie,contract_nli_confidentiality_of_agreement" \\
        --output results/legalbench
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import string
from pathlib import Path
from typing import Any

import requests

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

_HF_DATASET = "nguha/legalbench"

# ---------------------------------------------------------------------------
# Default 20-task sample
# Covers: classification, entailment, extraction, and multiple legal domains.
# ---------------------------------------------------------------------------
DEFAULT_20_TASKS: list[str] = [
    # Binary classification
    "abercrombie",                              # trademark: distinctiveness classification
    "contract_nli_confidentiality_of_agreement",  # contract NLI
    "contract_nli_explicit_identification",
    "contract_nli_limited_use",
    "contract_nli_no_licensing",
    # Entailment / yes-no
    "cuad_affiliate_license_licensee",          # CUAD clause detection
    "cuad_anti_assignment",
    "cuad_audit_rights",
    "cuad_change_of_control",
    "cuad_competitive_restriction_exception",
    # Multi-class classification
    "hearsay",                                  # evidence: hearsay rule
    "learned_hands_benefits",                   # legal issue classification
    "learned_hands_business",
    "learned_hands_consumer",
    "learned_hands_courts",
    # Extraction / span identification
    "privacy_policy_entailment",                # privacy law entailment
    "privacy_policy_qa",                        # extractive QA over privacy policies
    "ssla_company_defendants",                  # securities class action
    "ssla_individual_defendants",
    "unfair_tos",                               # unfair terms of service detection
]


# ---------------------------------------------------------------------------
# Answer normalisation
# ---------------------------------------------------------------------------

def normalize_answer(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    text = text.lower()
    text = "".join(ch for ch in text if ch not in string.punctuation)
    return " ".join(text.split())


def exact_match(prediction: str, gold: str) -> float:
    return float(normalize_answer(prediction) == normalize_answer(gold))


# ---------------------------------------------------------------------------
# Dataset helpers
# ---------------------------------------------------------------------------

def load_dataset(task: str, split: str = "test") -> Any:
    """Thin wrapper around HuggingFace load_dataset for easy mocking in tests."""
    from datasets import load_dataset as hf_load_dataset  # lazy import
    return hf_load_dataset(_HF_DATASET, task, trust_remote_code=True)


def load_task(task_name: str, split: str = "test") -> list[dict[str, str]]:
    """
    Load all examples for a single LegalBench task.

    Returns a list of dicts with keys:
        text (str)  — the legal text / prompt
        label (str) — the gold answer
    """
    ds_dict = load_dataset(task_name, split=split)

    # Select the appropriate split; fall back to 'train' if 'test' is absent.
    if split in ds_dict:
        split_data = ds_dict[split]
    elif "train" in ds_dict:
        logger.warning("Task '%s' has no '%s' split; using 'train'.", task_name, split)
        split_data = ds_dict["train"]
    else:
        available = list(ds_dict.keys())
        split_data = ds_dict[available[0]]
        logger.warning(
            "Task '%s': split '%s' not found. Using '%s'.", task_name, split, available[0]
        )

    examples: list[dict[str, str]] = []
    for row in split_data:
        # LegalBench columns vary by task; the canonical fields are 'text' and 'answer'.
        text = str(row.get("text", row.get("sentence", row.get("input", ""))))
        label = str(row.get("answer", row.get("label", row.get("output", ""))))
        examples.append({"text": text, "label": label})

    return examples


def resolve_tasks(tasks_arg: str) -> list[str]:
    """
    Expand the ``--tasks`` CLI argument into a concrete list of task names.

    ``"default20"`` expands to DEFAULT_20_TASKS.
    Any other value is treated as a comma-separated list of task names.
    """
    if tasks_arg.strip().lower() == "default20":
        return DEFAULT_20_TASKS
    return [t.strip() for t in tasks_arg.split(",") if t.strip()]


# ---------------------------------------------------------------------------
# Nexum query
# ---------------------------------------------------------------------------

def query_nexum(
    nexum_url: str,
    corpus_id: str | None,
    text: str,
    session: requests.Session,
    top_k: int = 3,
) -> str:
    """Query Nexum with a legal text snippet; return the top block text."""
    payload: dict[str, Any] = {
        "query": text[:2000],  # truncate very long inputs
        "mode": "semantic",
        "limit": top_k,
    }
    if corpus_id:
        payload["corpus_id"] = corpus_id

    resp = session.post(f"{nexum_url}/query", json=payload)
    resp.raise_for_status()
    results = resp.json().get("results", [])
    # Return the answer field if Nexum surfaces a structured answer, else block text.
    if results:
        first = results[0]
        return first.get("answer", first.get("text", ""))
    return ""


# ---------------------------------------------------------------------------
# Main eval
# ---------------------------------------------------------------------------

def run_eval(
    nexum_url: str,
    output_dir: Path,
    tasks: list[str],
    corpus_id: str | None = None,
    split: str = "test",
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()

    per_task_accuracy: dict[str, float] = {}
    all_detail_rows: list[dict[str, Any]] = []

    for task_name in tasks:
        logger.info("Evaluating task: %s", task_name)
        try:
            examples = load_task(task_name, split=split)
        except Exception as exc:
            logger.error("Failed to load task '%s': %s", task_name, exc)
            per_task_accuracy[task_name] = float("nan")
            continue

        scores: list[float] = []
        for ex in examples:
            pred = query_nexum(nexum_url, corpus_id, ex["text"], session)
            score = exact_match(pred, ex["label"])
            scores.append(score)
            all_detail_rows.append(
                {
                    "task": task_name,
                    "text": ex["text"][:200],
                    "gold": ex["label"],
                    "prediction": pred[:200],
                    "exact_match": score,
                }
            )

        task_acc = sum(scores) / len(scores) if scores else 0.0
        per_task_accuracy[task_name] = task_acc
        logger.info("  %s: accuracy=%.4f (n=%d)", task_name, task_acc, len(scores))

    # Macro average (ignore NaN tasks that failed to load)
    valid_accs = [v for v in per_task_accuracy.values() if not (v != v)]  # filter NaN
    macro_accuracy = sum(valid_accs) / len(valid_accs) if valid_accs else 0.0

    summary: dict[str, Any] = {
        "tasks_evaluated": tasks,
        "n_tasks": len(tasks),
        "n_tasks_ok": len(valid_accs),
        "corpus_id": corpus_id,
        "macro_accuracy": macro_accuracy,
        "per_task_accuracy": per_task_accuracy,
    }
    (output_dir / "legalbench_summary.json").write_text(json.dumps(summary, indent=2))

    detail_path = output_dir / "legalbench_detail.jsonl"
    with detail_path.open("w") as df:
        for row in all_detail_rows:
            df.write(json.dumps(row) + "\n")

    logger.info(
        "LegalBench macro accuracy: %.4f across %d/%d tasks",
        macro_accuracy,
        len(valid_accs),
        len(tasks),
    )
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="LegalBench evaluation against Nexum")
    parser.add_argument("--nexum-url", default="http://localhost:3000")
    parser.add_argument(
        "--tasks",
        default="default20",
        help=(
            "Comma-separated task names or 'default20' for the built-in 20-task sample. "
            "Example: 'abercrombie,hearsay'"
        ),
    )
    parser.add_argument(
        "--corpus-id",
        default=None,
        help="Nexum corpus ID to query. If omitted, uses the Nexum default.",
    )
    parser.add_argument(
        "--split",
        default="test",
        help="HuggingFace dataset split to use (default: test).",
    )
    parser.add_argument("--output", default="results/legalbench", type=Path)
    args = parser.parse_args()

    tasks = resolve_tasks(args.tasks)
    run_eval(
        nexum_url=args.nexum_url,
        output_dir=args.output,
        tasks=tasks,
        corpus_id=args.corpus_id,
        split=args.split,
    )


if __name__ == "__main__":
    main()
