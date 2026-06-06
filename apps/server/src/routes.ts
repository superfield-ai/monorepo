/**
 * Route handlers. Each handler is a small wrapper around a storage-layer
 * function plus request/response shape conversion. Per-route scope
 * declarations live next to the handler.
 */
import { idFromHex, idHex, type HashAlgo, type ObjectKind } from '@sharp/git-canonical';
import { createRepo, getObject, getRepo, listObjects, objectExists, putObject } from './cas';
import {
  createRef,
  deleteRef,
  getRef,
  listRefs,
  RefCasFailed,
  resolveRef,
  updateRef,
  updateSymbolicRef,
} from './refs';
import { createCommit, MissingObjectError } from './commit';
import { jsonError, jsonResponse, type RouteContext, type Router } from './router';
import { issueToken, type Scope } from './auth';
import { decodeCommit } from '@sharp/git-canonical';

const VALID_OBJECT_KINDS = new Set<ObjectKind>(['blob', 'tree', 'commit', 'tag']);

async function repoIdFromCtx(ctx: RouteContext): Promise<string | undefined> {
  const name = ctx.params.repo;
  if (!name) return undefined;
  const r = await getRepo(ctx.sql, name);
  return r?.id;
}

async function readBody(req: Request): Promise<Uint8Array> {
  const ab = await req.arrayBuffer();
  return new Uint8Array(ab);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function handleHealthz(): Promise<Response> {
  return jsonResponse(200, { ok: true, service: 'sharp-server' });
}

async function handleReadyz(_req: Request, ctx: RouteContext): Promise<Response> {
  try {
    await ctx.sql`select 1`;
    return jsonResponse(200, { ok: true });
  } catch (e) {
    return jsonError(503, 'db_unavailable', (e as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

async function handleCreateRepo(req: Request, ctx: RouteContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    name?: string;
    default_branch?: string;
    objectformat?: string;
  } | null;
  if (!body || typeof body.name !== 'string') {
    return jsonError(400, 'bad_request', 'name is required');
  }
  if (
    body.objectformat !== undefined &&
    body.objectformat !== 'sha1' &&
    body.objectformat !== 'sha256'
  ) {
    return jsonError(400, 'bad_request', `invalid objectformat: ${body.objectformat}`);
  }
  try {
    const r = await createRepo(ctx.sql, {
      name: body.name,
      defaultBranch: body.default_branch,
      objectformat: body.objectformat as HashAlgo | undefined,
    });
    return jsonResponse(201, r);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('duplicate')) return jsonError(409, 'repo_exists', `repo ${body.name} exists`);
    throw e;
  }
}

async function handleListRepos(_req: Request, ctx: RouteContext): Promise<Response> {
  const rows = await ctx.sql<
    { id: string; name: string; default_branch: string; objectformat: string }[]
  >`select id::text as id, name, default_branch, objectformat from repos order by name`;
  return jsonResponse(200, { repos: rows });
}

async function handleGetRepo(_req: Request, ctx: RouteContext): Promise<Response> {
  const r = await getRepo(ctx.sql, ctx.params.repo!);
  if (!r) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  return jsonResponse(200, r);
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

async function handlePutObject(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);

  const idHexParam = ctx.params.id;
  if (!idHexParam || !/^[0-9a-f]+$/.test(idHexParam)) {
    return jsonError(400, 'bad_request', 'id must be lowercase hex');
  }

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') as ObjectKind | null;
  if (!kind || !VALID_OBJECT_KINDS.has(kind)) {
    return jsonError(400, 'bad_request', `invalid or missing ?kind=`);
  }
  const algo = (url.searchParams.get('algo') as HashAlgo | null) ?? 'sha1';
  if (algo !== 'sha1' && algo !== 'sha256') {
    return jsonError(400, 'bad_request', `invalid ?algo=${algo}`);
  }

  const payload = await readBody(req);
  const id = await putObject(ctx.sql, { repo: repoId, algo, kind, payload });
  if (idHex(id) !== idHexParam) {
    return jsonError(409, 'hash_mismatch', `URL id ${idHexParam} != computed ${idHex(id)}`);
  }
  return jsonResponse(200, { id: idHex(id), kind });
}

async function handleGetObject(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  const idHexParam = ctx.params.id;
  if (!idHexParam || !/^[0-9a-f]+$/.test(idHexParam)) {
    return jsonError(400, 'bad_request', 'id must be lowercase hex');
  }
  const rec = await getObject(ctx.sql, repoId, idFromHex(idHexParam));
  if (!rec) return jsonError(404, 'object_not_found', `object ${idHexParam} not found`);
  // Cast: Bun.Response accepts Uint8Array; the standard BodyInit type
  // doesn't include it in older lib.dom typings.
  return new Response(rec.data as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'x-sharp-kind': rec.kind,
      'x-sharp-algo': rec.algo,
      'content-length': String(rec.data.length),
    },
  });
}

async function handleHeadObject(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return new Response(null, { status: 404 });
  const idHexParam = ctx.params.id;
  if (!idHexParam || !/^[0-9a-f]+$/.test(idHexParam)) return new Response(null, { status: 400 });
  const exists = await objectExists(ctx.sql, repoId, idFromHex(idHexParam));
  return new Response(null, { status: exists ? 200 : 404 });
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

async function handleListRefs(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  const refs = await listRefs(ctx.sql, repoId);
  return jsonResponse(200, {
    refs: refs.map((r) => ({
      name: r.name,
      target_kind: r.target.kind,
      target: r.target.kind === 'hash' ? idHex(r.target.target) : r.target.target,
    })),
  });
}

async function handleGetRef(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  const refName = ctx.params.refname!;
  const t = await getRef(ctx.sql, repoId, refName);
  if (!t) return jsonError(404, 'ref_not_found', `ref ${refName} not found`);
  return jsonResponse(200, {
    name: refName,
    target_kind: t.kind,
    target: t.kind === 'hash' ? idHex(t.target) : t.target,
    resolved:
      t.kind === 'symbolic' ? hexOrUndef(await resolveRef(ctx.sql, repoId, refName)) : undefined,
  });
}

function hexOrUndef(id: Uint8Array | undefined): string | undefined {
  return id ? idHex(id) : undefined;
}

async function handlePutRef(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  const refName = ctx.params.refname!;

  const body = (await req.json().catch(() => null)) as {
    target_kind?: 'hash' | 'symbolic';
    target?: string;
  } | null;
  if (!body || (body.target_kind !== 'hash' && body.target_kind !== 'symbolic')) {
    return jsonError(400, 'bad_request', 'target_kind is required (hash | symbolic)');
  }
  if (typeof body.target !== 'string') {
    return jsonError(400, 'bad_request', 'target is required');
  }

  if (body.target_kind === 'symbolic') {
    await updateSymbolicRef(ctx.sql, repoId, refName, body.target);
    return jsonResponse(200, { ok: true });
  }

  if (!/^[0-9a-f]+$/.test(body.target)) {
    return jsonError(400, 'bad_request', 'target must be lowercase hex for hash refs');
  }
  const newTarget = idFromHex(body.target);

  const ifMatch = req.headers.get('if-match');
  if (ifMatch) {
    if (!/^[0-9a-f]+$/.test(ifMatch)) {
      return jsonError(400, 'bad_request', 'if-match must be lowercase hex');
    }
    try {
      await updateRef(ctx.sql, repoId, refName, idFromHex(ifMatch), {
        kind: 'hash',
        target: newTarget,
      });
      return jsonResponse(200, { ok: true });
    } catch (e) {
      if (e instanceof RefCasFailed) {
        return jsonError(412, 'ref_cas_failed', 'if-match does not match current ref value');
      }
      throw e;
    }
  }

  // No If-Match → create-only.
  try {
    await createRef(ctx.sql, repoId, refName, { kind: 'hash', target: newTarget });
    return jsonResponse(201, { ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('duplicate'))
      return jsonError(409, 'ref_exists', `ref ${refName} already exists; use If-Match to update`);
    throw e;
  }
}

async function handleDeleteRef(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  await deleteRef(ctx.sql, repoId, ctx.params.refname!);
  return jsonResponse(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

interface CommitCreateBody {
  algo?: HashAlgo;
  tree: string;
  parents?: string[];
  author: { name_email: string; timestamp: number; timezone: string };
  committer: { name_email: string; timestamp: number; timezone: string };
  extra_headers?: { name: string; value: string }[];
  message: string;
  ref_update?: { name: string; expected_old?: string };
}

async function handleCreateCommit(req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  const body = (await req.json().catch(() => null)) as CommitCreateBody | null;
  if (!body || typeof body.tree !== 'string' || typeof body.message !== 'string') {
    return jsonError(400, 'bad_request', 'tree and message are required');
  }
  const algo = body.algo ?? 'sha1';
  try {
    const result = await createCommit(ctx.sql, {
      repo: repoId,
      algo,
      commit: {
        tree: idFromHex(body.tree),
        parents: (body.parents ?? []).map(idFromHex),
        author: {
          nameAndEmail: body.author.name_email,
          timestamp: body.author.timestamp,
          timezone: body.author.timezone,
        },
        committer: {
          nameAndEmail: body.committer.name_email,
          timestamp: body.committer.timestamp,
          timezone: body.committer.timezone,
        },
        extraHeaders: body.extra_headers,
        message: body.message,
      },
      refUpdate: body.ref_update
        ? {
            name: body.ref_update.name,
            expectedOld: body.ref_update.expected_old
              ? idFromHex(body.ref_update.expected_old)
              : undefined,
          }
        : undefined,
    });
    return jsonResponse(201, { id: idHex(result.id) });
  } catch (e) {
    if (e instanceof MissingObjectError) {
      return jsonError(409, 'missing_object', e.message);
    }
    if ((e as Error).message?.includes('ref CAS failed')) {
      return jsonError(412, 'ref_cas_failed', (e as Error).message);
    }
    throw e;
  }
}

// Helper to read a commit's tree pointer (used by clients building a working
// tree). Convenience over fetching the full object.
async function handleGetCommitTreePointer(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  const idHexParam = ctx.params.id!;
  if (!/^[0-9a-f]+$/.test(idHexParam))
    return jsonError(400, 'bad_request', 'id must be lowercase hex');
  const rec = await getObject(ctx.sql, repoId, idFromHex(idHexParam));
  if (!rec || rec.kind !== 'commit') return jsonError(404, 'commit_not_found', idHexParam);
  const c = decodeCommit(rec.data);
  return jsonResponse(200, {
    tree: idHex(c.tree),
    parents: c.parents.map(idHex),
    author: {
      name_email: c.author.nameAndEmail,
      timestamp: c.author.timestamp,
      timezone: c.author.timezone,
    },
    message: c.message,
  });
}

// ---------------------------------------------------------------------------
// List objects (export support)
// ---------------------------------------------------------------------------

async function handleListObjects(_req: Request, ctx: RouteContext): Promise<Response> {
  const repoId = await repoIdFromCtx(ctx);
  if (!repoId) return jsonError(404, 'repo_not_found', `repo ${ctx.params.repo} not found`);
  const out: { id: string; kind: ObjectKind }[] = [];
  for await (const o of listObjects(ctx.sql, repoId)) {
    out.push({ id: idHex(o.id), kind: o.kind });
  }
  return jsonResponse(200, { objects: out });
}

// ---------------------------------------------------------------------------
// Tokens (operator-only)
// ---------------------------------------------------------------------------

async function handleIssueToken(req: Request, ctx: RouteContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { principal?: string; scope?: Scope } | null;
  if (!body || typeof body.principal !== 'string' || !body.scope) {
    return jsonError(400, 'bad_request', 'principal and scope are required');
  }
  const result = await issueToken(ctx.sql, { principal: body.principal, scope: body.scope });
  return jsonResponse(201, result);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRoutes(router: Router): void {
  router
    // Health
    .add({ method: 'GET', pattern: '/healthz', noAuth: true, handler: handleHealthz })
    .add({ method: 'GET', pattern: '/readyz', noAuth: true, handler: handleReadyz })

    // Repos
    .add({ method: 'POST', pattern: '/repos', scope: 'operator', handler: handleCreateRepo })
    .add({ method: 'GET', pattern: '/repos', scope: 'read', handler: handleListRepos })
    .add({ method: 'GET', pattern: '/repos/:repo', scope: 'read', handler: handleGetRepo })

    // Objects
    .add({
      method: 'PUT',
      pattern: '/repos/:repo/objects/:id',
      scope: 'write',
      handler: handlePutObject,
    })
    .add({
      method: 'GET',
      pattern: '/repos/:repo/objects/:id',
      scope: 'read',
      handler: handleGetObject,
    })
    .add({
      method: 'HEAD',
      pattern: '/repos/:repo/objects/:id',
      scope: 'read',
      handler: handleHeadObject,
    })
    .add({
      method: 'GET',
      pattern: '/repos/:repo/objects',
      scope: 'read',
      handler: handleListObjects,
    })

    // Refs (rest-of-path captures the slash-bearing ref name)
    .add({
      method: 'GET',
      pattern: '/repos/:repo/refs',
      scope: 'read',
      handler: handleListRefs,
    })
    .add({
      method: 'GET',
      pattern: '/repos/:repo/ref/*refname',
      scope: 'read',
      handler: handleGetRef,
    })
    .add({
      method: 'PUT',
      pattern: '/repos/:repo/ref/*refname',
      scope: 'write',
      handler: handlePutRef,
    })
    .add({
      method: 'DELETE',
      pattern: '/repos/:repo/ref/*refname',
      scope: 'write',
      handler: handleDeleteRef,
    })

    // Commits
    .add({
      method: 'POST',
      pattern: '/repos/:repo/commits',
      scope: 'write',
      handler: handleCreateCommit,
    })
    .add({
      method: 'GET',
      pattern: '/repos/:repo/commits/:id',
      scope: 'read',
      handler: handleGetCommitTreePointer,
    })

    // Tokens
    .add({
      method: 'POST',
      pattern: '/admin/tokens',
      scope: 'operator',
      handler: handleIssueToken,
    });
}
