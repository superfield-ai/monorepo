# Scout #576 — Backlink & Cargo Cleanup Findings

**Phase:** backlink-cargo-cleanup  
**Scout issue:** #576  
**Scout PR:** #577  
**Date:** 2026-06-13

---

## 1. Prettier baseline — `docs/adr-embedding-model.md`

```
bunx prettier --write docs/adr-embedding-model.md
# → docs/adr-embedding-model.md 142ms (unchanged)
```

The file was already Prettier-clean. No diff was produced; no commit needed for
formatting. `bunx prettier --check docs/adr-embedding-model.md` exits 0.

**Workers for issues #570–#575 must NOT re-run Prettier on this file.**

---

## 2. Stale back-links in `packages/` — target for issue #570

`grep -rn 'docs/scout/\|docs/scouts/' packages/`

| File | Line | Stale reference | Replacement |
|------|------|-----------------|-------------|
| `packages/db/nexum-migration.ts` | 21 | `docs/scout/386-postgres-provisioning-migration-schemas.md` | `docs/architecture.md §Single-Instance Database Schema Layout` and `§Migration ownership` |
| `packages/db/migrations/nexum/0002__nexum_data_cutover.sql` | 23 | `docs/scout/386-postgres-provisioning-migration-schemas.md` | `docs/architecture.md §Single-Instance Database Schema Layout` |
| `packages/db/migrations/nexum/0001__nexum_schema.sql` | 12 | `docs/scout/386-postgres-provisioning-migration-schemas.md (Nexum inventory)` | `docs/architecture.md §Single-Instance Database Schema Layout` |
| `packages/db/index.ts` | 65 | `docs/scout/387-existing-service-runtimes-and-shared-boundaries.md` | `docs/architecture.md §Single-Instance Database Schema Layout` |
| `packages/db/index.ts` | 82 | `docs/scout/387-existing-service-runtimes-and-shared-boundaries.md` | `docs/architecture.md §Single-Instance Database Schema Layout` |
| `packages/db/index.ts` | 396 | `docs/scout/386-postgres-provisioning-migration-schemas.md` | `docs/architecture.md §Single-Instance Database Schema Layout` and `§Migration ownership` |
| `packages/firecracker/ebpf.ts` | 33 | `docs/scout/389-fastenv-host-control-plane-and-substrate-reliability.md` | `docs/architecture.md §Substrate Reliability` |
| `packages/firecracker/index.ts` | 24 | `docs/scout/281-oci-firecracker-toolchain.md` | `crates/fastenv/docs/scout/firecracker-prerequisites.md` |
| `packages/firecracker/index.ts` | 35 | `docs/scout/389-fastenv-host-control-plane-and-substrate-reliability.md` | `docs/architecture.md §Substrate Reliability` |
| `packages/firecracker/index.ts` | 87 | `docs/scout/389-fastenv-host-control-plane-and-substrate-reliability.md §Host Control Plane` | `docs/architecture.md §Substrate Reliability` |
| `packages/core/commands/deploy.ts` | 33 | `docs/scout/388-deployment-targets-and-runtime-error-sources.md` | `docs/architecture.md §CLI — Command Surface` |
| `packages/core/commands/deploy.ts` | 42 | `docs/scout/388-deployment-targets-and-runtime-error-sources.md §Runtime-Signal Sources` | `docs/architecture.md §CLI — Command Surface` |
| `packages/cli/commands/ci.ts` | 18 | `docs/scout/281-oci-firecracker-toolchain.md` | `crates/fastenv/docs/scout/firecracker-prerequisites.md` |
| `packages/firecracker/vm.ts` | 13 | `docs/scout/281-oci-firecracker-toolchain.md` | `crates/fastenv/docs/scout/firecracker-prerequisites.md` |

None of the referenced `docs/scout/281-*`, `docs/scout/386-*`, `docs/scout/387-*`,
`docs/scout/388-*`, `docs/scout/389-*` files exist. They were deleted scout
artifacts. Replacements point to the live canonical sources.

---

## 3. Stale back-link in `crates/sf-cli/src/deploy_ops.rs` — target for issue #571

`grep -n 'docs/scout/' crates/sf-cli/src/deploy_ops.rs`

