# Scout #622 — fastenv-doc-scout-cleanup

Scout for phase `fastenv-doc-scout-cleanup`. Findings below gate issues #619, #620, #621.

## Task 1 — Prettier baseline on architecture.md

Ran `bunx prettier --write crates/fastenv/docs/architecture.md`.

Result: **unchanged** — the file was already Prettier-clean. No diff to commit.

## Task 2 — Insertion point for §Doctor section (→ #619)

File: `crates/fastenv/docs/architecture.md`

Section headings found:

| Line | Heading                                   |
| ---- | ----------------------------------------- |
| 3    | `## 1. Overview`                          |
| 50   | `## 2. Trust Boundaries`                  |
| 98   | `## 3. Filesystem Layout`                 |
| 136  | `## 4. Execution Model`                   |
| 165  | `## 5. Policy Model`                      |
| 234  | `## 6. Cache Strategy`                    |
| 247  | `## 7. Security and Isolation Invariants` |
| 265  | `## 8. Container Lifecycle`               |
| 335  | `## 9. Open Decisions`                    |

**Insertion point:** Line 335 — insert the new `## 9. Doctor` section immediately before `## 9. Open Decisions` (which becomes `## 10. Open Decisions`).

**Recommended heading:** `## 9. Doctor`

**Content outline:** The `doctor` subcommand checks host prerequisites before any VM is started:

- `/dev/kvm` exists and is accessible (KVM device node present)
- The KVM kernel module is loaded (`lsmod | grep kvm`)
- Nested virtualization is enabled (`/sys/module/kvm_intel/parameters/nested` or `kvm_amd`)
- IOMMU is active (kernel cmdline contains `intel_iommu=on` or `amd_iommu=on`; `/sys/kernel/iommu_groups/` is populated)

Doctor emits a structured pass/fail report per check, exits non-zero if any required prerequisite is missing, and prints actionable remediation hints.

Pinning comment posted on #619.

## Task 3 — Stale scout artifact files confirmed (→ #621)

All three files confirmed present on `main`:

- `docs/scout-593-plan-schema-docs.md`
- `docs/scout-607-sharp-fastenv-plan-cleanup.md`
- `docs/scout-615-cargo-runner-plan-cleanup.md`

Issue #621 should delete all three in a single commit.

Pinning comment posted on #621.

## Task 4 — Plan #199 cargo-runner-plan-cleanup status (→ #620)

Fetched Plan #199 body. Under `## Phase: cargo-runner-plan-cleanup`, all three issues show `⊜` status:

- `#615` — `[dev-scout] establish exact edit targets for cargo-runner-plan-cleanup phase` — `⊜`
- `#614` — `fix stale superfield-cli-ts repository URL in Cargo.toml and docs/runner-setup.md` — `⊜`
- `#613` — `mark sharp-fastenv-plan-cleanup phase complete in Plan #199` — `⊜`

Issue #620 must change all three `⊜` markers to `✓ (completed)`.

Pinning comment posted on #620.
