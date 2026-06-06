/**
 * Episode-related route handlers, kept separate from `routes.ts` so the
 * episode lifecycle and analytics surface stays cohesive.
 */
import { idFromHex, idHex } from '@sharp/git-canonical';
import { getRepo } from './cas';
import {
  appendArtifact,
  finishEpisode,
  linkEpisodes,
  listArtifacts,
  listEpisodes,
  openEpisode,
  redactArtifact,
  type ArtifactKind,
  type EpisodeStatus,
  type LinkRelation,
} from './episodes';
import { jsonError, jsonResponse, type RouteContext, type Router } from './router';
import { QueryRefused, runAnalyticsQuery } from './analytics';

async function repoIdFromCtx(ctx: RouteContext): Promise<string | undefined> {
  const r = await getRepo(ctx.sql, ctx.params.repo!);
  return r?.id;
}

async function handleOpenEpisode(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', ctx.params.repo!);
  const body = (await req.json().catch(() => null)) as {
    parent_commit?: string;
    agent_identity?: string;
    model_id?: string;
    harness_version?: string;
    tool_versions?: Record<string, unknown>;
    decoding_params?: Record<string, unknown>;
  } | null;
  if (
    !body ||
    typeof body.parent_commit !== 'string' ||
    !body.agent_identity ||
    !body.model_id ||
    !body.harness_version
  ) {
    return jsonError(
      400,
      'bad_request',
      'parent_commit, agent_identity, model_id, harness_version are required',
    );
  }
  const r = await openEpisode(ctx.sql, {
    repo: repoId,
    parent_commit: idFromHex(body.parent_commit),
    agent_identity: body.agent_identity,
    model_id: body.model_id,
    harness_version: body.harness_version,
    tool_versions: body.tool_versions ?? {},
    decoding_params: body.decoding_params ?? {},
  });
  return jsonResponse(201, r);
}

async function handleAppendArtifact(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', ctx.params.repo!);
  const body = (await req.json().catch(() => null)) as {
    kind?: ArtifactKind;
    content_ref?: string;
    inline?: unknown;
  } | null;
  if (!body || !body.kind) {
    return jsonError(400, 'bad_request', 'kind is required');
  }
  if ((body.content_ref === undefined) === (body.inline === undefined)) {
    return jsonError(400, 'bad_request', 'exactly one of content_ref and inline must be set');
  }
  try {
    const r = await appendArtifact(ctx.sql, {
      episodeId: ctx.params.id!,
      kind: body.kind,
      contentRef: body.content_ref ? idFromHex(body.content_ref) : undefined,
      inline: body.inline,
    });
    return jsonResponse(201, r);
  } catch (e) {
    return jsonError(400, 'bad_request', (e as Error).message);
  }
}

async function handleFinishEpisode(req: Request, ctx: RouteContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    status?: EpisodeStatus;
    promoted_commit?: string;
  } | null;
  if (!body || !body.status || body.status === 'started') {
    return jsonError(400, 'bad_request', 'status must be one of completed | failed | abandoned');
  }
  await finishEpisode(ctx.sql, {
    episodeId: ctx.params.id!,
    status: body.status,
    promotedCommit: body.promoted_commit ? idFromHex(body.promoted_commit) : undefined,
  });
  return jsonResponse(200, { ok: true });
}

async function handleLinkEpisode(req: Request, ctx: RouteContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    to_episode?: string;
    relation?: LinkRelation;
  } | null;
  if (!body || !body.to_episode || !body.relation) {
    return jsonError(400, 'bad_request', 'to_episode and relation are required');
  }
  await linkEpisodes(ctx.sql, ctx.params.id!, body.to_episode, body.relation);
  return jsonResponse(201, { ok: true });
}

