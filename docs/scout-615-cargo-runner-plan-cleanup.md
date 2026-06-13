# Scout: cargo-runner-plan-cleanup (issue #615)

## Phase

cargo-runner-plan-cleanup

## Purpose

Pin exact edit targets for the two worker issues in this phase:

- **#614** — fix two stale `superfield-cli-ts` URLs (`Cargo.toml` + `docs/runner-setup.md`)
- **#613** — mark sharp-fastenv-plan-cleanup phase complete in Plan #199

---

## Finding 1 — `Cargo.toml` line 21

**File:** `Cargo.toml`
**Line:** 21

Current:

```toml
repository = "https://github.com/superfield-ai/superfield-cli-ts"
```

Replace with:

```toml
repository = "https://github.com/superfield-ai/monorepo"
```

**Pinned in:** [#614 comment](https://github.com/superfield-ai/monorepo/issues/614#issuecomment-4699360013)

---

## Finding 2 — `docs/runner-setup.md` line 27

**File:** `docs/runner-setup.md`
**Line:** 27

Current:

```sh
  --url https://github.com/superfield-ai/superfield-cli-ts \
```

Replace with:

```sh
  --url https://github.com/superfield-ai/monorepo \
```

**Pinned in:** [#614 comment](https://github.com/superfield-ai/monorepo/issues/614#issuecomment-4699360013)

---

## Finding 3 — Plan #199 sharp-fastenv-plan-cleanup phase lines (#613)

**Source:** `gh issue view 199 --json body -q .body`
**Phase heading:** `## Phase: sharp-fastenv-plan-cleanup`

All five issues in this phase currently lack a `✓` completion marker. The following lines must be updated:

| Issue | Current status symbol | Required change                          |
| ----- | --------------------- | ---------------------------------------- |
| #607  | `⊜`                   | `✓ (completed)`                          |
| #604  | `⊜`                   | `✓ (completed)`                          |
| #605  | `⊜`                   | `✓ (completed)`                          |
| #606  | `⊜`                   | `✓ (completed)`                          |
| #603  | (none)                | append `✓ (completed)` after `[risk: 1]` |

**Pinned in:** [#613 comment](https://github.com/superfield-ai/monorepo/issues/613#issuecomment-4699360664)

---

## No-op confirmation

No content changes were made to `Cargo.toml`, `docs/runner-setup.md`, or Plan #199.
All findings are read-only observations.
