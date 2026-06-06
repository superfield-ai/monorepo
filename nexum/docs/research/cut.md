# Nexum — Cut and Demoted Hypothesis Audit Trail

Audit trail for hypotheses that were CUT or DEMOTED from the active research program. Every entry records the reason, date, and what (if anything) replaced it. This file is append-only — entries are never removed, only added.

See `docs/research.md` for the full research plan and `docs/research/queue.md` for the active hypothesis queue.

---

## H3.4 — Read-After-Write Coherence Propagation

Status: CUT
Reason: Tautology — this is the definition of coherent read-after-write, not a hypothesis; no experiment can falsify a definitional property.
Date: 2026-05-01
Action: Dropped entirely. Tracked as a system invariant under Area 5 instead. The engineering requirement (new block queryable within one query cycle) is specified as a correctness invariant in the Area 5 update semantics work, not as a falsifiable hypothesis.

---

## H4.3 — Train/Serve Skew Accounts for >30% of Retrieval Failures

Status: CUT / REFRAME
Reason: The 30% number is fabricated — there is no prior literature or pilot data to justify this specific threshold as a prior. Running an experiment to confirm or deny a made-up number is not science.
Date: 2026-05-01
Action: Recast as a measurement study. Instrument a representative two-store deployment (a system with a separate training corpus and serving index), count skew-attributable failures empirically, and report what is found with no a priori threshold. The measurement study result will determine whether a hypothesis with a justified threshold is worth constructing. Not currently in the active queue; will be added to Area 4 as an exploratory measurement task once a two-store comparison deployment exists.

---

## H6.1 — GPU ANN Achieves >10x Speedup Over CPU HNSW at 10M+ Blocks

Status: DEMOTED → cite
Reason: Already established in the cuVS / FAISS-GPU literature. Re-benchmarking a known result as a Nexum finding wastes compute and dilutes the contribution.
Date: 2026-05-01
Action: Cite published numbers (cuVS/RAFT and FAISS-GPU papers) in the Area 6 sizing memo. The Nexum-specific question — whether GPU ANN can be kept in sync with the live Postgres block table — is a real engineering question tracked under Area 5 / Area 6 engineering work, not as a standalone hypothesis.

---

## H7.4 (old) — GGUF Export Pipeline Completes in Under 4 Hours

Status: DEMOTED → KPI
Reason: Engineering timing target, not a falsifiable hypothesis. "Export takes < 4 hours" is a performance requirement; it does not make a claim about the world that experiments can falsify. Belongs in the product engineering spec, not the research plan.
Date: 2026-05-01
Action: Moved to product engineering KPIs. The new H7.4 (staleness curve — measuring how frozen ONNX artifact accuracy degrades as a function of corpus update rate and time-since-export) is a genuine hypothesis and remains active in the queue.

---

## H1.3 — Embedding Storage Dominates Total DB Size at 1536 Dimensions

Status: DEMOTED → measurement
Reason: This is arithmetic, not an experiment. For any fixed block count and embedding dimension, the storage breakdown is calculable from first principles (blocks × dimension × bytes-per-float × replication factor). Running an experiment to confirm arithmetic is not a productive use of compute.
Date: 2026-05-01
Action: Compute once and document in a sizing memo (`docs/research/fixtures.md`). Use the result to motivate quantization work (embedding dimension ablation in Area 1) and to inform storage cost estimates in the compute budget template. The sizing memo calculation: at 1536 dimensions and float32, one block embedding is 6,144 bytes; at 1M blocks, embedding storage alone is ~6GB before replication, which for a typical ratio of block metadata to embedding size (block text + metadata ≈ 1–2KB) confirms embeddings dominate. Document this and move on.
