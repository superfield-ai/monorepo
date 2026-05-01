# Studio Tab — UX Design

The Studio tab is the primary day-to-day surface for a Superfield operator. It gives a
single view of every feature in flight: what it is, what the agent is doing, and how to
intervene. This document specifies the two-column layout (Option B) adopted as the
target design.

---

## Goals

1. **Never lose context.** The feature list stays visible at all times. Selecting a feature
   loads its detail without replacing the rail — the operator can jump between features
   without hitting back.

2. **Local-first.** The studio is fully operational with no GitHub project configured.
   Features are created in the local embedded DB. GitHub is an optional sync target.

3. **Obvious entry point on a clean project.** An operator who has never created a feature
   sees one clear action: a labeled text field at the bottom of the rail that says
   "Name a new feature…" with a CREATE button. Nothing else competes for attention.

4. **Body in the DB.** Every feature has a description stored locally. For features that
   arrive via the dev-loop (active slots) before a sync has run, the UI auto-registers a
   stub record so the operator can immediately write or edit the description in place.

5. **Three intent modes, one bottom bar.** The form at the bottom of the detail panel
   changes label and action depending on what state the feature is in:
   - No active session → UPDATE (edit the local spec)
   - Active session → STEER (send mid-turn context to the running agent)

---

## Overall Structure

```
┌──────────────────────────────────────────────────────────────────────┐
│  Studio │ Viewport │ Product                                    [!2] │  ← tab bar
├──────────────────┬───────────────────────────────────────────────────┤
│  FEATURES        │                                                   │
│  ─────────────── │        (detail panel — see below)                 │
│  ● #42  Billing… │                                                   │
│    #38  Dark mo… │                                                   │
│    #35  CSV exp… │                                                   │
│    #31  Auth re… │                                                   │
│                  │                                                   │
│                  │                                                   │
│                  │                                                   │
│                  │                                                   │
├──────────────────┤                                                   │
│  [New feature…]  │                                                   │
│  [   CREATE   ]  │                                                   │
└──────────────────┴───────────────────────────────────────────────────┘
     ← 220 px →    ←              flex-1                              →
```

The two zones are separated by a 1 px `var(--border-subtle)` vertical rule. The rail
does not resize (no drag handle). The detail panel fills the remaining width.

---

## Zone 1 — Feature Rail (left, 220 px fixed)

### Header

```
┌──────────────────┐
│  FEATURES        │   ← ALL-CAPS mono label, var(--fg-1)
│                  │   ← "loading…" appears inline right of label while polling
```

The header row has no border at the top (it butts against the tab bar border). A 1 px
`var(--border-subtle)` line runs below it, separating it from the list body.

### Feature Row

Each row is a `<button>` that fills the rail width.

```
┌──────────────────┐
│ ● #42  Billing…  │   ← active slot: cyan pulse dot + truncated title
│   #38  Dark mo…  │   ← local DB item: no dot, status badge right-aligned
│   draft          │   ← status badge: var(--fg-3), font-mono, xs, uppercase
└──────────────────┘
```

**Active slot** (source = `"slot"`, status = `"active"`):
- 6 px filled circle, `var(--accent-cyan)`, vertically centred left of the number.
- Issue number in `var(--accent-cyan)`.
- Title truncated with ellipsis at 1 line.
- No status badge (the dot communicates "running").

**Local DB item** (source = `"db"`):
- No dot.
- Issue number in `var(--accent-cyan)`.
- Title truncated at 1 line.
- Status badge right-aligned: one of `draft` / `open` / `in_progress` / `blocked`.
  `done` items are filtered out of the list entirely.

**Selected row**:
- Left border 2 px `var(--accent-cyan)`.
- Background `var(--bg-base)` (slightly lighter than the raised rail background).

**Hover**:
- Border color transitions to `var(--accent-cyan)` on the full row border (1 px).

**Row height**: 40 px minimum, padding `var(--sp-2) var(--sp-3)`.

### Empty State

When there are no features (fresh project, no slots, no DB records):

```
┌──────────────────┐
│  FEATURES        │
│                  │
│                  │
│   NO FEATURES    │
│                  │
│                  │
│                  │
├──────────────────┤
│  [New feature…]  │
│  [   CREATE   ]  │
└──────────────────┘
```

The empty-state message is `var(--fg-3)`, font-mono, xs, uppercase, centred. It does
**not** include a call to action — the CREATE form below is the only action. Avoid
duplicating it in the empty state copy.

### Create Form (bottom of rail, always visible)

```
┌──────────────────┐
│ ┌──────────────┐ │
│ │Name a new fe…│ │   ← textarea, 2 rows, font-mono
│ └──────────────┘ │
│ [    CREATE    ] │   ← full-width button, var(--accent-cyan) border
└──────────────────┘
```

- Separated from the list by a 1 px `var(--border-subtle)` line.
- `pushToGithub: false` — creates a local DB record only. If GitHub credentials are
  configured the sync service will pick it up on the next interval.
