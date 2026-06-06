# Research Plan Review — 2026-04-27

Reviewer perspective: a technical co-founder who also runs an AI lab. The plan is judged on two axes simultaneously — **does the science hold up**, and **does the work move the product forward**. Both bars matter; satisfying only one is a failure mode.

The plan under review is `docs/research.md` (Areas 1–7, ~50 hypotheses, hypothesis files in `docs/research/hypotheses/`).

---

## 1. Summary judgment

The plan is coherent at the engineering level and overreaching at the thesis level. Several areas are genuinely strong (1, 2, 5, 6); several are rhetorically inflated (3, 4, 7); a meaningful fraction of "hypotheses" are arithmetic, tautologies, or settled literature. The strongest ideas — typed-link contrastive curricula, block-level provenance, real-time ingest semantics, GPU hot-shard paging — are also the most commercial. They are currently buried under a thesis ("a graph replaces ONNX/GGUF weight files as a live inference substrate") that will not survive scrutiny from either a program committee or a technical buyer.

Net call: keep the program, reframe the thesis, cut roughly a third of the hypotheses, add the missing methodological scaffolding, and tie every remaining area to a design-partner-visible artifact.

---

## 2. What's strong

**Scientifically:**
- Areas 1, 5, 6 are well-formed systems research. Hypotheses H1.1, H5.1, H5.4, H6.5, H6.6 have clean baselines, measurable thresholds, modest compute, and produce useful artifacts even on null results.
- Area 2 (typed-link curricula) is the most novel contribution. H2.1–H2.4 propose a plausible mechanism — `contradicts`/`supports` edges as contrastive signal — that is genuinely under-explored.
- Hypothesis files follow a disciplined structure (claim, operationalization, null, acceptance criterion). Better than most prospectuses.
- The recursion of storing the research process inside the corpus it studies gives a built-in evaluation testbed.

**Commercially:**
- Block-level provenance (H4.4) is the single most sellable hypothesis in the document. Legal and medical buyers will pay for traceable answers.
- Area 5 (live ingest) is directly product-shaped: "we ingest your 500-page contract and answer questions about it within 60 seconds, with provenance" is a demoable claim.
- GPU hot-shard / Zipfian access (H6.5, H6.6) is the right kind of optimization research — it only matters once a customer is big enough to need it, and the answer drives unit economics at that scale.

---

## 3. What needs to be pushed back on

### 3.1 The core thesis is doing rhetorical work the hypotheses don't cash out

The thesis claims the graph **replaces** static weight files (ONNX/GGUF/safetensors). H3.3 quietly reveals the actual system: a transformer with sparse cross-attention over ANN-retrieved blocks. That is RAG. Weights are not being replaced; they are being augmented.

This is the difference between an interesting engineering program (high-quality typed-link RAG with provenance) and a fantastical one (a graph that *is* the model). The plan oscillates between them. Either deflate the framing to what you are actually building, or commit to a precise mechanism for how parametric knowledge is dispensed with — which is a five-year program, not a side claim. No customer is asking for the latter; no reviewer will accept it as written.

### 3.2 "Isomorphism" is overloaded

Using one Postgres database for training data, retrieval index, and inference context is **colocation**, not isomorphism. The mathematical term implies a structure-preserving correspondence not established here. H4.3 ("> 30% of retrieval failures come from train/serve skew") is a fabricated number presented as a hypothesis. Recast it as a measurement study or drop it. The actual underlying claim — "one store reduces sync bugs" — is true and boring; demote it to an architectural footnote.

### 3.3 Several "hypotheses" are not hypotheses

- **H1.3** (embedding storage > 70% at 1536-dim): arithmetic. Compute it once.
- **H3.4** (insert propagates to inference within one cycle): tautology — that is the definition of a coherent read-after-write.
- **H6.1** (GPU ANN > 10× CPU HNSW at 10M+ blocks): already established in the cuVS/FAISS literature. Cite it; do not re-benchmark it as a finding.

