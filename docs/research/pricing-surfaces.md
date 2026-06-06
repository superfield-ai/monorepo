# Nexum — Pricing Surfaces

Maps confirmed hypotheses to product invoice lines. Each pricing surface represents a billing axis that becomes defensible once the listed hypotheses are confirmed. A hypothesis that fails triggers a review of the pricing surface it unlocks — the billing axis may need to change or be dropped.

Format: billing axis, hypotheses that unlock it, rationale for the billing unit, and the buyer question that validates willingness to pay.

---

## Blocks Ingested (Storage Tier)

Billing axis: blocks/month ingested (cumulative live block count)

Unlocked by: H1.1, H5.1, H5.4, H5.x generally

Pricing rationale: The block is Nexum's fundamental unit of value — it is the granularity at which provenance, retrieval, and training signal operate. Billing on blocks ingested aligns cost with corpus size, which is the primary driver of storage, embedding compute, and HNSW index maintenance. H1.1 confirms the storage architecture scales to the target corpus sizes; H5.1 confirms insertion-to-retrieval latency is bounded; H5.4 confirms selective re-embedding on content-hash change (so re-ingesting a slightly edited block does not double-count). Without H1.1, the block ceiling is unknown and the pricing surface is unquotable.

Buyer question: "How much does it cost to ingest our 500,000-document contract archive, and what does the price look like as we add new documents each month?"

Tiers (indicative, subject to H1.1 benchmark results):
- Starter: up to 1M blocks/month
- Professional: 1M–20M blocks/month (confirmed scalable by H1.1)
- Enterprise: 20M–100M blocks/month (requires full Area 1 scale benchmark)
- Custom: > 100M blocks (requires Kuzu/Neptune migration if G1 fails at this scale)

---

## Queries per Month (Retrieval Tier)

Billing axis: queries/month (semantic + full-text + graph traversal combined)

Unlocked by: H3.2, H4.4

Pricing rationale: Query volume is the primary driver of inference cost — embedding compute, HNSW traversal, LLM generation tokens. H3.2 confirms the latency floor is bounded (20–50x vs. static model with cache), making the per-query cost predictable enough to set a price. H4.4 confirms that graph-resident retrieval produces measurably better attribution than vanilla RAG, which justifies a premium over commodity retrieval APIs. Without H3.2, latency uncertainty prevents reliable cost modeling; without H4.4, there is no differentiation from cheaper commodity RAG APIs.

Buyer question: "We run about 10,000 document searches per day across our legal team. What does that cost, and is there a volume discount?"

Tiers (indicative, subject to H3.2 latency benchmark):
- Starter: up to 100K queries/month
- Professional: 100K–1M queries/month
- Enterprise: 1M–10M queries/month
- Real-time tier: includes H5.1/H5.2 freshness guarantee (insertion-to-retrieval < 500ms); priced above base retrieval tier

---

## Audit-Grade Attribution (Premium Tier)

Billing axis: audit-grade tier (flat monthly seat license per reviewer, or per-attribution-event)

Unlocked by: H4.4, G2

Pricing rationale: Audit-grade attribution — the ability to trace every generated answer back to the exact source blocks, with < 5% false attribution rate — is the core commercial differentiator for legal, medical, and regulated-industry buyers. This is structurally impossible for dense transformer weights; it is a property of the Nexum architecture. G2 (wedge demo) confirms that design partners find this valuable enough to engage; H4.4 quantifies the attribution accuracy claim at < 5% false attribution rate. The billing axis is a seat license or per-attribution-event because the value is consumed by reviewers (lawyers, compliance officers, clinicians) who verify the attribution chain — not by the volume of documents ingested or queries run.

Buyer question: "We need to be able to show regulators exactly which source document and clause was used to generate each compliance determination. Can your system produce that audit trail, and what does it cost?"

