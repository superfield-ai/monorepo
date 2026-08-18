# Anomaly — the External Observer

This document is the design spec for **`anomaly`**, Superfield's external
observer: a standalone crate/binary that monitors the appliance's external
surfaces from **outside its fate domain** — uptime, real user navigation, and
domain trust — and reports into the same mother database (the sharp
`episodes` / `runtime_signals` schema) in the same OTLP-shaped telemetry
format, so the agent diagnostic loop reads outside-in evidence exactly like
inside-out evidence.

Decisions below were locked in the product-owner brainstorm of 2026-08-13 and
are presented as decisions, not options. Companion docs:
[`architecture.md`](./architecture.md) (schema layout, sf-notify, daemon
lifecycle), [`eval-design.md`](./eval-design.md) (the episode trace as ledger).

**Origin incident (Linear RM-54).** A two-day-old go-forward domain sat fully
spoofable; the fix was applied by hand; two records went live malformed while
the dashboard read green. The audit that caught it ran once, manually.
`anomaly` turns that one-time manual audit into a control loop.

---

## Three probe planes

### Availability

HTTP(S) endpoint probes, TLS validity/expiry, DNS resolution, and latency
percentiles — measured from the public internet, the vantage point users
actually occupy. The appliance's own health endpoints can say "I am fine" while
nobody outside can reach them; this plane exists to catch exactly that.

### Journey

Synthetic replay of scripted critical user flows in a headless browser
(land → sign up → core action), asserting each step and emitting per-step
spans. A journey failure localizes to a step, not just a URL.

RUM beacons from the real frontend are the **v2 extension** of this plane, not
a competing design: RUM needs client instrumentation and consent, and cannot
detect a total outage (no users → no beacons), which is why synthetic ships
first. Both are specced; synthetic is v1, RUM is a later milestone (locked
decision 1).

### Domain trust

Continuous enforcement of the DOMAIN blueprint (superfield-blueprint PR #56 —
Domain Trust Blueprint):

- **Posture verification** — two-resolver checks of every controlled zone
  against its expected record set (SPF, DMARC, null-MX, DKIM-revoke, DS, CAA).
- **RDAP watching** — registration expiry, NS changes, registrar lock-status
  removal.
- **CT-log watching** — certificates issued for our names that nobody
  requested.

This plane is the RM-54 fix made permanent: posture is asserted continuously
against a declared expected state, not audited once by hand.

---

## Architecture

### Locus: outside the fate domain

`anomaly` is a new workspace crate (bare concept name, like `sharp` /
`nexum` / `fastenv`) producing a standalone binary. It is **not part of the
appliance deployment**. It runs on a minimal external host on a **different
provider and region** from the appliance (locked decision 2). Fate independence
is the point: the appliance can never observe its own unreachability, so its
observer must share nothing with it — not the host, not the provider, not the
region, not the failure modes.

### Components

| Component       | Responsibility                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Probe inventory | Declarative config listing zones, endpoints, journeys, and expected DNS record sets — sourced from the same config that drives deployment, never hand-duplicated. |
| Scheduler       | Cadenced execution of the inventory across the three planes.                                                                                                      |
| Probe executors | One executor per plane: availability, journey (headless browser), domain trust (resolvers, RDAP, CT logs).                                                        |
| Verdict engine  | Deterministic thresholds in v1 (catalogue below); baseline/deviation scoring reserved for v2.                                                                     |
| Reporter        | Writes probe results into the appliance ingest (below).                                                                                                           |
| Alerter         | The out-of-band channel (below).                                                                                                                                  |

The inventory sourcing rule is load-bearing: the moment expected state is
hand-copied into the observer, drift between "what we deploy" and "what we
check" reopens the RM-54 gap.

### Reporting path

**Healthy:** OTLP-shaped writes into the appliance ingest. `anomaly` respects
the zero-database-connectivity worker rule (spec #53): it holds **no direct
Postgres credential** and never touches the database itself.

**Degraded (appliance unreachable or ingest failing):** locked decision 3, two
legs, both mandatory —

1. **Write-ahead buffer.** Every observation lands first in an append-only
   local WAL. On recovery, the buffer is backfilled with **original
   timestamps**, and the gap itself is recorded as a first-class observation.
   No observation is ever lost.
2. **Out-of-band alerting.** A minimal alert channel with **independent
   credentials** (sf-notify-style push/email) that does not traverse the
   appliance. It fires on "appliance dark" and on unrecoverable probe
   verdicts. It is deliberately dumb — no templating stack, no dependency on
   appliance services — so it cannot share a failure mode with the thing it
   reports on. No outage is ever silent.

### Telemetry format

Same span/log shapes the appliance emits: episodes correlation id,
`runtime_signals` rows. An outside-in probe run is an episode like any other —
the diagnostic loop needs no special-case reader, and Tier-3-style scoring of
production traces (see [`eval-design.md`](./eval-design.md)) covers outside-in
evidence for free.

---

## v1 threshold catalogue

Detection in v1 is deterministic (locked decision 4). The catalogue:

| Plane        | Threshold                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------ |
| Availability | Endpoint down N consecutive probes                                                         |
| Availability | TLS certificate expiring in <30 days, or chain invalid                                     |
| Domain trust | DNS posture drift from the expected record set (any of SPF / DMARC / MX / DKIM / DS / CAA) |
| Domain trust | RDAP delta: NS change, registrar lock removed, expiry <90 days                             |
| Domain trust | CT-log certificate from an unknown issuer or key                                           |
| Journey      | Journey step failure, or step latency over budget                                          |
| Domain trust | DMARC aggregate reports stopped arriving                                                   |

---

## v2: baselines (specced, not built)

Per-metric rolling baselines — latency distributions, journey funnel
completion, traffic shape — with deviation scoring. The verdict record
**reserves `baseline_window` and `deviation_score` now**, so v1 data feeds v2
models without a migration (locked decision 4). v1 writes the fields as null;
nothing reads them until the model ships.

---

## Non-goals (v1)

- **RUM** — specced above as the journey plane's v2 extension; not built in v1.
- **Auto-remediation** — `anomaly` observes and reports; the agent loop
  decides. The observer never mutates the thing it observes.
- **In-cluster deployment** — running inside the appliance's fate domain
  defeats the crate's purpose.
- **Third-party SaaS monitors** — the point is evidence in our own schema,
  readable by our own loop.

---

## Open questions

- Which provider for the external host (constraint: different provider and
  region from the appliance).
- Probe cadence economics — per-plane cadences vs. cost of RDAP/CT polling and
  headless-browser runs.
- Whether the out-of-band channel reuses `sf-notify` or deliberately forks it
  to keep credentials and code paths independent.
- How journey scripts are authored and kept from drifting against the real
  frontend — likely tied to the e2e suite.

---

## Milestones

| Milestone | Scope                                                                |
| --------- | -------------------------------------------------------------------- |
| M1        | Availability + domain-trust planes, WAL buffer, out-of-band alerting |
| M2        | Synthetic journeys                                                   |
| M3        | Baselines + RUM                                                      |
