# Red-Team Concept Review — Superfield

**Date:** 2026-07-02
**Type:** Adversarial review of concept, reasoning, and document coherence (not a line-level code review)
**Status:** Findings report — no fixes applied

## What was reviewed, and how

This review subjected the Superfield document corpus — `docs/prd.md`,
`docs/vision/unified-memory-layer.md`, `docs/technical-requirements.md`,
`docs/architecture.md`, `docs/milestone-1.md`, `docs/eval-design.md`,
`docs/testing.md`, `docs/testing-invariants.md`, `docs/rust-reorg-decisions.md`,
`docs/runtime-agent-selection.md`, `docs/ux/studio-ux.md`, both accepted ADRs
(`adr-schema-boundary.md`, `adr-embedding-model.md`,
`adr-ci-execution-manifest.md`), the README, and the operational artifacts they
cite (`install.sh`, `docker-compose*.yml`, migration trees) — to four
independent adversarial lenses, each run by a separate reviewer:

1. **Concept and market thesis** — does the idea survive contact with its own
   premises, its buyer, and its competitors?
2. **Architecture vs. concept coherence** — does the designed and shipped
   system actually implement the concept the documents claim?
3. **Cross-document coherence and drift** — do the canonical documents agree
   with each other, and are retired decisions marked as retired?
4. **Operational reality vs. the appliance claim** — could the stated customer
   actually install, run, secure, back up, and recover this thing today?

The four raw findings sets (59 findings total) were then deduplicated and
synthesized into this single document: 39 consolidated findings — 11 critical,
21 major, 7 minor — plus a consolidated strengths assessment and an
improvement roadmap.

## Product-owner framing (the premise this review grades against)

Superfield's users are **organizations that previously had no engineering
organization** but can now deploy bespoke software in the post-human software
development era. The product is built for the day **frontier models produce
1000 tokens/second and dark factories** — fully autonomous software factories —
**are real.** Every finding below is weighted against that premise: a gap that
is tolerable for an engineering team steering an AI tool may be disqualifying
for a customer with no engineers and an agent workforce running at machine
speed.

---

# Addendum (2026-07-02): ICP resolution and re-grading

After this review was issued, the founder resolved its central open question —
who the customer actually is. Official ICP (2026-07-02), verbatim:

> The customer is any company with more than $10M annual revenue that does not
> hire full-time engineers — a skeletal technical staff, possibly with a
> technical lead under whatever title (CIO, CTO, COO).

**The new operational bar.** This decision replaces both poles the review
graded between. The appliance is neither a zero-touch consumer device nor a
tool for a diff-reading engineer: it must be **administrable by a
sysadmin-generalist** — the person who runs the company firewall and the
Microsoft 365 tenant. The comparable product category is the **on-prem
NAS/firewall appliance**: installed from a signed artifact, administered
through a web console, recovered through buttons, never through a compiler or
a config-file edit. Findings below are re-graded against that bar.

**Re-grading of affected findings.**

| Finding | Old status | New status | Why |
|---------|-----------|------------|-----|
| R-01 | OPEN (critical) | Largely **RESOLVED** → concrete remediation | The two-products ambiguity is settled by the ICP. What remains is the rewrite it implies: prd.md §2-3's "large enterprise," "office of the CTIO," and "Steerer (Product/Engineering lead)" (prd.md:49-51) describe the wrong company and must be rewritten to the mid-market ICP. |
| R-02 | OPEN (critical) | **SHARPENED** | One part-time technical lead (the CIO/CTO/COO-titled generalist) is now the *entire* approval queue. Outcome-level review, batching, and risk budgets are promoted from recommendation to core-UX requirement. |
| R-05 | OPEN (critical) | **STANDS**, remediation target clarified | Bar moves from "zero-touch" to "IT-admin grade": a signed installer a sysadmin-generalist can run is sufficient. Cargo builds and toolchain constellations remain disqualifying. |
| R-06 | OPEN (critical) | **STANDS**, remediation target clarified | Studio-based credential setup, restore, and rollback at IT-admin grade is sufficient; `postgresql.conf` edits, `cargo run` recovery steps, and raw-JSON CLI invocations remain disqualifying. |
| R-23, R-24 | OPEN (major) | **STAND**, remediation target clarified | Same bar shift as R-05/R-06: backup, restore, and upgrade must be Studio-driven and IT-admin operable — GCS provisioning and `curl \| bash` re-runs remain disqualifying. |
| R-08, R-15 | OPEN | **SHARPENED / CLARIFIED** | The buyer is now named: the CIO/COO, spending from the existing IT/automation budget line. The real competitive set is vertical SaaS, Power-Platform consultants, MSPs, and a contractor wielding a frontier agent. The defensibility and commercial-thesis documents can now be written against a concrete buyer. |
| R-14 (data-gravity) | OPEN (major) | **PRIORITY RAISED** | This ICP's truth lives in QuickBooks/NetSuite/Excel/vertical SaaS. The read-connector and freshness/staleness-labeling remediations gain priority: without them the brain is empty of the facts this customer's apps need. |
| All others | OPEN | **UNCHANGED** | Spend ceilings (R-04), fail-open governance (R-03, R-11), security defaults (R-18), defensibility mechanics (R-08's moat analysis), premise timing (R-17), throughput (R-09, R-10, R-19, R-20), and the documentation-drift findings stand as issued. |

The original findings below are preserved as issued; inline notes mark where
this addendum modifies their status. Downstream remediation (the prd.md §2-3
rewrite) is logged in the Remediation log at the end of this document.

---

# Executive summary

Read together, the four reviews converge on seven cross-cutting themes. Each
theme recurs across at least two lenses; several recur across all four.

**1. The product's safety model presumes the engineer the customer does not
have.** The PRD's role model names a "Steerer (Product/Engineering lead)" and
seats the Owner in "the office of the CTIO" (prd.md:49-51); the README demands
"A Rust toolchain… to build the binary" (README.md:38-42); the restore
procedure is an 8-step DBA runbook ending in a `cargo run` command
(architecture.md:392-405); the credential story is a shell `export`
(architecture.md:594-604); and every gate — change review, policy authorship,
rollback — assumes a human who can read a diff and judge deployment risk. The
stated target user can staff none of these roles. The documents describe
engineer-steered autonomy; the pitch describes engineer-free software. These
are two different products (findings R-01, R-05, R-06).

**2. The 1000-tok/s premise is asserted, never designed for.** The primary
human surface is a live cockpit for watching 2-second agent turns and steering
mid-task (studio-ux.md:203-205, prd.md:66) — physically obsolete at the
premise's own speed. The shipped orchestrator is a single-threaded, fixed-order
loop that sleeps 60 seconds per pass (architecture.md:531). The merge gate
spawns rust-analyzer and runs `cargo check` per merge with no latency budget
(architecture.md:329-346). Every above-threshold change routes to an individual
human notification with no batching, budgets, or back-pressure
(architecture.md:227). At today's model speeds none of this hurts; at the
premise's speed the design collapses into a human inbox (R-02, R-09, R-19,
R-20).

**3. Governance is fail-open exactly where the thesis demands fail-closed.**
The "binding" Blueprint gate silently falls back to `BlueprintRules::empty()`
when the rule file is missing — and it *is* missing from a fresh checkout
(architecture.md:622, cross-doc F8). A fresh appliance with no LLM key
"silently degrade[s]" to a fixture executor that gardens placeholder content
while looking alive (architecture.md:590-604). A locked decisions document
mandates `#[ignore]`-based silent-skip tests that the project's own
testing-invariants doc bans by name (rust-reorg-decisions.md:44-45 vs
testing-invariants.md invariant 1). The loop's spend is unmetered despite
budget enforcement being a named requirement (technical-requirements.md:61).
The repo's own creed — "a green CI signal means nobody objected, not the code
ran" — is violated at the product level, four separate ways (R-03, R-04, R-06,
R-11).

**4. The appliance is a claim, not an artifact.** technical-requirements.md:134
concedes the appliance shell — "installer, seed apps, self-upgrade,
self-operation" — is "not yet existing in any form." Day-1 install is
`cargo build --release`; the "single artifact" needs a Rust toolchain,
rust-analyzer, Node, Postgres binaries, Firecracker, and crun on the host
(R-05); backups target a Google Cloud bucket behind a no-op stub with no
scheduler (architecture.md:388-409); the control plane binds `0.0.0.0:7000`
with an unauthenticated endpoint that mints Owner tokens (architecture.md:648,
:667); the upgrade story is re-running `curl | bash`; and zero operator
documentation exists for the PRD's own personas (R-05, R-06, R-23, R-24, R-27,
R-33).

**5. The document corpus fails the product's own thesis.** Superfield exists so
that "an agent [never] reads the stale spec with exactly the same confidence as
the fresh one" (unified-memory-layer.md:5) — yet an unbannered ring of stale
docs (studio-ux.md, runtime-agent-selection.md, testing.md's first half,
rust-reorg-decisions.md, parts of the README and both schema ADRs) still
describes the retired GitHub/TypeScript substrate in the present tense, and
duplicated decisions have drifted: the migration order differs between the
Accepted ADR and architecture.md, the governed embedding model is named two
ways, two schema-table inventories disagree, and "Nexum," "workspace,"
"Studio," and "orchestrator" each mean two to four different things depending
on the document (R-07, R-21, R-26, R-28, R-29, R-32, R-36).

**6. The commercial case is asserted, never argued.** No document contains a
competitor, a price, a named buyer, a unit-economics model, or a defensibility
analysis against the most obvious entrant — the frontier labs themselves, who
own the models, the capital, and the distribution, and for whom Superfield's
claimed moat (isolation, access control, trustworthy validation) is table
stakes. The appliance's per-customer isolation forfeits any cross-customer data
flywheel, and no premise-timing contingency exists for the scenarios where
models arrive late, unreliable, or via the labs' own vertical offerings (R-08,
R-15, R-17).

**7. The evidence machine cannot falsify the thesis.** The Forge-proves-the-
thesis argument is circular (R-12); success metrics are direction-only and
gameable (R-35); Milestone 1 is declared complete while eval-design.md states
its acceptance-criteria machinery is "unused and non-gating"; and the CI eval
runs on a free third-party model (GLM-4.6), not the shipped default (R-10). A
thesis whose scoreboard can only confirm it is a belief system, not a product
plan.

The consistent counterweight: the core diagnosis (fragmentation as a distance
problem agents cannot cross) is sharp and original; the fail-closed policy and
RLS primitives, the CI-manifest ADR, the daemon lifecycle engineering, and the
project's habit of naming its own gaps are genuinely strong. The gap is not
between a good idea and a bad one — it is between a strong thesis and a
document-and-artifact estate that does not yet live up to it, and in several
places actively contradicts it.

---

# Top 10 issues

