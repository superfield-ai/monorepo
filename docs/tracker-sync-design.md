# Tracker Sync — Bidirectional Sync with External Issue Trackers

This document is the design spec for **tracker sync**: the capability that
keeps Superfield's canonical database and a customer's external issue
tracker — GitHub first, then Linear, then Jira and others — in agreement,
in both directions, without either side silently drifting from the other.

Decisions below were locked in the product-owner brainstorm of 2026-08-13
and are presented as decisions, not options.

**Origin.** Today, Plan state lives *only* as markdown in a single GitHub
issue body (issue #199), parsed back out with regex/awk helper functions —
`plan_entries_json_from_body`, `plan_phases_json_from_body` — in
`superfield-ai/prompts`'s `scripts/{auto,feature,replan}/common.sh`, keyed
off an embedded `<!-- superfield: {json} -->` metadata comment per Plan
entry. That's a one-way, one-provider, string-parsing integration built to
prove the loop, not a sync engine. It has no notion of a second tracker, no
notion of ingesting a human edit made directly on GitHub, and roughly forty
files across that repo call `gh issue`/`gh pr`/`gh api graphql` directly with
no client abstraction between them and the GitHub CLI. This spec replaces
that ad hoc integration with a real, multi-tenant, multi-provider sync
engine.

---

## Why this is hard, in one paragraph

The canonical DB is the source of truth, but humans don't type into the
canonical DB — they type into GitHub issues, Linear tickets, Jira workflows.
So the system must push its own state out (for visibility) and pull human
edits back in (for correctness), and it must do both without those two
directions fighting each other: an outbound push produces exactly the kind
of remote change an inbound listener is watching for. Solving that
collision — not provider API shape, not schema design — is the load-bearing
problem this spec exists to solve.

---

## Current-state findings

These are verified against this codebase and cited so the design below is
grounded in what actually exists, not assumed:

- **Plan state today is markdown-only.** Issue #199's body is the sole
  record; `plan_entries_json_from_body` and `plan_phases_json_from_body` in
  `scripts/{auto,feature,replan}/common.sh` (in `superfield-ai/prompts`)
  regex/awk-parse it back into structured data on every read, keyed on an
  embedded `<!-- superfield: {json} -->` comment per entry. There is no
  database table backing Plan state; the issue body *is* the database.
- **No client abstraction in the live system.** ~40 files in
  `superfield-ai/prompts` shell out to `gh` directly (`gh issue
  create/edit/list/view`, `gh pr create/edit/list/view/checks/merge/ready`,
  `gh api graphql`). Every call site owns its own error handling and output
  parsing; there is no single seam a sync engine could sit behind today.
- **A real adapter interface already exists, but it's archived scaffolding.**
  `GitHubClientPort` in `packages/github/client.ts` of this monorepo is an
  Octokit-based structural interface (`getIssue`, `listIssues`,
  `createIssue`, `updateIssueBody`, `createIssueComment`,
  `addIssueLabel`/`removeIssueLabel`, `createPullRequest`,
  `listMergedPullRequests`, plus branch/file-contents helpers). It lived in
  the archived prototype orchestrator that `docs/architecture.md` explicitly
  says "must not be treated as appliance architecture." The surrounding
  system is deprecated, but the interface shape is a legitimate reference
  point for the outbound half of the new provider port — see
  [Reusing `GitHubClientPort`](#reusing-githubclientport) below.
- **No prior art in this codebase for multi-tracker support.** No docs, ADRs,
  or code comments anywhere discuss Linear or Jira as a concept. This spec
  is the first design surface for that idea.

---

## Locked decisions

1. **Multi-tenant product capability.** Different Superfield customers pick
   their own tracker — GitHub, Linear, later Jira — independently of each
   other. This is not an internal dogfooding integration; it is a feature
   every customer configures for their own tenant.
2. **The Superfield database is canonical.** Tasks, features, and PRs exist
   first in Superfield's own schema. The tracker is a projection of that
   state for human visibility, not the other way around.
3. **Sync is bidirectional.** Superfield pushes its state out, *and* ingests
   issues/comments/edits that human team members post directly in the
   external tracker, reconciling them back into the canonical DB.
4. **Reconciliation is deterministic-first, LLM-assisted-second.** Every
   inbound change is run through deterministic field/status/label mapping
   rules first. Only when the remote data is genuinely ambiguous — e.g. a
   freeform human comment implying an intent that doesn't map cleanly to a
   field change — does the system appeal to LLM inference to decide what to
   do with it.

---

## Architecture

### Three layers

**1. Canonical domain model + `provider_link` table.**
Tasks, features, and PRs live in Superfield's own schema, unchanged by
whether sync is configured. Alongside each syncable entity, a
`provider_link` join table records, per entity per tracker:

| Column               | Purpose                                                             |
| -------------------- | --------------------------------------------------------------------|
| `entity_id`           | FK to the canonical task/feature/PR row                            |
| `provider`            | `github` \| `linear` \| `jira` \| ...                              |
| `tenant_id`            | Which customer's provider connection this link belongs to         |
| `external_id`          | The tracker's own identifier (issue number, Linear ticket ID, ...)|
| `last_pushed_hash`     | Content hash/version of what Superfield last *wrote* out          |
| `last_seen_remote_hash`| Content hash/version of what Superfield last *read* from the tracker |

A row exists once a given entity is linked to a given tracker for a given
tenant; an entity with no `provider_link` row simply isn't synced anywhere.

**2. Provider port.**
A single adapter interface, implemented once per tracker, covering both
directions:

- **Outbound:** create/update issue, add/remove label, post comment — the
  same shape of operation regardless of tracker.
- **Inbound:** a normalized event stream (`issue_created`, `issue_updated`,
  `comment_posted`, `status_changed`, ...) that every provider implementation
  maps its own webhook payloads or poll diffs into. The sync engine only
  ever sees the normalized shape, never a provider-specific payload.

**3. Sync engine.**
Provider-agnostic. Consumes normalized inbound events, decides what changed
and whether it's an echo of Superfield's own write or a genuine external
edit, runs the reconciliation ladder, and issues outbound writes through the
provider port when canonical state changes need to be projected out.

### Echo suppression — the load-bearing invariant

Every outbound push (`provider_link.last_pushed_hash` updated, tracker
issue edited) is, from the tracker's point of view, indistinguishable from a
human edit. If sync is subscribed to webhooks or polling that tracker, its
own write bounces straight back as an inbound event. Without a way to
recognize "this inbound event is just an echo of what I wrote a moment ago,"
the sync engine will reconcile against its own output forever — a
self-sustaining feedback loop that either loops infinitely or, worse,
drifts on each round-trip if the reconciliation isn't perfectly
idempotent.

The fix: before reconciling any inbound event, the sync engine compares the
remote content's hash/version against `provider_link.last_pushed_hash` for
that entity/provider pair. A match means "this is what I last pushed —
it's an echo, not an edit," and the event is discarded without touching the
canonical DB. A mismatch means the remote side changed independently of
Superfield's last write, and the event proceeds to reconciliation.

This must be correct before anything else in this design is built. Every
other piece of this spec — the reconciliation ladder, LLM inference, field
mapping — assumes echo suppression is already filtering the inbound stream
down to genuine external edits. Get this wrong and every downstream
mechanism inherits a bug that looks like "sync is flaky" but is actually
"sync is arguing with itself."

### Reconciliation ladder

Inbound events that survive echo suppression are reconciled in two steps:

1. **Deterministic rules.** Field, status, and label changes that map
   cleanly onto a canonical field update — a Linear ticket moved to "Done,"
   a GitHub label added, a Jira status transition — are applied directly.
   Most inbound events resolve here.
2. **LLM inference, for what rules can't resolve.** A freeform comment that
   implies an intent — "actually let's push this to next sprint," a
   reply that reads as a scope change — has no deterministic mapping onto a
   canonical field. These go to LLM inference to decide what, if anything,
   should change in the canonical DB.

This repo already has a structurally identical pattern for "ambiguous,
don't block synchronously": `file-decision-issue.sh`'s default-and-defer
mechanism — apply a documented default action, file a decision record, and
continue rather than stopping the pipeline on an open question. Reconciliation
ambiguity is the same shape of problem: an inbound edit that can't be
resolved deterministically shouldn't block the sync engine or silently drop
the edit. This design reuses that escalation path rather than inventing a
new one: when LLM inference itself is uncertain, or when applying its
inferred change would be destructive, the engine applies the same
default-and-defer behavior — take the safe default action (typically: leave
the canonical field untouched), file a decision record describing the
ambiguous remote edit and the inference that was attempted, and continue
processing the rest of the inbound stream.

### Per-tenant field mapping

Field mapping is per-tenant configuration data, not a fixed table compiled
into the sync engine. GitHub labels, Linear workflow states/cycles, and
Jira per-project workflow statuses are not structurally comparable to each
other — a customer's Jira project may have a workflow with no GitHub-label
equivalent, and a Linear cycle has no meaning in GitHub at all. Each tenant,
per provider connection, configures its own mapping: which canonical status
values correspond to which tracker-side labels/states/statuses, which
canonical fields are pushed at all, and which inbound tracker fields feed
back into which canonical fields. The sync engine and provider port carry no
tracker-specific field assumptions; all of that lives in per-tenant
configuration consumed at reconciliation and push time.

### Multi-tenant credential and provider architecture

Because different customers use different trackers — and multiple customers
may use the same tracker with different accounts — provider connections are
runtime, per-tenant configuration, not a compile-time adapter swap:

- **Credential storage.** Per-customer OAuth tokens or API keys, scoped to a
  tenant and a provider, stored and rotated independently of any other
  tenant's credentials.
- **Provider registry.** A runtime registry mapping `provider` name to its
  provider-port implementation, so adding Jira later is "register a new
  implementation," not "recompile with a new adapter."
- **Connection lifecycle.** A tenant can connect, reconfigure, or disconnect
  a provider without affecting sync for any other tenant or provider.

### Reusing `GitHubClientPort`

`GitHubClientPort` (`packages/github/client.ts`) is Octokit-based and
outbound-only: `getIssue`, `listIssues`, `createIssue`, `updateIssueBody`,
`createIssueComment`, `updateIssueComment`, `deleteIssueComment`,
`addIssueLabel`/`removeIssueLabel`, `createPullRequest`,
`listMergedPullRequests`, plus branch and file-contents helpers.

- **Reusable as-is:** the outbound issue and comment operations
  (`getIssue`, `createIssue`, `updateIssueBody`, `createIssueComment`,
  `updateIssueComment`, `addIssueLabel`/`removeIssueLabel`) map directly
  onto the outbound half of the GitHub provider-port implementation. Their
  method shapes are a reasonable starting contract for "what outbound
  operations does a provider need to expose."
- **Needs extension:** the interface has no inbound half at all — no
  webhook receiver, no event normalization, no polling fallback. It was
  built for a system that only ever wrote to GitHub and read it back
  synchronously in the same process, never for a system that needs to react
  to a human editing an issue asynchronously. The GitHub provider-port
  implementation for this spec adds a webhook listener (issue
  edited/commented/labeled, PR state changed) and a polling fallback,
  translating both into the normalized inbound event stream described above.
  None of that inbound machinery exists anywhere in this codebase today.

---

## Open questions

- **Webhook vs. polling, per provider.** GitHub and Linear both support
  webhooks; whether tracker sync defaults to webhooks with a polling
  fallback, or polls uniformly for simplicity in early milestones, is not
  decided.
- **Conflict-resolution granularity for simultaneous edits.** If a canonical
  field and its linked tracker field change at nearly the same time (a
  human edits the tracker issue in the same window Superfield pushes an
  update), the precise conflict-resolution rule — last-write-wins by
  timestamp, field-level merge, or escalation to the reconciliation
  ladder's default-and-defer path — is not yet specified.

---

## Milestones

| Milestone | Scope                                                          |
| --------- | --------------------------------------------------------------- |
| M1        | GitHub provider, outbound push only (`provider_link`, provider port, sync engine skeleton) |
| M2        | GitHub inbound ingestion, echo suppression, deterministic reconciliation ladder |
| M3        | LLM-assisted reconciliation tier, per-tenant field mapping configuration |
| M4        | Linear provider (both directions), provider registry generalized beyond GitHub |
| M5        | Jira and additional providers |
