# Open Tensions Review — Superfield (Second Pass)

**Date:** 2026-07-03
**Type:** Second-pass review — open tensions and contradictions remaining after
the 2026-07-02 red-team review, its remediation cycle, and the founder
decision set (not a line-level code review)
**Status:** Findings report — no fixes applied

## What was reviewed, and how

This is the second-pass companion to
[`docs/code-reviews/2026-07-02-red-team-concept-review.md`](2026-07-02-red-team-concept-review.md).
The first review found 39 consolidated findings; every one of them acquired a
plan of record on 2026-07-02, and an authorized docs sweep landed the same day
across twelve canonical documents. A set of founder decisions was ratified
alongside: outcome-level approval, batch-review Studio, certified policy
templates, the fixed Superfield-owned core schema, guaranteed continuous
export, no cross-customer flywheel, the MSP/VAR-first channel, bundled
inference through the partner, fail-closed installs, "seams now, serial
implementation," and archive-the-prototype-now.

This review asks the question the first one could not: **now that the decisions
exist, do they cohere — with each other, with the thesis, and with the swept
documents?** It is a stress test of the decision set and an audit of the
remediation, not a re-litigation of the first review.

Three independent adversarial lenses were run by separate reviewers:

1. **Decision-set tensions** — do the ratified decisions contradict each other
   or the core thesis? (Findings T-1 through T-12, plus sound pairings.)
2. **Residual and freshly-introduced document contradictions** — did the
   2026-07-02 sweep leave contradictions standing, or create new ones?
   (Findings X-1 through X-16, plus a checked-and-CLEAN list.)
3. **Structural product-shape claims that survived remediation** — which of
   the first review's deepest objections are still true of the corpus as it
   stands today? (Findings P-1 through P-9.)

The three raw sets total **37 findings: 6 critical, 21 major, 10 minor**
(criticals: T-1, T-5, X-1, P-1, P-3, P-4). Where findings from different
lenses touch the same underlying issue they are **cross-referenced, not
merged** — the lenses saw different faces of the same object, and each face
carries its own evidence. Overlaps are named inline.

All file citations are to the repository state at review time, on top of the
merged remediation PRs (#838, #852, #853, #856).

---

# Executive summary — the cross-cutting patterns

Five patterns account for most of the findings. They are worth reading before
the individual items, because the fix for a pattern is rarely the sum of the
fixes for its instances.

**1. Every absolute guarantee acquired an unstated exception — mostly via the
MSP bundle.** The decision set ratified guarantees in absolute language:
"nothing leaves the appliance, and no data crosses between customers"
(`docs/prd.md:157`), "no hostage problem" as a product guarantee
(`docs/prd.md:162`), "no external release process is required" for Forge
evolution (`docs/prd.md:151`). The same decision set then ratified an MSP
bundle — partner-owned inference credential, partner fleet-management plane,
partner-set spend cap, vendor-distributed core schema and templates — each of
which quietly amends a guarantee: data-in-use transits a frontier lab under a
credential the customer doesn't own (T-1); a standing cross-customer partner
plane collects telemetry and holds access across brains (T-5); the customer's
ability to *think* depends on a partner contract (T-7); the fixed core can only
change via a vendor channel the self-sufficiency claim says doesn't exist
(T-11); and the no-flywheel commitment deletes the evidence channel the
falsifiability remediations depend on (T-12, T-6). None of these exceptions is
stated in the documents that carry the guarantees. The pattern-level fix is a
single honest move: convert each absolute into "nothing except…" with the
exception named, or redesign the mechanism so the absolute holds.

**2. The three "bound the claim" remediations never landed — they are the only
adopted findings whose status is bare "planned," and every claim they targeted
stands verbatim.** R-12 (publish the Forge self-fix metric), R-13 (bound
spec-inversion to maintenance-phase apps above a signal floor), and R-14
(downgrade whole-company-coherence claims; make freshness a schema property)
are recorded as ADOPTED at review lines 1315–1317 with status "planned" — and
the 2026-07-02 sweep touched none of their targets (P-1, P-3, P-4; the vision
halves are X-5, X-6). The sweep closed the findings that required *rewriting
claims to match decisions*; it skipped the findings that required *shrinking
claims to match evidence*. That asymmetry is itself a finding: remediation was
narrative in the flattering direction.

**3. The sweep created a new drift class: ratified target state written as
present-tense fact.** The PRD now states "the Blueprint gate fails closed"
while architecture.md documents the shipped fail-open loader as a defect, and
states batch review "is" the primary mode while no batch surface exists (P-7).
A PRD-only reader — including the product's own agents, which is the thesis
case — acquires false facts about the flagship governance properties. The
corpus already owns the fix (the "(target state)" marker the sweep itself
added for fastenv, R-30); it was applied once and then not applied uniformly.
The same reclassification move closed two open questions by renaming them
requirements with zero design behind the badge (P-8).

**4. The vision document is an unswept pre-ICP artifact.** `docs/vision/
unified-memory-layer.md` was not in the twelve-document sweep and now
contradicts the ratified corpus on the customer (large enterprise vs
no-engineer mid-market, X-1), schema ownership (customer schema team vs
Superfield-owned core, X-2), the review model (patch review vs never-diffs,
X-3), export (no-Git-remote vs ratified continuous git export, X-4), the
retired "agent IDE" term (X-7), and it carries the unbounded whole-company and
spec-inversion claims R-13/R-14 were adopted to bound (X-5, X-6). One vision
sweep resolves seven findings.

**5. The highest-leverage unowned design is a three-link join: Forge self-fix
metric → template certification evidence → initial risk budgets.** The R-12
metric (P-4) is the only candidate evidence for vendor certification of policy
templates (T-6, P-5), and template-carried initial risk budgets are the only
designed escape from the trust-escalator cold start (T-3, P-5) — which
otherwise deadlocks behind one part-time approver at the highest-change-volume
moment the appliance will ever see. Add the unassigned risk score (P-6) and
every quantity in PRD §9 is unanchored. No document owns any link of this
chain. It is one trust-escalator design doc, and it is the single most
valuable piece of design work the corpus is missing.

**Severity distribution:** 6 critical, 21 major, 10 minor. Two of the
criticals are decision-set tensions requiring founder-level forks (T-1
bundled inference vs the sovereignty moat; T-5 partner fleet plane vs
cross-customer isolation); the other four are unlanded-remediation and
unswept-document criticals resolvable by authorized work (X-1, P-1, P-3, P-4).
The full decision queue (7 forks) and fix queue follow the findings.

---

# Part 1 — Decision-set tensions (T-1 … T-12)

The decision set vs itself and vs the core thesis. Reviewed: all four
canonical docs plus the full red-team review (addendum + remediation log,
lines 46–80 and 1294–1353 of
`docs/code-reviews/2026-07-02-red-team-concept-review.md`).

## T-1 (critical) — Bundled-MSP inference guts the sovereignty moat it is supposed to fund

**Pole A:** Sovereignty is the ratified defensibility thesis and a product
guarantee. PRD §9 Isolation (`docs/prd.md:157`): "nothing leaves the
appliance, and no data crosses between customers." §9 Continuous export
(:162): "Sovereignty and the absence of a hostage problem are product
guarantees." Vision (`docs/vision/unified-memory-layer.md:88`): agents work
"without … ever leaving the brain to ask another system what is true."
Remediation log: "defensibility thesis = sovereignty + switching costs"
(review:1304).

**Pole B:** Inference is bundled via the MSP — "Superfield/partner owns the
frontier-model relationship … first boot requires no customer API key"
(review:1338). Every gardening pass therefore ships the brain's most sensitive
contents — source, intent, business signal, systems-of-record reads — to a
frontier lab's API **under a credential the customer neither owns nor has a
contract behind**. In-perimeter serving is deferred to a future premium tier.

**Why it matters:** The sovereignty claim degrades to "your data-at-rest is
on-prem; your data-in-use transits a hosted lab under a third party's
account." That is weaker, not stronger, than a customer using the lab directly
(who at least gets their own DPA/zero-retention terms). The addendum names
sovereignty/regulated-industry positioning as "the one place hosted lab
offerings can't follow" (R-08) — but the lab sees the same prompts either way;
the differentiator collapses to storage location. The parked data-residency
question (`docs/prd.md:175`) gets *harder*: residency is now determined by the
partner's API account region, invisible to the customer. And "nothing learned
leaves the appliance" is falsified at the traffic layer unless the lab
contractually zero-retains — a contract the **partner**, not Superfield or the
customer, holds.

**Resolutions:** (a) Reframe honestly as "sovereign state, brokered
inference": mandatory zero-retention flow-down in the partner contract,
customer-visible data-path disclosure in Studio, and pull in-perimeter serving
as the launch answer for the regulated segment. Trade-off: weakens the
marketing claim now; local serving fights the 1000-tok/s premise. (b) Offer a
customer-owned-key/BYO-enterprise-agreement mode alongside the bundle.
Trade-off: breaks bundle economics, the spend-cap semantics (T-4), and the
no-key-at-first-boot UX that solved R-06.

## T-2 (major) — MSP-as-operator re-staffs the human org the thesis eliminates; the buyer identity flips

**Pole A:** The thesis: agent autonomy replaces the engineering org; ICP is a
company that "does not hire full-time engineers" (`docs/prd.md:7,189`); the
review's premise frame is "post-human software development" (review:36–43).

**Pole B:** MSP/VAR-first channel with the partner able to "staff the
Administrator role" and operate the appliance fleet (`docs/prd.md:58,70,134`;
review:1304).