### 3.4 H3.1 has a methodological hole

"Graph-resident client beats stale fine-tuned model on recent-fact Q&A" is almost guaranteed to win — that is what RAG exists to do. The fair baseline is **RAG over a stale snapshot**, not a fine-tuned model. As written, the experiment measures "retrieval beats parametric memory on recency," which has been settled since 2021 and is operationalized by FreshQA.

### 3.5 The agent-loop / UCB protocol is suspect

Bandit selection over hypotheses presumes commensurable reward signal. Recall@10, fine-tune accuracy delta, and tokens/sec are not on the same scale, and the "expected value" of an untested hypothesis is a made-up prior. UCB will systematically chase whichever area has the noisiest evals. Replace with a curated priority queue with explicit kill criteria, or define a normalization scheme and defend it.

### 3.6 Risk concentration

Area 7 (frozen export) depends on Area 2 (curriculum) producing a non-trivial signal. If H2.1–H2.4 come back lukewarm, Area 7's distillation pipeline has nothing distinctive to distill — it collapses to standard fine-tuning. The dependency graph hides this single point of failure.

### 3.7 Missing methodological scaffolding

- **Statistical plans.** No n, no power analysis, no confidence intervals anywhere. Acceptance thresholds like "> 20% improvement" without sample-size reasoning are cherry-picking magnets.
- **Prior-art baselines.** No mention of LlamaIndex, Vespa, ColBERT, RAPTOR, GraphRAG, MemGPT. Each overlaps part of Areas 2–4. Without these, novelty cannot be evaluated and buy-vs-build decisions cannot be made.
- **Standard evals.** BEIR, MTEB, LegalBench, MIRAGE (medical), FreshQA, MultiHop-RAG. The plan keeps gesturing at "a legal corpus, e.g., 10K contracts" without naming CUAD, LEDGAR, or an in-house equivalent.
- **Null-result plan.** Under what evidence is the inference-substrate thesis abandoned? Without that, the program cannot terminate.
- **Compute budget.** Distillation + GGUF export + 2-week staleness sweeps + 10M-block GPU benchmarks is non-trivial. No estimate.

### 3.8 Missing product scaffolding

- **Design partners.** None named. Every hypothesis should declare which customer conversation it unblocks. If it unblocks none, it is a hobby.
- **Time-to-signal.** Most experiments are full studies. Each area needs a smallest-experiment-that-tells-us-whether-to-keep-going — days, not months. Replace open-ended studies with kill-criteria spikes.
- **Buy-vs-build calls.** The plan never asks where the off-the-shelf is good enough and where Nexum has to build. That decision is the actual roadmap.
- **A demo per area.** Research that cannot become a five-minute demo does not become a product. If you cannot picture the demo, the area is not ready.
- **A pricing story.** Block-level provenance, version dedup, real-time ingest are natural pricing surfaces (blocks/month, queries/month, audit-grade tier). Research outputs are never tied to what shows up on an invoice.
- **Buyer's bar evals.** A legal customer does not care about BEIR; they care about "did it find every clause that mentions indemnification." Build three to five institution-shaped eval sets early, before tuning anything.

---

## 4. Hypothesis-by-hypothesis triage

Disposition codes: **KEEP** (well-formed, run as planned), **TIGHTEN** (real hypothesis, needs better baseline / spec), **DEMOTE** (not a research finding — compute or cite), **CUT** (unfalsifiable, settled, or off-mission), **REFRAME** (good underlying idea, wrong framing).

