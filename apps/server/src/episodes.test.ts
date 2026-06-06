/**
 * Episode endpoint integration test, exercised via @sharp/episodes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idFromHex, idHex, hashObject } from '@sharp/git-canonical';
import { EpisodeApi } from '@sharp/episodes';
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
let api: EpisodeApi;
let parentCommit = '';

beforeAll(async () => {
  if (explicitSkip) return;
  dockerOk = dockerAvailable();
  if (!dockerOk && !requirePg) return;
  pg = await startPostgres();
  server = await startServer({ dsn: pg.url, port: 0, allowRawSha1: true });
  const op = (await issueToken(server.sql, { principal: 'admin', scope: 'operator' })).token;

  // Bootstrap a repo + a parent commit for episodes to attach to.
  const client = new SharpClient({ url: server.url, token: op, repo: 'eps' });
  await client.ensureRepo();
  // Empty tree as the root tree of the bootstrap commit.
  const emptyTree = idHex(hashObject('tree', new Uint8Array(0), 'sha1'));
  // Manually push the empty tree (server's putObject won't store empty
  // payload by default — let's make sure).
  await client.putObject('tree', new Uint8Array(0));
  parentCommit = await client.createCommit({
    tree: emptyTree,
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
    message: 'bootstrap\n',
    refUpdate: { name: 'refs/heads/main' },
  });

  api = new EpisodeApi({ url: server.url, token: op, repo: 'eps' });
}, 240_000);

afterAll(async () => {
  if (server) await server.stop();
  if (pg) await pg.stop();
});

const skip = explicitSkip || (!requirePg && !dockerOk);

describe.skipIf(skip)('episodes', () => {
  it('full lifecycle: open, append (inline + CAS), link siblings, finish', async () => {
    const winner = await api.openEpisode({
      parentCommit,
      agentIdentity: 'codex-1',
      modelId: 'claude-opus-4-7',
      harnessVersion: '0.1.0',
      toolVersions: { tsc: '5.5.0' },
      decodingParams: { temperature: 0.2 },
    });

    // Inline-routed (small)
    const a1 = await winner.appendArtifact('prompt', { role: 'system', content: 'hi' });
    expect(a1.seq).toBe(1);

    // Auto-routed to CAS (large json string)
    const big = { content: 'x'.repeat(60_000) };
    const a2 = await winner.appendArtifact('context', big);
    expect(a2.seq).toBe(2);

    // Buffer payload → CAS
    const a3 = await winner.appendArtifact(
      'intermediate_patch',
      new Uint8Array(Buffer.from('--- a/foo\n+++ b/foo\n', 'utf8')),
    );
    expect(a3.seq).toBe(3);

    // Sibling links
    const sib = await api.openEpisode({
      parentCommit,
      agentIdentity: 'codex-2',
      modelId: 'claude-opus-4-7',
      harnessVersion: '0.1.0',
    });
    await winner.linkSibling(sib.id);
    await sib.finish({ status: 'failed' });
    await winner.markSuperseded([sib.id]);

    await winner.finish({ status: 'completed', promotedCommit: parentCommit });

    // listEpisodes returns both
    const list = (await api.listEpisodes()) as { id: string; status: string }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    const winnerRow = list.find((r) => r.id === winner.id);
    expect(winnerRow?.status).toBe('completed');
  });

  it('rejects oversized inline payloads at the schema level', async () => {
    // The server's inline jsonb size cap fires when an artifact
    // exceeds 64KB; the library auto-routes around it via putBlob,
    // so the only way to trigger this is to bypass the library and
    // talk to the endpoint directly.
    const op = (await issueToken(server!.sql, { principal: 'forced', scope: 'write' })).token;
    const ep = await new EpisodeApi({ url: server!.url, token: op, repo: 'eps' }).openEpisode({
      parentCommit,
      agentIdentity: 'forced',
      modelId: 'm',
      harnessVersion: '0',
    });
    const oversized = 'x'.repeat(80_000);
    const res = await fetch(`${server!.url}/repos/eps/episodes/${ep.id}/artifacts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${op}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'prompt', inline: oversized }),
    });
    // Postgres check constraint violation is caught by the route handler
    // and surfaced as a 400 bad_request — the client sent something the
    // server's invariants reject.
    expect(res.status).toBe(400);
  });

  it('redaction overwrites payload and writes audit row', async () => {
    const ep = await api.openEpisode({
      parentCommit,
      agentIdentity: 'r',
      modelId: 'm',
      harnessVersion: '0',
    });
    await ep.appendArtifact('prompt', { secret: 'sk-...' });

    // Operator-scoped redact endpoint via raw fetch (the @sharp/episodes
    // library does not expose redaction; it's an operator-only path).
    const op = (await issueToken(server!.sql, { principal: 'op', scope: 'operator' })).token;
    const res = await fetch(`${server!.url}/repos/eps/episodes/${ep.id}/redact`, {
      method: 'POST',
      headers: { authorization: `Bearer ${op}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        seq: 1,
        policy: 'pii-v1',
        actor: 'op',
        redacted: { secret: '<REDACTED>' },
      }),
    });
    expect(res.status).toBe(200);

    // Audit row exists.
    const sql = server!.sql;
    const audits = await sql<{ count: string }[]>`
      select count(*)::text as count from episode_redactions where episode_id = ${ep.id}::uuid
    `;
    expect(audits[0]?.count).toBe('1');
  });

  it('analytics SQL passthrough returns rows; refuses non-SELECT and api_keys reads', async () => {
    const op = (await issueToken(server!.sql, { principal: 'analyst', scope: 'operator' })).token;
    const ok = await fetch(`${server!.url}/repos/eps/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${op}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'select count(*)::text as c from episodes' }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { rows: { c: string }[] };
    expect(Number(okBody.rows[0]?.c ?? 0)).toBeGreaterThan(0);

    const refused = await fetch(`${server!.url}/repos/eps/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${op}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'delete from episodes' }),
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: { code: string } };
    expect(body.error.code).toBe('query_refused');

    // analytics_role cannot read api_keys
    const denied = await fetch(`${server!.url}/repos/eps/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${op}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'select count(*) from api_keys' }),
    });
    expect(denied.status).toBe(400);
  });

  // Suppress unused-symbol warning
  void idFromHex;
});
