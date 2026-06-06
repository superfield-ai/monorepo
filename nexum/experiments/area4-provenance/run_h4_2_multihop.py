"""
H4.2 multi-hop compositional reasoning — executable benchmark.

Builds a synthetic legal corpus of 30 inter-linked contracts and a 100-question
multi-hop question set spanning hop depths 2/3/4/5. Compares two retrieval
strategies on the same corpus, with the same embedder, and the same per-question
ground-truth span:

  - **Vanilla** — top-k cosine retrieval over paragraph blocks (no graph).
  - **Graph (Nexum-style)** — top-k cosine retrieval *plus* one-step typed-link
    traversal repeated up to ``n_hops`` times, following explicit cross-document
    references encoded in the corpus (the same kind of structural links Nexum's
    `parseText` would produce on real CUAD contracts).

The metric is **answer accuracy**: did the gold span appear in the union of
text retrieved for the question? This is a recall-bounded upper bound on what
a downstream LLM could answer correctly given the retrieved context.

Why a synthetic corpus rather than CUAD: CUAD's QA pairs are all 1-hop
(single-document clause extraction). Multi-hop reasoning requires explicit
cross-document references, which CUAD does not annotate. Building a synthetic
corpus is the only honest way to measure hop-vs-accuracy at this stage. The
result is a ceiling: it says "*if* a corpus has cross-doc references and *if*
the graph layer surfaces them, here is the accuracy curve." It does not
claim that real CUAD contracts have such structure.

Output: a result envelope written through ``experiments/_lib/results_writer``.

Canonical references:
- docs/research/hypotheses/H4.2_multihop-compositional-reasoning.md
- docs/research.md (Area 4, H4.2)
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent))  # repo root for experiments._lib

from experiments._lib.results_writer import ResultEnvelope, write_result  # noqa: E402
from experiments._lib.runner import capture_run_context  # noqa: E402

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s"
)
logger = logging.getLogger("h4_2")


# ---------------------------------------------------------------------------
# Synthetic corpus — 30 contracts each with ~6 paragraph blocks. Some blocks
# carry explicit cross-document references ("see Section X of contract Y") that
# the graph traversal can follow.
# ---------------------------------------------------------------------------

@dataclass
class Block:
    block_id: str
    doc_id: str
    text: str
    # Outbound typed links to other blocks (structural, what parseText would
    # extract from real legal text). Plain list of target block_ids.
    links_out: list[str]


_CLAUSE_KINDS = (
    "termination",
    "governing_law",
    "indemnity",
    "non_compete",
    "arbitration",
    "assignment",
)


def _build_synthetic_corpus(n_contracts: int = 30, seed: int = 42) -> list[Block]:
    rng = random.Random(seed)
    blocks: list[Block] = []
    by_doc: dict[str, list[Block]] = {}

    # Pass 1: create blocks per contract.
    for i in range(n_contracts):
        doc_id = f"K-{i:03d}"
        doc_blocks: list[Block] = []
        for j, kind in enumerate(_CLAUSE_KINDS):
            bid = f"{doc_id}::B{j}"
            text = (
                f"Section {j+1}: {kind.replace('_', ' ').title()}. "
                f"This section of contract {doc_id} establishes the {kind} "
                f"obligations for the parties to {doc_id}. "
                f"Material covered: {kind}-clause-token-{doc_id}-{j}."
            )
            doc_blocks.append(Block(bid, doc_id, text, []))
        blocks.extend(doc_blocks)
        by_doc[doc_id] = doc_blocks

    # Pass 2: wire cross-document links. Each contract references the next
    # 3 contracts on a deterministic clause kind, building chains long enough
    # to support up to 5-hop traversal.
    doc_ids = sorted(by_doc.keys())
    for i, doc_id in enumerate(doc_ids):
        for offset, kind_idx in zip((1, 2, 3), (0, 2, 4)):
            tgt_idx = (i + offset) % len(doc_ids)
            tgt_doc = doc_ids[tgt_idx]
            src_block = by_doc[doc_id][kind_idx]
            tgt_block = by_doc[tgt_doc][kind_idx]
            ref_phrase = (
                f" See also Section {kind_idx+1} of {tgt_doc} "
                f"(reference-token-{doc_id}-to-{tgt_doc})."
            )
            src_block.text += ref_phrase
            src_block.links_out.append(tgt_block.block_id)

    return blocks


# ---------------------------------------------------------------------------
# Multi-hop question construction over the synthetic corpus.
#
# A k-hop question requires the answer span hidden in the k-th document along
# a chain that starts from a doc_id mentioned in the question. The vanilla
# retriever can only match the seed document; the graph retriever can follow
# links to reach the answer-bearing block.
# ---------------------------------------------------------------------------

@dataclass
class HopQuestion:
    question: str
    n_hops: int
    seed_doc_id: str
    chain: list[str]  # list of block_ids along the chain
    gold_span: str  # substring guaranteed to be unique to the answer block
    required_doc_ids: list[str]


def _build_question_set(
    blocks: list[Block],
    seed: int = 7,
    n_per_hop: int = 25,
) -> list[HopQuestion]:
    by_id = {b.block_id: b for b in blocks}
    by_doc: dict[str, list[Block]] = {}
    for b in blocks:
        by_doc.setdefault(b.doc_id, []).append(b)
    doc_ids = sorted(by_doc.keys())

    rng = random.Random(seed)
    questions: list[HopQuestion] = []

    for n_hops in (2, 3, 4, 5):
        # Pick distinct seed docs deterministically per hop bucket.
        seeds = rng.sample(doc_ids, k=min(n_per_hop, len(doc_ids)))
        for seed_doc in seeds:
            # Walk forward n_hops via the first available outbound link.
            chain_blocks: list[Block] = []
            cur = by_doc[seed_doc][0]  # start at block 0 of the seed doc
            chain_blocks.append(cur)
            ok = True
            for _ in range(n_hops):
                if not cur.links_out:
                    ok = False
                    break
                cur = by_id[cur.links_out[0]]
                chain_blocks.append(cur)
            if not ok or len(chain_blocks) != n_hops + 1:
                continue
            tail = chain_blocks[-1]
            # Gold span is the kind-token unique to the tail block.
            m = re.search(r"([a-z_]+-clause-token-[A-Z0-9-]+-\d+)", tail.text)
            if not m:
                continue
            gold_span = m.group(1)
            # Question text references only the seed doc, forcing multi-hop
            # traversal to reach the answer. We deliberately mention the
            # *termination* clause kind (matching the chain anchor block 0)
            # so seed retrieval grounds on the correct starting block; the
            # gold-bearing block lies n_hops downstream.
            seed_text = chain_blocks[0].text[:60]
            q = (
                f"In contract {seed_doc}'s termination section "
                f"(\"{seed_text}\"), trace the cross-document termination "
                f"references {n_hops} hops forward. What is the unique "
                f"clause token in the final referenced termination section?"
            )
            questions.append(
                HopQuestion(
                    question=q,
                    n_hops=n_hops,
                    seed_doc_id=seed_doc,
                    chain=[b.block_id for b in chain_blocks],
                    gold_span=gold_span,
                    required_doc_ids=sorted({b.doc_id for b in chain_blocks}),
                )
            )

    return questions


# ---------------------------------------------------------------------------
# Retrievers
# ---------------------------------------------------------------------------

def _embed(texts: list[str], model) -> np.ndarray:
    embs = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return np.asarray(embs, dtype=np.float32)


class VanillaRetriever:
    """Pure top-k cosine over paragraph blocks. No graph traversal."""

    def __init__(self, blocks: list[Block], model, top_k: int = 8) -> None:
        self.blocks = blocks
        self.top_k = top_k
        self.embeddings = _embed([b.text for b in blocks], model)
        self.model = model

    def retrieve(self, question: str) -> list[Block]:
        q = _embed([question], self.model)[0]
        scores = self.embeddings @ q
        idx = np.argsort(-scores)[: self.top_k]
        return [self.blocks[i] for i in idx]


class GraphRetriever:
    """Top-k cosine seed retrieval, then follow typed links up to ``hops`` steps."""

    def __init__(
        self,
        blocks: list[Block],
        model,
        top_k: int = 8,
        max_hops: int = 5,
    ) -> None:
        self.by_id = {b.block_id: b for b in blocks}
        self.blocks = blocks
        self.top_k = top_k
        self.max_hops = max_hops
        self.embeddings = _embed([b.text for b in blocks], model)
        self.model = model

    def retrieve(self, question: str, n_hops: int) -> list[Block]:
        q = _embed([question], self.model)[0]
        scores = self.embeddings @ q
        seed_idx = np.argsort(-scores)[: self.top_k]
        seen: set[str] = set()
        frontier: list[Block] = []
        for i in seed_idx:
            b = self.blocks[i]
            if b.block_id not in seen:
                seen.add(b.block_id)
                frontier.append(b)
        out: list[Block] = list(frontier)
        depth = min(n_hops, self.max_hops)
        cur_layer = list(frontier)
        for _ in range(depth):
            next_layer: list[Block] = []
            for b in cur_layer:
                for tgt in b.links_out:
                    if tgt in seen:
                        continue
                    seen.add(tgt)
                    nb = self.by_id[tgt]
                    next_layer.append(nb)
                    out.append(nb)
            cur_layer = next_layer
            if not cur_layer:
                break
        return out


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _answer_correct(retrieved: list[Block], gold_span: str) -> bool:
    return any(gold_span in b.text for b in retrieved)


def run_benchmark(
    blocks: list[Block],
    questions: list[HopQuestion],
    model,
) -> dict:
    vanilla = VanillaRetriever(blocks, model)
    graph = GraphRetriever(blocks, model, max_hops=5)

    by_hops: dict[int, dict] = {}
    for q in questions:
        bucket = by_hops.setdefault(
            q.n_hops, {"n": 0, "vanilla_correct": 0, "graph_correct": 0}
        )
        bucket["n"] += 1
        if _answer_correct(vanilla.retrieve(q.question), q.gold_span):
            bucket["vanilla_correct"] += 1
        if _answer_correct(graph.retrieve(q.question, q.n_hops), q.gold_span):
            bucket["graph_correct"] += 1

    per_hop: dict[int, dict] = {}
    for n_hops, b in sorted(by_hops.items()):
        van = b["vanilla_correct"] / b["n"] if b["n"] else 0.0
        gra = b["graph_correct"] / b["n"] if b["n"] else 0.0
        per_hop[n_hops] = {
            "n_questions": b["n"],
            "vanilla_accuracy": round(van, 4),
            "graph_accuracy": round(gra, 4),
            "delta": round(gra - van, 4),
            "graph_better": gra > van,
        }

    hop3_and_up = [n for n in per_hop if n >= 3]
    h4_2_supported = bool(hop3_and_up) and all(
        per_hop[n]["graph_better"] for n in hop3_and_up
    )

    wins_at = [n for n, v in per_hop.items() if v["graph_better"]]
    return {
        "per_hop": {str(k): v for k, v in per_hop.items()},
        "min_hops_where_graph_wins": min(wins_at) if wins_at else None,
        "h4_2_supported": h4_2_supported,
        "n_questions_total": sum(b["n"] for b in by_hops.values()),
    }


# ---------------------------------------------------------------------------
# ASCII curve plot for the README
# ---------------------------------------------------------------------------

def _ascii_curve(per_hop: dict[str, dict]) -> str:
    lines = [
        "hops | vanilla | graph  | delta",
        "-----+---------+--------+------",
    ]
    for n_hops in sorted(per_hop, key=int):
        v = per_hop[n_hops]
        lines.append(
            f"  {n_hops}  |  {v['vanilla_accuracy']:.3f}  | {v['graph_accuracy']:.3f}  | "
            f"{v['delta']:+.3f}"
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="H4.2 multi-hop compositional benchmark")
    parser.add_argument("--n-contracts", type=int, default=30)
    parser.add_argument("--n-per-hop", type=int, default=25)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--embed-model", default="sentence-transformers/all-MiniLM-L6-v2")
    parser.add_argument("--output-dir", default=str(HERE))
    args = parser.parse_args()

    logger.info("Building synthetic corpus (%d contracts) ...", args.n_contracts)
    blocks = _build_synthetic_corpus(args.n_contracts, seed=args.seed)
    logger.info("Built %d blocks.", len(blocks))

    logger.info("Building multi-hop question set ...")
    questions = _build_question_set(blocks, seed=args.seed, n_per_hop=args.n_per_hop)
    logger.info(
        "Built %d questions across hop depths %s.",
        len(questions),
        sorted({q.n_hops for q in questions}),
    )

    logger.info("Loading embedder %s ...", args.embed_model)
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(args.embed_model)

    logger.info("Running benchmark ...")
    t0 = time.time()
    metrics = run_benchmark(blocks, questions, model)
    metrics["wall_time_sec"] = round(time.time() - t0, 2)

    print()
    print("Hop-vs-accuracy curve:")
    print(_ascii_curve(metrics["per_hop"]))
    print()
    print(
        f"min_hops_where_graph_wins = {metrics['min_hops_where_graph_wins']}, "
        f"h4_2_supported = {metrics['h4_2_supported']}"
    )

    runtime = capture_run_context(gate="H4.2", hypothesis="H4.2", seed=args.seed)
    envelope = ResultEnvelope(
        gate="H4.2",
        hypothesis="H4.2",
        passed=bool(metrics["h4_2_supported"]),
        metrics=metrics,
        runtime=runtime,
        notes=(
            "Synthetic 30-contract corpus with explicit cross-document "
            "reference chains. Vanilla = top-k cosine only; graph = top-k "
            "cosine + typed-link traversal up to n_hops. Both share embedder "
            f"{args.embed_model}."
        ),
        extra={
            "n_contracts": args.n_contracts,
            "n_questions_per_hop": args.n_per_hop,
            "embed_model": args.embed_model,
            "corpus": "synthetic",
        },
    )
    out = write_result(envelope, args.output_dir)
    logger.info("Wrote result envelope: %s", out)
    print(f"\nResult envelope: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
