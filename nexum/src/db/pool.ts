import pg from 'pg'
import { config } from '../config.js'

let pool: pg.Pool | null = null

export function resetPool(): void {
  pool = null
}

export async function getPool(): Promise<pg.Pool> {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.DATABASE_URL })
    // Register vector type so embedding columns deserialize as number[] not raw strings
    // pgvector OID is 16385 by default, but query the actual OID to be safe
    const client = await pool.connect()
    try {
      const { rows } = await client.query("SELECT oid FROM pg_type WHERE typname = 'vector'")
      if (rows.length > 0) {
        const vectorOid = rows[0].oid
        pg.types.setTypeParser(vectorOid, (val: string) => {
          return val.slice(1, -1).split(',').map(Number)
        })
      }
    } finally {
      client.release()
    }
  }
  return pool
}
