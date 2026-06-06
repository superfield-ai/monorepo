/**
 * Integration tests for the storage layer (migrations + CAS + refs + commit).
 *
 * Auto-skips when docker is unavailable. CI sets `SHARP_TEST_REQUIRE_PG=1`
 * to convert skips into hard failures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { encodeTree, hashObject, idFromHex, idHex, type TreeEntry } from '@sharp/git-canonical';
import {
  dockerAvailable,
  startPostgres,
  type PgContainer,
} from '../../../tests/harness/pg-container';
import { runMigrations } from './migrate';
import { createRepo, getObject, objectExists, putObject, getRepo } from './cas';
import {
  createRef,
  getRef,
  listRefs,
  resolveRef,
  RefCasFailed,
  updateRef,
  updateSymbolicRef,
} from './refs';
import { createCommit } from './commit';

const requirePg = process.env.SHARP_TEST_REQUIRE_PG === '1';
const explicitSkip = process.env.SHARP_TEST_SKIP_PG === '1';
let container: PgContainer | undefined;
let sql: postgres.Sql | undefined;
let dockerOk = false;

beforeAll(async () => {
  if (explicitSkip) return;
  dockerOk = dockerAvailable();
  if (!dockerOk && !requirePg) return;
  if (!dockerOk && requirePg) {
    throw new Error('SHARP_TEST_REQUIRE_PG=1 but docker is unavailable');
  }
  container = await startPostgres();
  sql = postgres(container.url, { onnotice: () => {} });
  await runMigrations(sql);
}, 240_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 2 });
  if (container) await container.stop();
});

const PINNED = {
  nameAndEmail: 'Alice Doe <alice@example.com>',
  timestamp: 1735689600,
  timezone: '+0000',
};

describe.skipIf(explicitSkip || (!requirePg && !dockerOk))('storage layer', () => {
  it('runs migrations idempotently', async () => {
    const result = await runMigrations(sql!);
    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied.length).toBeGreaterThanOrEqual(3);
  });

  it('creates a repo and stores/reads objects', async () => {
    const repo = await createRepo(sql!, { name: `test_${Date.now()}_${Math.random()}` });
    const payload = new Uint8Array(Buffer.from('hello world\n', 'utf8'));
    const id = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'blob',
      payload,
    });
    // Sharp's id == git's id == sha1(`blob 12\0hello world\n`)
    expect(idHex(id)).toBe(idHex(hashObject('blob', payload, 'sha1')));
    expect(await objectExists(sql!, repo.id, id)).toBe(true);
    const rec = await getObject(sql!, repo.id, id);
    expect(rec?.kind).toBe('blob');
    expect(Buffer.from(rec!.data).toString('utf8')).toBe('hello world\n');
  });

  it('putObject is idempotent (re-put returns same id, no row dup)', async () => {
    const repo = await createRepo(sql!, { name: `idem_${Date.now()}_${Math.random()}` });
    const payload = new Uint8Array(Buffer.from('idempotent', 'utf8'));
    const id1 = await putObject(sql!, { repo: repo.id, algo: 'sha1', kind: 'blob', payload });
    const id2 = await putObject(sql!, { repo: repo.id, algo: 'sha1', kind: 'blob', payload });
    expect(idHex(id1)).toBe(idHex(id2));
    const count = await sql!<{ count: string }[]>`
      select count(*)::text as count from objects where repo_id = ${repo.id}::uuid and id = ${Buffer.from(id1)}
    `;
    expect(count[0]?.count).toBe('1');
  });

  it('getRepo round-trip', async () => {
    const name = `getrepo_${Date.now()}`;
    await createRepo(sql!, { name, defaultBranch: 'trunk' });
    const found = await getRepo(sql!, name);
    expect(found?.name).toBe(name);
    expect(found?.default_branch).toBe('trunk');
  });

  it('refs: create, get, atomic CAS update', async () => {
    const repo = await createRepo(sql!, { name: `refs_${Date.now()}_${Math.random()}` });
    const a = idFromHex('aa'.repeat(20));
    const b = idFromHex('bb'.repeat(20));
    await createRef(sql!, repo.id, 'refs/heads/main', { kind: 'hash', target: a });
    const r1 = await getRef(sql!, repo.id, 'refs/heads/main');
    expect(r1?.kind).toBe('hash');
    if (r1?.kind === 'hash') expect(idHex(r1.target)).toBe('aa'.repeat(20));

    await updateRef(sql!, repo.id, 'refs/heads/main', a, { kind: 'hash', target: b });
    const r2 = await getRef(sql!, repo.id, 'refs/heads/main');
    if (r2?.kind === 'hash') expect(idHex(r2.target)).toBe('bb'.repeat(20));

    // CAS race: stale expected → RefCasFailed
    await expect(
      updateRef(sql!, repo.id, 'refs/heads/main', a, {
        kind: 'hash',
        target: idFromHex('cc'.repeat(20)),
      }),
    ).rejects.toBeInstanceOf(RefCasFailed);
  });

  it('refs: HEAD is symbolic; resolveRef follows the chain', async () => {
    const repo = await createRepo(sql!, { name: `head_${Date.now()}_${Math.random()}` });
    const tip = idFromHex('11'.repeat(20));
    await createRef(sql!, repo.id, 'refs/heads/main', { kind: 'hash', target: tip });
    await updateSymbolicRef(sql!, repo.id, 'HEAD', 'refs/heads/main');
    const head = await getRef(sql!, repo.id, 'HEAD');
    expect(head?.kind).toBe('symbolic');
    const resolved = await resolveRef(sql!, repo.id, 'HEAD');
    expect(resolved && idHex(resolved)).toBe('11'.repeat(20));

    const refs = await listRefs(sql!, repo.id);
    expect(refs.map((r) => r.name).sort()).toEqual(['HEAD', 'refs/heads/main']);
  });

  it('createCommit: stores tree/commit, populates commit_paths, advances ref', async () => {
    const repo = await createRepo(sql!, { name: `commit_${Date.now()}_${Math.random()}` });

    // Two blobs in a tree.
    const helloId = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'blob',
      payload: new Uint8Array(Buffer.from('hello\n', 'utf8')),
    });
    const worldId = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'blob',
      payload: new Uint8Array(Buffer.from('world\n', 'utf8')),
    });

    const entries: TreeEntry[] = [
      { mode: '100644', name: 'hello.txt', id: helloId },
      { mode: '100644', name: 'world.txt', id: worldId },
    ];
    const treeBytes = encodeTree(entries);
    const treeId = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'tree',
      payload: treeBytes,
    });

    const result = await createCommit(sql!, {
      repo: repo.id,
      algo: 'sha1',
      commit: {
        tree: treeId,
        parents: [],
        author: PINNED,
        committer: PINNED,
        message: 'initial\n',
      },
      refUpdate: { name: 'refs/heads/main' },
    });
    expect(result.id).toBeDefined();

    // ref advanced
    const main = await getRef(sql!, repo.id, 'refs/heads/main');
    if (main?.kind === 'hash') expect(idHex(main.target)).toBe(idHex(result.id));

    // commit_paths populated
    const paths = await sql!<{ path: string }[]>`
      select path from commit_paths where repo_id = ${repo.id}::uuid and commit_id = ${Buffer.from(result.id)} order by path
    `;
    expect(paths.map((p) => p.path)).toEqual(['hello.txt', 'world.txt']);
  });

  it('createCommit: rejects when tree is missing', async () => {
    const repo = await createRepo(sql!, { name: `missing_${Date.now()}_${Math.random()}` });
    const ghostTree = idFromHex('de'.repeat(20));
    await expect(
      createCommit(sql!, {
        repo: repo.id,
        algo: 'sha1',
        commit: {
          tree: ghostTree,
          parents: [],
          author: PINNED,
          committer: PINNED,
          message: 'should fail\n',
        },
      }),
    ).rejects.toThrow(/missing tree/);
  });

  it('createCommit: parent diff drives commit_paths (only changed paths)', async () => {
    const repo = await createRepo(sql!, { name: `diff_${Date.now()}_${Math.random()}` });

    // Initial: tree with hello.txt
    const v1 = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'blob',
      payload: new Uint8Array(Buffer.from('v1\n', 'utf8')),
    });
    const tree1 = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'tree',
      payload: encodeTree([{ mode: '100644', name: 'hello.txt', id: v1 }]),
    });
    const c1 = await createCommit(sql!, {
      repo: repo.id,
      algo: 'sha1',
      commit: { tree: tree1, parents: [], author: PINNED, committer: PINNED, message: 'v1\n' },
    });

    // Second: change hello.txt, add second.txt
    const v2 = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'blob',
      payload: new Uint8Array(Buffer.from('v2\n', 'utf8')),
    });
    const second = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'blob',
      payload: new Uint8Array(Buffer.from('second\n', 'utf8')),
    });
    const tree2 = await putObject(sql!, {
      repo: repo.id,
      algo: 'sha1',
      kind: 'tree',
      payload: encodeTree([
        { mode: '100644', name: 'hello.txt', id: v2 },
        { mode: '100644', name: 'second.txt', id: second },
      ]),
    });
    const c2 = await createCommit(sql!, {
      repo: repo.id,
      algo: 'sha1',
      commit: {
        tree: tree2,
        parents: [c1.id],
        author: PINNED,
        committer: PINNED,
        message: 'v2\n',
      },
    });

    const paths = await sql!<{ path: string }[]>`
      select path from commit_paths where repo_id = ${repo.id}::uuid and commit_id = ${Buffer.from(c2.id)} order by path
    `;
    expect(paths.map((p) => p.path)).toEqual(['hello.txt', 'second.txt']);
  });
});
