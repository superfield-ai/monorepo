/**
 * Refs (branches, tags, HEAD).
 *
 * Updates use a compare-and-swap model so concurrent pushes to the same
 * ref deterministically produce one winner; the others get a typed
 * `RefCasFailed` error and can retry.
 */
import type postgres from 'postgres';

export type Sql = postgres.Sql | postgres.TransactionSql;

export type RefTarget = { kind: 'hash'; target: Uint8Array } | { kind: 'symbolic'; target: string };

export class RefCasFailed extends Error {
  public readonly repo: string;
  public override readonly name = 'RefCasFailed';
  public readonly refName: string;
  constructor(repo: string, refName: string) {
    super(`ref CAS failed: ${refName} in ${repo}`);
    this.repo = repo;
    this.refName = refName;
  }
}

interface RefRow {
  name: string;
  target: Buffer | null;
  symbolic_target: string | null;
  target_kind: 'hash' | 'symbolic';
}

function rowToTarget(row: RefRow): RefTarget {
  return row.target_kind === 'hash'
    ? { kind: 'hash', target: new Uint8Array(row.target!) }
    : { kind: 'symbolic', target: row.symbolic_target! };
}

export async function getRef(sql: Sql, repo: string, name: string): Promise<RefTarget | undefined> {
  const rows = await sql<RefRow[]>`
    select name, target, symbolic_target, target_kind
      from refs where repo_id = ${repo}::uuid and name = ${name}
  `;
  return rows[0] ? rowToTarget(rows[0]) : undefined;
}

export async function listRefs(
  sql: Sql,
  repo: string,
  prefix?: string,
): Promise<{ name: string; target: RefTarget }[]> {
  const rows = prefix
    ? await sql<RefRow[]>`
        select name, target, symbolic_target, target_kind
          from refs where repo_id = ${repo}::uuid and name like ${prefix + '%'}
          order by name
      `
    : await sql<RefRow[]>`
        select name, target, symbolic_target, target_kind
          from refs where repo_id = ${repo}::uuid order by name
      `;
  return rows.map((r) => ({ name: r.name, target: rowToTarget(r) }));
}

/**
 * Create a ref. Fails if a ref with the same name already exists.
 */
export async function createRef(
  sql: Sql,
  repo: string,
  name: string,
  target: RefTarget,
): Promise<void> {
  if (target.kind === 'hash') {
    await sql`
      insert into refs (repo_id, name, target, target_kind)
      values (${repo}::uuid, ${name}, ${Buffer.from(target.target)}, 'hash')
    `;
  } else {
    await sql`
      insert into refs (repo_id, name, symbolic_target, target_kind)
      values (${repo}::uuid, ${name}, ${target.target}, 'symbolic')
    `;
  }
}

/**
 * Atomic compare-and-swap update.
 *
 * If `expectedOld` is undefined, the operation creates the ref iff it
 * doesn't already exist (insert-or-throw). If `expectedOld` is a hash,
 * the operation updates the ref iff its current value matches.
 *
 * Throws `RefCasFailed` on race.
 */
export async function updateRef(
  sql: Sql,
  repo: string,
  name: string,
  expectedOld: Uint8Array | undefined,
  target: RefTarget,
): Promise<void> {
  if (expectedOld === undefined) {
    // Create-only path.
    await createRef(sql, repo, name, target);
    return;
  }

  // Build the update with the matching CAS condition. Only hash → hash
  // CAS is supported; symbolic refs are updated atomically without CAS
  // because they don't race the same way.
  if (target.kind !== 'hash') {
    throw new Error('symbolic ref update is not a CAS — call createRef or updateSymbolicRef');
  }

  const rows = await sql<{ target: Buffer }[]>`
    update refs
       set target = ${Buffer.from(target.target)},
           updated_at = now()
     where repo_id = ${repo}::uuid
       and name = ${name}
       and target_kind = 'hash'
       and target = ${Buffer.from(expectedOld)}
     returning target
  `;
  if (rows.length === 0) {
    throw new RefCasFailed(repo, name);
  }
}

/**
 * Replace a symbolic ref's target. Used for HEAD updates after `checkout`.
 */
export async function updateSymbolicRef(
  sql: Sql,
  repo: string,
  name: string,
  newTarget: string,
): Promise<void> {
  const rows = await sql`
    update refs
       set symbolic_target = ${newTarget}, updated_at = now()
     where repo_id = ${repo}::uuid and name = ${name} and target_kind = 'symbolic'
     returning name
  `;
  if (rows.count === 0) {
    // Insert as a new symbolic ref.
    await createRef(sql, repo, name, { kind: 'symbolic', target: newTarget });
  }
}

export async function deleteRef(sql: Sql, repo: string, name: string): Promise<void> {
  await sql`delete from refs where repo_id = ${repo}::uuid and name = ${name}`;
}

/**
 * Resolve a ref to a hash, following symbolic refs. Returns undefined if
 * the chain dead-ends or contains a cycle.
 */
export async function resolveRef(
  sql: Sql,
  repo: string,
  name: string,
  depth = 0,
): Promise<Uint8Array | undefined> {
  if (depth > 8) return undefined;
  const t = await getRef(sql, repo, name);
  if (!t) return undefined;
  return t.kind === 'hash' ? t.target : resolveRef(sql, repo, t.target, depth + 1);
}
