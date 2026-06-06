"""
Generate synthetic block corpora for Area 1 scale tests.

Produces corpora at configurable sizes (1M / 5M / 20M / 100M blocks) with
controlled document-type mix (legal, biomedical, general). Uses real sentence
templates from each domain to produce plausible text distributions without
requiring large downloads.

Outputs:
  data/synthetic/<size>/blocks.jsonl   — {id, text, domain, doc_id}

Usage:
  python fixtures/synthetic.py --size 1m --output-dir data/synthetic/1m
  python fixtures/synthetic.py --size 5m --mix legal=0.5,bio=0.25,general=0.25
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import uuid
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

SIZE_MAP = {
    "1m": 1_000_000,
    "5m": 5_000_000,
    "20m": 20_000_000,
    "100m": 100_000_000,
}

BLOCKS_PER_DOC = 40  # average paragraphs per document

TEMPLATES: dict[str, list[str]] = {
    "legal": [
        "This Agreement is entered into as of {date} by and between {party_a} and {party_b}.",
        "The parties hereby agree that any dispute arising under this Agreement shall be resolved by arbitration.",
        "Notwithstanding the foregoing, {party_a} shall have the right to terminate this Agreement upon {n} days written notice.",
        "This clause shall survive the termination or expiration of this Agreement for a period of {n} years.",
        "Each party represents and warrants that it has full authority to enter into this Agreement.",
        "The confidentiality obligations under Section {n} shall not apply to information that is publicly known.",
        "In the event of a breach, the non-breaching party shall be entitled to seek injunctive relief.",
        "This Agreement constitutes the entire understanding between the parties with respect to the subject matter hereof.",
        "No amendment or modification of this Agreement shall be valid unless made in writing and signed by both parties.",
        "The prevailing party in any legal action shall be entitled to recover its reasonable attorneys fees.",
    ],
    "bio": [
        "Patients were randomized to receive {drug} or placebo in a double-blind controlled trial.",
        "The primary endpoint was defined as reduction in {symptom} at {n} weeks from baseline.",
        "Adverse events were reported in {n}% of patients in the treatment arm versus {n}% in placebo.",
        "Statistical significance was assessed using a two-sided t-test with alpha set at 0.05.",
        "Serum levels of {marker} were measured at baseline, week 4, week 8, and week 12.",
        "Inclusion criteria required a confirmed diagnosis of {condition} per {guideline} criteria.",
        "Secondary endpoints included quality of life measures assessed by the {scale} scale.",
        "The trial was approved by the institutional review board at each participating center.",
        "All participants provided written informed consent prior to enrollment.",
        "A Kaplan-Meier survival analysis was performed to estimate time-to-event outcomes.",
    ],
    "general": [
        "The organization reported revenue of ${n} million in the fiscal year ending {date}.",
        "Key performance indicators showed a {n}% improvement compared to the prior quarter.",
        "The strategic initiative is expected to generate cost savings of ${n} million annually.",
        "Stakeholder feedback was incorporated into the revised operational framework.",
        "The project timeline has been updated to reflect the dependencies identified in the review.",
        "Resource allocation decisions were made based on priority scoring across {n} workstreams.",
        "The working group met on {date} to review progress against the milestones.",
        "Risks identified during the assessment phase have been logged in the risk register.",
        "External partners were briefed on the updated requirements on {date}.",
        "The final report incorporates feedback received during the public comment period.",
    ],
}

FILL = {
    "date": ["January 1, 2024", "March 15, 2023", "June 30, 2025", "October 1, 2022"],
    "party_a": ["Acme Corp.", "GlobalTech Inc.", "Meridian LLC", "Apex Holdings"],
    "party_b": ["the Contractor", "the Licensee", "the Vendor", "the Client"],
    "n": ["30", "60", "90", "5", "10", "2", "3", "12", "24"],
    "drug": ["Treatment A", "Compound B", "Agent X", "Study Drug"],
    "symptom": ["pain score", "symptom severity", "functional impairment", "disease activity"],
    "marker": ["CRP", "IL-6", "HbA1c", "troponin", "PSA"],
    "condition": ["Type 2 Diabetes", "Rheumatoid Arthritis", "Hypertension", "COPD"],
    "guideline": ["ADA", "ACR", "JNC", "GOLD"],
    "scale": ["SF-36", "EQ-5D", "PROMIS", "HAQ"],
}


def fill_template(template: str) -> str:
    result = template
    for key, values in FILL.items():
        placeholder = f"{{{key}}}"
        if placeholder in result:
            result = result.replace(placeholder, random.choice(values), 1)
    return result


def generate_corpus(n_blocks: int, mix: dict[str, float], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "blocks.jsonl"

    domains = list(mix.keys())
    weights = [mix[d] for d in domains]

    docs_needed = max(1, n_blocks // BLOCKS_PER_DOC)
    logger.info("Generating %d blocks across ~%d documents…", n_blocks, docs_needed)

    written = 0
    doc_id = str(uuid.uuid4())
    doc_block_count = 0

    with out_path.open("w") as f:
        while written < n_blocks:
            if doc_block_count == 0:
                doc_id = str(uuid.uuid4())
                domain = random.choices(domains, weights=weights, k=1)[0]

            template = random.choice(TEMPLATES[domain])
            text = fill_template(template)

            f.write(
                json.dumps(
                    {
                        "id": str(uuid.uuid4()),
                        "text": text,
                        "domain": domain,
                        "doc_id": doc_id,
                    }
                )
                + "\n"
            )

            written += 1
            doc_block_count += 1
            if doc_block_count >= BLOCKS_PER_DOC:
                doc_block_count = 0

            if written % 100_000 == 0:
                logger.info("  %d / %d blocks written", written, n_blocks)

    logger.info("Done. Wrote %d blocks → %s", written, out_path)


def parse_mix(mix_str: str) -> dict[str, float]:
    result: dict[str, float] = {}
    for part in mix_str.split(","):
        k, v = part.strip().split("=")
        result[k.strip()] = float(v.strip())
    total = sum(result.values())
    return {k: v / total for k, v in result.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic block corpus")
    parser.add_argument(
        "--size",
        choices=list(SIZE_MAP.keys()),
        default="1m",
        help="Target corpus size",
    )
    parser.add_argument(
        "--n-blocks",
        type=int,
        default=None,
        help="Exact block count (overrides --size)",
    )
    parser.add_argument(
        "--mix",
        default="legal=0.4,bio=0.3,general=0.3",
        help="Domain mix as key=weight pairs (comma-separated)",
    )
    parser.add_argument("--output-dir", default=None, type=Path)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    random.seed(args.seed)
    n_blocks = args.n_blocks if args.n_blocks is not None else SIZE_MAP[args.size]
    mix = parse_mix(args.mix)
    output_dir = args.output_dir or Path(f"data/synthetic/{args.size}")
    generate_corpus(n_blocks, mix, output_dir)


if __name__ == "__main__":
    main()