Tier contents:
- Attribution chain export (block-level provenance per answer, machine-readable)
- Attribution F1 certification per corpus (run on partner's held-out QA set; certify < 5% false attribution rate for that corpus)
- Human reviewer interface (highlight source blocks in source documents)
- Requires: G2 confirmed; H4.4 experiment run on partner corpus

---

## Frozen Snapshot Export (Air-Gap Tier)

Billing axis: per-export event (one-time fee per frozen artifact generated) plus optional annual support subscription

Unlocked by: H7.3, H7.5

Pricing rationale: The frozen ONNX export is a one-time serialization of the live graph model — same parameters, same computation graph, no distillation loss (per H7.3). It enables deployment in environments where live graph traversal is unacceptable: air-gapped networks, latency-sensitive on-device inference, regulatory environments prohibiting external API calls. H7.5 confirms the efficiency gain (≥ 10x throughput over live graph traversal), which is the primary value proposition — it is not just a compliance feature but a performance feature. Billing per-export aligns cost with the event that produces value; the support subscription covers re-export cadence guidance (informed by H7.4 staleness curve).

Buyer question: "We cannot send our documents to an external server. Can we run your model locally, on our own hardware, disconnected from the internet? What does that cost, and how often do we need to refresh it?"

Tier contents:
- ONNX artifact export (full graph model: block embedding matrix + link weight tensor + sparse adjacency tensor + message-passing computation graph)
- Re-export cadence recommendation (based on H7.4 staleness curve for the customer's corpus update rate)
- ONNX Runtime integration support
- Throughput benchmark on customer hardware (validate H7.5 ≥ 10x claim holds on their SKU)
- Requires: G4 confirmed (losslessness); H7.5 experiment completed

---

## Training Curriculum Export (ML Tier)

Billing axis: GPU-hours consumed (metered on Nexum infrastructure) or flat license for self-hosted curriculum export

Unlocked by: H2.1

Pricing rationale: If H2.1 is confirmed — contrastive pairs from `contradicts` and `supports` links produce better domain fine-tunes than randomly sampled pairs — then the Nexum typed-link graph is a curriculum generation engine. Organizations with their own ML infrastructure can license the curriculum export: a stream of (anchor, positive, negative) training pairs derived from the typed link graph, formatted for use with standard fine-tuning frameworks (HuggingFace Trainer, Axolotl, OpenAI fine-tuning API). GPU-hours is the natural billing axis for customers running curriculum generation on Nexum infrastructure; flat license applies for self-hosted export. This pricing surface is conditional on H2.1 — if typed-link contrastive pairs do not improve over random sampling, the curriculum export has no differentiated value.

Buyer question: "We want to fine-tune our own model on our legal corpus. Can your system generate training data from the relationships between our documents — not just the text itself?"

Tier contents:
- Curriculum export pipeline (typed-link contrastive pair generation from the customer's Nexum corpus)
- Export formats: HuggingFace datasets, JSONL (OpenAI fine-tuning format), Axolotl-compatible
- Curriculum quality report (link confidence distribution, pair count by link type, diversity metrics)
- Optional: Nexum-managed fine-tuning run (GPU-hours metered separately)
- Requires: H2.1 confirmed; G0 does not need to be confirmed (curriculum export works regardless of whether the graph is differentiable)

---

## Notes on Hypothesis-Pricing Surface Dependencies

If a hypothesis fails, the following pricing surfaces are affected:

| Hypothesis fails | Pricing surface impact |
|---|---|
| H1.1 fails | Blocks ingested tier has no confirmed ceiling; must quote per-deployment-sizing-study until G1 is resolved |
| H4.4 fails | Audit-grade attribution tier is not credible; fold into base retrieval tier |
| G2 fails | Audit-grade attribution tier is shelved; program narrows to systems research; pricing is commodity storage + retrieval only |
| H7.3 fails | Frozen snapshot export requires distillation; per-export price rises (distillation is more compute-intensive); "lossless" marketing claim is dropped |
| H7.5 fails | Frozen snapshot export value proposition weakens (if ONNX Runtime is not ≥ 10x faster, air-gap deployment is less compelling); re-evaluate billing axis |
| H2.1 fails | Training curriculum export tier is dropped; no differentiated curriculum value |
