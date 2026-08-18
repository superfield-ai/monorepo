# Agent prompt: Superfield user-facing workproduct format research

## Mission

Research and produce a **text report with a single recommendation** for how
Superfield should produce user-facing synthetic workproducts — the documents,
reports, briefs, specs, and other generated artifacts that Superfield's agents
render for human consumption. The decision under study is the **default
production/rendering format**, given that the storage and agent-interface
layer is already Markdown-aligned.

The report is a decision document, not a survey. It must land on one
recommendation with explicit decision drivers, a fallback position, and
revisit triggers. Do not deliver a menu of options for a human to choose from.

## Framing (given, not up for debate)

1. **Markdown is the storage and interchange layer.** Knowledgebases, agent
   skills, Obsidian-class tools, and the broader agent ecosystem have
   standardized on `.md` as the source-of-truth and agent-interface format.
   Superfield stays compatible with this. The question is NOT "md vs X."
2. **The question is the projection layer**: when agents render a workproduct
   for a human (or for the human's downstream tools), what should the default
   output format be? The two lead candidates:
   - **(a) Open-document XML** — ODF (`.odt`/`.ods`, zipped XML) and/or OOXML
     (`.docx`/`.xlsx`). Native to office suites, e-signature flows, and
     "send it to my accountant" workflows.
   - **(b) HTML** — self-contained rich pages, allowing interactive
     interfaces, embedded data viz, and direct rendering in Studio and the
     delivered webapps.
     You may evaluate secondary candidates (PDF as a terminal/archival render,
     Typst/LaTeX pipelines, md-with-render-pipeline as a "neither" position),
     but only if they materially change the recommendation.

3. **Be forward-looking.** Weight the evaluation by where things are going
   over roughly the next 3–7 years, not the present installed base:
   - What will the target user's preferred productivity surfaces be? (Office
     suite persistence vs. AI-native canvases/artifacts vs. chat-embedded
     documents; browser as the universal renderer.)
   - How will AI inference capability change the calculus? (Model fidelity at
     generating each format directly; token cost of verbose XML vs. HTML vs.
     md; models as on-demand format converters making the "default" choice
     cheaper to change later.)
   - How will document-management and agent tooling evolve? (MCP-connected
     stores, md-first knowledgebases, HTML artifact viewers, structured-doc
     diffing.)
   - Any other bottlenecks you identify: round-trip editability (human edits
     the workproduct — can it re-enter the brain?), rendering fidelity,
     git-diffability, e-signature/compliance/archival requirements,
     accessibility, offline/air-gapped rendering.

## Product context (Superfield)

Read these repo docs FIRST — they are canonical and constrain the answer:

- `docs/prd.md` — canonical PRD. Note §8: Superfield is explicitly NOT a
  reporting/analytics platform; "synthesis in service of execution is in
  scope; reporting and metrics unrelated to the development loop are not."
  Note §9: continuous export/exit continuity (git tree + portable schema) is
  a hard guarantee. Any workproduct format choice must respect both.
- `docs/architecture.md` — the appliance. Note the `/pages/*` routes: the
  brain already projects knowledge-base content **as markdown** over HTTP.
- `docs/technical-requirements.md` — capability derivation; "gap surfacing"
  is the closest existing thing to a synthesized user-facing artifact.
- `docs/vision/unified-memory-layer.md` — product thesis; "the schema is the
  product," synthesized view must drive work.
- `docs/rust-reorg-decisions.md` — contains the only explicit format decision
  to date: PDF/DOCX parsers are out of core, moved to the app
  template/framework layer (see also `docs/control-template-integration.md`).
- `blueprint/docs/technical/ux-governance.md` — existing format policy for
  internal UX artifacts: HTML preferred for interactive validation, SVG for
  static export, markdown as derived companion, "do not duplicate truth
  across formats."

Key product facts to hold constant:

- **Customer**: companies past ~$10M revenue with **no full-time engineers**;
  the buyer/operator is a sysadmin-grade CIO/CTO/COO. Workproduct consumers
  include non-technical executives, and downstream parties (accountants,
  auditors, regulators, partners) who live in office suites and email.
- **Delivery**: an on-prem appliance ("Forge"), sold MSP/VAR-first. Exactly
  two user surfaces per delivered app, behind one sign-on: the **running
  webapp** and the **Studio** control panel. There is no Superfield cloud —
  **sovereignty is the moat**. Any rendering pipeline must run fully
  self-hosted, ideally air-gap-capable; no cloud converter services.