Ordered by severity × leverage: how badly it breaks the product premise,
multiplied by how much fixing it unlocks.

## R-01 (critical) — The documented product and the pitched product have different customers

**Sources:** L1:C-01, L3:F11

**Issue.** Every canonical document describes an enterprise *with* an
engineering organization; the stated target user — an org with no engineering
org — appears in none of them.

*(See Addendum 2026-07-02: largely RESOLVED by the founder's ICP decision;
what remains is the concrete remediation — rewrite prd.md §2-3 for the
mid-market, no-full-time-engineers customer.)*

**Evidence.**
- prd.md:5-7 — the problem statement is "Every large enterprise carries an
  unserved build backlog… it loses the prioritization fight against the
  roadmap." Only orgs with engineering have roadmaps and prioritization fights.
- prd.md:51 — the role model literally names "**Steerer
  (Product/Engineering lead)**"; prd.md:49 — the Owner is "the office of the
  CTIO or equivalent."
- prd.md:65 — the Steerer "review[s] a proposed change together with the full
  chain of reasoning… the validation" — reviewing code diffs and validation
  output is engineering work.
- README.md — "Superfield is an Agent Integrated Development Environment
  (Agent IDE)… The developer steers intent"; Requirements: "A Rust toolchain…
  to build the binary," Install: `cargo build --release` (README.md:38-42).
- "Agent IDE" appears only in the README and the vision doc; prd.md and
  technical-requirements.md never use it — the repo's front door frames a
  developer tool, the PRD an appliance for business stakeholders.

**Why it matters given the premise.** The product owner's thesis (post-human
software for orgs with no engineers) and the written PRD (backlog relief for
large enterprises with CTIOs and engineering leads) are two different products
with different buyers, different trust requirements, and different UX floors.
An org with genuinely no engineering organization cannot staff a single role in
prd.md §3 except Requestor and Viewer. Every downstream design decision —
diff-level review, policy authorship, CLI-based recovery — inherits this
ambiguity.

**Recommendation.** Pick one target and rewrite the role model for it. If the
target is truly no-engineering orgs: (a) replace human diff review with
outcome-level acceptance ("does the app do the thing," demoed against
representative data), (b) make policy authoring template-based with certified
defaults, (c) ship a binary, not a Rust build step. If the target is
enterprises with engineering, say so and stop claiming otherwise upstream. The
README should adopt PRD vocabulary (Forge, control panel, appliance) and label
`cargo build` as the pre-installer dev path.

## R-02 (critical) — The human-approval gate is load-bearing, unstaffable, un-amortized, self-graded, and legally naked

**Sources:** L1:C-02, L2:RT-02, L4:F6

**Issue.** Safety rests entirely on a human gate that the target customer
cannot staff, that the architecture routes every change through individually,
whose risk score may be assigned by the agent being gated, and behind which no
liability story exists.

*(See Addendum 2026-07-02: SHARPENED — the ICP's one part-time technical lead
is the entire approval queue; outcome-level review, batching, and risk budgets
are now core-UX requirements, not recommendations.)*

**Evidence.**
- prd.md:145 — "no change above the policy-defined risk threshold may ship
  without human approval." unified-memory-layer.md:60 — "it does not remove
  the need for a human-set policy on what counts as a valid correction and
  when review is mandatory."
- prd.md:161 — "How does an enterprise measure trust in autonomous changes
  well enough to raise the policy threshold over time?" — the core safety
  mechanism is filed as an *open question*; prd.md:154 (minimum policy
  vocabulary) likewise.
- architecture.md:202 — a single `active` policy per workspace with one scalar
  `RiskLevel 0..=100` vs `risk_threshold` as the only autonomy dial;
  architecture.md:227 — "`notify_awaiting_approval` — **always** dispatches";
  architecture.md:568 — `IntentSpecInference` is "Never auto-applied — a human
  confirms or corrects it." No batching, no approval-by-class, no risk budget
  over a time window, no back-pressure from a saturated approval queue.
- Who assigns the 0–100 `RiskLevel` is unspecified; if the agent scores its
  own change's blast radius, the gate is self-graded (L4:F6).
- Nothing anywhere addresses vendor liability, SLA, warranty, or incident
  responsibility when an autonomously shipped change corrupts customer data;
  `license = "UNLICENSED"` (Cargo.toml) is the only "legal" artifact in the
  repo. Customer-facing rollback is `superfield deploy rollback <record-json>`
  — an engineer's interface (README), though `/studio/deploy/rollback/{env}`
  (architecture.md:689) is a promising button-shaped seam.

**Why it matters given the premise.** At 1000 tok/s, one workspace's agents
can produce hundreds of validated changes per hour; the design routes each to
an individual notification and an individual human review. The pitch's two
success metrics — speed ("signal-to-correction in minutes," prd.md:42) and
human control — are in direct tension, and no document acknowledges it.
Approval by someone who cannot assess the artifact is a rubber stamp: it
launders agent output through a human signature without adding safety, while
restoring "the speed of human hand-offs" the PRD says it eliminates
(prd.md:32). In a post-human org the gate either bottlenecks on a
non-technical Owner rubber-stamping diffs they can't read, or gets set to full
autonomy — at which point there is no documented answer to "who pays when the
loop ships a defect to production."

**Recommendation.** Design the approval surface for queue economics: change
batching by blast-radius class, per-window autonomous risk budgets,
policy-driven sampling review (approve the policy, audit the stream), loop
back-pressure when `awaiting-approval` depth exceeds a bound. Replace
code-level review with behavior-level review (executable before/after
demonstrations plus a plain-language risk statement). Specify independent —
non-self-graded — risk scoring; make canary/staged deploys with automatic
rollback on telemetry regression the default blast-radius control; publish an
operational-responsibility matrix (vendor vs customer). Promote the
trust-escalation mechanism from open question to requirement — it *is* the
product.

## R-03 (critical) — The "binding" Blueprint gate is fail-open prompt-stuffing, and the Blueprint itself is told three ways and absent

**Sources:** L2:RT-01, L3:F8

**Issue.** The flagship governance mechanism — architectural conformance as a
binding merge condition — is implemented as optional prompt garnish with a
silent fallback to zero rules, and the artifact it reads does not exist in a
fresh checkout.

**Evidence.**
- architecture.md:25 — "The Blueprint is a binding input to the validation
  gate: no change merges without conformance… Advisory-only consultation is
  insufficient for the appliance." vs architecture.md:622 — "If the file is
  missing or unreadable, `run_loop` falls back to `BlueprintRules::empty()`
  (no rules) with a warning log rather than aborting," and :624 —
  `query(keywords)` keyword-substring filtering "Used by the
  `ArchitectureProposal` step to inject relevant architectural constraints
  into the LLM prompt."
- The Blueprint's substance is described three incompatible ways:
  rows-in-the-database (unified-memory-layer.md: "The blueprint… is rows in
  the same database as the issues it governs…; when it changes, the change is
  a migration"), baked into model weights as the target (architecture.md:
  "The rules are not a runtime config — they are baked into the model's
  weights"), and interim compiled YAML "sourced from
  `dot-matrix-labs/superfield-blueprint` and tracked as a git subtree at
  `blueprint/`."
- In reality `blueprint/` is an **empty git submodule** whose `.gitmodules`
  URL is `https://github.com/superfield-ai/superfield-blueprint.git` — not a
  subtree, not `dot-matrix-labs`; `blueprint/rules/graph.yaml` does not exist
  in a checkout. A fresh clone gardens with zero rules, silently.
- PRD Constraint §9 requires validation to include "conformance to the
  governed architectural and security constraints the brain holds, not test
  results alone." No document — not architecture.md, not any ADR — designs
  *how conformance to a rule is checked* at the gate. As designed, the gate is
  `cargo check` + tests: exactly what the PRD calls insufficient.

**Why it matters given the premise.** The policy engine and RLS are proudly
fail-closed; the mechanism carrying the product's "encoded judgment" is
fail-open. For a lights-out factory, an empty rule set with a warning log is
indistinguishable from a governed one — every autonomous merge in that state
is ungoverned while claiming governance.

**Recommendation.** Write the missing ADR: Blueprint-conformance checking as a
gate stage (rule → checkable predicate → verdict recorded in
`forge.validation_runs`); make a missing/unparseable rule graph a boot failure
(fail-closed, like the policy engine); correct the subtree/org claim;
reconcile the vision's rows-in-DB story with the weights target (or mark the
vision aspirational); and stop calling prompt injection "binding" until an
evaluator exists.

## R-04 (critical) — Unmetered spend on an infinite loop: token cost is the COGS and nothing enforces a ceiling

**Sources:** L4:F3 (budget-enforcement gap also flagged in L2:RT-07)

**Issue.** The loop runs indefinitely at a 5-second default cadence against a
customer-billed API key, and the named budget-enforcement requirement exists
nowhere in the code or the design.

**Evidence.**
- milestone-1.md §4.4 — the loop runs "indefinitely," inter-step delay
  default **5 s**.
- technical-requirements.md:61 *names the requirement* — "per-agent cost
  metering and budget enforcement (an Owner must be able to see and cap what
  autonomy costs)" — but grep across `crates/sf-loop` and `crates/sf-serve`
  shows only display-side `costUsd` accumulation on WorkSlot cards
  (architecture.md:695, :724). The only budget primitive in the codebase is
  `--turn-budget` in the *eval* binary (`crates/sf-eval/src/main.rs`).
- No document models unit economics: no $/app, no $/gardening-pass, no cost
  ceiling, no kill-switch-on-budget-exhaustion anywhere in `docs/`.

**Why it matters given the premise.** At dark-factory throughput, a 24/7 loop
with a 5-second cadence and no cap is an uncapped invoice wired to the
customer's API key. One prompt-drift regression is a runaway bill discovered
at month end — by a customer with no engineering org to diagnose it. This is
the single largest commercial-viability gap for the stated buyer.

**Recommendation.** Hard per-workspace daily/monthly budget in the substrate,
enforced in `sf-loop` before each step (loop pauses and notifies the Owner at
threshold). Publish a unit-economics doc (tokens/step × steps/day × model
price) as a canonical page the loop itself maintains.

## R-05 (critical) — Day-1 install is a Rust engineering workflow; the "single artifact" is a toolchain constellation; the appliance shell does not exist

**Sources:** L4:F1, L2:RT-15

**Issue.** The appliance claim is aspirational: first boot requires building
from source, and a working system needs an unpackaged constellation of
developer tooling on the customer host.

*(See Addendum 2026-07-02: STANDS — the remediation target is now "IT-admin
grade," not "zero-touch"; a signed installer a sysadmin-generalist can run is
sufficient, but cargo builds remain disqualifying.)*

**Evidence.**
- README.md Requirements: "A Rust toolchain (see `rust-version` in
  `Cargo.toml`) to build the binary"; the Install section is literally
  `cargo build --release`.
