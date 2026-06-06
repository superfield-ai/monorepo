/**
 * End-to-end HTTP integration tests. Exercises the full surface from
 * authentication through repos / objects / refs / commits using fetch
 * against a real server bound to a random port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeTree, hashObject, idHex } from '@sharp/git-canonical';
import {
  dockerAvailable,
  startPostgres,
  type PgContainer,
} from '../../../tests/harness/pg-container';
import { startServer, type ServerHandle } from './server';
import { issueToken } from './auth';

const requirePg = process.env.SHARP_TEST_REQUIRE_PG === '1';
const explicitSkip = process.env.SHARP_TEST_SKIP_PG === '1';

let pg: PgContainer | undefined;
let server: ServerHandle | undefined;
let dockerOk = false;
let writeToken = '';
let operatorToken = '';
let readToken = '';

beforeAll(async () => {
  if (explicitSkip) return;
  dockerOk = dockerAvailable();
  if (!dockerOk && !requirePg) return;
  if (!dockerOk && requirePg) throw new Error('docker required');

  pg = await startPostgres();
  server = await startServer({
    dsn: pg.url,
    port: 0,
    migrate: true,
    allowRawSha1: true,
  });
  // Issue tokens by talking directly to the DB; this is the bootstrap
  // path the operator CLI will eventually use.
  writeToken = (await issueToken(server.sql, { principal: 'tester', scope: 'write' })).token;
  operatorToken = (await issueToken(server.sql, { principal: 'admin', scope: 'operator' })).token;
  readToken = (await issueToken(server.sql, { principal: 'reader', scope: 'read' })).token;
}, 240_000);

afterAll(async () => {
  if (server) await server.stop();
  if (pg) await pg.stop();
});

const skip = explicitSkip || (!requirePg && !dockerOk);

function api(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  return fetch(`${server!.url}${path}`, { ...init, headers });
}

describe.skipIf(skip)('http server', () => {
  it('GET /healthz works without auth', async () => {
    const res = await fetch(`${server!.url}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('rejects unauthenticated requests to scoped routes', async () => {
    const res = await fetch(`${server!.url}/repos`);
    expect(res.status).toBe(401);
  });

  it('rejects under-scoped tokens', async () => {
    const res = await api('/repos', { method: 'POST', token: readToken });
    expect(res.status).toBe(403);
  });

  it('creates and lists a repo', async () => {
    const create = await api('/repos', {
      method: 'POST',
      token: operatorToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    });
    expect(create.status).toBe(201);
    const repo = await create.json();
    expect(repo.name).toBe('demo');

    const list = await api('/repos', { token: readToken });
    const body = (await list.json()) as { repos: { name: string }[] };
    expect(body.repos.find((r) => r.name === 'demo')).toBeDefined();
  });

  it('puts and reads an object end-to-end', async () => {
    const blob = new Uint8Array(Buffer.from('hello\n', 'utf8'));
    const expected = idHex(hashObject('blob', blob, 'sha1'));
    const put = await api(`/repos/demo/objects/${expected}?kind=blob`, {
      method: 'PUT',
      token: writeToken,
      body: blob as unknown as BodyInit,
    });
    expect(put.status).toBe(200);

    const head = await api(`/repos/demo/objects/${expected}`, { method: 'HEAD', token: readToken });
    expect(head.status).toBe(200);

    const get = await api(`/repos/demo/objects/${expected}`, { token: readToken });
    expect(get.status).toBe(200);
    expect(get.headers.get('x-sharp-kind')).toBe('blob');
    const buf = new Uint8Array(await get.arrayBuffer());
    expect(Buffer.from(buf).toString('utf8')).toBe('hello\n');
  });

  it('rejects PUT object when URL hash mismatches body', async () => {
    const wrongId = '00'.repeat(20);
    const res = await api(`/repos/demo/objects/${wrongId}?kind=blob`, {
      method: 'PUT',
      token: writeToken,
      body: new Uint8Array(Buffer.from('mismatch', 'utf8')) as unknown as BodyInit,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('hash_mismatch');
  });

  it('refs: create, list, atomic CAS update with If-Match', async () => {
    const target1 = 'aa'.repeat(20);
    const target2 = 'bb'.repeat(20);

    const create = await api('/repos/demo/ref/refs/heads/main', {
      method: 'PUT',
      token: writeToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_kind: 'hash', target: target1 }),
    });
    expect(create.status).toBe(201);

    // CAS update with the right If-Match
    const update = await api('/repos/demo/ref/refs/heads/main', {
      method: 'PUT',
      token: writeToken,
      headers: { 'content-type': 'application/json', 'if-match': target1 },
      body: JSON.stringify({ target_kind: 'hash', target: target2 }),
    });
    expect(update.status).toBe(200);

    // CAS update with a stale If-Match
    const stale = await api('/repos/demo/ref/refs/heads/main', {
      method: 'PUT',
      token: writeToken,
      headers: { 'content-type': 'application/json', 'if-match': target1 },
      body: JSON.stringify({ target_kind: 'hash', target: 'cc'.repeat(20) }),
    });
    expect(stale.status).toBe(412);
  });

  it('commits: create with a tree, advance ref atomically', async () => {
    // Reuse the blob from earlier.
    const blob = new Uint8Array(Buffer.from('hello\n', 'utf8'));
    const blobId = idHex(hashObject('blob', blob, 'sha1'));

    const tree = encodeTree([
      {
        mode: '100644',
        name: 'hello.txt',
        id: new Uint8Array(Buffer.from(blobId, 'hex')),
      },
    ]);
    const treeId = idHex(hashObject('tree', tree, 'sha1'));
    const treePut = await api(`/repos/demo/objects/${treeId}?kind=tree`, {
      method: 'PUT',
      token: writeToken,
      body: tree as unknown as BodyInit,
    });
    expect(treePut.status).toBe(200);

    const create = await api('/repos/demo/commits', {
      method: 'POST',
      token: writeToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        algo: 'sha1',
        tree: treeId,
        parents: [],
        author: {
          name_email: 'Alice <alice@example.com>',
          timestamp: 1735689600,
          timezone: '+0000',
        },
        committer: {
          name_email: 'Alice <alice@example.com>',
          timestamp: 1735689600,
          timezone: '+0000',
        },
        message: 'initial\n',
        ref_update: { name: 'refs/heads/feature' },
      }),
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{40}$/);

    // The commit's tree-pointer endpoint round-trips.
    const probe = await api(`/repos/demo/commits/${id}`, { token: readToken });
    expect(probe.status).toBe(200);
    const body = (await probe.json()) as { tree: string; parents: string[]; message: string };
    expect(body.tree).toBe(treeId);
    expect(body.parents).toEqual([]);
    expect(body.message).toBe('initial\n');

    // The ref was advanced.
    const ref = await api('/repos/demo/ref/refs/heads/feature', { token: readToken });
    expect(ref.status).toBe(200);
    const refBody = (await ref.json()) as { target: string };
    expect(refBody.target).toBe(id);
  });

  it('admin can issue a token; non-operators cannot', async () => {
    const refused = await api('/admin/tokens', {
      method: 'POST',
      token: writeToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principal: 'someone', scope: 'read' }),
    });
    expect(refused.status).toBe(403);

    const ok = await api('/admin/tokens', {
      method: 'POST',
      token: operatorToken,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principal: 'someone', scope: 'read' }),
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { token: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
