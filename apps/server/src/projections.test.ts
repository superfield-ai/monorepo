/**
 * Integration test for Phase 21b: continuous speculative merge projections.
 *
 * Start postgres (via docker), create a repo, push two commits on different
 * branches, register a projection, verify it goes stale when a ref advances,
 * and verify that GET recomputes it.
 *
 * Auto-skips when docker is unavailable (same guard as other tests).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeTree, hashObject, idHex, type TreeEntry } from '@sharp/git-canonical';
import {
  dockerAvailable,
  startPostgres,
  type PgContainer,
} from '../../../tests/harness/pg-container';
import { startServer, type ServerHandle } from './server';
import { issueToken } from './auth';
import { SharpClient } from '../../client/src';

const requirePg = process.env.SHARP_TEST_REQUIRE_PG === '1';
const explicitSkip = process.env.SHARP_TEST_SKIP_PG === '1';
let pg: PgContainer | undefined;
let server: ServerHandle | undefined;
let dockerOk = false;
let client: SharpClient;
let opToken: string;

const PINNED = {
  name_email: 'Alice <alice@example.com>',
  timestamp: 1735689600,
  timezone: '+0000',
};

/** Helper: push a blob + single-file tree + commit, returns commit hex. */
async function pushCommit(
  c: SharpClient,
  filename: string,
  content: string,
  parents: string[],
  refName: string,
): Promise<string> {
  const blobPayload = new Uint8Array(Buffer.from(content, 'utf8'));
  const blobId = await c.putObject('blob', blobPayload);
  const entries: TreeEntry[] = [
    { mode: '100644', name: filename, id: new Uint8Array(Buffer.from(blobId, 'hex')) },
  ];
  const treeBytes = encodeTree(entries, 'sha1');
  const treeId = idHex(hashObject('tree', treeBytes, 'sha1'));
  await c.putObject('tree', treeBytes);
  return c.createCommit({
    tree: treeId,
    parents,
    author: PINNED,
    committer: PINNED,
    message: `add ${filename}\n`,
    refUpdate: { name: refName },
  });
}

beforeAll(async () => {
  if (explicitSkip) return;
  dockerOk = dockerAvailable();
  if (!dockerOk && !requirePg) return;
  pg = await startPostgres();
  server = await startServer({ dsn: pg.url, port: 0, allowRawSha1: true });
  opToken = (await issueToken(server.sql, { principal: 'admin', scope: 'operator' })).token;

  client = new SharpClient({ url: server.url, token: opToken, repo: 'proj-test' });
  await client.ensureRepo();
}, 240_000);

afterAll(async () => {
  if (server) await server.stop();
  if (pg) await pg.stop();
});

const skip = explicitSkip || (!requirePg && !dockerOk);

describe.skipIf(skip)('projections', () => {
  let mainCommit = '';
  let featCommit = '';

  it('set up: two commits on different branches', async () => {
    // main: file-a.ts
    mainCommit = await pushCommit(
      client,
      'file-a.ts',
      'export const a = 1;\n',
      [],
      'refs/heads/main',
    );
    expect(mainCommit).toMatch(/^[0-9a-f]{40}$/);

    // feat: file-b.ts (separate branch off the same empty start — simulate diverge)
    featCommit = await pushCommit(
      client,
      'file-b.ts',
      'export const b = 2;\n',
      [],
      'refs/heads/feat',
    );
    expect(featCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('register a projection (starts stale)', async () => {
    const res = await fetch(`${server!.url}/repos/proj-test/projections`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        branch_ref: 'refs/heads/feat',
        target_ref: 'refs/heads/main',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; branch_ref: string };
    expect(body.status).toBe('stale');
    expect(body.branch_ref).toBe('refs/heads/feat');
  });

  it('list projections returns the registered row', async () => {
    const res = await fetch(`${server!.url}/repos/proj-test/projections`, {
      headers: { authorization: `Bearer ${opToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projections: { branch_ref: string; status: string }[] };
    expect(body.projections.length).toBeGreaterThanOrEqual(1);
    expect(body.projections.some((p) => p.branch_ref === 'refs/heads/feat')).toBe(true);
  });

  it('GET a projection recomputes it (stale → clean or dilemma)', async () => {
    const encoded = encodeURIComponent('refs/heads/feat__refs/heads/main');
    const res = await fetch(`${server!.url}/repos/proj-test/projections/${encoded}`, {
      headers: { authorization: `Bearer ${opToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; branch_tip: string | null };
    // After recompute the status must NOT be stale.
    expect(body.status).not.toBe('stale');
    // branch_tip should be set to the current feat tip.
    expect(body.branch_tip).toBe(featCommit);
  });

  it('advancing a ref marks the projection stale again', async () => {
    // Push another commit on main.
    const newMainCommit = await pushCommit(
      client,
      'file-c.ts',
      'export const c = 3;\n',
      [mainCommit],
      'refs/heads/main',
    );
    expect(newMainCommit).toMatch(/^[0-9a-f]{40}$/);

    // The trigger should have marked the projection stale.
    const rowsAfter = await server!.sql<{ status: string }[]>`
      select p.status from projections p
      join repos r on r.id = p.repo_id
      where r.name = 'proj-test'
        and p.branch_ref = 'refs/heads/feat'
        and p.target_ref = 'refs/heads/main'
    `;
    expect(rowsAfter[0]?.status).toBe('stale');
  });

  it('GET after staleness recomputes again', async () => {
    const encoded = encodeURIComponent('refs/heads/feat__refs/heads/main');
    const res = await fetch(`${server!.url}/repos/proj-test/projections/${encoded}`, {
      headers: { authorization: `Bearer ${opToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).not.toBe('stale');
  });

  it('DELETE removes the projection', async () => {
    const encoded = encodeURIComponent('refs/heads/feat__refs/heads/main');
    const del = await fetch(`${server!.url}/repos/proj-test/projections/${encoded}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${opToken}` },
    });
    expect(del.status).toBe(200);

    // GET should now 404.
    const get = await fetch(`${server!.url}/repos/proj-test/projections/${encoded}`, {
      headers: { authorization: `Bearer ${opToken}` },
    });
    expect(get.status).toBe(404);
  });
});