**Line 21 (current):**
```rust
//! See `docs/architecture.md` §5 and `docs/scout/375-cli-and-control-api-contracts.md`
//! §2 (Operator Commands).
```

The file `docs/scout/375-cli-and-control-api-contracts.md` does not exist.
The `§5` reference is wrong (architecture.md uses named headings, not numbered
sections).

**Replacement:**
```rust
//! See `docs/architecture.md` §CLI — Command Surface (deploy subcommands) and
//! §Daemon Lifecycle (auto-spawn flow).
```

---

## 4. Wrong-prefix `docs/scout/` paths in `crates/fastenv/src/` — target for issue #572

`grep -rn 'docs/scout/' crates/fastenv/src/`

The files exist at `crates/fastenv/docs/scout/` — all occurrences use the wrong
root-relative prefix.

| File | Lines | Stale path | Correct path |
|------|-------|------------|--------------|
| `crates/fastenv/src/host_control_plane.rs` | 13 | `docs/scout/firecracker-prerequisites.md` | `crates/fastenv/docs/scout/firecracker-prerequisites.md` |
| `crates/fastenv/src/host_control_plane.rs` | 222 | `docs/scout/firecracker-prerequisites.md` | `crates/fastenv/docs/scout/firecracker-prerequisites.md` |
| `crates/fastenv/src/host_control_plane.rs` | 683 | `docs/scout/firecracker-prerequisites.md §4` | `crates/fastenv/docs/scout/firecracker-prerequisites.md §4` |
| `crates/fastenv/src/guest_ebpf.rs` | 6 | `docs/scout/guest-ebpf-findings.md` | `crates/fastenv/docs/scout/guest-ebpf-findings.md` |
| `crates/fastenv/src/guest_ebpf.rs` | 266 | `docs/scout/guest-ebpf-findings.md` | `crates/fastenv/docs/scout/guest-ebpf-findings.md` |
| `crates/fastenv/src/guest_ebpf.rs` | 305 | `docs/scout/guest-ebpf-findings.md` | `crates/fastenv/docs/scout/guest-ebpf-findings.md` |
| `crates/fastenv/src/guest_ebpf.rs` | 335 | `docs/scout/guest-ebpf-findings.md` | `crates/fastenv/docs/scout/guest-ebpf-findings.md` |
| `crates/fastenv/src/guest_ebpf.rs` | 547 | `docs/scout/guest-ebpf-findings.md` | `crates/fastenv/docs/scout/guest-ebpf-findings.md` |
| `crates/fastenv/src/guest_ebpf.rs` | 1013 | `docs/scout/guest-ebpf-findings.md` | `crates/fastenv/docs/scout/guest-ebpf-findings.md` |
| `crates/fastenv/src/exec.rs` | 6 | `docs/scout/phase2-findings.md` | `crates/fastenv/docs/scout/phase2-findings.md` |
| `crates/fastenv/src/exec.rs` | 7 | `docs/scout/phase3-findings.md` | `crates/fastenv/docs/scout/phase3-findings.md` |
| `crates/fastenv/src/exec.rs` | 223 | `docs/scout/guest-ebpf-findings.md §1` | `crates/fastenv/docs/scout/guest-ebpf-findings.md §1` |

**Note:** `crates/fastenv/src/doctor.rs` line 6 already uses the correct prefix
(`crates/fastenv/docs/scout/firecracker-prerequisites.md`) — no change needed.

**Available files at correct prefix:**
```
crates/fastenv/docs/scout/firecracker-prerequisites.md
crates/fastenv/docs/scout/guest-ebpf-findings.md
crates/fastenv/docs/scout/hardware-validation.md
crates/fastenv/docs/scout/issue-72-findings.md
crates/fastenv/docs/scout/phase1-findings.md
crates/fastenv/docs/scout/phase2-findings.md
crates/fastenv/docs/scout/phase3-findings.md
crates/fastenv/docs/scout/phase4-findings.md
```

**Fix:** In each file, replace every occurrence of `docs/scout/<filename>` with
`crates/fastenv/docs/scout/<filename>`.

---

## 5. Phases to mark complete in Plan #199 — target for issue #573

All issues in the following phases are GitHub-CLOSED. Plan #199 can be updated to
mark them complete.