| ID | Disposition | Reason |
|---|---|---|
| H1.1 | KEEP | Clean systems hypothesis, easy kill criterion. |
| H1.2 | TIGHTEN | Define "cross-type query" and the eval set; specify what "degrades embedding quality" means quantitatively. |
| H1.3 | DEMOTE | Arithmetic — compute and document, do not "test." |
| H2.1 | KEEP | Most novel hypothesis in the plan. Add a RAG-only baseline. |
| H2.2 | KEEP | Tighten with a power analysis on perplexity deltas. |
| H2.3 | TIGHTEN | "Reasoning vs. retrieval" needs a concrete task split, not adjectives. |
| H2.4 | TIGHTEN | "Version-delta test set" needs to be constructed and named before this is runnable. |
| H3.1 | TIGHTEN | Replace baseline with stale-snapshot RAG, not stale fine-tune. Cite FreshQA. |
| H3.2 | KEEP | Well-scoped engineering claim. |
| H3.3 | TIGHTEN | BLEU/ROUGE on summarization is weak signal in 2026. Use a current-gen rubric or LM-as-judge with calibration. |
| H3.4 | CUT | Tautology dressed as an experiment. |
| H4.1 | TIGHTEN | "More auditable" needs an operational definition (attribution F1, expert agreement). |
| H4.2 | KEEP | Compositional reasoning vs. hop count is a real, testable claim. |
| H4.3 | CUT or REFRAME | The 30% number is fabricated. Recast as a measurement study with no a priori threshold. |
| H4.4 | KEEP | Highest-value hypothesis commercially. Lead with this. |
| H5.1 | KEEP | Textbook systems hypothesis. |
| H5.2 | KEEP | Important for the live-ingest demo. |
| H5.3 | KEEP | Tie acceptance criterion to a real document distribution, not an arbitrary 500 pages. |
| H5.4 | KEEP | Cleanest hypothesis in the document. |
| H5.5 | KEEP | Pairs naturally with H5.1. |
| H6.1 | DEMOTE | Settled in cuVS/FAISS literature; cite, do not re-benchmark. |
| H6.2 | TIGHTEN | Tie to a specific embedding model and hardware SKU. |
| H6.3 | KEEP | Architecturally important; the answer changes the deployment story. |
| H6.4 | KEEP | Standard but worth measuring on Nexum's actual workload. |
| H6.5 | KEEP | Most interesting GPU hypothesis. |
| H6.6 | KEEP | Empirical and decision-relevant. |
| H7.1 | TIGHTEN | Aggressive; needs a real student model and a named benchmark. |
| H7.2 | KEEP | The one genuinely novel idea in Area 7 — graph-conditioned attention biases during distillation. |
| H7.3 | TIGHTEN | The functional form ("super-linear above 1k blocks/day") is asserted, not derived. Drop the form, measure the curve. |
| H7.4 | DEMOTE | Engineering timing target, not a hypothesis. Track as a roadmap KPI. |
| H7.5 | TIGHTEN | Fine as an engineering bake-off, not a research finding. |

Net effect: roughly a third of the hypothesis list compresses into measurements, citations, or KPIs. The remainder is sharper.

---

## 5. Reframe: what Nexum is actually building

Replace the current thesis with this:

> Nexum is a typed-link retrieval substrate over a Postgres-native block graph, with three differentiating properties: (1) block-level provenance for auditable answers, (2) real-time ingest with version-atomic visibility, and (3) typed link structure that doubles as a contrastive training signal for domain fine-tunes. The same store optionally feeds a frozen-snapshot deployment path for latency-sensitive or air-gapped environments.

This is honest, novel where it matters, sellable, and falsifiable. It also preserves every research direction worth keeping. Drop "isomorphism," drop "replaces ONNX/GGUF," drop "live inference substrate." None of those phrases survive contact with either a reviewer or a technical buyer.

---

## 6. Remediation plan

Six concrete steps, sequenced. Each step has an owner-checkable deliverable.

### Step 1 — Rewrite the thesis and mission (1–2 days)
- **Action:** Replace the "Mission" and "Core Thesis" sections of `docs/research.md` with the reframe in §5. Remove the words "isomorphism," "replaces," "static weight file," and "live inference substrate" from headers and hypothesis claims.
- **Deliverable:** Updated `docs/research.md` thesis section. Existing hypothesis files updated to remove inflated framing.
- **Kill criterion:** None — this is a writing task.