async function handleRedactArtifact(req: Request, ctx: RouteContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    seq?: number;
    policy?: string;
    actor?: string;
    redacted?: unknown;
  } | null;
  if (!body || typeof body.seq !== 'number' || !body.policy || !body.actor) {
    return jsonError(400, 'bad_request', 'seq, policy, actor are required');
  }
  await redactArtifact(ctx.sql, {
    episodeId: ctx.params.id!,
    seq: body.seq,
    policy: body.policy,
    actor: body.actor,
    redacted: body.redacted,
  });
  return jsonResponse(200, { ok: true });
}

async function handleListEpisodes(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', ctx.params.repo!);
  const url = new URL(req.url);
  const rows = await listEpisodes(ctx.sql, {
    repo: repoId,
    modelId: url.searchParams.get('model_id') ?? undefined,
    status: (url.searchParams.get('status') as EpisodeStatus | null) ?? undefined,
    parentCommit: url.searchParams.get('parent_commit')
      ? idFromHex(url.searchParams.get('parent_commit')!)
      : undefined,
    promotedCommit: url.searchParams.get('promoted_commit')
      ? idFromHex(url.searchParams.get('promoted_commit')!)
      : undefined,
    limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
  });
  return jsonResponse(200, {
    episodes: rows.map((r) => ({
      id: r.id,
      parent_commit: idHex(new Uint8Array(r.parent_commit)),
      promoted_commit: r.promoted_commit ? idHex(new Uint8Array(r.promoted_commit)) : null,
      agent_identity: r.agent_identity,
      model_id: r.model_id,
      harness_version: r.harness_version,
      tool_versions: r.tool_versions,
      decoding_params: r.decoding_params,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at,
    })),
  });
}

async function handleGetEpisode(_req: Request, ctx: RouteContext): Promise<Response> {
  const artifacts = await listArtifacts(ctx.sql, ctx.params.id!);
  return jsonResponse(200, {
    artifacts: artifacts.map((a) => ({
      seq: a.seq,
      kind: a.kind,
      content_ref: a.content_ref ? idHex(new Uint8Array(a.content_ref)) : null,
      inline: a.inline,
      created_at: a.created_at,
    })),
  });
}

async function handleAnalyticsQuery(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', ctx.params.repo!);
  const body = (await req.json().catch(() => null)) as { sql?: string; params?: unknown[] } | null;
  if (!body || typeof body.sql !== 'string') {
    return jsonError(400, 'bad_request', 'sql is required');
  }
  try {
    // Note: the read-only role is process-wide (no repo scoping in v1);
    // the operator scope on the route is what gates access.
    const result = await runAnalyticsQuery(ctx.sql as never, {
      sql: body.sql,
      params: body.params,
    });
    return jsonResponse(200, result);
  } catch (e) {
    if (e instanceof QueryRefused) return jsonError(400, 'query_refused', e.message);
    return jsonError(400, 'query_failed', (e as Error).message);
  }
}

export function registerEpisodeRoutes(router: Router): void {
  router
    .add({
      method: 'POST',
      pattern: '/repos/:repo/query',
      scope: 'operator',
      handler: handleAnalyticsQuery,
    })
    .add({
      method: 'POST',
      pattern: '/repos/:repo/episodes',
      scope: 'write',
      handler: handleOpenEpisode,
    })
    .add({
      method: 'GET',
      pattern: '/repos/:repo/episodes',
      scope: 'read',
      handler: handleListEpisodes,
    })
    .add({
      method: 'GET',
      pattern: '/repos/:repo/episodes/:id/artifacts',
      scope: 'read',
      handler: handleGetEpisode,
    })
    .add({
      method: 'POST',
      pattern: '/repos/:repo/episodes/:id/artifacts',
      scope: 'write',
      handler: handleAppendArtifact,
    })
    .add({
      method: 'POST',
      pattern: '/repos/:repo/episodes/:id/finish',
      scope: 'write',
      handler: handleFinishEpisode,
    })
    .add({
      method: 'POST',
      pattern: '/repos/:repo/episodes/:id/links',
      scope: 'write',
      handler: handleLinkEpisode,
    })
    .add({
      method: 'POST',
      pattern: '/repos/:repo/episodes/:id/redact',
      scope: 'operator',
      handler: handleRedactArtifact,
    });
}
