/**
 * Content-addressed object store for a single repo.
 *
 * Wraps the `objects` table with a Git-canonical hash function from
 * @sharp/git-canonical. Sharp's object IDs *are* Git's IDs (whitepaper
 * §4.0), so an object stored here can be exported byte-for-byte and the
 * receiving Git remote computes the same SHA over the canonical bytes.
 *
 * SHA-1DC (collision-detection variant) is the eventual production hash
 * runner. v1 ships with a stub that always reports "no collision detected"
 * so development isn't blocked on vendoring the SHA-1DC C library; the
 * server refuses to start in production unless `SHARP_ALLOW_RAW_SHA1=1`
 * is set, signaling that the operator has knowingly accepted the gap.
 * See `verifyHashSafety` below.
 */
import { hashObject, type HashAlgo, type ObjectKind } from '@sharp/git-canonical';
import type postgres from 'postgres';

// Accept either a top-level Sql or a TransactionSql passed by sql.begin's
// callback so the cas/refs/commit helpers can be reused inside transactions.
export type Sql = postgres.Sql | postgres.TransactionSql;

export interface PutObjectInput {
  repo: string; // repo uuid
  algo: HashAlgo;
  kind: ObjectKind;
  payload: Uint8Array;
}

export interface ObjectRecord {
  id: Uint8Array;
  algo: HashAlgo;
  kind: ObjectKind;
  size: number;
  data: Uint8Array;
}

/**
 * Stub for SHA-1DC. Production deployments must replace this with a real
 * SHA-1DC implementation (vendored or via FFI). Returns `true` if a
 * collision-attempt is *not* detected, `false` if it is. The stub always
 * returns `true` (passes everything).
 *
 * The server's startup checks this is either a real implementation or
 * `SHARP_ALLOW_RAW_SHA1=1` is set.
 */
export function shaCollisionCheckStub(_payload: Uint8Array): boolean {
  return true;
}

export function verifyHashSafety(opts: { allowRawSha1: boolean }): void {
  if (!opts.allowRawSha1) {
    throw new Error(
      'SHA-1DC integration is not yet wired up. ' +
        'Set SHARP_ALLOW_RAW_SHA1=1 to acknowledge that the server is running ' +
        'with raw SHA-1 (acceptable for development, not for production).',
    );
  }
}

/**
 * Store an object. Returns its computed ID. Idempotent — re-putting the
 * same canonical bytes returns the same ID and is a no-op at the row level.
 */
export async function putObject(sql: Sql, input: PutObjectInput): Promise<Uint8Array> {
  if (!shaCollisionCheckStub(input.payload)) {
    throw new Error('object rejected: SHA-1 collision attempt detected');
  }
  const id = hashObject(input.kind, input.payload, input.algo);
  await sql`
    insert into objects (repo_id, id, algo, kind, size, data)
    values (
      ${input.repo}::uuid,
      ${Buffer.from(id)},
      ${input.algo},
      ${input.kind},
      ${input.payload.length},
      ${Buffer.from(input.payload)}
    )
    on conflict (repo_id, algo, id) do nothing
  `;
  return id;
}

export async function getObject(
  sql: Sql,
  repo: string,
  id: Uint8Array,
): Promise<ObjectRecord | undefined> {
  const rows = await sql<
    {
      id: Buffer;
      algo: HashAlgo;
      kind: ObjectKind;
      size: string;
      data: Buffer;
    }[]
  >`
    select id, algo, kind, size::text as size, data
      from objects
     where repo_id = ${repo}::uuid and id = ${Buffer.from(id)}
     limit 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: new Uint8Array(row.id),
    algo: row.algo,
    kind: row.kind,
    size: Number(row.size),
    data: new Uint8Array(row.data),
  };
}

export async function objectExists(sql: Sql, repo: string, id: Uint8Array): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1 from objects where repo_id = ${repo}::uuid and id = ${Buffer.from(id)}
    ) as exists
  `;
  return rows[0]?.exists ?? false;
}

export async function* listObjects(
  sql: Sql,
  repo: string,
): AsyncIterable<{ id: Uint8Array; kind: ObjectKind }> {
  const rows = await sql<
    { id: Buffer; kind: ObjectKind }[]
  >`select id, kind from objects where repo_id = ${repo}::uuid order by id`;
  for (const r of rows) yield { id: new Uint8Array(r.id), kind: r.kind };
}

export async function createRepo(
  sql: Sql,
  opts: { name: string; defaultBranch?: string; objectformat?: HashAlgo },
): Promise<{ id: string; name: string }> {
  const id = crypto.randomUUID();
  const defaultBranch = opts.defaultBranch ?? 'main';
  const objectformat = opts.objectformat ?? 'sha1';
  await sql`
    insert into repos (id, name, default_branch, objectformat)
    values (${id}::uuid, ${opts.name}, ${defaultBranch}, ${objectformat})
  `;
  return { id, name: opts.name };
}

export async function getRepo(
  sql: Sql,
  name: string,
): Promise<
  { id: string; name: string; default_branch: string; objectformat: HashAlgo } | undefined
> {
  const rows = await sql<
    {
      id: string;
      name: string;
      default_branch: string;
      objectformat: HashAlgo;
    }[]
  >`select id::text as id, name, default_branch, objectformat from repos where name = ${name}`;
  return rows[0];
}