- On success: refetch the list, auto-select the new feature, open detail panel.
- On Enter (no Shift): submit. Shift+Enter inserts a newline.
- Button is disabled and 40% opacity while the input is empty.

---

## Zone 2 — Detail Panel (right, flex-1)

### No Selection State (default on load)

When no feature is selected the detail panel shows a neutral empty state:

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│                                                       │
│              Select a feature from the list           │
│              or create one to get started.            │
│                                                       │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Text: `var(--fg-3)`, font-mono, xs, uppercase, centred. No form visible.

### Feature Selected — Header

```
┌───────────────────────────────────────────────────────┐
│  ← BACK   #42  Billing overhaul              ACTIVE   │
└───────────────────────────────────────────────────────┘
```

- `← BACK` ghost button (font-mono, xs, `var(--fg-2)`, subtle border). Returns to
  "no selection" state without closing the rail. Keyboard: Escape.
- Issue number `var(--accent-cyan)`, font-mono, xs.
- Title `var(--fg-1)`, font-sans, sm, truncated.
- `ACTIVE` badge right-aligned, `var(--accent-cyan)`, font-mono, xs — only shown when
  `source === "slot"`. No badge for local-only items.
- 1 px `var(--border-subtle)` line below the header.

### Detail Body (scrollable)

```
┌───────────────────────────────────────────────────────┐
│  DESCRIPTION                                          │
│  ─────────────────────────────────────────────────── │
│  - [x] Design payment flow                            │
│  - [ ] Stripe webhook handler                         │
│  - [ ] Invoice PDF generation                         │
│                                                       │
│  SESSION LOG                                          │
│  ─────────────────────────────────────────────────── │
│  10:42  2.3s  $0.04  "Implement Stripe webhook…"     │
│  10:31  1.8s  $0.03  "Scaffold billing module"        │
│  10:18  4.1s  $0.07  "Design session: payment flow"   │
│                                                       │
└───────────────────────────────────────────────────────┘
```

The body is a single `overflow-y: auto` scroll container. Sections are separated by
section headers (ALL-CAPS mono label + 1 px divider line), not by cards or boxes.

#### DESCRIPTION section

- Renders the feature's `body` field from the local DB.
- Parses GitHub-style task lists (`- [ ]` / `- [x]`) into a checklist. Each item renders
  with a mono checkbox glyph (`[ ]` or `[x]`) in `var(--fg-3)` / `var(--accent-green)`.
- When `body` is empty or absent: shows the prompt
  `"No description yet — add one using the form below. Use - [ ] item for tasks."` in
  `var(--fg-3)`, font-mono, xs. This is the only instruction copy in the panel.
- Checkboxes are **not interactive** (read-only). Editing the body is done via the UPDATE
  form below.

Section label rename: **DESCRIPTION** (not SUBTASKS) — the section displays the full
body including prose, not just task items. The task list is a subset of the body.

#### SESSION LOG section

- Only shown when `feature.sessionId` is defined (i.e. an active or recently active slot).
- Renders `TurnTimeline` — a flat list of turns, each on one row:
  ```
  HH:MM  Xs  $X.XX  "first 60 chars of prompt…"
  ```
  Clicking a row opens a modal with the full prompt + response.
- When `sessionId` is undefined: the SESSION LOG section is hidden entirely (not shown
  with an empty state). An operator working on a local-only feature doesn't need to
  see the log section.

### Bottom Form (always docked, never scrolls away)

The form docks to the bottom of the detail panel. Its label, placeholder, and button
change based on feature state:

```
             ┌────────────────────────────────────────┐
             │ placeholder text…                      │  ← textarea, 2 rows, font-mono
             └────────────────────────────────────────┘
             [              BUTTON LABEL             ]
```

| Condition                        | Placeholder                         | Button   | Action                           |
|----------------------------------|-------------------------------------|----------|----------------------------------|
| Feature selected, no session     | `Refine the feature spec…`          | `UPDATE` | `PATCH /studio/issues/:n` (body) |
| Feature selected, active session | `Steer the running agent…`          | `STEER`  | `POST /studio/steer`             |

The textarea is `var(--bg-base)`, 1 px `var(--border-subtle)` border, font-mono, sm.
The button is full-width beneath the textarea, `var(--accent-cyan)` border and text,
transparent background. Disabled + 40% opacity when input is empty.

On Enter (no Shift): submit. Shift+Enter inserts newline.

**UPDATE behaviour**: after a successful patch the section body re-renders from the
updated DB record. No full page reload. If the updated body contains `- [ ]` items the
DESCRIPTION section immediately shows them.

**STEER behaviour**: no visible confirmation — the form clears and focus returns to the
textarea. The agent turn appears in SESSION LOG when the turn log polls next.

**Error display**: errors from either action appear inline above the textarea in
`var(--accent-red)`, font-mono, xs. Auto-dismissed on next successful action.

---

## State Machine

