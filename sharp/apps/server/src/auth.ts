/**
 * Bearer-token authentication.
 *
 * Tokens are random 32-byte values, base64url-encoded for transport.
 * On the wire: `Authorization: Bearer <token>`. The server hashes the
 * token with SHA-256 and looks it up in `api_keys`. Token secrets are
 * never persisted; only their hashes.
 */
import { createHash, randomBytes } from 'node:crypto';
import type postgres from 'postgres';

export type Scope = 'read' | 'read_no_episodes' | 'write' | 'operator';

const SCOPE_RANK: Record<Scope, number> = {
  read_no_episodes: 0,
  read: 1,
  write: 2,
  operator: 3,
};

/**
 * Returns true if a principal with `granted` scope can perform an action
 * that requires `required` scope. The hierarchy is operator > write > read
 * > read_no_episodes.
 */
export function scopeAllows(granted: Scope, required: Scope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

export interface Principal {
  principal: string;
  scope: Scope;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export async function lookupPrincipal(
  sql: postgres.Sql | postgres.TransactionSql,
  token: string,
): Promise<Principal | undefined> {
  const hash = hashToken(token);
  const rows = await sql<{ principal: string; scope: Scope }[]>`
    select principal, scope from api_keys
     where token_hash = ${hash} and revoked_at is null
  `;
  return rows[0];
}

/** Issue a fresh token. Returns the secret (caller stores it; we don't). */
export async function issueToken(
  sql: postgres.Sql,
  opts: { principal: string; scope: Scope },
): Promise<{ token: string }> {
  const token = randomBytes(32).toString('base64url');
  await sql`
    insert into api_keys (token_hash, principal, scope)
    values (${hashToken(token)}, ${opts.principal}, ${opts.scope})
  `;
  return { token };
}

export function parseAuthHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m?.[1];
}