- `install.sh` downloads from `https://github.com/superfield-ai/monorepo/releases`
  — a repo at `version = "0.1.0"`, `license = "UNLICENSED"` (Cargo.toml), with
  no evidence of published release assets, no checksums, and no code signing
  (`install.sh:104-106` just `curl | chmod +x | mv`).
- technical-requirements.md:134 openly admits the appliance shell —
  "installer, seed apps, self-upgrade, self-operation" — is "Not yet existing
  in any form."
- The runtime dependency inventory (L2:RT-15): the merge gate runs
  `cargo check` (architecture.md:333); rust-analyzer is located via
  "`rustup which rust-analyzer`" (:346); `tsserver_bridge_client` "spawns the
  TypeScript bridge script" — a Node runtime (:326); `LocalPostgresProvisioner`
  needs `initdb`/`pg_ctl` discovered on the host (:508); fastenv doctor checks
  KVM, Firecracker, `crun`, TUN/TAP (:831). None of this is packaged,
  versioned, or health-gated as a unit — doctor covers fastenv's slice only.
  technical-requirements.md §2.12 demands "Single-artifact installation."

**Why it matters given the premise.** A non-technical organization cannot
reach first boot without hiring exactly the engineering capacity the product
promises to eliminate. "Install one artifact" currently means "have an
engineer prepare the host."

**Recommendation.** Ship a signed, checksummed single-binary release (plus
.deb/.rpm or a bootable image) and a systemd unit; make `install.sh` verify
signatures. Define the appliance-image ADR: the single artifact is a
fastenv-supervised image bundling pinned toolchains (they are validation-gate
dependencies, hence product components), with `doctor` extended to the full
dependency inventory and a designed remediation path. Make "curl | bash to
running daemon in under 5 minutes with zero toolchain" a CI-gated acceptance
test.

## R-06 (critical) — First-run and recovery assume an engineer; without a credential the appliance silently gardens fake content

**Sources:** L2:RT-03, L4:F2

**Issue.** Credential entry, health diagnosis, and disaster recovery all
terminate in CLI-and-Unix literacy, and the no-credential state is a
false-alive machine.

*(See Addendum 2026-07-02: STANDS — the bar is now "IT-admin grade":
Studio-based credential setup, restore, and rollback is sufficient;
`postgresql.conf` edits and `cargo run` recovery steps remain disqualifying.)*

**Evidence.**
- architecture.md:590-604 — "A fresh appliance ships **no** LLM credential…
  the gardening loop and the studio agent **silently degrade** to the
  deterministic `FixtureAgentExecutor`: the loop gardens placeholder content
  and the agent answers canned echoes." The operator remedy is
  `export SF_LLM_API_KEY="sk-ant-…"` plus `SF_LLM_ENDPOINT`/`SF_LLM_MODEL`
  env vars. "The appliance… has no secrets-management backend" — no rotation,
  no vault, no persistence story.
- architecture.md:392-405 — the Restore Procedure is 8 manual steps including
  "Set `restore_command` in `postgresql.conf`", "Set
  `recovery_target_time = …`", and "run `cargo run -p sf-cli -- db status`".
- The CLI operator surface (architecture.md:737-758):
  `superfield deploy ship <config-json>`, `episode append <ep-id> <type>
  <json>`, `session issue <ws-id> <uid> <role>` — raw-JSON invocations.
- technical-requirements.md §2.12 — "the appliance has no ops team. Its own
  backup, recovery, replication, and health monitoring are product features."
- A zero-engineering customer whose appliance is producing "canned echoes" has
  no diagnostic path but `daemon.log` (milestone-1.md §4.2).

**Why it matters given the premise.** A mis-set key yields a machine that
*looks* alive — the loop advances, pages update — while producing placeholder
output: the exact false-green failure mode the repo's own test-coverage policy
rails against, promoted to product behavior. And when disaster strikes, the
recovery story is a DBA runbook for a customer with no DBA.

**Recommendation.** First-boot setup flow in Studio that collects and
validates the credential, stores it encrypted in the substrate, and
hard-refuses to run the production loop on fixtures (fixture executor gated
behind an explicit dev flag, with a loud degraded-mode banner). One-click PITR
with a time slider; credential and health workflows in the control panel; mark
the CLI as an internal/agent surface, not an operator one.

## R-07 (critical) — Milestone 1 is declared complete while claiming machinery eval-design says does not exist; quality evidence is graded on a free third-party model

**Sources:** L3:F1, L4:F11

**Issue.** The record of what shipped contradicts itself, and the eval that
would arbitrate runs on the wrong model with non-gating acceptance criteria.

**Evidence.**
- milestone-1.md §4.6 (stated as "Milestone 1 requirements"): "each acceptance
  criterion is stored as a typed `AcceptanceCriterion` node linked to its
  parent `Feature` node via the `project:feature_has_acceptance_criterion`
  edge" and "test functions named in the source tree are linked to the
  acceptance criteria they verify." architecture.md §Milestone 1: "Milestone 1
  delivered the headless binary… All six phase issues… are closed."
- eval-design.md: "Today `AcceptanceCriterion` exists as a node type in
  `nexum.project_nodes` but is **unused and non-gating** — there is no
  acceptance-criteria data attached to a Feature, and nothing checks it."
- eval-design.md: the CI todo-app eval runs "keylessly with OpenCode's free
  Big Pickle model (GLM-4.6)… no API key and no repo secret," while the
  production default is `claude-haiku-4-5` (architecture.md:555). The eval is
  "intentionally rough… a substrate for experimentation, not a gate."

**Why it matters given the premise.** Anyone auditing "what shipped" gets
opposite answers depending on which canonical doc they read; the appliance's
core promise — verifiable acceptance — is claimed and disclaimed
simultaneously. Meanwhile the customer's expected outcome ("did I get the app
I asked for") is validated on a different model than the one they'll pay for,
with acceptance criteria that gate nothing. The green eval badge overstates
readiness.