```
LOAD
 └─ fetch slots + DB
     ├─ for each slot missing from DB → POST /studio/issues { number } (stub)
     └─ merge into feature list

LIST VIEW (no selection)
 ├─ click rail row     → DETAIL VIEW (feature selected)
 └─ submit CREATE form → POST /studio/issues { title }
                         → on success: refetch + auto-select new feature

DETAIL VIEW (feature selected)
 ├─ press Escape / click ← BACK → LIST VIEW
 ├─ click different rail row    → DETAIL VIEW (new feature, no navigation)
 ├─ submit UPDATE form          → PATCH /studio/issues/:n { body }
 │                               → on success: refetch, re-render DESCRIPTION
 └─ submit STEER form           → POST /studio/steer { context, sessionId }
                                 → on success: clear form
```

Polling runs every 10 seconds regardless of which view is active. On each poll the
visible list and detail body update in place without visual flash.

---

## Data Sources

| UI element           | Source                              | Poll interval |
|----------------------|-------------------------------------|---------------|
| Feature rail list    | `/analytics/slots` + `/studio/issues` | 10 s        |
| Feature body/title   | `/studio/issues` (embedded DB)      | 10 s          |
| Session log (turns)  | `/studio/turns/:sessionId`          | on detail open + 10 s |
| Sync trigger         | `POST /studio/sync/github`          | manual only   |

The embedded DB (`packages/db`) is the sole source of truth for title and body.
`/analytics/slots` supplies `sessionId` and slot metadata only.

---

## Visual Design Tokens

All measurements use the shared design token set. Key tokens for this surface:

| Token                  | Usage                                    |
|------------------------|------------------------------------------|
| `var(--bg-base)`       | Detail panel background, selected row bg |
| `var(--bg-raised)`     | Rail background, form docking areas      |
| `var(--border-subtle)` | All 1 px dividing lines                  |
| `var(--fg-1)`          | Primary text (titles, body copy)         |
| `var(--fg-2)`          | Secondary text (back button label)       |
| `var(--fg-3)`          | Tertiary text (empty states, timestamps) |
| `var(--accent-cyan)`   | Numbers, active badge, CREATE button     |
| `var(--accent-green)`  | Completed task `[x]` glyph               |
| `var(--accent-red)`    | Inline error messages                    |
| `var(--font-mono)`     | All labels, badges, form inputs          |
| `var(--font-sans)`     | Feature titles in rail and header        |
| `var(--text-xs)`       | Labels, badges, timestamps               |
| `var(--text-sm)`       | Body text, form textarea                 |
| `var(--sp-2)`          | Row padding vertical                     |
| `var(--sp-3)`          | Row padding horizontal, section gap      |
| `var(--sp-4)`          | Detail body padding                      |

Rail width: **220 px**, fixed, no resize handle.

---

## Keyboard Interactions

| Key              | Context            | Action                             |
|------------------|--------------------|-------------------------------------|
| `Escape`         | Detail view        | Return to no-selection (back)       |
| `Enter`          | CREATE textarea    | Submit create form                  |
| `Enter`          | UPDATE/STEER form  | Submit form                         |
| `Shift+Enter`    | Any textarea       | Insert newline                      |
| `↑` / `↓`        | Rail (future)      | Move selection between features     |

---

## Responsive Behaviour

The two-column layout is designed for laptop and desktop widths (≥ 900 px).

At narrower widths (< 768 px):
- The rail collapses — the layout switches back to the single-pane drill-down (Option A
  behaviour). The rail is shown as the list view; selecting a feature replaces it with
  the detail view plus a back button.
- This breakpoint is handled via a CSS media query; the component tree does not change.

The Studio tab is not intended for mobile use.

---

## Section Labels — Canonical Names

| Old label   | New label       | Reason                                             |
|-------------|-----------------|-----------------------------------------------------|
| SUBTASKS    | DESCRIPTION     | The section shows the full body, not only task items |
| (none)      | SESSION LOG     | Unchanged                                           |

---

## Open Design Questions

1. **Editable title.** Should the feature title be editable inline in the header? Current
   design: title is set at creation only. Update: only the body (`PATCH … { body }`).
   If title editing is needed, a small pencil icon next to the title in the header would
   trigger an inline input.

2. **Checkbox interactivity.** Should clicking `[ ]` in the DESCRIPTION section directly
   patch the body? Current design: read-only. Patching requires the UPDATE form. This is
   intentional to keep the edit surface explicit, but it could be added later with a
   debounced patch on checkbox toggle.

3. **GitHub sync indicator.** When `GITHUB_TOKEN` + `GITHUB_REPO` are set, should the
   rail header show a sync badge (e.g. `↻ synced 3m ago`)? Not in scope for this
   iteration — the sync service logs via debug events already.

4. **Rail width configurability.** 220 px is fixed. If title truncation becomes annoying
   with longer issue titles, a drag-resize handle on the rail/detail border could be
   added. Not in scope for this iteration.

5. **Multi-repo.** All features are currently scoped to one `GITHUB_REPO`. If multi-repo
   support is added, the rail would need a repo selector above the FEATURES header. Not
   in scope.