**Exact phase heading strings and their issues:**

| Phase heading | Issues (all CLOSED) |
|---------------|---------------------|
| `## Phase: loop-wiring-fixes` | #534, #531, #532, #533 |
| `## Phase: docs-prototype-cleanup` | #541, #539, #540 |
| `## Phase: embedding-accuracy-fixes` | #549, #545, #546, #548 |
| `## Phase: adr-routes-cleanup` | #558, #554, #555, #556, #557 |
| `## Phase: embed-scout-cleanup` | #566, #564, #565 |

Each phase's issue lines should have `⊜` replaced with `✓ (completed)`.

---

## 6. sf-embed workspace references for removal — target for issue #574

`grep -rn 'sf-embed\|sf_embed' Cargo.toml crates/sf-embed/`

**Root `Cargo.toml`:**
- Line 13: `"crates/sf-embed"` — workspace member (remove from `members` array)
- Line 35: `sf-embed = { path = "crates/sf-embed" }` — workspace dependency (remove from `[workspace.dependencies]`)

**`crates/sf-embed/Cargo.toml`:**
- Line 2: `name = "sf-embed"`
- Line 11: `name = "sf_embed"` (benchmark name)

**`crates/sf-embed/src/lib.rs`:**
- Line 1: `//! \`sf-embed\` — in-process embedding crate for the Superfield Rust binary.`
- Line 132: `/// use sf_embed::Embedder;`
- Line 136: `/// assert_eq!(vec.len(), sf_embed::GOVERNED_DIM);`

**Removal plan:**
1. Remove `"crates/sf-embed"` from `[workspace] members` in root `Cargo.toml`
2. Remove `sf-embed = { path = "crates/sf-embed" }` from `[workspace.dependencies]` in root `Cargo.toml`
3. Delete `crates/sf-embed/` directory entirely

**Pre-deletion check:**
```bash
grep -rn 'sf-embed\|sf_embed' crates/ --exclude-dir=sf-embed
# Expected: no results — embedding logic was inlined into crates/nexum/src/embed.rs
```

---

## 7. Stale TypeScript/Xenova claims in `docs/adr-embedding-model.md` — target for issue #575

`grep -n 'Xenova\|@xenova\|TypeScript' docs/adr-embedding-model.md`

| Line | Content | Action |
|------|---------|--------|
| 30 | `\| **Model (JS/TS)** \| \`Xenova/all-MiniLM-L6-v2\` (ONNX, via \`@xenova/transformers\`) \|` | Remove this table row — TypeScript consumers no longer use `@xenova/transformers` |
| 101 | `### TypeScript (\`packages/db/index.ts\`)` | Remove entire subsection (lines 101–111) |
| 105 | `  model: "Xenova/all-MiniLM-L6-v2",` | Part of subsection removal above |
| 146 | `TypeScript consumers use \`@xenova/transformers\` with the same underlying` | Replace with Rust-only claim |

**Sections to neutralize:**

1. **Line 30** — Remove `| **Model (JS/TS)** | ... |` row from Standards table.

2. **Lines 101–111** — Remove the entire `### TypeScript (packages/db/index.ts)`
   subsection including its fenced code block.

3. **Line 146** — Replace:
   > The `crates/nexum/src/embed.rs` module is the canonical implementation for Rust consumers;
   > TypeScript consumers use `@xenova/transformers` with the same underlying
   > model weights.

   With:
   > The `crates/nexum/src/embed.rs` module is the canonical implementation;
   > all embedding calls go through the Rust service layer.

**Reminder:** `bunx prettier --check docs/adr-embedding-model.md` already exits 0.
Workers must NOT re-run Prettier on this file.

---

## Integration risks

- The `packages/firecracker` and `packages/core` and `packages/db` TypeScript
  packages appear to be retiring (ref Plan #199 Browser UI cutover phase). Workers
  for #570 should confirm whether these files are already slated for deletion
  before doing comment-only fixes.
- `crates/sf-embed/` has no reverse dependencies in the workspace (embedding was
  inlined); verify with the pre-deletion grep before removing.
- No Rust or TypeScript compilation is affected by any comment/doc-string change
  in this phase.