**Why it matters:** The customer's "no engineers" is now satisfied by renting
the partner's humans — a standing professional operator wrapped around a
product whose pitch is removing standing professional operators. Two collapses
threaten: (1) the value prop drifts toward "AI-leveraged MSP tooling," where
the comparison set is RMM/PSA vendors plus a frontier agent, not a new
category; (2) the real economic buyer becomes the MSP (they choose the
product, own the model relationship, set the cap, hold the fleet plane), while
the PRD is written as if the CIO/COO is the buyer. Superfield's relationship
with its stated customer is intermediated on every axis that matters —
inference, operations, upgrades — which also weakens the switching-cost moat
*for Superfield* (the customer's switching relationship is with the partner).

**Resolutions:** (a) Declare the two-sided product explicitly: PRD for the
company, a partner PRD for the MSP, with the value split named (agents do the
engineering; the partner does provisioning/ops, not development) and a
direct-sale path preserved so the channel is a multiplier, not the buyer.
Trade-off: two personas to serve before v1. (b) Accept MSP-as-buyer and
reposition (fleet product, per-appliance economics). Trade-off: abandons the
post-human category claim; the vision doc's terminal state becomes marketing.

**Note in favor:** the channel choice fits the ICP's real buying behavior
(this segment already buys firewalls through MSPs) — the tension is with the
thesis, not with GTM realism.

## T-3 (major) — Fail-closed install + one part-time approver vs "time to first app in days": the escalator has a cold-start deadlock

*Overlap: P-5 examines the same cold start from the document side — the
fail-closed default lives only in the review log, and certified templates as
written can contradict it.*

**Pole A:** "Fresh appliances ship fail-closed — every change requires
outcome-level approval at install; the trust escalator … earns autonomy per
change-class from track record" (review:1340). The approval queue is one
non-engineer (R-02 addendum, review:69, 237–241).

**Pole B:** Success metric: "time from adoption to a first backlog app shipped
… measured in days" (`docs/prd.md:42`); agents produce changes "orders of
magnitude faster than humans" (`docs/technical-requirements.md:34`).

**Why it matters:** Standing up the first app is the highest-change-volume
period the appliance will ever see, gated at the throughput of one part-time
person. Worse, the escalator is circular at t=0: autonomy requires track
record; track record accrues at approval throughput; and the sampling audits
need quality signal (rollbacks, defects, usage) that doesn't exist before the
app ships — the same bootstrap gap as R-13's spec inversion. Batch review (the
ratified Studio primary mode) mitigates queue mechanics but not judgment cost:
at standup there is no "representative data" or before/after baseline to
demonstrate against, so the approver's first hundred decisions are the
least-informed ones.

**Resolutions:** (a) Make the certified template pre-certify a "greenfield
standup" change class — net-new code in an empty workspace, no external reads,
no deploy beyond preview — as autonomous from install, so fail-closed applies
to changes with blast radius > 0. Trade-off: shifts safety weight onto
template certification (see T-6). (b) Approve the standup as one outcome (the
delivered v1 demo), not N changes. Trade-off: one large under-audited batch;
per-change audit trail (PRD §9 Auditability) is thin for exactly the period
auditors will ask about.

## T-4 (major) — The partner-set spend cap protects the wrong party and was decided before pricing exists

**Pole A:** The self-improving promise: correction "at the speed data updates"
(`docs/prd.md:32,44`), self-maintenance share rising (:45); tech-req §2.4: "a
broken live system always outranks new feature work."

**Pole B:** "The spend cap is enforced as vendor/partner margin protection and
set by the partner" (review:1338); R-04's adopted mechanism pauses the loop
and notifies the Owner at threshold (review:1310).

**Why it matters:** When the cap fires, the customer's appliance visibly stops
improving — and, as specified, stops *correcting*: nothing in the decision
exempts corrective/security changes from the pause, directly contradicting
broken-system-first. The entity harmed (customer) is not the entity protected
(partner margin), and the notification goes to an Owner who cannot raise a cap
the partner sets — an alert with no remedy for its recipient. The perverse
incentive is structural: with tokens priced in, every token is partner COGS,
so the partner maximizes margin by throttling exactly the autonomous activity
the product is sold on. And because pricing is **parked** (review:1307), the
cap's semantics were ratified against an undefined denominator.

**Resolutions:** (a) Two-tier budget: a reserved corrective/security allowance
that never pauses (broken-first honored), plus a partner-capped
discretionary-improvement budget; cap breaches surface to *both* parties with
a customer-side purchase path. Trade-off: partner margin exposed to runaway
corrective loops — needs a defect-loop circuit breaker instead. (b) Un-park
pricing enough to define the cap: publish the unit-economics page (already
adopted, R-04) as a three-party artifact so cap-setting is contractual, not
discretionary. Trade-off: drags a parked commercial question back into the
product track.

## T-5 (critical) — Partner fleet management is a standing cross-customer trust surface inside a "nothing crosses between customers" architecture

**Pole A:** PRD §9 Isolation (:157): "Each company's brain is isolated by the
appliance boundary: nothing leaves the appliance, and no data crosses between
customers." The whole trust model (RLS, workspace isolation, appliance
boundary — `docs/technical-requirements.md:25`) is designed *within* one
brain; the review praised these primitives as fail-closed.

**Pole B:** PRD §7 (:134) and the Partner operator role (:58): a partner
"operates one or more customer appliances … through a multi-appliance
fleet-management surface" — provisioning, monitoring, upgrade, health, and
possibly the Administrator role (backup/restore, i.e., data-plane access).

**Why it matters:** A standing partner credential across many customers'
brains is precisely the MSP supply-chain surface (Kaseya-class): one
compromised partner tech = fleet-wide access to stores that each hold a
company's source, operational record, and synthesized business view. The fleet
surface also necessarily moves *some* data off-appliance (health, versions,
cost telemetry) into a cross-customer pane, quietly amending "nothing leaves
the appliance" to "nothing except what the partner plane collects." No
document designs this trust boundary — the remediation log itself says the
feature is "not yet mentioned in any project doc, needs PRD/feature intake"
(review:1308); the PRD sweep added the requirement but no trust design. RLS
assumptions (per-workspace, per-brain) simply do not model a cross-appliance
principal.

**Resolutions:** (a) Control-plane-only partner plane:
health/version/provision/upgrade, hard data-plane exclusion enforced
structurally (like the read-only connector trait), short-lived per-customer
per-action credentials, customer-visible audit of every partner action in
their own brain. Trade-off: partner cannot staff Administrator fully (restore
touches data) — the role split must be redrawn. (b) Pull-based fleet:
appliances publish signed outbound health beacons; no inbound standing
credential; upgrades staged by `superfield self-update` with partner
*approval* but appliance-side execution. Trade-off: slower partner incident
response; weakens the fleet-ops sales pitch to MSPs.

## T-6 (major) — Certified policy templates without a flywheel: certification with no evidence channel

*Overlap: P-5 finds the same hole from the design side — certification is
undefined, and its only candidate evidence source is the R-12 metric that
doesn't exist (P-4).*

**Pole A:** "Policy enters the system only as certified templates the Owner
selects and tunes" (`docs/prd.md:156,198`) — the mechanism that dissolves both
the R-02 policy-authorship gap and the "no configuration surface" constraint
(§8, :147).

**Pole B:** "No cross-customer flywheel — nothing leaves the appliance"
(review:1304). Superfield therefore certifies risk calibrations (what may ship
autonomously, per domain) with **zero field evidence** from any deployment: it
cannot observe whether a template's risk budgets were right, anywhere, ever.

**Why it matters:** Certification is an empirical claim ("this autonomy
boundary is safe for this class of business") made by a vendor who has
structurally forsworn the data that would validate it. The only calibration
evidence is Superfield's own dogfood Forge — which R-12 already flagged as
circular. There's also an unowned boundary inside the mechanism: the Owner
"tunes" a certified template — at what point does tuning void certification
and become the forbidden configuration surface / policy authorship? And
"certified" carries assurance-adjacent weight while liability is parked to
counsel (review:1307) — the word is writing a check the parked workstream
hasn't priced.

**Resolutions:** (a) Narrow the certification claim to structural properties —
fail-closed defaults, budget presence, audit coverage, escalator mechanics —
and let *domain* risk calibration be earned locally by each customer's
escalator track record. Trade-off: weaker sales artifact; "certified" becomes
"well-formed," not "safe for your industry." (b) Carve one explicit exception
to no-flywheel: opt-in, aggregate, non-content escalator outcomes (budget
breaches, rollback rates per template version) flowing back for
recertification. Trade-off: the flat "nothing leaves" guarantee becomes
"nothing except…" — the exact erosion T-5 already starts; must be
contractually crisp or it poisons the sovereignty story.

## T-7 (major) — "No hostage problem" is a product guarantee while the decision set builds a three-headed hostage: inference, operations, and switching costs

**Pole A:** Continuous export is ratified precisely as the anti-lock-in
guarantee: "Sovereignty and the absence of a hostage problem are product
guarantees, not policies" (`docs/prd.md:162`; review:1306, 1309).

**Pole B:** The same decision set ratifies defensibility = "sovereignty +
**switching costs**" (review:1304) and bundles inference through the partner
with *no customer API key* (review:1338), while R-06's remediation makes the
appliance "hard-refuse to run the production loop on fixtures" (review:1312).

**Why it matters:** The exported git tree + portable schema is a corpse
without the loop: the day the MSP relationship ends, an appliance with no
customer-owned credential cannot think — and is *designed* to refuse to fake
it. The customer's continuity depends on a partner contract Superfield
ratified as the default. Meanwhile "switching costs as moat" and "no hostage
problem as guarantee" are the same phenomenon described as a feature to
investors and a non-feature to customers; that's survivable (data portable,
accumulated context not) but only if stated honestly, and no doc states it.

