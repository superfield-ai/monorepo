/**
 * @file seam-143.ts — dev-scout seam document for issue #143
 *
 * Phase-5 gate resolution: linker auto-population wiring audit.
 *
 * ## Canonical docs
 * - src/index.ts            — application entry point (startup)
 * - src/embed/worker.ts     — embed worker loop (runEmbedWorker)
 * - src/linker/structural.ts — structural linker loop (runStructuralLinker)
 * - src/linker/ai.ts        — AI linker loop (runAiLinker)
 *
 * ## Problem statement (issue #143 / #134)
 *
 * Gate G2 (H4.4) produced a 0.7pp attribution F1 delta because the typed-link
 * layer was never populated.  The three worker loops that produce embeddings,
 * structural links, and AI links exist in the codebase but are **never
 * started** — neither at server startup nor during ingest.
 *
 * ## Exact seam locations
 *
 * ### 1. POST /documents does not enqueue an embed job (missing wiring)
 *   File:  src/routes/documents.ts
 *   Line:  115 — `send(res, 202, { … status: 'pending_embed' })`
 *   Gap:   The response claims status `pending_embed` but no `embed-version`
 *          job is ever inserted into `job_queue`.  The call that is missing is:
 *
 *            await enqueueJob('embed-version', { version_id: versionId })
 *
 *          This single call must be added *before* `send(res, 202, …)` inside
 *          the `try` block, after `client.query('COMMIT')` at line 113.
 *          Estimated diff: +2 lines (import enqueueJob + one call).
 *
 * ### 2. runEmbedWorker is never started at server boot
 *   File:  src/index.ts
 *   Line:  22 — `const server = createApp()`
 *   Gap:   `runEmbedWorker()` from `src/embed/worker.ts` is never called.
 *          The worker must be started as an unattended background loop after
 *          `startupRequireAge()` and before or after `server.listen`.
 *          Estimated diff: +2 lines (import + call).
 *
 * ### 3. runStructuralLinker is never started at server boot
 *   File:  src/index.ts
 *   Same location as above.
 *   Gap:   `runStructuralLinker()` from `src/linker/structural.ts` is never
 *          called.  The embed worker already chains to the structural linker
 *          via `enqueueJob('structural-link', …)` at worker.ts line 43, so
 *          only startup wiring is missing.
 *          Estimated diff: +2 lines (import + call).
 *
 * ### 4. runAiLinker is never started at server boot
 *   File:  src/index.ts
 *   Same location as above.
 *   Gap:   `runAiLinker()` from `src/linker/ai.ts` is never called.
 *          The structural linker already chains to the AI linker via
 *          `enqueueJob('ai-link', …)` at structural.ts line 97, so only
 *          startup wiring is missing.
 *          Estimated diff: +2 lines (import + call).
 *
 * ## Fix approach: per-request enqueue + startup workers
 *
 * The architecture already separates job production (routes) from job
 * consumption (workers).  The fix is two-pronged:
 *
 *   A. **Per-request (ingest gate):** POST /documents must call
 *      `enqueueJob('embed-version', { version_id })` so that every newly
 *      ingested document version enters the pipeline.
 *
 *   B. **Startup workers:** src/index.ts must launch the three long-running
 *      loops (`runEmbedWorker`, `runStructuralLinker`, `runAiLinker`) as
 *      fire-and-forget async tasks so they consume queued jobs while the
 *      server handles HTTP traffic.
 *
 * Rationale for this approach over alternatives:
 *
 *   - **Background worker queue (chosen):** cleanly decoupled, already
 *     implemented, no HTTP latency impact, retryable via failJob.
 *   - **Inline/per-request blocking:** would stall POST /documents for the
 *     entire embed+link pipeline duration (potentially minutes per document).
 *     Rejected.
 *   - **Separate worker process:** unnecessary complexity; the existing in-
 *     process job queue is sufficient for the G2 re-run scale.
 *
 * ## Total estimated diff for issue #134
 *
 *   src/routes/documents.ts  +4 lines (import + enqueueJob call + blank line)
 *   src/index.ts             +6 lines (3 imports + 3 worker calls)
 *   ─────────────────────────
 *   Total                    ~10 lines changed, 0 lines deleted.
 *   Well within the < 50 line estimate gate.
 *
 * ## Shared-config and startup-ordering risks
 *
 *   1. **AGE gate must run before workers start.**  `startupRequireAge()` at
 *      src/index.ts line 20 throws if AGE is unavailable.  Workers that call
 *      `writeAgeEdge` (structural.ts:86, ai.ts:116) must not start before
 *      this check passes.  Add worker calls *after* `await startupRequireAge()`
 *      to preserve ordering.
 *
 *   2. **DB pool initialisation.**  Workers call `claimJob` → `execute` which
 *      imports the pool lazily via `getPool()`.  No ordering issue; the pool
 *      is initialised on first use.  No change required.
 *
 *   3. **AbortSignal / graceful shutdown.**  `runEmbedWorker`, `runStructuralLinker`,
 *      and `runAiLinker` accept an optional `AbortSignal`.  For the G2 re-run
 *      it is safe to pass no signal (loops run for the lifetime of the process).
 *      If a graceful shutdown is later needed, wire a shared `AbortController`
 *      and call `controller.abort()` on SIGTERM.
 *
 *   4. **Concurrent worker instances.**  `claimJob` uses `FOR UPDATE SKIP LOCKED`
 *      which is concurrency-safe.  Starting one instance of each worker is
 *      sufficient and avoids lock contention.
 *
 *   5. **Error propagation.**  Worker loops catch errors internally and call
 *      `failJob` without rethrowing.  Unhandled rejections cannot crash the
 *      server.  No additional error boundary is required.
 *
 * ## This file
 *
 * This file contains no runtime-executable logic.  It is a dev-scout seam
 * stub that compiles cleanly and serves as the permanent audit record for the
 * wiring gap discovered in issue #143.  The actual fix is implemented in
 * issue #134.
 */

// No-op export to satisfy the TypeScript module system.
export {}
