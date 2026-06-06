import { getPool } from './pool.js'

export async function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const pool = await getPool()
  const result = await pool.query(sql, params)
  return result.rows as T[]
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

export async function execute(sql: string, params?: unknown[]): Promise<void> {
  const pool = await getPool()
  await pool.query(sql, params)
}
