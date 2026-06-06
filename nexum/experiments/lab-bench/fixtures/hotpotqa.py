"""
Download HotpotQA and emit JSONL for ingestion.

HotpotQA Full Wiki: 5M+ Wikipedia paragraphs as the corpus,
113K multi-hop QA pairs with supporting sentence annotations.

Outputs:
  data/hotpotqa/corpus.jsonl      — Wikipedia paragraphs: {id, title, text}
  data/hotpotqa/questions.jsonl   — QA pairs: {id, question, answer, supporting_facts, type}

Usage:
  python fixtures/hotpotqa.py [--output-dir data/hotpotqa] [--split fullwiki|distractor]
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def download_hotpotqa(output_dir: Path, split: str = "fullwiki") -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        raise SystemExit("Install datasets: pip install datasets")

    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Loading HotpotQA (%s) from Hugging Face…", split)
    ds = load_dataset("hotpotqa/hotpot_qa", split)

    questions_path = output_dir / "questions.jsonl"
    corpus_path = output_dir / "corpus.jsonl"

    seen_paragraphs: set[str] = set()

    with questions_path.open("w") as qf, corpus_path.open("w") as cf:
        for split_name in ["train", "validation"]:
            if split_name not in ds:
                continue
            for row in ds[split_name]:
                qf.write(
                    json.dumps(
                        {
                            "id": row["id"],
                            "question": row["question"],
                            "answer": row["answer"],
                            "supporting_facts": row["supporting_facts"],
                            "type": row["type"],
                            "level": row["level"],
                        }
                    )
                    + "\n"
                )

                # Emit supporting Wikipedia paragraphs as corpus documents
                context = row.get("context", {})
                titles = context.get("title", [])
                sentences_list = context.get("sentences", [])
                for title, sentences in zip(titles, sentences_list):
                    para_id = f"hotpotqa-{title.replace(' ', '_')}"
                    if para_id not in seen_paragraphs:
                        seen_paragraphs.add(para_id)
                        cf.write(
                            json.dumps(
                                {
                                    "id": para_id,
                                    "title": title,
                                    "text": " ".join(sentences),
                                    "source": "hotpotqa-wikipedia",
                                }
                            )
                            + "\n"
                        )

    logger.info("Wrote corpus (%d paragraphs) → %s", len(seen_paragraphs), corpus_path)
    logger.info("Wrote questions → %s", questions_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and emit HotpotQA corpus")
    parser.add_argument("--output-dir", default="data/hotpotqa", type=Path)
    parser.add_argument(
        "--split",
        choices=["fullwiki", "distractor"],
        default="distractor",
        help="distractor (10 paragraphs) is faster; fullwiki uses the full 5M Wikipedia corpus",
    )
    args = parser.parse_args()
    download_hotpotqa(args.output_dir, args.split)


if __name__ == "__main__":
    main()