- **Approval model**: humans steer at the outcome level (behavior against
  representative data), never code diffs. Workproducts are part of how
  non-engineers see and approve what the system did.

## Terminology caveats (avoid these traps)

- In this repo, **"projection"** already means (a) Sharp's speculative-merge
  projection (`crates/sharp/docs/projections.md`) and (b) the brain's
  markdown pages projection. **"Export"** means estate portability (git tree
  - portable schema), not document export. Your report must not overload
    these terms — pick a distinct term for rendered workproducts (e.g.
    "renders," "workproduct projections") and define it once.
- There is **no existing ADR** on user-facing output formats. Your report is
  the input to that ADR; structure the recommendation so it can be lifted
  into one.

## Research method

1. Read the repo docs above (paths relative to the monorepo root).
2. Web research, with sources cited inline. Cover at minimum:
   - Format trajectory: ODF/OOXML standardization health, browser/office-suite
     convergence, HTML as document format (self-contained pages, EPUB, web
     bundles), PDF's role, and md-render toolchains (Pandoc, Typst).
   - AI-native document surfaces: chat artifacts/canvases (Anthropic, OpenAI,
     Google), agent-generated docs in office suites (Copilot in Word,
     Gemini in Docs), and what formats those pipelines emit natively.
   - Model fidelity and cost per format: how reliably current frontier models
     emit valid OOXML/ODF vs HTML vs md; token-cost asymmetry; the
     library-assisted path (model emits structured intermediate → library
     renders docx/html) vs direct generation.
   - Ecosystem signals: MCP and agent-tool standards around documents;
     md-first knowledgebase growth; enterprise document-management direction.
   - Round-trip: what happens when the human edits the rendered artifact in
     Word/LibreOffice/browser — which formats can re-enter an md-canonical
     store with least loss.
3. Weigh evidence against the evaluation criteria below. Where evidence is
   thin or genuinely contested, say so explicitly rather than smoothing it
   over.

## Evaluation criteria (score both lead candidates against all of these)

1. **Forward trajectory of user surfaces** (3–7 yr): where will Superfield's
   ICP actually open and share documents?
2. **AI generation fidelity & cost**: can agents produce it reliably today,
   and does the trend make that better or irrelevant (converters)?
3. **Sovereignty fit**: fully self-hosted render pipeline, no cloud calls,
   air-gap capable, open-spec longevity (exit continuity for workproducts,
   mirroring PRD §9).
4. **Round-trip editability**: human edits re-entering the md-canonical brain.
5. **Rich-interface ceiling**: interactivity, embedded viz, live data —
   relevant because Studio and the delivered webapps are HTML surfaces.
6. **Downstream interop**: email attachments, e-signature, auditors,
   regulators, print.
7. **Operational cost**: rendering toolchain footprint on the appliance,
   maintenance burden, template-layer fit (per the existing decision that
   PDF/DOCX machinery lives in the template/framework layer, not core).
8. **Reversibility**: cost of switching the default later if the bet is
   wrong.

## Deliverable

A single text report (markdown), ~2,500–4,500 words, structured as:

1. **Recommendation** (first, one paragraph): the default production format,
   stated unambiguously, including whether it is one default or a two-tier
   rule (e.g. "HTML default, ODF/OOXML on demand at the template layer").
2. **Decision drivers**: the 3–5 findings that actually determine the answer,
   each with evidence.
3. **Forward-looking analysis**: the trajectory arguments (surfaces, AI
   capability, tooling), with cited sources and explicit confidence levels.
4. **Architecture sketch**: how the choice maps onto Superfield's layers —
   md-canonical brain → render pipeline → surface; what lives in core vs the
   template/framework layer; how round-trip works.
5. **Rejected alternatives**: why the other lead candidate (and any secondary
   candidates) lost, stated fairly.
6. **Risks and revisit triggers**: concrete observable events that should
   reopen the decision (e.g. "frontier models emit valid OOXML at >99%
   first-pass rates," "ICP survey shows >X% of approvals happen in Office").
7. **Suggested ADR skeleton**: title, decision statement, consequences — ready
   to lift into `docs/adr-workproduct-formats.md`.

Cite every external claim. Distinguish observed fact, sourced projection, and
your own judgment. If during research you find the framing itself is wrong
(e.g. the md-canonical + projection split is unstable), say so in a clearly
marked section — but still deliver the recommendation under the given framing.
