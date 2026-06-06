"""
Download CUAD (Contract Understanding Atticus Dataset) and emit JSONL for ingestion.

Outputs:
  data/cuad/contracts.jsonl   — one contract per line: {id, title, text, annotations}
  data/cuad/qa.jsonl          — one QA pair per line: {id, contract_id, question, answers}

Usage:
  python fixtures/cuad.py [--output-dir data/cuad]
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def download_cuad(output_dir: Path) -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        raise SystemExit("Install datasets: pip install datasets")

    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Loading CUAD from Hugging Face…")
    ds = load_dataset("theatticusproject/cuad", trust_remote_code=True)
    train = ds["train"]

    contracts_path = output_dir / "contracts.jsonl"
    qa_path = output_dir / "qa.jsonl"

    seen_contracts: dict[str, str] = {}  # title → id

    with contracts_path.open("w") as cf, qa_path.open("w") as qf:
        for i, row in enumerate(train):
            title = row["title"]
            context = row["context"]

            if title not in seen_contracts:
                contract_id = f"cuad-contract-{len(seen_contracts):04d}"
                seen_contracts[title] = contract_id
                cf.write(
                    json.dumps(
                        {
                            "id": contract_id,
                            "title": title,
                            "text": context,
                            "source": "cuad",
                        }
                    )
                    + "\n"
                )

            contract_id = seen_contracts[title]
            answers = row["answers"]
            qf.write(
                json.dumps(
                    {
                        "id": f"cuad-qa-{i:06d}",
                        "contract_id": contract_id,
                        "question": row["question"],
                        "answers": answers,
                    }
                )
                + "\n"
            )

    n_contracts = len(seen_contracts)
    n_qa = i + 1
    logger.info("Wrote %d contracts → %s", n_contracts, contracts_path)
    logger.info("Wrote %d QA pairs → %s", n_qa, qa_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and emit CUAD corpus")
    parser.add_argument("--output-dir", default="data/cuad", type=Path)
    args = parser.parse_args()
    download_cuad(args.output_dir)


if __name__ == "__main__":
    main()
