"""
Download LEDGAR (LexGLUE) and emit JSONL for ingestion.

LEDGAR: 846K contract provisions from SEC EDGAR Exhibit-10 filings,
classified into 12 principal topic categories.

Outputs:
  data/ledgar/provisions.jsonl   — {id, text, label, split}

Usage:
  python fixtures/ledgar.py [--output-dir data/ledgar]
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

LABEL_NAMES = [
    "Agreements",
    "Amendments",
    "Anti-Corruption Laws",
    "Applicable Laws",
    "Approvals",
    "Arbitration",
    "Assignments",
    "Binding Effects",
    "Books",
    "Brokers",
    "Change Of Control",
    "Closings",
    "Compliance With Laws",
    "Confidentiality",
    "Consent To Jurisdiction",
    "Counterparts",
    "Definitions",
    "Disability",
    "Disclosures",
    "Effective Dates",
    "Employment",
    "Entire Agreements",
    "Erisa",
    "Existence",
    "Expenses",
    "Further Assurances",
    "General",
    "Governing Laws",
    "Headings",
    "Indemnifications",
    "Insurances",
    "Integration",
    "Intellectual Property",
    "Interests",
    "Jurisdictions",
    "Liabilities",
    "Miscellaneous",
    "Modifications",
    "No Conflicts",
    "No Waivers",
    "Non-Disparagement",
    "Notices",
    "Organizations",
    "Payments",
    "Positions",
    "Powers",
    "Publicity",
    "Qualifications",
    "Records",
    "Releases",
    "Remedies",
    "Representations",
    "Sales",
    "Sanctions",
    "Severability",
    "Solvency",
    "Specific Performance",
    "Successors",
    "Survival",
    "Tax Withholdings",
    "Taxes",
    "Terminations",
    "Third-Party Beneficiaries",
    "Titles",
    "Transactions With Affiliates",
    "Use Of Proceeds",
    "Vacations",
    "Venues",
    "Waivers",
    "Warranties",
    "Withholdings",
]


def download_ledgar(output_dir: Path) -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        raise SystemExit("Install datasets: pip install datasets")

    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Loading LEDGAR from LexGLUE on Hugging Face…")
    ds = load_dataset("coastalcph/lex_glue", "ledgar")

    out_path = output_dir / "provisions.jsonl"
    total = 0
    with out_path.open("w") as f:
        for split_name in ["train", "validation", "test"]:
            if split_name not in ds:
                continue
            for i, row in enumerate(ds[split_name]):
                label_idx = row["label"]
                label_name = LABEL_NAMES[label_idx] if label_idx < len(LABEL_NAMES) else str(label_idx)
                f.write(
                    json.dumps(
                        {
                            "id": f"ledgar-{split_name}-{i:07d}",
                            "text": row["text"],
                            "label": label_name,
                            "label_idx": label_idx,
                            "split": split_name,
                            "source": "ledgar-lexglue",
                        }
                    )
                    + "\n"
                )
                total += 1

    logger.info("Wrote %d provisions → %s", total, out_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and emit LEDGAR corpus")
    parser.add_argument("--output-dir", default="data/ledgar", type=Path)
    args = parser.parse_args()
    download_ledgar(args.output_dir)


if __name__ == "__main__":
    main()