### Step 2 — Triage hypotheses per §4 (2–3 days)
- **Action:** Apply the table in §4. For DEMOTE and CUT items, move content into a new `docs/research/cut.md` with a one-line reason for each (so the reasoning is auditable). For TIGHTEN items, edit the hypothesis files to incorporate the specific fix noted.
- **Deliverable:** `docs/research/hypotheses/` reduced to KEEP + TIGHTEN entries; `docs/research/cut.md` documents what was cut and why.
- **Kill criterion:** If TIGHTEN edits cannot make a hypothesis falsifiable in under one page, it joins CUT.

### Step 3 — Add methodological scaffolding (1 week)
- **Action:** Create `docs/research/methodology.md` covering: standard evals adopted (BEIR, MTEB, FreshQA, LegalBench, MIRAGE, MultiHop-RAG, plus 3–5 institution-shaped sets to be built), statistical plan template (n, power, CI policy), prior-art baseline list (LlamaIndex, Vespa, ColBERT, RAPTOR, GraphRAG, MemGPT) and which hypothesis each baselines, compute-budget template, and a null-result protocol.
- **Deliverable:** `methodology.md` plus a per-hypothesis `baselines:` and `compute_budget:` field added to the frontmatter schema.
- **Kill criterion:** Any hypothesis without a named baseline and compute estimate after this step is not runnable.

### Step 4 — Add product scaffolding (1 week, parallel with Step 3)
- **Action:** For every KEEP / TIGHTEN hypothesis, add three frontmatter fields: `design_partner_question` (which customer conversation does this unblock), `demo` (the five-minute demo it produces), `kill_criterion_spike` (the smallest experiment that decides keep-or-drop, in days). Create `docs/research/pricing-surfaces.md` mapping hypothesis outputs to invoice lines.
- **Deliverable:** Updated hypothesis files; new `pricing-surfaces.md`.
- **Kill criterion:** Any hypothesis whose `design_partner_question` is empty after this step is reclassified as exploratory and not staffed until a partner asks.

### Step 5 — Replace UCB with a curated queue (2 days)
- **Action:** Rewrite the "Agent Loop Protocol" section. Replace UCB with a manually maintained priority queue scored by (commercial value × scientific novelty × tractability) / (compute cost × time to signal), reviewed weekly. The autonomous-research loop reads from this queue rather than computing UCB.
- **Deliverable:** Updated `docs/research.md` §"Agent Loop Protocol"; updated `researcher` skill if it consumes the protocol.
- **Kill criterion:** None.

### Step 6 — Land the wedge demo (4–6 weeks)
- **Action:** Build the smallest end-to-end demo combining H4.4 (provenance) + a slice of H2.1 (typed-link contrastive signal) + H5.1/H5.2 (real-time ingest). One legal or medical corpus, one design partner, one demo script. Everything else in the plan waits.
- **Deliverable:** A recorded demo, a written eval against a vanilla-RAG baseline on the partner's questions, and a go/no-go memo on the rest of the program.
- **Kill criterion:** If the demo does not produce visibly better answers than vanilla RAG, and two design partners do not engage on it within four weeks, the program reverts to a pure systems-research project (Areas 1, 5, 6 only) and the inference / curriculum / export thread is shelved until a customer pulls.

After Step 6, reassess sequencing for Areas 2 (depth), 6 (when scale demands), and 7 (only if a partner asks).

---

## 7. What success looks like in 6 months

If remediation lands:

- A reframed `research.md` that a program committee would not laugh at and a buyer would not be confused by.
- Roughly two-thirds of the original hypothesis count, each tied to a baseline, a budget, a customer question, and a demo.
- One shipped wedge demo on a real partner corpus, with provenance and real-time ingest as the visible differentiators.
- A clear, defensible answer to "what is Nexum that LlamaIndex / GraphRAG / Vespa is not."
- A written null-result protocol so the program can end honestly if the wedge does not land.

If remediation does not land, the predictable failure mode is twelve months of interesting benchmarks with no customer and no paper, because the thesis was too grand to falsify and too vague to sell.
