/**
 * HTTP route handlers for the projections surface (Phase 21b).
 *
 * A projection tracks the always-up-to-date speculative merge of a
 * feature branch onto a target branch. See projections.ts and
 * docs/whitepaper.md §6.7 for the data model.
 *
 * Endpoints:
 *   POST   /repos/:repo/projections          register (branch_ref, target_ref)
 *   GET    /repos/:repo/projections           list; optional ?status= filter
 *   GET    /repos/:repo/projections/:encoded  get one, recompute if stale
 *   DELETE /repos/:repo/projections/:encoded  remove
 *
 * :encoded is `<branch_ref>__<target_ref>` with slashes percent-encoded —
 * the client encodes as `encodeURIComponent(branch + '__' + target)`.
 */
import { getRepo } from './cas';
import {
  deleteProjection,
  getProjection,
  listProjections,
  registerProjection,
  type ProjectionStatus,
} from './projections';
import { jsonError, jsonResponse, type RouteContext, type Router } from './router';
import type postgres from 'postgres';

async function repoIdFromCtx(ctx: RouteContext): Promise<string | undefined> {
  const r = await getRepo(ctx.sql, ctx.params.repo!);
  return r?.id;
}

/**
 * Decode the :encoded path parameter back into branch_ref and target_ref.
 * The encoding is `<branch_ref>__<target_ref>` where both components have
 * their slashes preserved (the router captures via *encoded).
 *
 * Example: `refs/heads/feat__refs/heads/main`
 */
function decodeEncoded(encoded: string): { branch_ref: string; target_ref: string } | undefined {
  const sep = encoded.indexOf('__');
  if (sep < 0) return undefined;
  return {
    branch_ref: encoded.slice(0, sep),
    target_ref: encoded.slice(sep + 2),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleRegisterProjection(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);

  const body = (await req.json().catch(() => null)) as {
    branch_ref?: string;
    target_ref?: string;
  } | null;
  if (!body || typeof body.branch_ref !== 'string' || typeof body.target_ref !== 'string') {
    return jsonError(400, 'bad_request', 'branch_ref and target_ref are required');
  }

  const row = await registerProjection(
    ctx.sql as postgres.Sql,
    repoId,
    body.branch_ref,
    body.target_ref,
  );
  return jsonResponse(201, row);
}

async function handleListProjections(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);

  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status') as ProjectionStatus | null;
  const VALID_STATUSES = new Set<string>(['clean', 'dilemma', 'stale', 'error']);
  if (statusParam && !VALID_STATUSES.has(statusParam)) {
    return jsonError(400, 'bad_request', `invalid status: ${statusParam}`);
  }

  const rows = await listProjections(ctx.sql, repoId, statusParam ?? undefined);
  return jsonResponse(200, { projections: rows });
}

async function handleGetProjection(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);

  const encoded = ctx.params.encoded;
  if (!encoded) return jsonError(400, 'bad_request', 'encoded projection key required');
  const parts = decodeEncoded(encoded);
  if (!parts) {
    return jsonError(400, 'bad_request', 'encoded must be <branch_ref>__<target_ref>');
  }

  const row = await getProjection(
    ctx.sql as postgres.Sql,
    repoId,
    parts.branch_ref,
    parts.target_ref,
  );
  if (!row) {
    return jsonError(404, 'projection_not_found', `projection ${encoded} not found`);
  }
  return jsonResponse(200, row);
}

async function handleDeleteProjection(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);

  const encoded = ctx.params.encoded;
  if (!encoded) return jsonError(400, 'bad_request', 'encoded projection key required');
  const parts = decodeEncoded(encoded);
  if (!parts) {
    return jsonError(400, 'bad_request', 'encoded must be <branch_ref>__<target_ref>');
  }

  await deleteProjection(ctx.sql, repoId, parts.branch_ref, parts.target_ref);
  return jsonResponse(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProjectionRoutes(router: Router): void {
  router
    .add({
      method: 'POST',
      pattern: '/repos/:repo/projections',
      scope: 'write',
      handler: handleRegisterProjection,
    })
    .add({
      method: 'GET',
      pattern: '/repos/:repo/projections',
      scope: 'read',
      handler: handleListProjections,
    })
    .add({
      method: 'GET',
      pattern: '/repos/:repo/projections/*encoded',
      scope: 'read',
      handler: handleGetProjection,
    })
    .add({
      method: 'DELETE',
      pattern: '/repos/:repo/projections/*encoded',
      scope: 'write',
      handler: handleDeleteProjection,
    });
}
