# Scout 541 — docs-prototype-cleanup findings

**Phase:** docs-prototype-cleanup  
**Scout issue:** #541  
**Downstream issues:** #539 (Xenova/ONNX + dead link), #540 (four stale TypeScript references)  
**Date:** 2026-06-13

## Prettier baseline

`bunx prettier --check docs/architecture.md` exits 0 before and after running
`bunx prettier --write`. The file was already formatted; no diff was produced.
Workers on downstream issues **must not** re-run prettier on `docs/architecture.md`.

---

## Issue #539 targets — §Governed Embedding Standard

### Runtime row (Xenova/ONNX → candle)

File: `docs/architecture.md`

| Line | Current text                                                                       |
| ---- | ---------------------------------------------------------------------------------- |
| 179  | `\| **Runtime**    \| Local inference via Xenova (ONNX) — no external API call \|` |

Replace with:

```
| **Runtime**    | Local inference via `candle` (Rust, CPU/GPU) — no external API call |
```

Context: `crates/sf-embed` and `crates/nexum` implement embedding using
[candle](https://github.com/huggingface/candle), not the Node/Xenova/ONNX
runtime referenced in the table.

### Dead link to issue #75

File: `docs/architecture.md`

| Line | Current text                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| 207  | `\| Nexum     \| \`nexum\` \| \`links\` \| \`edge_embedding\` \| 384 \| Conforming — stub; population tracked in issue #75 \|` |

Remove the "population tracked in issue #75" clause. The issue link is stale
(#75 is closed / no longer relevant). The replacement status cell should read:

```
Conforming — stub; edge_embedding population not yet implemented
```

---

## Issue #540 targets — four stale TypeScript prototype references

### 1. §AGE graph extension — packages/db/nexum-graph.ts

File: `docs/architecture.md`

| Line | Current text                                                                                                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 164  | `The \`packages/db/nexum-graph.ts\` module provides \`traverseGraph()\` (recursive CTE), \`isGraphReady()\`, and \`NEXUM_GRAPH_SETUP_SQL\`. Integration tests in \`packages/db/tests/nexum-graph.test.ts\` verify multi-hop traversal against a single containerised Postgres instance.` |

Replace with a reference to the Rust implementation:

```
The `crates/nexum/src/query.rs` module provides `traverseGraph()` (recursive CTE),
`isGraphReady()`, and graph traversal over `nexum.links`. Integration tests in
`crates/nexum/tests/` verify multi-hop traversal against a single containerised
Postgres instance.
```

### 2. §Nexum intro — external GitHub link

File: `docs/architecture.md`

| Line | Current text                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------- |
| 29   | `[\`superfield-ai/nexum\`](https://github.com/superfield-ai/nexum) is the unified operational store…` |

Replace with a monorepo-relative reference:

```
[`crates/nexum`](crates/nexum) is the unified operational store…
```

The external `github.com/superfield-ai/nexum` repository is retired; the
implementation lives at `crates/nexum/` in this monorepo.

### 3. crates/nexum/src/query.rs — "mirrors the TypeScript" module doc

File: `crates/nexum/src/query.rs`

| Lines | Current text                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4–6   | `//! \`sf-db\` pool. The module mirrors the TypeScript \`src/routes/query.ts\``/`//! implementation in \`superfield-ai/nexum\` so that result shapes and SQL`/`//! semantics are identical.` |

Remove lines 4–6 (the "mirrors the TypeScript …" sentence). The module doc
opening should read:

```rust
//! Nexum query layer — full-text, semantic (HNSW), graph, and hybrid.
//!
//! All four query modes run against the single shared Postgres instance via the
//! `sf-db` pool.
```

### 4. crates/sf-serve/src/routes/orchestrator.rs — "TypeScript orchestrator progressively retired"

File: `crates/sf-serve/src/routes/orchestrator.rs`

| Lines | Current text                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| 13–14 | `//! Additional routes (start/stop, logs SSE) will be added as the TypeScript` / `//! orchestrator is progressively retired.` |

Remove lines 13–14. The TypeScript orchestrator has already been retired
(see PR #462). The comment is no longer accurate.

---

## Notes for downstream workers

- Do NOT run `bunx prettier --write docs/architecture.md` — scout already
  established the baseline.
- The §Governed Embedding Standard Model row (line 177) and all other Xenova
  mentions in the Rationale (lines 187–188) and Adoption rule (line 218) are
  outside the scope of #539 per the issue text; only the **Runtime row** (line 179) and the **dead #75 link** (line 207) are in scope for #539.
- For #540, the four targets are in two separate files: `docs/architecture.md`
  (lines 29 and 164) and two Rust source files.
