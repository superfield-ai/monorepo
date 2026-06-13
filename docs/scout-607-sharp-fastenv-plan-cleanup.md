# Scout: sharp-fastenv-plan-cleanup Phase (#607)

Scout issue: #607  
Phase: `sharp-fastenv-plan-cleanup`  
Date: 2026-06-13  
Scout role: READ-ONLY research + pin exact edit targets on downstream issues.

## Summary

Five edit targets identified across three files and Plan #199. All four downstream
issues (#603, #604, #605, #606) have received pinning comments.

---

## Target 1 — `crates/sharp/src/merge_flow.rs` (for issue #604)

Grep: `grep -n "superfield-ai/superfield-cli-ts" crates/sharp/src/merge_flow.rs`

| Line | Context                                                       |
| ---- | ------------------------------------------------------------- |
| 33   | Module doc comment (`//!`) — `MergeRequest` struct literal    |
| 60   | Field doc on `pub repo_name: String`                          |
| 209  | Unit test `merge_request_fields_are_correct` — struct literal |
| 231  | Unit test `assert_eq!` assertion                              |

**Old value (all 4 lines):** `"superfield-ai/superfield-cli-ts"`  
**Replacement:** `"superfield-ai/monorepo"`

Line 33 and 209 use `.to_string()` — replace only the string literal portion.  
Line 60 is a backtick-quoted example in a doc comment.  
Line 231 is a bare string in `assert_eq!`.

---

## Target 2 — `crates/sharp/tests/integration.rs` (for issue #604)

Grep: `grep -n "superfield-ai/superfield-cli-ts" crates/sharp/tests/integration.rs`

| Line | Context                                         |
| ---- | ----------------------------------------------- |
| 1274 | JSON literal field `"repo"` in integration test |

**Old value:** `"superfield-ai/superfield-cli-ts"`  
**Replacement:** `"superfield-ai/monorepo"`

---

## Target 3 — `crates/fastenv/README.md` (for issue #605)

Grep: `grep -n "superfield-ai/superfield-cli-ts" crates/fastenv/README.md`

| Line | Context                                              |
| ---- | ---------------------------------------------------- |
| 128  | Markdown hyperlink URL in the introductory paragraph |

**Old value:** `https://github.com/superfield-ai/superfield-cli-ts`  
**Replacement:** `https://github.com/superfield-ai/monorepo`

Only the URL changes. The surrounding sentence and link text
(`[Superfield](...)`) are unchanged.

---

## Target 4 — Plan #199: annotate #482 as closed (for issue #606)

Location: `## Unplaced candidates` section of issue #199 (body line 84).

**Remove** the three-line bullet for #482 (body lines 88–91) and its trailing
blank line.

**Insert** a blockquote annotation following the `#481` annotation pattern
(line 93):

```
> #482 closed as completed (2026-06-13): feat(observability): OpenTelemetry
> instrumentation, Postgres episodes schema, and AI anomaly-to-issue pipeline
> — substrate and loop-wiring slices shipped; issue is CLOSED.
```

Execution order: #606 must run **before** #603.

---

## Target 5 — Plan #199: mark plan-schema-docs-cleanup complete (for issue #603)

Location: `## Phase: plan-schema-docs-cleanup` section of issue #199 (body line 319).

All 9 issues in the phase are GitHub-state CLOSED. The following issue lines
need status markers updated:

| Issue | Current marker in Plan body | Required change        |
| ----- | --------------------------- | ---------------------- |
| #593  | `⊜`                         | `✓ (completed)`        |
| #586  | `⊜`                         | `✓ (completed)`        |
| #587  | `⊜`                         | `✓ (completed)`        |
| #588  | `⊜`                         | `✓ (completed)`        |
| #589  | `⊜`                         | `✓ (completed)`        |
| #592  | `⊜`                         | `✓ (completed)`        |
| #591  | _(none)_                    | append `✓ (completed)` |
| #590  | _(none)_                    | append `✓ (completed)` |
| #585  | _(none)_                    | append `✓ (completed)` |

Execution order: #603 must run **after** #606.

---

## Pinning comments posted

| Issue | Comment URL                                                                  |
| ----- | ---------------------------------------------------------------------------- |
| #604  | https://github.com/superfield-ai/monorepo/issues/604#issuecomment-4699269937 |
| #605  | https://github.com/superfield-ai/monorepo/issues/605#issuecomment-4699270149 |
| #603  | https://github.com/superfield-ai/monorepo/issues/603#issuecomment-4699270650 |
| #606  | https://github.com/superfield-ai/monorepo/issues/606#issuecomment-4699271010 |

---

## No-change guarantee

This scout made no edits to `merge_flow.rs`, `integration.rs`, `README.md`, or
Plan #199. Only pinning comments were posted and this artifact was committed.