**Recommendation.** Amend milestone-1.md §4.6 to mark items 2–3 as
delivered-as-schema-only/deferred, or retract the "completed" status line in
architecture.md; cross-link eval-design's "missing primitive" section as owner
of the gap. Run the nightly Tier-2 eval on the shipped default model (pinned),
and land executable acceptance criteria (eval-design's own sequencing step 1)
before marketing outcome guarantees.

## R-08 (critical) — No defensibility analysis against the obvious competitor: the frontier labs — and the appliance model forfeits the only data moat

**Sources:** L1:C-04

**Issue.** No document contains a competitive landscape, and the claimed moat
is precisely the competency set of the better-resourced entrants.

*(See Addendum 2026-07-02: SHARPENED/CLARIFIED — the buyer is now the
CIO/COO spending from the existing IT/automation line; the real competitive
set is vertical SaaS, Power-Platform consultants, MSPs, and a
contractor-with-agent. The defensibility document can now be written against
a concrete buyer.)*

**Evidence.**
- prd.md:123 — "Agent execution — access to large-language-model agent
  capability" is an external integration; Superfield owns none of the
  intelligence.
- unified-memory-layer.md:92-96 — the only moat claim: "the accumulated
  engineering that makes one place safe to bet a company on," while admitting
  "the defensibility is not the idea… that is free."
- No document contains the words "competitor" or "alternative," a pricing
  model, or any lab/hyperscaler product.
- README.md:11 — self-hosted appliance "on infrastructure it controls," so
  learning stays inside each customer's brain: **no cross-customer flywheel**
  accrues to Superfield.

**Why it matters given the premise.** If Anthropic/OpenAI/Google ship
"describe an internal app, we build, host, and maintain it" — a natural
extension of 2026 tooling — Superfield's residual differentiators are a schema
it admits is free to copy and an on-prem posture it never argues as a moat.
"We did hard engineering" is a head start, not a moat, against entrants for
whom the hard parts are table stakes.

**Recommendation.** Write the defensibility document. Candidate honest moats:
sovereignty/regulated-industry positioning (the one place hosted lab offerings
can't follow), the Nexum cross-deployment synthetic curriculum (README.md:29 —
the only flywheel candidate, currently one line in a table), and switching
costs of an accumulated brain. If none survive scrutiny, the honest strategy
is speed-to-category and acquisition — plan for it.

## R-09 (critical) — The brain schema is the conceptual single point of failure, and the substrate is accreting the bottom-up union the requirements forbid

**Sources:** L2:RT-04

**Issue.** Every distinctive capability reads a schema that remains the
largest unstarted design artifact, while per-component schemas harden with
governance language that raises the cost of the top-down redesign.

**Evidence.**
- technical-requirements.md:27 — "The schema is the product… it is top-down
  work: it cannot be assembled by unioning the schemas of components that
  happen to exist." :132 — "the brain _schema_ itself… remains the largest
  unstarted design artifact in the roadmap."
- Meanwhile architecture.md §Single-Instance Schema Layout and
  adr-schema-boundary.md lock a per-component schema union
  (sharp/nexum/auth/orchestrator/substrate/forge), and adr-embedding-model.md
  pins the sole permitted vector space "without a superseding ADR."
- §2.8's spec inference, diagnosis, and gap surfacing — the entire moat —
  read the unbuilt schema. No document contains the event-sourcing or
  single-clock design, a risk spike, or a decision deadline.

**Why it matters given the premise.** If the assumption "one Postgres schema
can hold operational events + semantics + intent + causality under one clock"
is false, the whole concept collapses — and the project is doing exactly what
its own requirements document warns against while it waits.

**Recommendation.** Treat the brain schema as build-order step 1 in fact, not
just prose: produce the schema ADR (event model, clock, intent-as-records,
causal-link population) before further component-schema hardening, and label
current schemas explicitly as migration-fodder, not canon.

## R-10 (critical) — The 1000-tok/s premise dissolves the product's own primary surface

**Sources:** L1:C-03

**Issue.** The steering cockpit the docs invest in is a human-paced
affordance that the product's own premise makes vestigial.

**Evidence.**
- studio-ux.md:305-307 — "Polling runs every 10 seconds"; studio-ux.md:203-205
  — the session-log mock shows agent turns of "2.3s $0.04", "1.8s $0.03".
- prd.md:66 — "watch an agent work against a live preview… and correct it
  mid-task"; prd.md:22 — the control panel's value is "watching agents work…
  reviewing and approving changes"; studio-ux.md:254 — the STEER form.
- unified-memory-layer.md:86 mocks GitHub as an "accommodation for a
  human-paced collaboration model that agents do not need."

**Why it matters given the premise.** At 1000 tok/s an agent turn completes
before a human finishes reading its first line — the mock's own 2-second turn
timings already show it. You cannot steer something that finishes in 2
seconds. The product criticizes GitHub for being human-paced while designing a
human-paced cockpit; in a true dark factory, live preview watching, mid-task
correction, and per-turn session logs are vestigial.

**Recommendation.** Redesign the human surface around the premise: humans
interact with *batches of completed candidate states* — variants, A/B'd
outcomes, policy exceptions — not live agent turns. The unit of human
attention should be "which finished version do you want," not "watch and steer
the worker." Keep steering only as a degraded mode for the pre-dark-factory
interim, and say which mode is primary.

---

# Full findings register

39 consolidated findings from 59 raw. Severity is the maximum assigned by any
contributing lens. Lenses: **L1** concept/market thesis, **L2**
architecture-vs-concept, **L3** cross-document coherence, **L4** operational
reality. Detail for R-01..R-10 is in "Top 10 issues" above; R-11..R-39 in
"Remaining findings" below.

| ID | Sev | Title | Lens(es) | Sources |
|----|-----|-------|----------|---------|
| R-01 | critical | Documented product (engineering org) vs pitched product (no engineers) | L1, L3 | C-01, F11 |
| R-02 | critical | Human-approval gate: unstaffable, un-amortized, self-graded, no liability | L1, L2, L4 | C-02, RT-02, F6 |
| R-03 | critical | "Binding" Blueprint gate is fail-open; Blueprint told three ways, artifact absent | L2, L3 | RT-01, F8 |
| R-04 | critical | Unmetered spend on an infinite loop; budget requirement unimplemented | L4, L2 | F3, RT-07 |
| R-05 | critical | Install requires Rust workflow; single-artifact claim vs toolchain constellation | L4, L2 | F1, RT-15 |
| R-06 | critical | First-run/recovery assume an engineer; silent fixture degrade | L2, L4 | RT-03, F2 |
| R-07 | critical | Milestone-1 completion claims vs eval-design reality; eval on free 3rd-party model | L3, L4 | F1, F11 |
| R-08 | critical | No defensibility vs frontier labs; appliance forfeits cross-customer flywheel | L1 | C-04 |
| R-09 | critical | Brain schema is the SPOF; substrate accreting the forbidden bottom-up union | L2 | RT-04 |
| R-10 | critical | 1000-tok/s premise dissolves the steering surface | L1 | C-03 |
| R-11 | critical | Locked decision mandates the silent-skip pattern the invariants ban | L2, L3 | RT-11, F2 |
| R-12 | major | Forge-proves-thesis is circular; built artifact far from the claim | L1 | C-05 |
| R-13 | major | Spec inversion can't bootstrap; departmental apps lack signal density | L1 | C-06 |
| R-14 | major | Green wedge reintroduces the fragmentation the thesis declares fatal | L1 | C-07 |
| R-15 | major | No buyer, no price, no alternatives; unit economics unquantified | L1, L4 | C-08, F12 |
| R-16 | major | Self-sufficiency costs unaccounted: lock-in, ecosystem-zero, no exit path | L1 | C-09 |
| R-17 | major | No premise-timing contingency reasoning anywhere | L1 | C-10 |
| R-18 | major | Security defaults lab-grade: 0.0.0.0 bind, unauthenticated Owner-token minting, no TLS | L2, L4 | RT-10, F8 |
| R-19 | major | Gardening loop is a serial 60-s poller vs the concurrent fan-out requirement | L2 | RT-05 |
| R-20 | major | Merge-gate latency unexamined: cargo check + LSP subprocess per merge | L2 | RT-06 |
| R-21 | major | LLM boundary decided twice, differently; appliance got the weaker one | L2, L3 | RT-07, F4 |
| R-22 | major | Migration order, schema inventory, and filename convention drift (ADR vs architecture) | L2, L3 | RT-08, F3, F15 |
| R-23 | major | Backup targets a GCS bucket; backup seam is a no-op stub; no scheduler | L2, L3, L4 | RT-12, F16, F5 |
| R-24 | major | Upgrade story ("self-upgrade") does not exist; interim is curl \| bash | L4 | F9 |
| R-25 | major | Dual-track duplication: appliance-critical truth lives in the disposable prototype | L2, L4 | RT-09, F7 |
| R-26 | major | studio-ux.md specifies the retired prototype; documented UPDATE flow cannot work | L1, L3, L4 | C-13, F5, F7 |
| R-27 | major | GitHub load-bearing (distribution, gate enforcement, UI shapes) despite GitHub-never | L2, L4 | RT-14, F4 |
| R-28 | major | "Nexum" means three different things across README, architecture, tech-req | L3 | F6 |
| R-29 | major | "Workspace" is simultaneously the enterprise brain and the per-app unit | L3 | F7 |
| R-30 | major | PRD's "everything runs in fastenv" constraint has no owner for the Forge itself | L3 | F9 |
| R-31 | major | testing.md's `act` doctrine contradicts the Accepted CI-manifest ADR | L3 | F10 |
| R-32 | major | Glossary chaos: Forge/appliance/daemon; control panel/Studio; orchestrator; loop | L3 | F12 |
| R-33 | minor | Operator documentation for the customer's personas does not exist | L4 | F13 |
| R-34 | minor | "Schema is the product" vs "no configuration surface" — unassigned work | L1 | C-11 |
| R-35 | minor | Success metrics are direction-only, baseline-free, and gameable | L1 | C-12 |
| R-36 | minor | Embedding pin is sunk-cost reasoning; model named two ways across ADRs | L2, L3 | RT-13, F14 |
| R-37 | minor | `/health` is readiness in milestone-1 but bare liveness in architecture | L3 | F13 |
| R-38 | minor | Dangling/stale cross-references (product.md, §Control Webapp, org names, "container") | L3, L4 | F17, F10 |
| R-39 | minor | Sharp's native hash algorithm told two ways (SHA-256 vs SHA-1 default) | L3 | F18 |

---

# Remaining findings (R-11 – R-39)

## R-11 (critical) — Locked decision mandates the silent-skip pattern the invariants ban

rust-reorg-decisions.md:44-45: "DB-gated and rust-analyzer-gated tests are
`#[ignore]`'d so CI without Postgres/RA stays green" — versus
testing-invariants.md invariant 1: "A test that self-disables — `#[ignore]`,
`t.Skip()`… — produces a false green… must **fail in CI when the resource is
absent**, not skip," and adr-ci-execution-manifest.md:108-110's gate ("loud-skip
never silent-skip; exit-0 ≠ tested").
`docs/scout/embedding-coverage-offline-weights-and-pgvector-seams.md` confirms
"the `#[ignore]` markers are the _existing_ silent-skip pattern this phase
exists to remove." Which rule an agent follows depends on which document it
read last — on Sharp, whose "silent mis-merge" failure mode the requirements
call "fatal in a lights-out system" (technical-requirements.md:36). **Fix:**
SUPERSEDED-in-part banner on rust-reorg-decisions.md §Gate pointing at
testing-invariants.md (copy the control-template-integration.md banner
pattern); resource-provisioned CI lanes so DB/RA tests fail loudly.

## R-12 (major) — Forge-proves-thesis is circular; the built artifact is orders of magnitude from the claim

prd.md:17 calls the Forge "the most direct proof of the product's thesis" —
but Milestone 1 is a loop that ingests markdown and derives Feature/Issue
nodes (milestone-1.md:3-5, §4.3, §4.6): no code changes, no validation gate,
no deploy, no signal-to-correction loop. Meanwhile the flagship self-improving
system carries a documented, un-self-healed frontend/backend route mismatch
(studio-ux.md:256-264) — the exact class of small, in-brain defect the vision
says agents fix "within seconds" (unified-memory-layer.md:111-116). **Fix:**
make "the Forge fixed X defects in itself autonomously, N% approved" a
tracked, published metric; treat the studio-ux mismatch as the acceptance
test.

## R-13 (major) — Spec inversion can't bootstrap, and departmental apps never generate the signal density it needs

"The delta is the spec" (unified-memory-layer.md:50-52) is unavailable by
definition at the first build — v1 comes from a non-engineer Requestor's prose
description (prd.md:84), the classic requirements problem the thesis claims
dissolved. And the worked example's signal — "Checkout 500 affecting 3
sessions in the last hour" (unified-memory-layer.md:115) — is consumer-grade
traffic; the GTM sells reconciliation tools used by 6 people twice a month,
where behavioral traces are anecdote and inference will confidently overfit.
**Fix:** bound the claim to maintenance-phase, sufficiently-trafficked apps;
specify the bootstrap path (structured intake, agent-generated clickable
prototypes); set a minimum-signal threshold below which the loop must not
auto-infer intent.

## R-14 (major) — The green wedge reintroduces the fragmentation the thesis declares fatal

The enterprise's actual truth — ERP, CRM, HR, finance — permanently lives
outside the brain behind read-only connectors (prd.md:120), which is
definitionally the "one more system at more distance" the vision says you
"cannot pipeline your way out of" (unified-memory-layer.md:15, :153). The
coherence guarantee holds only over the net-new slice, while "a synthesized,
continuously current view of itself" (prd.md:15) and the operations-takeover
terminal state (unified-memory-layer.md:145-153) require whole-company
coherence; the reconciling read-boundary question is open (prd.md:157).
**Fix:** downgrade the claims to what the wedge supports; make freshness a
first-class schema property on external replicas; future-flag the
whole-business-view language.

## R-15 (major) — No buyer, no price, no alternatives; unit economics unquantified

"The demand is large, the budget for IT and automation exists" (prd.md:7) is
asserted with no mechanism; no document mentions pricing, cost-per-app
economics, deal size, procurement path, or the buyer's real alternatives in
2026 — low-code platforms, a contractor wielding a frontier coding agent,
vertical SaaS, or lab-hosted app-building (L1:C-08). Studio's per-turn "$0.04"
figures (studio-ux.md SESSION LOG) are display, not governance; there is no
target $/app or tokens-per-feature measurement plan beyond eval-design's
per-scenario process metric (L4:F12). The strongest competitor for "department
needs a small tool" is one operations-minded employee with a $200/month
frontier-agent subscription — which gets stronger at the premise. **Fix:**
one-page commercial thesis (named buyer, price anchored to alternatives,
kill-criteria comparison); make cost-per-merged-change and
cost-per-satisfied-acceptance-criterion first-class Tier-3 metrics with
historical trend in Studio.

## R-16 (major) — Total self-sufficiency's costs — lock-in, ecosystem-zero, no exit path — are never accounted

Own VCS, own CI, own exec environment, "Source code lives in the database,
not in a Git tree" (unified-memory-layer.md:84; prd.md:141-142) is framed as
pure value, while prd.md:149 simultaneously demands system-of-record-grade
availability and recovery. The thick slice enterprises actually buy from
incumbents — HA, backup drills, secrets, access reviews, compliance
attestations, a labor market — must all be rebuilt (Sharp, fastenv, Nexum,
sf-auth, sf-deploy — README.md:113-126), and the customer bets their entire
estate and its source on a bespoke stack with zero third-party auditors and no
exit path. The concentration-of-risk objection is acknowledged and then
*rebranded as the moat* (unified-memory-layer.md:94-96) — rhetorical judo, not
an answer. **Fix:** make continuous export (source-as-git-tree,
brain-as-portable-schema) a customer guarantee — Sharp is already
"backwards-compatible with Git" (README.md:28); publish the recovery/HA story;
apply the Postgres-embedding pragmatism test to every rebuilt component.

## R-17 (major) — No premise-timing contingency reasoning anywhere

No document discusses cheap-but-unreliable models (the human gate dominates
and the buyer can't staff it — the product regresses to an AI-assisted dev
tool in a brutally crowded market), premise-early (labs' integrated offerings
arrive first and the steering surface is obsolete), or reliable-but-regulated
(a self-hosted appliance means *every customer* individually bears
certification burden while a hosted competitor amortizes it once). Closest
touchpoints: prd.md:148, prd.md:160. **Fix:** a premises-and-scenarios section
in the vision doc — load-bearing assumptions, leading indicators, pre-planned
pivots. A thesis this premise-dependent without tripwires is a bet, not a
strategy.

## R-18 (major) — Security defaults are lab-grade: 0.0.0.0 bind, unauthenticated Owner-token minting, static passwords, no TLS

architecture.md:648 — default bind `0.0.0.0:7000`; :667 —
`POST /api/auth/session`, Auth "None," "Issue a session token for a
`(workspace_id, user_id, role)` triple"; :669 — unauthenticated
`/api/auth/register`; :722 — "the route is expected to be reachable only from
localhost during this phase" (while the bind is every interface). Anyone who
can reach port 7000 can mint an Owner session for any workspace — the
downstream `require_owner`/RLS rigor is security theater while the front door
issues arbitrary-role tokens. Plus: `POSTGRES_PASSWORD: superfield` and port
5432 published (docker-compose.yml), hardcoded `replicator_secret`
(docker-compose.replication.yml), and no TLS/reverse-proxy/hardening guidance
anywhere (L4:F8). Enterprise SSO and agents-as-principals remain "not yet
existing in any form" (technical-requirements.md:134) despite PRD §9's
"enterprise-grade" launch constraint. An org with no engineering team runs
the defaults. **Fix:** bind `127.0.0.1` by default; gate `session`/`register`
behind a bootstrap secret even at milestone 1; per-install generated
credentials; embedded TLS flow; write the SSO/identity ADR; hardening
checklist in the health gate.

## R-19 (major) — The gardening loop is a serial 60-second poller; the spec demands concurrent fan-out

architecture.md:531 — "cycles through nine steps in a fixed order… After a
full pass it pauses 60 seconds before repeating," one
`orchestrator.gardening_cursor` row per workspace (:630-641) — versus
technical-requirements.md §2.4 ("many agents work concurrently with sequenced,
gated merging") and §2.3 (validation is "the agent's _inner loop_, not a
queue"). The pipeline hard-codes one change proposal per full pass — a cadence
ceiling shaped entirely by today's LLM latency. **Fix:** design the re-rooted
loop engine now as a DAG of resumable jobs over the brain (the
`nexum.job_queue` table exists, unused by the loop), with per-step concurrency
and event triggers instead of fixed cycle + sleep.

## R-20 (major) — Merge-gate latency is unexamined: `cargo check` + LSP subprocess per merge cannot be the inner loop at agent cadence

Every Tier-1 merge spawns `rust-analyzer`, performs the LSP initialize
handshake, then runs `cargo check` on the merged workspace
(architecture.md:329-346); every change must record a passing validation run
(:169). technical-requirements.md:49 applies the sub-second economics argument
to *environments* only — never to the merge gate, which costs tens of seconds
to minutes per attempt. With sequenced gated merging, merge throughput =
1/(gate latency): the merge queue, not the model, becomes the factory's rate
limiter. **Fix:** a numeric merge-gate latency budget alongside the fastenv
one; persistent warm rust-analyzer/tsserver pools; incremental `cargo check`
against snapshots; `projections` (:321) as the default path so merge is a
cache hit.

## R-21 (major) — The LLM boundary is decided twice, differently, and the appliance got the weaker one

runtime-agent-selection.md documents a full backend/tier/failover design over
vendor CLIs (`claude`, `codex`, `opencode`) with `~/.superfield/config.yaml` —
all implemented in the retired `packages/core` prototype, present-tense, with
no SUPERSEDED banner (control-template-integration.md got one; this doc
didn't). testing.md's opening line still says "Superfield's runtime spawns an
agent CLI as a subprocess." The appliance's entire LLM config is three env
vars — `SF_LLM_API_KEY`, `SF_LLM_ENDPOINT`, `SF_LLM_MODEL`
(architecture.md:547-556) — one endpoint, no failover, no metering, versus
technical-requirements.md §2.5's "vendor-abstracted, metered, and swappable —
including… models inside their own trust perimeter." `SF_LLM_PROVIDER` (from
eval-design/`crates/sf-loop/src/provider.rs`) appears zero times in
architecture.md. The prototype's YAML-override design also contradicts PRD §8
Out of Scope: "A configuration surface." **Fix:** banner
runtime-agent-selection.md as prototype-era; rewrite testing.md's first
paragraph; write the appliance LLM-boundary ADR (provider abstraction, hard
budget enforcement at the executor seam, persistent availability state,
customer-perimeter model serving path).

## R-22 (major) — Migration order, schema inventory, and filename convention drift between the Accepted ADR and its "canonical reference"

adr-schema-boundary.md:225-226 mandates "`auth` → `nexum` → `sharp` →
`orchestrator`"; architecture.md:134/:452 says the Rust runner walks
`COMPONENT_DIRS` in "`sf-db → sf-auth → nexum → sharp`" order — the ADR omits
`sf-db` (which must run first: it creates `public.workspaces` that
`nexum.page_revisions` FKs against) and includes `orchestrator`, which the
runner omits. The ADR's table includes `forge.policies` and the
`public.workspaces` exception; architecture.md's table (:83-90) has neither —
despite architecture's own §Policy engine documenting `forge.policies`.
adr-schema-boundary.md:207 attributes graph traversal to
`packages/db/nexum-graph.ts`; architecture.md:212 to
`crates/nexum/src/query.rs`. The ADR's `<NNNN>_<schema>_<description>.sql`
convention is contradicted by the very files architecture cites
(`0003_page_revisions.sql`, `0009_rls_workspace_isolation.sql` — no schema
token). An agent — the only "engineer" this customer has — reading the
Accepted ADR builds a runner that fails on FK dependencies. **Fix:** one
document owns the order (the other points by reference); sync the two schema
tables; fix or ratify the filename convention; delete the TS attribution.

## R-23 (major) — Backup targets a Google Cloud bucket, behind a no-op stub, with no scheduler — inside a trust-perimeter appliance

architecture.md:388-390 — WAL archiving to "`gs://sf-wal-archive/<env>/`,"
daily `pg_basebackup` to "`gs://sf-backups/<env>/…`" "in the current
deployment" (quietly: the vendor's deployment, not the product); :390 —
scheduling "owned by the appliance's execution environment — no external
scheduler is a required dependency" (i.e., no scheduler is designed);
:409-415 — `NoopSubstrateBackup` "satisfies the interface" as a stub. This
contradicts PRD §5 ("entirely within our trust boundary"), milestone-1.md
("no cloud dependency"), and PRD §9 self-sufficiency — while
technical-requirements.md:25 admits "one store concentrates risk, so
recoverability is launch-critical." The 5-min RPO / 15-min RTO targets are
asserted against a job that has no scheduler, no on-appliance destination,
and a no-op seam. **Fix:** appliance-local backup target by default (second
disk / customer-pointed S3-compatible endpoint, configured in Studio); the
daemon's loop as the scheduler; replace the no-op with an enforced health
check (no recent backup event → high-severity signal → `sf-notify`);
one-command `superfield restore`; periodic automated restore drills as a
health metric.

## R-24 (major) — The upgrade story does not exist; "self-upgrade" is listed among things "not yet existing in any form"

prd.md:60,82,141 promise "no separate upgrade process";
technical-requirements.md:113 names "Self-upgrade — the Forge ships changes to
itself"; technical-requirements.md:134 admits it doesn't exist. `install.sh`
does a semver compare but has no channel, no binary rollback, no
migration-compat guarantee (milestone-1 §4.2 runs migrations forward only).
Day-30 the customer is on 0.1.0 with a critical fix upstream and no documented
mechanism for upgrading a running daemon safely — and loop-driven
self-modification without the R-02 controls means the appliance can brick
itself. **Fix:** ship a boring `superfield self-update` (download, verify
signature, drain, swap, migrate, health-gate, auto-rollback on failed gate)
*before* pursuing loop-driven self-modification.

## R-25 (major) — Dual-track duplication: appliance-critical artifacts' source of truth lives in the disposable prototype, which still ships in the repo

RLS exists "in two interchangeable forms" (`packages/db/migrations/0001_…`
TS/k3s and `crates/sharp/migrations/0009_…` Rust) maintained in mirror
(architecture.md:127-134); the deployment contract's canonical copy is "the
TypeScript artifact emitted by `packages/control-core/fastenv-translate.ts`"
with the Rust `FastenvManifest` as "the consumer-side mirror, kept in sync
field-for-field" (:827) — canonical truth inside the code
technical-requirements.md:122 has sentenced to death, default deploy backend
still `k3s` (:831). Meanwhile the repo root still contains `package.json`
(bun workspaces, a `superfield start` script for the *old* CLI), `packages/`,
`orchestrator/migrations/`, and a `docker-compose.yml` whose `migrate` service
runs `bun packages/db/migrate.ts` — the prototype's migration path (L4:F7). A
customer, auditor, or agent cannot tell which half of the repo is the product,
and inherits whichever mirrored copy drifted. **Fix:** invert ownership now
(Rust side canonical for RLS and the manifest; TS generated or deleted); CI
gate diffing the RLS pair until k3s retires; fastenv as default backend at
parity; split or archive `packages/`/`orchestrator/`; distribution artifact
contains only the appliance.

## R-26 (major) — studio-ux.md, the primary operator-surface spec, is written against the retired prototype — and its documented UPDATE flow cannot work

The spec's data-source table lists `/studio/turns/:sessionId` and
`POST /studio/sync/github` (neither exists in `crates/sf-serve/src/`); it
declares "The embedded DB (`packages/db`) is the sole source of truth"; it
designs around `GITHUB_TOKEN` + `GITHUB_REPO` and "GitHub is an optional sync
target" (studio-ux.md:16-18, :148-149, :400-402) against README.md:11's "no
GitHub… ever required." Its state machine says "submit UPDATE form →
`PATCH /studio/issues/:n { body }`" while its own NOTE admits "There is **no**
`PATCH /studio/issues/:n` route… the update handler… does not accept a
Markdown `body` field" (studio-ux.md:256-264) — the operator's one documented
edit flow is specified against a route that doesn't exist. For a product whose
central claim is that agents never read a stale fact with fresh-fact
confidence (unified-memory-layer.md:5), the canonical UX doc containing
exactly that staleness is a pointed self-refutation. **Fix:** rewrite
studio-ux.md against the sf-serve route table (or banner the
GitHub/`packages/db` sections as prototype-historical); fix the PATCH/update
mismatch; make cross-doc consistency an automated gardening-loop check — the
cheapest possible demonstration of the thesis on itself.

## R-27 (major) — GitHub remains load-bearing in distribution, gate enforcement, and UI shapes despite the GitHub-never constraint

technical-requirements.md:5 — "No appliance may require a GitHub account… or
network reachability to github.com." Yet `install.sh:60` resolves the release
tag from `api.github.com` and downloads from
`github.com/superfield-ai/monorepo/releases` (day-1 reachability required);
the manifest validation gate is "wired into
`.github/workflows/manifest-lint.yml`" only (adr-ci-execution-manifest.md:146);
and the control panel carries `/studio/deploy/ci` plus a check-runs contract
shaped for GitHub polling — including a deliberately "producerless"
always-empty envelope (architecture.md:686, :696-697). Prototype anatomy is
fossilizing into appliance contract. **Fix:** host release artifacts on a
vendor domain (install.sh's header already implies `superfield.dev`); run
`lint-manifest` in the FastENV executor as the primary gate; reshape the
analytics contract around `forge.validation_runs` before more UI binds to the
GitHub-shaped envelope.

## R-28 (major) — "Nexum" means three different things

architecture.md: "Nexum… is the unified operational store for all company
knowledge… the live company brain"; README Phase 1: "**Company brain (Nexum)**";
README Phase 2: "**Nexum** — [`superfield-ai/nexum`] — Self-improving
synthetic corpus" (a different product in an external repo); and
technical-requirements.md §3: "Fit caution: Nexum as built is a document
system; the brain is much more… The risk to avoid is treating document
ingestion as the brain." Readers cannot tell what Nexum is or where it lives.
**Fix:** one definition in the README; delete or date-stamp the Phase 2
external-repo row; align architecture's "live company brain" phrasing with
tech-req's caution.

## R-29 (major) — "Workspace" is simultaneously the enterprise brain and the per-app unit

prd.md §6: "**Workspace (company brain):** provisioned → active…" and §9
"Each enterprise workspace is isolated from every other" — versus prd.md §5:
"A new workspace is created for that app inside the brain" and §6 App: "Each
app gets its own workspace within the enterprise's brain." architecture.md
uses `workspace_id` as the per-tenant RLS key on every table. The isolation
unit — the load-bearing security concept — is ambiguous: does RLS isolate
enterprises or wall apps off from each other inside one brain? The latter
conflicts with the PRD's coherence constraint ("any fact joins to any related
fact"). **Fix:** PRD glossary (enterprise/brain vs app/workspace); relabel §6;
architecture states which level `workspace_id` denotes and how cross-app joins
survive RLS.

## R-30 (major) — PRD's "everything runs in fastenv" constraint has no owner for the Forge itself

prd.md §9: "**fastenv execution.** All Superfield workloads — the Forge
itself, validation jobs, and delivered application instances — run in
fastenv." But milestone-1.md §4.1 runs the appliance "entirely within a single
host OS process group," the daemon/Postgres/loop run bare on the host per
architecture §Daemon Lifecycle, and no doc — including tech-req §4's build
order — schedules moving the Forge into fastenv. A hard PRD constraint (also
load-bearing for the isolation answer to PRD open question 9) is unclaimed.
**Fix:** soften PRD §9 to "target state," or add the Forge-in-fastenv step to
the build order / a milestone doc.

## R-31 (major) — testing.md's 150-line `act` doctrine contradicts the Accepted CI-manifest ADR

testing.md teaches "We run them locally with `act` so a local run executes the
**unmodified** workflow YAML… **the documented default**" — while
adr-ci-execution-manifest.md (Accepted 2026-07-01) rules: "The appliance does
**not** embed a GitHub Actions YAML parser or an ACT-style runner emulator…
GHA YAML as source of truth + ACT for local runs — Rejected… the emulation is
the bug source" (citing "the ci-runner image has no `node`, so ACT stops at
the first JS action" as documented pain). Both docs are current-dated;
testing.md never mentions `run-manifest`/`lint-manifest`. **Fix:** a paragraph
in testing.md's act section marking it interim-while-GitHub-remains-push-target,
cross-linking the ADR and `manifest-lint.yml`.

## R-32 (major) — Glossary chaos: four core terms with two to four referents each

*Forge vs appliance vs daemon vs binary:* PRD "The installation root is the
**Forge**"; README "The binary is the Forge"; architecture/milestone-1 say
"the appliance"/"the daemon." *Control panel vs Studio vs control webapp vs
agent IDE:* PRD/tech-req say "control panel"; architecture routes say "Studio"
— which is simultaneously the whole surface and one tab of three
(`Studio │ Viewport │ Product`, studio-ux.md). *Orchestrator:* a PRD seed app,
the `orchestrator` schema/routes (daemon control), the retired TS stack, and a
root `orchestrator/` directory holding one migration. *Loop:* "gardening
loop," "loop engine," "core loop," plus plan/dev/doc "lanes." An agent
grepping "control panel" finds nothing in the route table; "orchestrator"
retrieval mixes four referents. **Fix:** one glossary section (README or
prd.md) mapping Forge = appliance = `superfield` binary, control panel =
Studio, disambiguating orchestrator; normalize per-doc first-use ("Studio (the
PRD's control panel)").

## R-33 (minor) — Operator documentation for the customer's personas does not exist

`docs/` contains PRD, architecture, ADRs, testing invariants, eval design —
all builder-facing. There is no operator runbook, no "getting started" for the
Owner/Steerer persona, no troubleshooting guide beyond a pointer to
`daemon.log` (milestone-1 §4.2), and no support/escalation channel referenced
anywhere. The personas the PRD defines as non-engineers have zero
documentation written for them; the appliance's only manual is its source
tree. **Fix:** an operator handbook (install, first feature, approving a
change, reading cost, rollback, backup verification, "the loop looks stuck")
written for the PRD's personas, shipped inside Studio.

## R-34 (minor) — "The schema is the product" contradicts "no configuration surface," and nobody owns the work

unified-memory-layer.md:68-70 ("schema design is a product decision") and :74
("the schema team replaces the warehouse-and-ETL data team" — a team the
target org lacks) versus prd.md:132/:137 ("one coherent way to run the loop
rather than… configuration knobs"; "not… a configuration surface"). Either one
universal Superfield schema (and the per-company reframing is marketing) or
bespoke per-enterprise schema design (requiring competence the customer
lacks). **Fix:** a fixed Superfield-owned core schema
(intent/change/validation/deploy/signal) plus agent-extended per-app leaf
schemas approved at the outcome level; state which parts are immutable
product.

## R-35 (minor) — Success metrics are direction-only, baseline-free, and gameable

prd.md:40-45 — "days, not quarters," "rises," "drops from days to minutes."
No threshold, baseline method, or counter-metric anywhere. "Self-maintenance
share rises" is trivially gameable: an agent-generated bug fixed by an agent
counts as two units of self-maintenance; signal-to-correction "minutes"
measures proposal latency, not correctness. A thesis whose metrics can only
confirm it is a belief system. **Fix:** pair every velocity metric with a
quality counter-metric (rollback rate, defect-reintroduction rate,
approved-vs-proposed ratio); numeric acceptance thresholds per milestone.

## R-36 (minor) — The governed embedding pin is sunk-cost reasoning, and the standard's own documents disagree on the model's name

adr-embedding-model.md rejects every alternative principally because it
"would still require re-embedding existing corpora," asserting "no
demonstrated retrieval gain" with no benchmark; architecture.md:261 makes it
the *only* legal vector space. A 2021-era 22M-parameter sentence embedder is
frozen as the company brain's sole semantic geometry to avoid re-embedding a
prototype corpus — exactly the mechanical bulk work a dark factory makes free.
Meanwhile adr-schema-boundary.md:215 names "`Xenova/all-MiniLM-L6-v2`" (the
JS/ONNX port) while the embedding ADR and architecture name
`sentence-transformers/all-MiniLM-L6-v2`; adr-embedding still says "ONNX in
JS" vs architecture's candle/Rust pin, still lists a prototype-era "CLI —
lowdb JSON store" row, and the two disagree on whether `edge_embedding` is a
stub or populated by `ai_link.rs`. **Fix:** keep the single-vector-space
invariant, decouple it from this model (versioned embedding-space column +
designed re-embed pipeline); benchmark retrieval on code+causal-link workloads
before the brain schema locks in 384 dims; fix the name and inventory drift.

## R-37 (minor) — `/health` is readiness in milestone-1 but bare liveness in architecture

milestone-1.md §4.5: 200 only when "Postgres is accepting connections. All
migrations are applied… The gardening loop task is running" — versus
architecture.md's route table: "Unauthenticated liveness probe — returns
`{\"status\":\"ok\"}`." An operator building monitoring per milestone-1
assumes guarantees architecture doesn't make. **Fix:** state the actual
contract in both (gate implicit in bind-after-health-gate, or `/health` really
checks — say which).

## R-38 (minor) — Dangling and stale cross-references

control-template-integration.md's banner points at "§Control Webapp" in
architecture.md — no such section (zero grep hits). prd.md:3 "supersedes
`product.md`" — the file doesn't exist. testing.md records fixtures against
`dot-matrix-labs/superfield-ts` while README/`.gitmodules` use
`superfield-ai`. eval-design claims Tier 2 "runs nightly" vs testing.md
"there is no nightly workflow… only manually before a release." milestone-1
§4.2 says "Start Postgres **container**" (and "state… when the **container**
is stopped") vs architecture's explicitly no-container
`LocalPostgresProvisioner` ("no Docker, no root") — leaving ambiguous whether
the customer host needs a container runtime at all (L4:F10). Each is small;
together they signal which docs stopped being maintained. **Fix:** point the
banner at §HTTP Routes; drop the product.md clause; s/container/instance/;
align the nightly claims; fix the org name.

## R-39 (minor) — Sharp's native hash algorithm is told two ways

rust-reorg-decisions.md: "reuse existing `sharp.objects` **SHA-256** content
store… native sharp objects stay SHA-256" (echoed by architecture's
`workspace` module) — versus
`docs/scout/sharp-object-algo-column-seams.md` quoting the whitepaper:
"`algo`… `sha1` (default) or `sha256`" and "Sharp's object IDs _are_ Git's
object IDs. Git defaults to SHA-1." Whether native objects are SHA-256
(git-incompatible ids) or default SHA-1 (git-identical) changes the interop —
and exit-path (R-16) — story. **Fix:** one line in architecture §Sharp stating
the truth (e.g., native SHA-256; `algo` default `sha1` applies to imported git
objects only), superseding the ambiguity.

---

# What is genuinely strong

Consolidated from all four lenses — these are real, not consolation prizes.

**Concept.**
- **The core diagnosis is sharp and original.** "An agent reads the stale spec
  with exactly the same confidence as the fresh one, and has no way to
  triangulate" (unified-memory-layer.md:5) is a real, under-articulated
  insight; framing fragmentation as a *distance* problem agents can't cross is
  the strongest idea in the corpus.
- **Intellectual honesty rare in vision documents.** Validation is named as
  the unsolved hard part (unified-memory-layer.md:58-62); "What This Is Not"
  (:100-106) prunes overclaims; the PRD's Open Questions (prd.md:152-162) ask
  most of the right questions; technical-requirements §3's "nothing is
  grandfathered in" disposal of the prototype, its candid "not yet existing in
  any form" inventory, and eval-design labeling its own roughness are honest
  self-audit. (The problem is that several open questions are load-bearing,
  not that they're unasked.)
- **The green-wedge GTM is a genuinely good adoption answer** — bounded blast
  radius, no rip-and-replace, no incumbent displacement
  (unified-memory-layer.md:133-139) — even though it contradicts the maximal
  thesis (R-14).
- **The appliance/sovereignty posture is well-timed** — self-hosted,
  own-trust-boundary AI (prd.md:59) is arguably the strongest moat candidate
  the docs have, though they never argue it as one.
- **The backlog problem is real and large**, for exactly the cost-structure
  reasons prd.md:7-9 gives; **spec inversion is a novel, plausible
  maintenance-phase mechanism** for well-trafficked apps; and **dogfooding by
  construction** is circular as *proof* but excellent as an
  *evidence-generating machine*.

**Architecture.**
- **adr-ci-execution-manifest.md is the best-reasoned document in the set** —
  the spec/substrate decomposition of GHA, "agent authors the
  schema-conformant artifact, deterministic executor enforces it," shipped as
  a closed loop (schema, executor, adapter, gate).
- **Fail-closed governance primitives:** no active policy → every change
  requires approval; NULL workspace_id → RLS returns nothing; `MergeDecision`
  computed identically on the pure and persisted paths by construction.
- **Sharp's core guarantees** (no non-compiling merge reaches storage,
  provenance via episodes, projections for speculative merges) map directly
  onto agent-cadence needs — the requirement, not the tool, drives retention.
- **Pragmatic substrate minimalism:** one stock Postgres, recursive CTEs over
  a patched-build AGE dependency, local candle inference — real complexity
  refusals.
- **Read-only-by-construction connector seam** — the PRD non-goal enforced
  structurally (no write verbs in the trait, test-asserted), not by
  documentation.

**Operations.**
- **Daemon lifecycle engineering is appliance-grade:** flock'd auto-spawn,
  health-gated boot (Postgres up + migrations applied before the socket
  binds), atomic `daemon.json`, drain-before-stop cursor commit,
  version-mismatch self-replacement.
- **Durable, resumable loop:** at-least-once cursor semantics, crash-resume,
  no busy-loop (milestone-1 §4.4).
- **Episode traces as an audit ledger** — every prompt/tool-call/judge
  recorded in `sharp.episodes`, directly serving the Auditor persona.
- **Credential hygiene** (key never logged/persisted; boot banner carries
  state only, architecture.md:611); **local embeddings** avoid an external API
  on the hot path; **replication drill tooling exists and is tested locally**;
  RPO/RTO targets are stated as concrete numbers.

**Corpus.** The inner canon — prd.md, technical-requirements.md,
architecture.md, milestone-1.md, testing-invariants.md, the vision doc — is
unusually coherent for its ambition: PRD constraints trace into tech-req
sections and architecture seams, and the prototype/appliance boundary is
explicitly declared. The drift lives at that boundary's unbannered edges.

---

# How to improve the product

A prioritized roadmap in three horizons.

## Horizon A — Document hygiene, doable this week

Cheap, high-leverage, and the most on-thesis work available: a corpus that
agents read as ground truth must not contain stale facts. In rough order:

1. **Superseded-banner pass on the stale ring** (R-11, R-21, R-26, R-31):
   rust-reorg-decisions.md §Gate (point at testing-invariants.md),
   runtime-agent-selection.md, studio-ux.md's GitHub/`packages/db` sections,
   testing.md's `act` section and first paragraph. The banner pattern already
   exists in control-template-integration.md — copy it.
2. **Fix the duplicated-decision drift** (R-22, R-36): one owner for the
   migration order; sync the two schema-table inventories (add
   `forge.policies`, `public.workspaces` to architecture.md); one canonical
   embedding-model identifier; delete the TS graph-traversal attribution.
3. **Write the glossary** (R-32, R-28, R-29): Forge = appliance = `superfield`
   binary; control panel = Studio; enterprise/brain vs app/workspace;
   disambiguate "orchestrator" and "Nexum." Put it in prd.md or the README and
   normalize first-use everywhere.
4. **Reconcile the completion record** (R-07): amend milestone-1.md §4.6 to
   delivered-as-schema-only, or retract architecture.md's "all closed" line;
   cross-link eval-design as owner of the acceptance-criteria gap.
5. **Fix the contradiction one-liners** (R-37, R-38, R-39, R-30): `/health`
   contract, dangling §Control Webapp/product.md references, org names,
   "container" wording, Sharp hash-algo sentence, fastenv-for-the-Forge marked
   "target state" or scheduled.
6. **Rewrite the README front door** (R-01): PRD vocabulary, `cargo build`
   labeled as the developer path, "Agent IDE" retired or glossed.
7. **Make cross-doc consistency an automated gardening-loop check** (R-26):
   the cheapest possible demonstration of the thesis on itself.

## Horizon B — Design work required before the appliance claim is honest

These are the gaps between "a strong prototype with strong documents" and "a
thing a no-engineering org can run." Each needs an ADR or a milestone, not a
banner.

1. **Budget enforcement** (R-04): per-workspace daily/monthly caps enforced in
   `sf-loop` before each step; pause + notify at threshold; unit-economics
   page maintained by the loop. This is the appliance's circuit breaker —
   nothing else in Horizon B matters if the customer's first month ends in an
   uncapped invoice.
2. **Approval-queue economics** (R-02): batching by blast-radius class,
   per-window risk budgets, sampling review, back-pressure on
   `awaiting-approval` depth; independent (non-self-graded) risk scoring;
   behavior-level (not diff-level) review artifacts; canary deploys with
   auto-rollback as the default blast-radius control.
3. **Fail-closed governance everywhere** (R-03, R-06): missing Blueprint =
   boot failure; fixture executor behind an explicit dev flag with a loud
   banner; the Blueprint-conformance ADR (rule → checkable predicate → verdict
   in `forge.validation_runs`).
4. **The installer and upgrade path** (R-05, R-24): signed single-binary
   release + systemd unit; signature-verifying `install.sh`; boring
   `superfield self-update` with drain/swap/migrate/health-gate/rollback;
   "zero-toolchain to running daemon in 5 minutes" as a CI-gated acceptance
   test; the appliance-image ADR bundling the toolchain constellation.
5. **Operator UX** (R-06, R-23, R-33): first-boot credential flow in Studio
   with encrypted storage; one-click PITR; appliance-local backups scheduled
   by the daemon with restore drills as a health metric; one-click env
   rollback as the primary Studio affordance; the operator handbook shipped
   inside Studio; CLI demoted to internal/agent surface.
6. **Security defaults** (R-18): bind 127.0.0.1 by default; bootstrap-secret
   gate on `session`/`register`; per-install generated credentials; embedded
   TLS; the SSO/agents-as-principals ADR.
7. **Throughput design for the premise** (R-19, R-20, R-10): the loop-engine
   DAG with per-step concurrency and event triggers; a numeric merge-gate
   latency budget with warm analyzer pools and projections-as-default; the
   batch-review human surface.
8. **Kill the dual track** (R-25, R-27): Rust as source of truth for RLS and
   the manifest; archive `packages/`/`orchestrator/`; `lint-manifest` in the
   FastENV executor; releases on a vendor domain.
9. **The brain-schema ADR** (R-09): event model, clock, intent-as-records,
   causal links — before further component-schema hardening. Sequence it
   ahead of anything that writes more governance language around the current
   union.

## Horizon C — Strategic and product decisions for the founders

No amount of engineering closes these; they are choices.

1. **The target-user decision** (R-01, R-02) — **DECIDED (2026-07-02).**
   The founder's ICP: any company with more than $10M annual revenue that
   does not hire full-time engineers — a skeletal technical staff, possibly
   with a technical lead under whatever title (CIO, CTO, COO). Operational
   bar: administrable by a sysadmin-generalist; comparable category:
   on-prem NAS/firewall appliance (see Addendum 2026-07-02). The downstream
   remediation — rewriting prd.md §2-3 (role model, "large enterprise,"
   "office of the CTIO," "Steerer") for this buyer — is no longer a founder
   decision and now belongs to Horizon A/B work.
2. **The defensibility thesis** (R-08, R-15). Write the document that names
   the buyer, the price anchor, the real 2026 alternatives (low-code, a
   contractor with a frontier agent, lab-hosted app-building), and the moat —
   sovereignty positioning, the Nexum curriculum flywheel, brain switching
   costs — with kill criteria. If none survive, plan for speed-to-category
   and acquisition explicitly.
3. **Premise-timing tripwires** (R-17). Name the load-bearing assumptions
   (model reliability at the autonomy threshold, regulatory posture, labs'
   vertical-integration appetite), the leading indicator for each, and the
   pre-planned pivot per scenario: premise-late (product regresses to an
   AI-assisted dev tool — crowded market), premise-early (labs arrive first;
   the steering surface is obsolete), reliable-but-regulated (per-customer
   certification burden vs a hosted competitor's amortized one).
4. **The exit-path guarantee** (R-16). Commit contractually to continuous
   export: source-as-git-tree (Sharp is already git-compatible — make it a
   promise), brain-as-portable-schema. The single-blast-radius objection
   cannot be rebranded as the moat; the answer to "what if Superfield
   disappears" must be a product feature, or risk-averse buyers — the PRD's
   own — will not sign.
5. **Falsifiable success metrics** (R-35, R-12, R-13): pair every velocity
   metric with a quality counter-metric and numeric thresholds; publish "the
   Forge fixed X defects in itself autonomously" as the thesis's tracked
   evidence; bound spec inversion to maintenance-phase, sufficiently-trafficked
   apps and specify the bootstrap path honestly.

---

## Remediation log

Remediations against this review's findings are recorded here as they land.

| Date | Finding ids | Remediation | Status |
|------|-------------|-------------|--------|
| 2026-07-02 | R-01 (partial) | Founder ICP decision recorded; PRD rewrite pending | logged |
| 2026-07-02 | R-02 | DECIDED: approval is outcome-level only (behavior demos, never diffs); trust escalation proceeds as default assumption pending explicit ratification | logged |
| 2026-07-02 | R-10 | DECIDED (inferred): Studio primary mode is batch review of completed candidates; live cockpit demoted to interim/degraded mode | logged |
| 2026-07-02 | R-03 | DECIDED (inferred): policy ships as certified templates; Blueprint as fail-closed versioned rule set proceeds as default assumption | logged |
| 2026-07-02 | R-08 | DECIDED: no cross-customer flywheel — nothing leaves the appliance; defensibility thesis = sovereignty + switching costs. DECIDED: MSP/VAR-first channel; buyer path runs through partners, adding fleet-management requirement and MSP-grade operator docs | logged |
| 2026-07-02 | R-09 | DEFAULT: one fixed Superfield-owned core schema with agent-extended leaves (unratified) | logged |
| 2026-07-02 | (exit path) | DEFAULT: continuous export guarantee (git tree + portable schema) treated as product requirement (unratified); vendor-liability question deferred to counsel | logged |
| 2026-07-02 | R-08, C-10, (liability/pricing) | PARKED as commercial-track details per founder decision: vendor liability + license (to counsel), pricing model, premise-timing tripwires, and the read-boundary/data-residency questions are deferred from product docs to the commercial workstream | logged |
| 2026-07-02 | (new requirement) | PROMOTED to product feature per founder decision: multi-appliance fleet management for MSP/VAR partners — partner-facing provisioning, monitoring, upgrade, and health surface across the customer appliances they operate; not yet mentioned in any project doc, needs PRD/feature intake | logged |
| 2026-07-02 | R-02, R-03, R-09, (exit path) | RATIFIED: the four standing defaults are now decisions — trust escalation via per-window risk budgets and sampling audits; Blueprint as versioned fail-closed rule set in the brain; one fixed Superfield-owned core schema with agent-extended leaves; guaranteed continuous export (git tree + portable schema) | logged |
| 2026-07-02 | R-04 | ADOPTED: enforce a hard per-workspace daily/monthly budget in `sf-loop` before each step (pause and notify the Owner at threshold) and publish a loop-maintained unit-economics page. | planned |
| 2026-07-02 | R-05 | ADOPTED: ship a signed, checksummed single-binary release with signature-verifying `install.sh` and systemd unit, define the appliance-image ADR bundling the pinned toolchain constellation with extended doctor coverage, and make zero-toolchain install-to-running-daemon in under 5 minutes a CI-gated acceptance test. | planned |
| 2026-07-02 | R-06 | ADOPTED: build a first-boot Studio credential flow with encrypted storage that hard-refuses to run the production loop on fixtures (dev-flag-gated with a loud degraded-mode banner), plus one-click PITR and control-panel credential/health workflows, demoting the CLI to an internal/agent surface. | planned |
| 2026-07-02 | R-07 | ADOPTED: amend milestone-1.md §4.6 to delivered-as-schema-only (or retract architecture.md's completion line), cross-link eval-design as owner of the acceptance-criteria gap, run the nightly Tier-2 eval on the pinned shipped default model, and land executable acceptance criteria before marketing outcome guarantees. | planned |
| 2026-07-02 | R-11 | ADOPTED: add a SUPERSEDED-in-part banner on rust-reorg-decisions.md §Gate pointing at testing-invariants.md, and provision resource-backed CI lanes so DB/rust-analyzer tests fail loudly instead of silently skipping. | planned |
| 2026-07-02 | R-12 | ADOPTED: publish "the Forge fixed X defects in itself autonomously, N% approved" as a tracked metric and treat the studio-ux route mismatch as its acceptance test. | planned |
| 2026-07-02 | R-13 | ADOPTED: bound the spec-inversion claim to maintenance-phase sufficiently-trafficked apps, specify the bootstrap path (structured intake, agent-generated clickable prototypes), and set a minimum-signal threshold below which the loop must not auto-infer intent. | planned |
| 2026-07-02 | R-14 | ADOPTED: downgrade whole-company-coherence claims to what the green wedge supports, make freshness a first-class schema property on external replicas, and future-flag the whole-business-view language. | planned |
| 2026-07-02 | R-18 | ADOPTED: bind 127.0.0.1 by default, gate `session`/`register` behind a bootstrap secret, generate per-install credentials, add an embedded TLS flow, write the SSO/agents-as-principals ADR, and put a hardening checklist in the health gate. | planned |
| 2026-07-02 | R-19 | ADOPTED: design the re-rooted loop engine now as a DAG of resumable jobs over the brain (using the existing `nexum.job_queue`) with per-step concurrency and event triggers instead of fixed cycle plus sleep. | planned |
| 2026-07-02 | R-20 | ADOPTED: set a numeric merge-gate latency budget alongside the fastenv one, backed by persistent warm rust-analyzer/tsserver pools, incremental `cargo check` against snapshots, and projections as the default path so merge is a cache hit. | planned |
| 2026-07-02 | R-21 | ADOPTED: banner runtime-agent-selection.md as prototype-era, rewrite testing.md's first paragraph, and write the appliance LLM-boundary ADR covering provider abstraction, hard budget enforcement at the executor seam, persistent availability state, and a customer-perimeter model-serving path. | planned |
| 2026-07-02 | R-22 | ADOPTED: make one document own the migration order (the other points by reference), sync the two schema-table inventories, fix or ratify the migration filename convention, and delete the stale TS graph-traversal attribution. | planned |
| 2026-07-02 | R-23 | ADOPTED: default to an appliance-local backup target configured in Studio, use the daemon's loop as the scheduler, replace the no-op backup seam with an enforced health check that raises a high-severity signal, and add one-command `superfield restore` plus periodic automated restore drills as a health metric. | planned |
| 2026-07-02 | R-24 | ADOPTED: ship a boring `superfield self-update` (download, verify signature, drain, swap, migrate, health-gate, auto-rollback on failed gate) before pursuing loop-driven self-modification. | planned |
| 2026-07-02 | R-25 | ADOPTED: invert ownership now — Rust canonical for RLS and the fastenv manifest with TS generated or deleted, a CI gate diffing the RLS pair until k3s retires, fastenv as default backend at parity, and `packages/`/`orchestrator/` split or archived so the distribution artifact contains only the appliance. | planned |
| 2026-07-02 | R-26 | ADOPTED: rewrite studio-ux.md against the sf-serve route table (or banner the GitHub/`packages/db` sections as prototype-historical), fix the PATCH/update mismatch, and make cross-doc consistency an automated gardening-loop check. | planned |
| 2026-07-02 | R-27 | ADOPTED: host release artifacts on a vendor domain, run `lint-manifest` in the FastENV executor as the primary gate, and reshape the analytics contract around `forge.validation_runs` before more UI binds to the GitHub-shaped envelope. | planned |
| 2026-07-02 | R-28 | ADOPTED: give Nexum one definition in the README, delete or date-stamp the Phase-2 external-repo row, and align architecture's "live company brain" phrasing with tech-req's fit caution. | planned |
| 2026-07-02 | R-29 | ADOPTED: add a PRD glossary distinguishing enterprise/brain from app/workspace, relabel §6, and have architecture state which level `workspace_id` denotes and how cross-app joins survive RLS. | planned |
| 2026-07-02 | R-30 | ADOPTED: soften PRD §9's everything-runs-in-fastenv constraint to "target state," or add the Forge-in-fastenv step to the build order or a milestone doc. | planned |
| 2026-07-02 | R-31 | ADOPTED: add a paragraph to testing.md's `act` section marking it interim-while-GitHub-remains-push-target, cross-linking the CI-manifest ADR and `manifest-lint.yml`. | planned |
| 2026-07-02 | R-32 | ADOPTED: write one glossary section mapping Forge = appliance = `superfield` binary and control panel = Studio, disambiguating "orchestrator," and normalize per-doc first-use. | planned |
| 2026-07-02 | R-35 | ADOPTED: pair every velocity metric with a quality counter-metric (rollback rate, defect-reintroduction rate, approved-vs-proposed ratio) and set numeric acceptance thresholds per milestone. | planned |
| 2026-07-02 | R-36 | ADOPTED: keep the single-vector-space invariant but decouple it from the pinned model via a versioned embedding-space column and a designed re-embed pipeline, benchmark retrieval on code-plus-causal-link workloads before the brain schema locks in 384 dims, and fix the model-name and inventory drift. | planned |
| 2026-07-02 | R-37 | ADOPTED: state the actual `/health` contract in both milestone-1.md and architecture.md — either the readiness gate is implicit in bind-after-health-gate or `/health` really checks, and say which. | planned |
| 2026-07-02 | R-38 | ADOPTED: point control-template-integration.md's banner at §HTTP Routes, drop the product.md clause, replace the "container" wording, align the nightly-eval claims, and fix the org name. | planned |
| 2026-07-02 | R-39 | ADOPTED: add one line in architecture §Sharp stating the truth — e.g. native objects are SHA-256 with the `algo` default `sha1` applying to imported git objects only — superseding the ambiguity. | planned |

All 39 findings now have a plan of record (2026-07-02). The project-docs
sweep against this log is authorized.

---

## Summary

- Reviewed Superfield's concept, architecture, docs, and operational reality
  through four adversarial lenses; 59 raw findings deduplicated to 39 (11
  critical, 21 major, 7 minor).
- Core tensions: the safety model presumes engineers the customer lacks; the
  1000-tok/s premise is asserted but not designed for; governance is fail-open
  where the thesis demands fail-closed; the appliance is a claim, not an
  artifact; the doc corpus violates its own staleness thesis; no commercial or
  defensibility case exists.
- Real strengths: the fragmentation-as-distance diagnosis, fail-closed policy
  and RLS primitives, the CI-manifest ADR, daemon lifecycle engineering, and
  unusual self-honesty.
- Roadmap: banner-and-glossary hygiene this week; budget, approval-economics,
  installer, operator-UX, and security design before the appliance claim;
  founder decisions on moat, premise tripwires, and exit path. The target-user
  decision is made (Addendum 2026-07-02): mid-market, no-full-time-engineers
  ICP, IT-admin-grade appliance; the prd.md §2-3 rewrite it implies is pending
  (see Remediation log).
