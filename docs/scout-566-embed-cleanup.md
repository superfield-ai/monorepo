# Scout 566 — Embed Cleanup: Exact Stale Comment Locations and Artifact List

**Date:** 2026-06-13  
**Issue:** #566  
**Phase:** embed-scout-cleanup (dev-scout)  
**Feeds:** #564 (fix stale references), #565 (delete scout artifacts)

---

## 1. `models/embedding.lock` — Stale `sf_embed` / `crates/sf-embed` References

File: `models/embedding.lock`

| Line | Current text                                                                                      | Replacement                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 9    | `#   Rust  — sf_embed::GOVERNED_MODEL, sf_embed::GOVERNED_MODEL_REVISION, sf_embed::GOVERNED_DIM` | `#   Rust  — nexum::embed::GOVERNED_MODEL, nexum::embed::GOVERNED_MODEL_REVISION, nexum::embed::GOVERNED_DIM` |
| 17   | `# HuggingFace model ID (safetensors, used by the Rust sf-embed crate via hf-hub + candle)`       | `# HuggingFace model ID (safetensors, used by the Rust crates/nexum/src/embed.rs via hf-hub + candle)`        |

**Rationale:** PR #474 (commit 87da7a3c) inlined the candle embedder from `crates/sf-embed` into
`crates/nexum/src/embed.rs`. The public constants are now `nexum::embed::GOVERNED_MODEL`,
`nexum::embed::GOVERNED_MODEL_REVISION`, and `nexum::embed::GOVERNED_DIM`. The file
`crates/sf-embed` still exists as a crate but is no longer the canonical Rust embedding
implementation. PR #560 already updated `docs/adr-embedding-model.md`; these two comment lines
in `models/embedding.lock` were missed.

---

## 2. `packages/db/index.ts` — Stale `crates/sf-embed` Reference

File: `packages/db/index.ts`

| Line | Current text                                                                         | Replacement                                                                                    |
| ---- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 34   | ` * weight downloads. It matches \`GOVERNED_MODEL_REVISION\` in \`crates/sf-embed\`` | ` * weight downloads. It matches \`GOVERNED_MODEL_REVISION\` in \`crates/nexum/src/embed.rs\`` |

**Context:** This is inside the JSDoc comment for `GOVERNED_EMBEDDING` (lines 27–39). The
surrounding text (lines 27–39) is a comment block; only line 34 needs updating.

---

## 3. Scout Artifact Files to Delete (feeds #565)

### Top-level `docs/` scout files (4 files)

All parent issues confirmed **CLOSED** via `gh api`.

| File                                   | Parent issue | Status |
| -------------------------------------- | ------------ | ------ |
| `docs/scout-534-loop-wiring.md`        | #534         | CLOSED |
| `docs/scout-541-prototype-cleanup.md`  | #541         | CLOSED |
| `docs/scout-549-embedding-accuracy.md` | #549         | CLOSED |
| `docs/scout-558-adr-routes.md`         | #558         | CLOSED |

### `docs/scout/` directory (8 files)

| File                                                                     | Parent issue | Status |
| ------------------------------------------------------------------------ | ------------ | ------ |
| `docs/scout/281-oci-firecracker-toolchain.md`                            | #281         | CLOSED |
| `docs/scout/294-c11-check-run-data-surfaces.md`                          | #294         | CLOSED |
| `docs/scout/365-nexum-typescript-surface-api-contracts.md`               | #365         | CLOSED |
| `docs/scout/375-cli-and-control-api-contracts.md`                        | #375         | CLOSED |
| `docs/scout/386-postgres-provisioning-migration-schemas.md`              | #386         | CLOSED |
| `docs/scout/387-existing-service-runtimes-and-shared-boundaries.md`      | #387         | CLOSED |
| `docs/scout/388-deployment-targets-and-runtime-error-sources.md`         | #388         | CLOSED |
| `docs/scout/389-fastenv-host-control-plane-and-substrate-reliability.md` | #389         | CLOSED |

### `docs/scouts/` directory (1 file + directory removal)

| File                                     | Parent issue | Status |
| ---------------------------------------- | ------------ | ------ |
| `docs/scouts/426-postgres-schema-map.md` | #426         | CLOSED |

The `docs/scouts/` directory should be removed after its only file is deleted.  
The `docs/scout/` directory should be removed after all 8 files are deleted.

**Total files to delete: 13 files + 2 empty directories.**

---

## 4. Verification Notes

- `crates/sf-embed` still exists as a Rust crate (`crates/sf-embed/Cargo.toml`, lib name
  `sf_embed`). It is out of scope — only comment references to it in lock/TS files are stale.
- The canonical Rust embedding implementation is `crates/nexum/src/embed.rs`, which exposes
  `GOVERNED_MODEL`, `GOVERNED_MODEL_REVISION`, and `GOVERNED_DIM` in the `nexum::embed`
  namespace.
- `docs/adr-embedding-model.md` was already fixed by PR #560 — no further changes needed there.