**Resolutions:** (a) Add a continuity clause to the export guarantee: on
partner termination, the customer can attach their own LLM credential and run
degraded-but-live (the env-var seam already exists — `SF_LLM_API_KEY`).
Trade-off: undermines the partner's commercial position; partners will resist
contractually. (b) Escrow the inference relationship: Superfield (not the
partner) holds the master model contract, partners resell — termination swaps
the reseller, not the credential. Trade-off: contradicts "partner owns the
model-API relationship" as decided; Superfield takes on COGS and rate-limit
risk.

## T-8 (minor) — "No configuration surface" survives only by relocating the knobs to an undesigned partner plane

**Pole A:** PRD §8 (:142,147): no arbitrary workflow customization, no
configuration surface; §9 Operability (:161): every flow performable by the
customer's sysadmin-generalist through the control panel.

**Pole B:** The partner fleet surface is, by function, a configuration and
operations surface — caps, credentials, provisioning, deploy targets, upgrade
rings — for which no equivalent "no knobs" doctrine, UX bar, or doc exists
(review:1308).

**Why it matters:** The customer-facing simplicity claim is honest only
because the complexity moved to a surface no document governs. Two operator
personas (customer Administrator, partner fleet operator) now share one stated
operability bar; the partner surface will accrete knobs unchecked because the
"one coherent way" constraint doesn't name it.

**Resolution:** Extend the §8 doctrine explicitly to the partner surface (same
certified-template pattern for fleet policy), or state that the partner plane
is exempt and why. Trade-off: more constraint-writing before the surface
exists; the alternative is R-34 recurring one level up.

## T-9 (major) — The premise-deferral stack-up: every speed decision defers the premise, and the tripwires that would un-defer it are parked

**Pole A:** The whole architecture is justified by agent-cadence economics:
sub-second fastenv as "an economics requirement"
(`docs/technical-requirements.md:49`), agent-cadence change management (§2.2),
the 1000-tok/s framing the review grades against (review:36–43).

**Pole B:** The decisions: "seams now, serial implementation" (review:1339),
fail-closed full-approval install (:1340), batch review primary (:1302) — plus
"premise-timing tripwires … PARKED" (:1307).

**Why it matters:** Each decision is individually sound. Composed, the launch
product is a serial loop, human-gated on every change, reviewed in batches by
one part-timer — operationally indistinguishable from R-15's named strongest
competitor ("one operations-minded employee with a $200/month frontier-agent
subscription"), while carrying the full cost of a bespoke substrate (own VCS,
CI, exec fabric) built for a speed regime deliberately not enabled. The
differentiated value is all deferred; the cost is all current. The one
instrument that would tell the company *when* to flip the seams —
premise-timing tripwires (R-17) — is exactly what got parked. "Seams now"
without tripwires is a seam with no trigger condition.

**Resolutions:** (a) Un-park the minimal tripwire: one page naming the
model-speed/reliability indicator per seam (DAG loop, merge-gate budget, batch
API) and the flip criterion. Trade-off: small; the parking decision was about
the commercial doc, and this is an engineering trigger — cheap to separate.
(b) Accept the interim positioning honestly: sell the wedge period on
sovereignty + appliance ops (not speed) — but note that leans on the moat T-1
weakens.

## T-10 (major) — The in-perimeter premium tier that redeems the sovereignty moat is the tier the channel is paid to not sell

**Pole A:** In-perimeter model serving is the designated answer for
regulated/sovereignty customers — "the candidate premium/regulated tier"
(review:1338); tech-req §2.5 requires the LLM boundary be swappable "including
for enterprises that will demand models inside their own trust perimeter"
(`docs/technical-requirements.md:65`).

**Pole B:** Partner economics run on bundled tokens — "tokens are priced in;
the spend cap is … partner margin protection" (review:1338). An in-perimeter
customer consumes no partner-brokered tokens: the premium tier deletes the
partner's recurring token margin.

**Why it matters:** The channel that owns the customer relationship has a
direct financial incentive to steer customers *away* from the one tier that
makes the sovereignty defensibility claim (T-1) true — and the customers who
most need that tier (regulated) are the moat's flagship segment. The decision
set thus routes the moat's proof-case through the party incentivized to
suppress it. Also unresolved: model swappability is now a three-party
negotiation, since the model relationship is a partner asset.

**Resolutions:** (a) Price the in-perimeter tier so the partner keeps
equivalent margin (ops/hosting fee replacing token spread). Trade-off: raises
the tier's price against hosted-lab alternatives. (b) Sell the in-perimeter
tier direct, bypassing the channel. Trade-off: channel conflict on the
highest-value accounts — the classic way vendors lose their MSP channel.

## T-11 (major) — The fixed vendor-owned core (schema, templates, Blueprint) needs an inbound vendor channel that "self-sufficiency" says doesn't exist

**Pole A:** PRD §9 Self-sufficiency (:151): "The Forge upgrades itself through
the same loop; no external release process is required to evolve it"; §5
(:90): "the Forge upgrades itself without a separate release process."

**Pole B:** The ratified decisions make three artifacts vendor-owned and
non-locally-evolvable: the fixed Superfield-owned core schema ("the core is
product, not customer configuration," :153; review:1309), certified policy
templates (only certified entry, :156), and the certified Blueprint rule set.
The local loop *may not* author these — so they can only change via vendor
distribution; and R-24's adopted remediation ships "a boring `superfield
self-update`" precisely because loop-driven self-modification isn't safe yet
(review:1324).

**Why it matters:** The decision set creates a class of product substance that
must flow vendor→appliance (schema migrations to the core, recertified
templates, Blueprint updates) across a boundary the PRD says nothing needs to
cross — and, per no-flywheel, with no return channel to inform those updates
(T-6). The self-improvement narrative ("no separate upgrade process,"
`docs/prd.md:17,66`) is contradicted by the plan of record's own vendor-update
mechanism. The doc sweep left PRD §9's claim intact while the remediation log
ratified its exception.

**Resolutions:** (a) Amend PRD §9 to name the two lanes honestly: local loop
evolves apps and Forge behavior *within* the certified frame; the frame (core
schema, templates, Blueprint) arrives via signed vendor updates through the
partner fleet channel. Trade-off: gives up a clean marketing sentence; also
formally makes the partner plane (T-5) a code-distribution vector — raising
its security stakes further. (b) Let the local loop propose
core-schema/template changes upstream for certification. Trade-off: that's a
data channel leaving the appliance — colliding with no-flywheel.

## T-12 (minor) — No-flywheel silently deletes the evidence channel the falsifiability remediations depend on

**Pole A:** Remediations R-12/R-35 commit to published, tracked evidence:
"'the Forge fixed X defects in itself autonomously, N% approved' as a tracked
metric" (review:1315), paired counter-metrics now in the PRD
(`docs/prd.md:40–47`).

**Pole B:** "Nothing learned leaves the appliance" (review:1304) means no
customer's time-to-first-app, rollback rate, or self-maintenance share is ever
observable by Superfield.

**Why it matters:** The PRD's success metrics become measurable only on
Superfield's own Forge — the exact circularity R-12 diagnosed. The thesis's
scoreboard, post-decision, is structurally limited to the dogfood instance
plus whatever partners voluntarily relay. Not fatal (dogfood evidence is real
evidence), but the review's "belief system, not a product plan" critique is
only half-answered.

**Resolution:** Define the metric program explicitly as: dogfood Forge
(public) + partner-relayed aggregate outcomes under the fleet contract (T-5's
plane, consent-scoped). Trade-off: same "nothing except…" erosion as T-6(b);
alternatively accept dogfood-only and say so.

---

# Part 2 — Residual and freshly-introduced contradictions (X-1 … X-16)

## Part 2a — The vision doc (untouched by the sweep) vs the new PRD/README

**X-1 (critical) — Vision's customer is the large enterprise; the PRD's is a
mid-market company with no engineers**
- Pole A: `docs/vision/unified-memory-layer.md:131-139` — "Going to Market:
  How This Enters an Enterprise… you cannot sell a large enterprise a
  rip-and-replace… Every large enterprise carries an unserved build backlog…
  what let a risk-averse enterprise say yes."
- Pole B: `docs/prd.md:7,189` — "Superfield's customer is a company with more
  than $10M in annual revenue that does not hire full-time engineers…
  skeletal technical staff."
- Fix: rewrite the vision GTM section (and its "enterprise" vocabulary
  throughout) to the ratified ICP, or banner the doc's audience framing as
  pre-ICP.

**X-2 (major) — Vision assigns the customer a schema team and a PM; the PRD
says the schema core is Superfield-owned and no customer role reads code**
- Pole A: `unified-memory-layer.md:68,74` — "In a unified-memory company the
  schema *is* the product… the schema team replaces the warehouse-and-ETL
  data team… The product manager's job shifts… to curating inferences."
- Pole B: `docs/prd.md:153` — "The schema's core is fixed and
  Superfield-owned… extended per app by agent-authored leaf schemas… the core
  is product, not customer configuration"; `prd.md:51` — "No role assumes the
  ability to read code."
- Fix: add one clause to the vision's "Schema Is the Product" section stating
  the schema is *Superfield's* product (fixed core, agent-authored leaves),
  not customer org design.

**X-3 (major) — Vision's worked example has the human reviewing a code patch;
the PRD forbids diff review**
- Pole A: `unified-memory-layer.md:115` — "Draft patch ready for review. The
  human reviews the patch, not the diagnosis."
- Pole B: `docs/prd.md:33,98,156` — "Approvers judge behavior demonstrated
  against representative data, never code diffs… Approvers are never asked to
  read code diffs."
- Fix: change the worked example to "the human reviews the demonstrated
  behavior/outcome, not the diagnosis or the diff."

**X-4 (major) — Vision's "no Git tree, no Git remote" is unqualified;
continuous git-tree export is now a ratified product guarantee**
- Pole A: `unified-memory-layer.md:84,159` — "Source code lives in the
  database, not in a Git tree synced to a remote… There is no Git remote, no
  CI fleet, no separate tracker."
- Pole B: `docs/prd.md:162` — "The company must be able to continuously export
  its estate — source code as a standard git tree… at any time";
  `README.md:46` — "Continuous export — source as a plain git tree plus a
  portable brain schema — is a ratified product guarantee (2026-07-02)."
- Fix: add one sentence to vision §No Assumed Priors: internal storage is
  database-native, but a standard git tree is continuously exported as a
  sovereignty guarantee.

**X-5 (major) — Vision's whole-company terminal state remains unbounded; the
ratified plan was to downgrade it to what the wedge supports**

*Overlap: this is the vision-doc half of P-1 — R-14's claim-downgrade never
landed anywhere, and the PRD half stands verbatim too.*

- Pole A: `unified-memory-layer.md:145-153` — "the destination is… a company
  whose software all lives in one brain… the operational middle — people
  moving information between systems — is exactly what collapses."
- Pole B: `docs/prd.md:143-145` (§8) — synthesis only "in service of
  execution"; non-software improvement out of scope; and review remediation
  R-14 ("downgrade whole-company-coherence claims… future-flag the
  whole-business-view language") is status **planned** — no doc executed it,
  and the vision doc was not touched.
- Fix: future-flag "Where This Goes" (explicit "beyond current product scope"
  marker) per the adopted R-14 remediation.

**X-6 (major) — Spec-inversion is still unbounded in *both* vision and the
rewritten PRD; no doc landed the ratified bounding**

*Overlap: this is the document-drift half of P-3 — the structural finding that
the honest bound may exclude most of the wedge.*

- Pole A: `unified-memory-layer.md:50-52` — "The delta is the spec… The PRD
  becomes a byproduct… the artifact is unnecessary"; and `docs/prd.md:94` —
  "the specification is continuously revised, never separately authored"
  (re-asserted by the sweep with no maintenance-phase/minimum-signal bound).
- Pole B: review remediation R-13 (ADOPTED, planned): "bound the
  spec-inversion claim to maintenance-phase sufficiently-trafficked apps… set
  a minimum-signal threshold below which the loop must not auto-infer
  intent." The only partial bound anywhere is `architecture.md:577`
  (IntentSpecInference "no-ops when there are no signals; never
  auto-applied").
- Answer to the axis question: **no doc actually bounded the claim** — the PRD
  rewrite was the natural place and didn't.
- Fix: add the minimum-signal / maintenance-phase qualifier to PRD §5 "Stating
  intent and inferring the spec" and mirror it in the vision's Spec Inversion
  section.

**X-7 (minor) — Vision uses the retired "agent IDE" term and GitHub-melting
framing against incumbents the ICP doesn't have**
- Pole A: `unified-memory-layer.md:159` — "The agent IDE is the surface
  through which humans participate"; `:86` — "We are melting the thin slice…
  the saaspocalypse."
- Pole B: `README.md:7` — "Earlier drafts called Superfield an 'Agent IDE.'
  That term is retired"; `docs/prd.md:15` — "There is no incumbent to
  displace, because there is no product" (green wedge; the no-engineer
  customer has no GitHub/CI estate to melt); MSP/appliance channel framing in
  prd.md §3/§7.
- Fix: replace "agent IDE" with "Studio (the control panel)" and reframe §No
  Assumed Priors as Superfield's *own* build choice rather than customer
  displacement.

## Part 2b — The 12 swept files against each other

**X-8 (major) — The Blueprint is still told two incompatible ways inside
architecture.md itself (and vision/PRD side with the second)**

*Overlap: this is the residue of first-review R-03 — the decision ratified the
in-brain versioned rule set, but architecture's opening paragraph still
teaches the fine-tuned-model story.*

- Pole A: `docs/architecture.md:11` — "the Superfield Blueprint is
  Superfield's fine-tuned dev agent model… The rules are not a runtime config
  — they are baked into the model's weights." ("The fine-tuned model is the
  target.")
- Pole B: `docs/architecture.md:27` and `docs/prd.md:155,197` — Blueprint
  governed as "a **versioned, fail-closed rule set held in the brain**";
  `unified-memory-layer.md:159` — "the blueprint… is rows in the same
  database… when it changes, the change is a migration." Weights-in-a-model
  cannot be a versioned rule set whose absence is a boot failure with
  per-change verdicts in `forge.validation_runs`.
- Fix: rewrite architecture §Superfield Blueprint's opening so the ratified
  target is the in-brain versioned rule set, with fine-tuning listed as a
  possible future encoding, not the target.

**X-9 (major) — The appliance loop's cursor table lives in a migrations
directory the appliance runner is documented never to apply**
- Pole A: `docs/adr-schema-boundary.md:238-242` — "The runner does not walk
  `orchestrator/migrations/`; that directory is applied on the prototype/k3s
  track only, not by the appliance runner."
- Pole B: `docs/architecture.md:639-649` and `docs/milestone-1.md:73` — the
  appliance gardening loop's resumable cursor is `orchestrator.gardening_cursor`
  (`orchestrator/migrations/0001_gardening_cursor.sql` per architecture's
  ownership table at `:121`, which also says the runner "applies all pending
  migrations from all components"). If the appliance runner never applies it,
  nothing creates the appliance's own cursor table — and the ratified
  archive-prototype decision will archive `orchestrator/` entirely.
- Fix: move `0001_gardening_cursor.sql` into a runner-walked component
  directory (or add `orchestrator` to `COMPONENT_DIRS`) and make the three
  docs state one story.

**X-10 (major) — Architecture's deploy section still documents the
k3s-default TS prototype as current, which README says is not documented
there — and the ratified decision inverted both**
- Pole A: `docs/architecture.md:837-841` — "The source of truth for the wire
  shape is the TypeScript artifact emitted by
  `packages/control-core/fastenv-translate.ts`… The deploy path coexists with
  k3s until parity. `runDeployCommand` (`packages/core/commands/deploy.ts`)
  takes a backend option (default `k3s`)."
- Pole B: `README.md:22` — the prototype's "internals remain only in git
  history and the `packages/*` tree, and are **not** documented as appliance
  architecture (`docs/architecture.md`)"; and the review's ratified decision
  (`2026-07-02-red-team-concept-review.md:1341,1325`) — "archive the prototype
  now… Rust canonical for… the fastenv manifest with TS generated or deleted…
  make fastenv the default deploy backend."
- Fix: re-scope architecture §Backend selector / §FastenvManifest to
  Rust-canonical + fastenv-default, marking the TS translate path and k3s
  default as archived-prototype interim.

**X-11 (minor) — Policy lifecycle vocabulary: architecture attributes
"drafted" to a PRD §6 that now says "template selected"**
- Pole A: `docs/architecture.md:205` — "**Lifecycle (PRD §6):** a policy
  traverses `drafted → active → revised → retired`" (pinned by DB CHECK
  constraint).
- Pole B: `docs/prd.md:123` — "**Policy:** template selected → active →
  revised → retired. Policy… is never authored from scratch."
- Fix: architecture should state the DB vocabulary maps `drafted` = "template
  selected, not yet active," or the state name gets migrated; stop citing PRD
  §6 for a vocabulary it no longer contains.

**X-12 (minor) — Architecture's auth model enumerates "the seven PRD §3
roles"; the swept PRD §3 now has nine**
- Pole A: `docs/architecture.md:668` — "one of the seven PRD §3 roles
  (`owner`, `requestor`, `steerer`, `collaborator`, `agent`, `auditor`,
  `viewer`)."
- Pole B: `docs/prd.md:53-61` — §3 adds **Administrator** and **Partner
  operator (MSP/VAR)** (nine roles); PRD §7 requires a partner
  fleet-management surface that has no auth/route representation anywhere in
  architecture.
- Fix: architecture states the role-model delta explicitly ("seven implemented
  of PRD §3's nine; Administrator and Partner operator unmapped, fleet surface
  unbuilt").

**X-13 (minor) — The two new glossaries disagree on "Orchestrator," and README
still equates the brain with the Nexum crate**
- Pole A: `docs/prd.md:194` — "**Orchestrator** — in this document, only the
  CI job orchestrator seed app… other uses must be qualified, never bare";
  `prd.md:187` — "Where another document uses one of these terms differently,
  this glossary governs"; and PRD's Brain = "knowledge base and transactional
  record" including "source code, change history, validation results"
  (`prd.md:15,191`).
- Pole B: `README.md:45` — "**Orchestrator** — The `orchestrator` schema and
  routes (daemon control)" (no mention of the seed app); `README.md:43` —
  "**Nexum** — The company brain — the PostgreSQL knowledge store
  (`crates/nexum`)," although source code/changes/validation live in the
  `sharp`/`forge` schemas, outside `crates/nexum`. (The R-28 log row flags the
  architecture half as "pending" but the README carries the same equation.)
- Forge/Studio/workspace/loop definitions between the two glossaries:
  **aligned** — checked CLEAN.
- Fix: README glossary adds the seed-app sense of Orchestrator and redefines
  Nexum as "the knowledge-graph component of the brain," not the brain itself.

**X-14 (minor) — /health: milestone-1 promises one more boot guarantee than
architecture backs**
- Pole A: `docs/milestone-1.md:91-95` — a reachable `/health` implies Postgres
  up, migrations applied, **and** "The gardening loop task was running (i.e.
  `LoopHandle` registered in `AppState`)."
- Pole B: `docs/architecture.md:730` — reachable `/health` implies only
  "Postgres accepting connections, all migrations applied"; the boot sequence
  (`:458-471`) binds after provision+migrate, with loop start not part of the
  documented gate.
- Otherwise the two docs' liveness-not-readiness phrasing is **aligned**
  (R-37 largely held) — this is the one residual delta.
- Fix: either add loop-registration to architecture's stated gate (if
  `boot_loop` truly precedes bind) or drop bullet 3 from milestone-1 §4.5.

**X-15 (minor) — R-10's status escalates across docs: "DECIDED (inferred)" in
the log, "ratified" in studio-ux**
- Pole A: `2026-07-02-red-team-concept-review.md:1302` — "R-10 | DECIDED
  (inferred): Studio primary mode is batch review… | logged"; the RATIFIED row
  (`:1309`) covers R-02/R-03/R-09/R-34/R-16 but **not** R-10.
- Pole B: `docs/ux/studio-ux.md:43-45` — "The **ratified product decision**
  (red-team concept review, finding R-10) makes batch review… Studio's primary
  interaction mode"; `README.md:42` — "(decided 2026-07-02)."
- Fix: add R-10 to a ratification row in the remediation log, or soften
  studio-ux/README to "decided (inferred)."

**X-16 (minor) — PRD asserts Forge-in-fastenv is "a scheduled later step in
the build order," but no build-order doc contains that step, and architecture
still states the all-workloads constraint as hard**
- Pole A: `docs/prd.md:13,152` — "moving the Forge itself into fastenv is
  explicitly a scheduled later step in the build order."
- Pole B: `docs/technical-requirements.md` §4 build order and
  `docs/milestone-1.md` contain no such step; and `docs/architecture.md:806` —
  "PRD §9 makes it a hard appliance constraint: every Superfield workload —
  the Forge, validation jobs, and delivered app instances — runs in fastenv,"
  un-softened by the "target state" qualifier the PRD added (R-30).
- Fix: add the Forge-in-fastenv step to technical-requirements §4 (or a
  milestone doc) and mirror PRD's "target state / scheduled later" qualifier
  in architecture §fastenv.

**X-adjacent (out of the 12 swept files but load-bearing):**
`docs/technical-requirements.md:99-101` (§2.10) still specifies live steering
("watching agents work against a live preview and correcting them mid-task")
as the control-panel's core review mode with the old seven-role list — it
predates the batch-review decision and the Administrator/Partner roles; it was
not in the sweep and now trails the PRD it calls itself a companion to.

---

# Part 3 — Structural claims that survived remediation (P-1 … P-9)

Key context: in the review's remediation log, **R-12, R-13, and R-14 are the
only three ADOPTED findings whose status is bare "planned"** (review lines
1315–1317) — none of their bounding landed in the docs sweep that closed most
other findings.

## P-1 (critical) — R-14's claim-downgrade never happened: the whole-company-view claim stands verbatim, and no freshness property exists anywhere

*Overlap: X-5 is the vision-doc instance of the same unlanded remediation.*

**Adopted:** "downgrade whole-company-coherence claims to what the green wedge
supports, make freshness a first-class schema property on external replicas,
and future-flag the whole-business-view language" (review:1317, status:
planned).

**What stands today:**
- `prd.md:15` — "The same store gives the business a **synthesized,
  continuously current view of itself**" — the exact sentence R-14 targeted,
  unmodified, unbounded.
- `technical-requirements.md:84` — gap surfacing is "the brain's
  **synthesized, continuously current view of the business**… the expansion
  engine of the green wedge."
- `vision/unified-memory-layer.md:145-153` — the terminal state ("a company
  whose software-shaped operational roles… are run by agents against the
  brain") stands with zero bounding; the only bound in the vision (:127)
  scopes the *software slice*, not data coverage.
- Freshness/staleness as a schema property: **zero hits** for
  freshness/staleness labeling in any doc. The connector seam
  (`architecture.md` §Systems-of-Record Connector Seam) specifies
  read-only-by-construction and per-workspace credentials, but no freshness
  metadata, no brain-clock stamping of external reads, no staleness concept at
  all.

**Deeper structural point:** tech-req 2.8 makes gap surfacing the *expansion
engine* — but its input is the whole-company view, and the wedge only puts
net-new departmental apps plus on-demand external reads in the brain. The
expansion mechanism consumes exactly the coverage the coherence guarantee
cannot provide. The wedge→brain escalation is asserted as "mechanical"
(vision:147) while its engine reads data that is definitionally outside the
guarantee.

**Resolvable?** Partially by work: the claim rewrite is hours of docs work;
freshness labeling is a designable schema property (per-read timestamp in the
brain's clock domain, staleness surfaced to agents). But "continuously current
view of *itself*" is intrinsic overreach for a read-connector architecture —
currency of the copy is achievable; currency of the *view of the company* is
not, because the systems of record update outside the brain's clock. The
honest claim is "current view of what the brain governs, timestamped view of
what it reads."

**Recommendation:** Land the R-14 rewrite now (prd.md:15, tech-req:84, vision
§Where This Goes gets a premise-flag). Specify freshness as connector-seam
metadata in architecture.md. Re-scope gap surfacing's v1 input to in-brain app
signal, with external-view gaps explicitly labeled lower-confidence.

## P-2 (major) — The read-boundary question now has two contradictory owners, which makes the R-14 work unownable

**What stands:** `prd.md:172-175` moves "What is the read boundary to systems
of record — which data must an app read live, and what may it copy into the
brain" to **"Deferred to the commercial workstream (owned there; not answered
in this PRD)"** (per remediation log :1307). But
`technical-requirements.md:92` still says "The connector boundary (what is
read live vs. copied into the brain, and who governs that) is a PRD open
question **answered here**" (§2.9 app platform).

**Tension:** what-may-be-copied-into-the-brain determines what the
one-clock/one-schema guarantee covers — it is a schema-governance question,
the direct prerequisite of P-1's freshness work. Filing it as "commercial" is
a category error that the tech-req contradicts on its face. The R-14
remediation cannot land while its load-bearing input is owned by a workstream
that doesn't write schemas.

**Resolvable?** Yes, trivially by work — reassign. **Recommendation:** split
the question: data-residency/regulatory boundary → commercial;
live-read-vs-copy semantics and freshness governance → product/architecture
(tech-req §2.9 keeps it). Fix prd.md:174 accordingly.

## P-3 (critical) — R-13's bounds don't exist: no bootstrap path, no minimum-signal threshold, and the honest bound may exclude most of the wedge

*Overlap: X-6 is the cross-document instance — neither the vision nor the
rewritten PRD carries the adopted bound.*

**Adopted:** "bound the spec-inversion claim to maintenance-phase
sufficiently-trafficked apps, specify the bootstrap path…, set a
minimum-signal threshold below which the loop must not auto-infer intent"
(review:1316, status: planned).

**What stands today:**
- `vision/unified-memory-layer.md:48-52` — §The Spec Inversion is
  character-for-character unbounded: "The delta is the spec… close the
  distance and the artifact is unnecessary." No maintenance-phase qualifier.
- `prd.md:92` (wedge workflow) — v1 still bootstraps from prose: "A Requestor
  describes a need… agents stand up a working first version." No structured
  intake, no clickable-prototype step.
- Minimum-signal threshold: **zero hits** in any doc
  ("minimum.signal|signal.densit" greps empty outside the review itself).
- `prd.md:94` and `technical-requirements.md:82` (spec inference) carry no
  signal floor; nothing tells the loop when *not* to infer.

**Is the tension resolvable?** The bootstrap path is resolvable by work
(structured intake is ordinary product design). The signal-density floor is
**partly intrinsic**: the ICP's typical backlog app (reconciliation tool, 6
users, twice a month) may never cross any defensible threshold — meaning the
flagship differentiator (spec inversion) is inert for the median wedge app,
and the product's maintenance story for those apps quietly reduces to
error-signal-driven fixes plus human-stated intent, i.e., a conventional (if
good) request loop. Writing the bound honestly shrinks the thesis's
applicability claim; that is presumably why it hasn't been written.

**Recommendation:** Write the bound anyway. Add to vision §Spec Inversion:
applies to maintenance-phase apps above a signal floor. Make the floor a
certified-policy-template parameter (joins the existing template mechanism).
State explicitly in prd.md §5 what the loop does below the floor (error-triage
yes, intent-inference no). Grade the wedge story on the below-floor path,
since that is the ICP's common case.

## P-4 (critical) — R-12's self-proof metric is defined nowhere, its designated acceptance test was destroyed by the remediation sweep itself, and the build order schedules the proof last

**Adopted:** "publish 'the Forge fixed X defects in itself autonomously, N%
approved' as a tracked metric and treat the studio-ux route mismatch as its
acceptance test" (review:1315, status: planned).

**What stands today:**
- The metric appears in **no doc**: not in prd.md §2 success metrics, not in
  eval-design.md (whose Tier-3 "trust dashboard," eval-design:123, is the
  natural home but doesn't mention it), not in architecture.md. No tracking
  location, no counting rule, no target.
- `prd.md:17` still asserts, unhedged: "This makes the Forge **the most direct
  proof of the product's thesis**."
- **The acceptance test was consumed by hand:** R-26's docs sweep
  "PATCH/update fix landed" (review:1326) — humans manually fixed the exact
  studio-ux route mismatch R-12 designated as the self-fix acceptance test, in
  the same sweep that left R-12 "planned." The first test case for autonomous
  self-repair was repaired by the docs team, and no replacement defect was
  designated.
- **Sequencing contradiction:** tech-req build order step 6 — "The first
  install where the Forge ships a validated change to itself **closes the
  thesis**" — the self-proof evidence arrives at the *end* of the build order,
  while prd.md:17 presents it as the most direct proof available. Meanwhile
  the actual dogfooding today is Sharp managing its own crate source
  (`architecture.md:357`) — a merge-gate dogfood, not a
  signal→diagnosis→fix loop.
- **Fail-closed interaction:** the ratified fail-closed-at-install decision
  (review:1340) means every self-change requires outcome-level approval — so
  "fixed autonomously" is definitionally zero until the trust escalator grants
  a change-class autonomy, and pre-customer the only approver/track-record
  generator is the vendor. No doc says whether vendor-approved dogfooding
  evidence counts, or transfers.

**Resolvable?** The circularity itself is intrinsic (self-proof can't be
independent proof); the metric was the honest mitigation, and it is fully
definable work. **Recommendation:** define it: counted from
`sharp.episodes`/`forge.validation_runs` (defect signal originating in the
brain → agent-proposed fix → merged under policy), split by approval mode
(autonomous vs approved), published on the Tier-3 dashboard; designate a
*currently live* defect as the new acceptance test and freeze it against
manual fixes; qualify prd.md:17 ("will become the most direct proof once the
Forge ships changes to itself — build-order step 6").

## P-5 (major) — Trust-escalator cold start: the fail-closed-at-install decision lives only in the review's log, and certified templates as written can contradict it

*Overlap: T-3 is the decision-set face of the same cold start (throughput
deadlock); T-6 is the certification-evidence face (no flywheel to calibrate
templates). This finding is the document-side audit of both.*

**Adopted/ratified:** "fresh appliances ship fail-closed — every change
requires outcome-level approval at install; the trust escalator… earns
autonomy per change-class from track record" (review:1340 — ratified, but a
log entry, not a doc).

**What stands today:**
- `prd.md:156` (§9 trust escalation) describes risk budgets and sampling
  audits but **never states the install-time default**. The fail-closed start
  is in no canonical doc.
- Certified templates as specified can grant day-1 autonomy: `prd.md:53` — a
  template sets "what risk level may ship without human review"; `prd.md:68` —
  "which changes agents may ship autonomously." Read plainly, an Owner
  selecting a permissive certified template at install contradicts the
  ratified fail-closed start. Neither doc resolves this.
- The cold-start arithmetic is nowhere: track record = approvals × the ICP's
  one part-time technical lead's hours. No doc bounds how many approvals per
  change-class constitute escalation evidence, what a sampling audit is, or
  what the Owner's realistic approval throughput implies for time-to-autonomy.
  (Also unanswered: sampling audits of demonstrated behavior are performed by
  a non-engineer — audit quality is asserted, not designed.)
- **Certification is undefined and circular:** "certified policy template"
  (prd.md:198) — certified by whom, against what evidence? The only candidate
  evidence source for vendor certification of initial risk budgets is the
  vendor's own Forge track record — the R-12 metric that doesn't exist (P-4).
  The designed escape from the cold start (vendor-side pre-training of trust,
  template-carried initial thresholds) is exactly this join, and no doc owns
  it.

**Resolvable?** Yes, by design work, and it is the highest-leverage unowned
design in the corpus: P-4's metric is P-5's certification evidence.
**Recommendation:** add the install-time fail-closed default to prd.md §9;
define template certification as "vendor-measured autonomy track record per
change-class on the vendor's own fleet/dogfood Forge, carried as initial
per-window risk budgets"; state the escalation arithmetic (approvals-to-budget,
audit sample rate) in a trust-escalator design doc; reconcile prd.md:53/:68
with the fail-closed start (templates bound the *ceiling* the escalator can
reach, not day-1 grants).

## P-6 (major) — The risk score that denominates the entire trust escalator still has no assigner; the self-graded-gate objection survived untouched

**Adopted:** R-02's remediation text included "Specify independent — non-self-
graded — risk scoring" (review:287); the ratified decisions (:1309, :1340)
adopt risk budgets and sampling audits but are silent on scoring independence.

**What stands today:** `architecture.md:203-207` — `RiskLevel` is "a `0..=100`
score for a change's blast radius"; who assigns it is unspecified, exactly as
the review found (review:257-258). `prd.md` §9 never mentions risk scoring
provenance. Per-window "risk budgets" (prd.md:156) are *sums of this number* —
if the gated agent assigns its own score, the budget mechanism and the
sampling-audit trigger both inherit the self-grading hole, and the escalator
escalates on self-reported evidence.

**Resolvable?** Fully, by work (deterministic blast-radius heuristics — tables
touched, deploy surface, policy class — or an independent scorer agent, with
the verdict recorded in `forge.validation_runs`). **Recommendation:** one
paragraph in prd.md §9 ("risk is scored independently of the proposing agent")
plus the scoring design in the trust-escalator doc from P-5. Without it, every
quantity in §9 is unanchored.

## P-7 (major) — The remediation created a new drift class: ratified *target* state written as present-tense *fact* in the PRD

**What stands today:**
- `prd.md:155` and glossary `:197` state the Blueprint gate "**fails
  closed**: a missing or unreadable rule set blocks merges" — present tense.
  `architecture.md:631` says the shipped loader "falls back to
  `BlueprintRules::empty()`… **This fail-open fallback is a documented
  defect**." A PRD-only reader (or agent — the product's own thesis case)
  acquires a false fact about the flagship governance property.
- Same pattern: `prd.md:22/:102` — "Batch review of completed candidates
  **is** the primary mode" — no batch-review surface exists; architecture
  still documents per-change `notify_awaiting_approval` dispatch.
- The review's own concern was claims outrunning artifacts; the sweep's
  method — rewriting claims to the ratified decisions — moved several claims
  *further ahead* of the system while the "bound the claim" items (P-1, P-3,
  P-4) stayed unbounded. Remediation was narrative in both directions.

**Resolvable?** Yes — this is a documentation-convention fix, and the corpus
already has the tool (architecture.md's "documented defect" annotation;
prd.md §9 fastenv's "(target state)" marker). **Recommendation:** apply the
fastenv precedent uniformly: any §9 constraint the artifact does not yet meet
carries the same "(target state)" or a pointer to the defect note. A
requirements doc may bind the future; it may not misreport the present.

## P-8 (major) — PRD "Answered (2026-07-02)" open questions were closed by reclassification, not by answers

**What stands today:** `prd.md:169-170` — the review's "core safety mechanism
filed as an open question" (R-02 evidence) is now marked *Answered*: "trust
escalation **is a requirement, not a question**." Renaming a question a
requirement answers nothing: no measurement method, no budget arithmetic, no
audit design, no scorer (P-5, P-6) exists. Likewise the policy-vocabulary
question is "Answered: policy ships as certified templates" — while the
template's actual vocabulary (what a template contains, what "tuning"
exposes) appears in no document, and certification is undefined. The two
hardest product questions in the corpus now display a green "Answered" badge
over zero design — the same false-green pattern the project's test-coverage
creed condemns, at the requirements level.

**Resolvable?** Yes. **Recommendation:** re-mark both as "Decided (mechanism
chosen) — design open," with owners: the policy-template spec and the
trust-escalator design doc (P-5). A decision record is not a design.

## P-9 (minor) — The wedge's v1-quality story has no evidence machinery at ICP fidelity — but eval-design contains the corpus's one genuinely structural bound, which should be credited and extended

**What stands today:** The only scenario eval grades rung 1 "the project graph
*describes* add/list/complete" and rung 2 "a *compiling* candidate"
(`eval-design.md` §First scenario) — far below prd.md:83's promise
(non-engineer's description → working app) and prd.md:42's time-to-first-app
metric. The acceptance-criteria primitive is still "unused and non-gating"
(eval-design:37-39). **However**, eval-design:213-216 is a real structural
bound, the only one of its kind to land: "executable acceptance criteria land
**before** any outcome guarantee is claimed — until step 1 ships, no document
or badge may assert that user outcomes are verified." This is what "bound the
claim" looks like when it actually happens.

**Recommendation:** extend the same binding-sentence pattern to P-1/P-3/P-4
(each gets one sentence in the owning doc: "no doc may claim X until Y
ships"); add a Tier-2 scenario at ICP fidelity — non-engineer-authored seed
intent, fail-closed policy active, outcome-level approval exercised end-to-end
— as the evidence backing time-to-first-app.

---

# What holds up — sound pairings and clean checks

Fairness requires stating what the decision set and the sweep got right. Both
lenses that hunted for contradictions also verified coherence, and much of it
is real.

## Sound decision pairings (no tension found)

- **Outcome-level approval + batch-review Studio + trust escalator**
  (review:1301, 1302, 1309, 1340): a mutually reinforcing governance stack;
  batch review is the correct UI for outcome approval, and the escalator is
  the designed growth path. The only crack is the T-3 cold start, not the
  stack itself.
- **Fixed Superfield-owned core schema + guaranteed continuous export**
  (review:1309): actively synergistic — a portable export schema is only
  definable *because* the core is fixed and vendor-owned. This pairing also
  cleanly resolves R-34's schema-vs-configuration contradiction.
- **Archive the prototype now + fastenv default + seams-now** (review:1339,
  1341): coherent with the self-sufficiency constraint, kills the
  R-25/R-26/R-27 dual-track drift, and "seams now" is honest engineering for
  an unvalidated premise (the gap is only the parked tripwire, T-9).
- **MSP channel + IT-admin operational bar** (`docs/prd.md:13,161`; review
  addendum): the NAS/firewall operational posture is exactly the product
  category MSPs already sell and operate — the channel and the ops bar were
  chosen to fit each other, and they do.
- **Bundled inference + no-key-first-boot + spend cap, as a packaging unit**:
  internally well-constructed — one decision simultaneously closes R-04
  (runaway invoice), R-06 (credential first-boot), and R-15 (pricing
  legibility). Every tension it creates (T-1, T-4, T-7, T-10) is with *other*
  commitments, not within the bundle itself.
- **Fail-closed Blueprint + fail-closed policy + fail-closed autonomy at
  install** (review:1303, 1340): the governance surfaces now fail in one
  consistent direction, repairing the R-3/R-11 fail-open incoherence.

## Feared inconsistencies checked and found CLEAN

- **Migration order** ADR ↔ architecture: both `sf-db → sf-auth → nexum →
  sharp`, single owner + defer-by-reference — CLEAN (except the
  orchestrator-directory wrinkle, X-9).
- **Schema-table inventories** ADR ↔ architecture: identical, including
  `forge`/`substrate`/`public.workspaces` — CLEAN.
- **Embedding model name/revision/dim** across adr-embedding-model,
  adr-schema-boundary, architecture: all
  `sentence-transformers/all-MiniLM-L6-v2@c9745ed`, 384 — CLEAN.
- **Nightly-eval claims** eval-design ↔ testing.md: both say "manual
  pre-release today, nightly planned" — CLEAN.
- **Pinned default model** eval-design ↔ architecture LoopConfig
  (`claude-haiku-4-5-20251001`) — CLEAN.
- **Sharp hash algorithm** architecture ↔ rust-reorg-decisions: SHA-256
  native / SHA-1 import-only, both stated — CLEAN.
- **act doctrine vs CI-manifest ADR**: interim banner present in testing.md —
  CLEAN.
- **rust-reorg `#[ignore]` gate vs loud-skip invariant**: SUPERSEDED-in-part
  banner present and consistent — CLEAN.
- **Installer honesty** README ↔ PRD ↔ milestone-1: "signed artifact planned,
  dev build documented as dev path" — consistent — CLEAN.
- **"No GitHub" vs act/GHA text**: consistently qualified as
  interim-while-GHA-is-push-target — CLEAN.
- **Batch-review vs live-steering** across README/PRD/studio-ux banner:
  substantively aligned (only the ratified-vs-inferred wording, X-15).
- **Glossary Forge/Studio/workspace/"the loop"** README ↔ PRD §11: aligned —
  CLEAN (Orchestrator and Nexum/brain are the exceptions, X-13).
- **Review-doc remediation log rows vs addendum**: chronologically
  consistent; R-28 "pending" annotation accurate; no status row contradicts
  the addendum — CLEAN apart from X-15.

---

# DECISION QUEUE — founder-level forks

These are the genuinely new forks this pass surfaced. Each needs a founder
decision; none is resolvable by editing documents. Options and trade-offs are
as the findings give them. Subsidiary choices that fold into a queue item are
noted, so the queue stays at seven.

**D-1 (from T-1, critical) — Sovereignty vs bundled inference: pick the honest
framing.**
(a) "Sovereign state, brokered inference": mandatory zero-retention flow-down
in the partner contract, customer-visible data-path disclosure in Studio, and
in-perimeter serving pulled forward as the launch answer for the regulated
segment — weakens the marketing claim now; local serving fights the 1000-tok/s
premise. (b) Customer-owned-key / BYO-enterprise-agreement mode alongside the
bundle — breaks bundle economics, the spend-cap semantics (D-4), and the
no-key-at-first-boot UX that solved R-06. *Subsidiary: the T-6(a)/(b)
certification-evidence choice and the T-11(a)/(b) vendor-update-lane choice
are both instances of the same "convert absolutes to 'nothing except…'"
framing this decision sets; T-12's metric-program scope follows from
whichever exception set is ratified.*

**D-2 (from T-5, critical) — Partner fleet plane trust boundary.**
(a) Control-plane-only plane: health/version/provision/upgrade, hard
data-plane exclusion enforced structurally, short-lived per-customer
per-action credentials, customer-visible audit of every partner action —
partner cannot staff Administrator fully; the role split must be redrawn.
(b) Pull-based fleet: signed outbound health beacons, no inbound standing
credential, upgrades staged by `superfield self-update` with partner approval
but appliance-side execution — slower partner incident response; weakens the
fleet-ops sales pitch to MSPs.

**D-3 (from T-7, major) — Exit-continuity clause for the inference credential.**
(a) On partner termination, the customer can attach their own LLM credential
and run degraded-but-live (the `SF_LLM_API_KEY` seam exists) — undermines the
partner's commercial position; partners will resist contractually. (b) Escrow
the inference relationship: Superfield holds the master model contract,
partners resell; termination swaps the reseller, not the credential —
contradicts "partner owns the model-API relationship" as decided; Superfield
takes on COGS and rate-limit risk.

**D-4 (from T-4, major) — Spend-cap semantics and the corrective exemption.**
(a) Two-tier budget: a reserved corrective/security allowance that never
pauses, plus a partner-capped discretionary-improvement budget; breaches
surface to both parties with a customer-side purchase path — partner margin
exposed to runaway corrective loops; needs a defect-loop circuit breaker.
(b) Un-park pricing enough to define the cap: publish the unit-economics page
as a three-party artifact so cap-setting is contractual — drags a parked
commercial question back into the product track.

**D-5 (from T-10, major) — Premium-tier channel conflict.**
(a) Price the in-perimeter tier so the partner keeps equivalent margin
(ops/hosting fee replacing token spread) — raises the tier's price against
hosted-lab alternatives. (b) Sell the in-perimeter tier direct, bypassing the
channel — channel conflict on the highest-value accounts; the classic way
vendors lose their MSP channel.

**D-6 (from T-2, major) — Declare the two-sided product, or accept
MSP-as-buyer.**
(a) Two-sided declaration: PRD for the company, a partner PRD for the MSP,
value split named, direct-sale path preserved so the channel is a multiplier
— two personas to serve before v1. (b) Accept MSP-as-buyer and reposition
(fleet product, per-appliance economics) — abandons the post-human category
claim; the vision doc's terminal state becomes marketing. *Subsidiary: T-8's
partner-plane knobs doctrine should be written into whichever PRD structure
this decision produces.*

**D-7 (from T-9, major) — Un-park the minimal premise tripwire.**
(a) One page naming the model-speed/reliability indicator per seam (DAG loop,
merge-gate budget, batch API) and the flip criterion — cheap; the parking
decision was about the commercial doc, and this is an engineering trigger.
(b) Accept the interim positioning honestly: sell the wedge period on
sovereignty + appliance ops, not speed — leans on the moat D-1 must first
repair. *Subsidiary: T-3's cold-start resolution (greenfield-standup change
class vs standup-as-one-outcome) is a product-design choice that can ride the
trust-escalator design doc rather than this queue, but it must be made before
the first install.*

# FIX QUEUE — mechanical corrections, no decision required

Each line: finding — file(s) — fix. These either execute already-adopted
remediations or repair drift; none forks strategy.

**Vision sweep (one pass resolves seven):**
- X-1 — `docs/vision/unified-memory-layer.md` §Going to Market — rewrite to the ratified ICP or banner the framing as pre-ICP.
- X-2 — vision §Schema Is the Product — one clause: the schema is Superfield's product (fixed core, agent-authored leaves), not customer org design.
- X-3 — vision `:115` worked example — "reviews the demonstrated behavior/outcome, not the diagnosis or the diff."
- X-4 — vision §No Assumed Priors — one sentence: database-native storage, continuously exported standard git tree as a sovereignty guarantee.
- X-5 — vision §Where This Goes — future-flag "beyond current product scope" per adopted R-14 (see P-1).
- X-6 — vision §The Spec Inversion + `docs/prd.md` §5 — add the maintenance-phase / minimum-signal qualifier per adopted R-13 (see P-3).
- X-7 — vision `:159,:86` — replace "agent IDE" with "Studio (the control panel)"; reframe no-priors as Superfield's own build choice.

**Swept-corpus drift:**
- X-8 — `docs/architecture.md:11` — rewrite §Superfield Blueprint opening: in-brain versioned rule set is the target; fine-tuning is a possible future encoding.
- X-9 — `orchestrator/migrations/0001_gardening_cursor.sql` — move into a runner-walked component directory (or add `orchestrator` to `COMPONENT_DIRS`); align adr-schema-boundary/architecture/milestone-1 to one story.
- X-10 — `docs/architecture.md:837-841` — re-scope §Backend selector / §FastenvManifest to Rust-canonical + fastenv-default; mark TS translate path and k3s default as archived-prototype interim.
- X-11 — `docs/architecture.md:205` — map `drafted` = "template selected, not yet active" (or migrate the state name); stop citing PRD §6 for retired vocabulary.
- X-12 — `docs/architecture.md:668` — state the role-model delta: seven implemented of PRD §3's nine; Administrator and Partner operator unmapped, fleet surface unbuilt.
- X-13 — `README.md:43-45` — add the seed-app sense of Orchestrator; redefine Nexum as the knowledge-graph component of the brain, not the brain.
- X-14 — `docs/milestone-1.md:91-95` or `docs/architecture.md:730` — add loop-registration to architecture's stated `/health` gate or drop bullet 3 from milestone-1 §4.5.
- X-15 — review remediation log or `docs/ux/studio-ux.md:43-45` + `README.md:42` — add R-10 to a ratification row, or soften "ratified" to "decided (inferred)."
- X-16 — `docs/technical-requirements.md` §4 + `docs/architecture.md:806` — add the Forge-in-fastenv build-order step; mirror the PRD's "target state" qualifier in architecture §fastenv.
- X-adjacent — `docs/technical-requirements.md:99-101` (§2.10) — update live-steering-as-core-review-mode and the seven-role list to the batch-review decision and nine-role PRD.

**Structural-claims repairs (execute the adopted-but-unlanded remediations):**
- P-1 — `docs/prd.md:15`, `docs/technical-requirements.md:84`, architecture connector seam — land the R-14 rewrite ("current view of what the brain governs, timestamped view of what it reads"); specify freshness as connector-seam metadata; re-scope gap surfacing's v1 input to in-brain signal.
- P-2 — `docs/prd.md:174` — split the read-boundary question: residency/regulatory → commercial; live-read-vs-copy semantics and freshness governance → tech-req §2.9.
- P-3 — `docs/prd.md` §5 + vision §Spec Inversion — write the R-13 bound; make the signal floor a certified-template parameter; state the below-floor behavior (error-triage yes, intent-inference no).
- P-4 — `docs/eval-design.md` (Tier-3 dashboard) + `docs/prd.md:17` — define the self-fix metric (counted from `sharp.episodes`/`forge.validation_runs`, split by approval mode); designate a currently live defect as the new acceptance test, frozen against manual fixes; qualify prd.md:17 to build-order step 6.
- P-5 — `docs/prd.md` §9 + new trust-escalator design doc — state the install-time fail-closed default; define template certification (vendor dogfood track record → initial risk budgets); reconcile prd.md:53/:68 (templates bound the ceiling, not day-1 grants); write the escalation arithmetic.
- P-6 — `docs/prd.md` §9 + the P-5 design doc — one paragraph: risk is scored independently of the proposing agent; scoring design (deterministic blast-radius heuristics or independent scorer, verdict in `forge.validation_runs`).
- P-7 — `docs/prd.md:155,197,22,102` — apply the "(target state)" marker uniformly to every §9 constraint the artifact does not yet meet (Blueprint fail-closed, batch review primary).
- P-8 — `docs/prd.md:169-170` — re-mark "Answered" to "Decided (mechanism chosen) — design open," with owners (policy-template spec; trust-escalator design doc).
- P-9 — `docs/eval-design.md` — extend the binding-sentence pattern to P-1/P-3/P-4; add a Tier-2 scenario at ICP fidelity (non-engineer seed intent, fail-closed policy, outcome approval end-to-end).

Note the dependency: P-5 and P-6 fixes land cleanly regardless of decisions,
but P-4's "does vendor-approved dogfood evidence transfer?" and T-6's
certification-claim scope should be settled by D-1's exception framing before
the trust-escalator design doc is finalized.

---

## Remediation log

Decisions and fixes against this review's findings are recorded here as they
land. (Same convention as the first review's log.)

| Date | Finding ids | Action | Status |
|------|-------------|--------|--------|
| 2026-07-03 | T-1 (D-1; subsumes T-6/T-11/T-12 framing) | DECIDED: sovereignty stays directional positioning, not contract machinery — soften absolute "nothing leaves the appliance" language to "data-at-rest on-prem; inference transits the lab API via the partner"; defensibility leans on switching costs + appliance operations; no zero-retention mandate | decided |
| 2026-07-03 | T-5 (D-2) | DECIDED (customer-first): partner fleet plane is control-plane-only — short-lived per-action credentials, hard data-plane exclusion, every partner action audited in the customer's brain | decided |
| 2026-07-03 | T-7 (D-3) | DECIDED (customer-first): unilateral exit continuity — on partner termination the customer may attach their own LLM credential and run degraded-but-live | decided |
| 2026-07-03 | T-4 (D-4) | DECIDED: single-tier spend cap; corrective/security work is pausable by the cap; the pause is loud (Owner + partner notified), never silent | decided |
| 2026-07-03 | T-10 (D-5) | DISSOLVED: in-perimeter serving stays a roadmap candidate, not a committed tier; channel-conflict pricing design deferred until committed | decided |
| 2026-07-03 | T-2 (D-6; subsumes T-8 doctrine) | DECIDED (customer-first): two-sided product declared — company PRD + partner PRD; guarantees bind to the company; direct-sale path preserved | decided |
| 2026-07-03 | T-9 (D-7; T-3 rides the escalator design doc) | ADOPTED as hygiene default: minimal engineering tripwire page (flip criterion per seam) — no founder question required; shipped as `docs/premise-tripwires.md` | done (2026-07-03 fix sweep) |
| 2026-07-03 | X-1, X-2, X-3, X-4, X-5, X-6, X-7 | Vision-doc sweep to the ratified corpus (ICP, schema ownership, outcome review, git export, R-13/R-14 bounds, retired terms) | done (2026-07-03 fix sweep) |
| 2026-07-03 | X-8 | Rewrite architecture §Superfield Blueprint opening to the in-brain versioned rule set | done (2026-07-03 fix sweep) |
| 2026-07-03 | X-9 | Move `0001_gardening_cursor.sql` to a runner-walked directory; align the three docs (runner walks `orchestrator/migrations/` as the final `COMPONENT_DIRS` entry per #762; architecture.md and adr-schema-boundary.md aligned) | done (2026-07-03 fix sweep) |
| 2026-07-03 | X-10 | Re-scope architecture deploy section to Rust-canonical + fastenv-default | done (2026-07-03 fix sweep) |
| 2026-07-03 | X-11, X-12, X-13, X-14, X-15, X-16, X-adjacent | Minor drift batch: policy vocabulary, nine roles, glossaries, /health gate, R-10 status, Forge-in-fastenv step (now build-order step 7, tech-req §4), tech-req §2.10 | done (2026-07-03 fix sweep) |
| 2026-07-03 | P-1 (with X-5) | Land R-14: claim rewrite + freshness as connector-seam metadata + gap-surfacing re-scope | done (2026-07-03 fix sweep) |
| 2026-07-03 | P-2 | Split the read-boundary question's ownership (residency → commercial; copy semantics → tech-req §2.9) | done (2026-07-03 fix sweep) |
| 2026-07-03 | P-3 (with X-6) | Land R-13: maintenance-phase/signal-floor bound + below-floor behavior + template-parameterized floor (doc bounds landed; floor *enforcement* is engineering work) | docs done (2026-07-03); design/build planned |
| 2026-07-03 | P-4 | Define the Forge self-fix metric; designate and freeze a new acceptance-test defect; qualify prd.md:17 (metric defined in eval-design Tier 3 and prd.md:17 qualified; acceptance-test defect designation pending) | docs done (2026-07-03); design/build planned |
| 2026-07-03 | P-5, P-6 (with T-3, T-6) | Write the trust-escalator design doc: install default, certification definition, escalation arithmetic, independent risk scoring (fail-closed install default + template bounds now in PRD §9; escalator design doc still owed) | docs done (2026-07-03); design/build planned |
| 2026-07-03 | P-7 | Apply "(target state)" markers uniformly to §9 constraints the artifact does not meet | done (2026-07-03 fix sweep) |
| 2026-07-03 | P-8 | Re-mark the two "Answered" open questions as "Decided — design open," with owners | done (2026-07-03 fix sweep) |
| 2026-07-03 | P-9 | Extend eval-design's binding-sentence pattern to P-1/P-3/P-4; add the ICP-fidelity Tier-2 scenario | done (2026-07-03 fix sweep) |

---

**Summary**

- 37 findings across three lenses: 6 critical (T-1, T-5, X-1, P-1, P-3, P-4),
  21 major, 10 minor.
- Dominant pattern: the MSP bundle quietly re-intermediates every absolute
  guarantee — sovereignty, continuity, isolation, self-sufficiency — with
  unstated exceptions.
- The three "bound the claim" remediations (R-12/R-13/R-14) never landed;
  every targeted claim stands verbatim, while the sweep pushed other claims
  ahead of the artifacts (present-tense fail-closed/batch-review).
- The unswept vision doc contradicts the ratified corpus on seven axes.
- Highest-leverage unowned design: self-fix metric → template certification →
  initial risk budgets (the trust cold-start escape).
- Seven founder decisions queued; the rest is authorized mechanical work.
