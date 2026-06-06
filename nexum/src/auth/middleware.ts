import { createHash, randomBytes } from 'node:crypto'
import { IncomingMessage } from 'node:http'
import { config } from '../config.js'
import { queryOne } from '../db/queries.js'

export interface Principal {
  id: string
  type: 'user' | 'agent'
  name: string
  scopes: string[]
}

export async function authenticate(req: IncomingMessage): Promise<Principal | null> {
  if (config.AUTH_OFF) return { id: 'anon', type: 'user', name: 'anon', scopes: ['*'] }

  const header = req.headers['authorization']
  if (!header?.startsWith('Bearer ')) return null

  const token = header.slice(7)
  const hash = createHash('sha256').update(token).digest('hex')

  const entity = await queryOne<Principal & { api_key_hash: string }>(
    `SELECT id, type, name, scopes FROM entities WHERE api_key_hash = $1`,
    [hash]
  )
  return entity
}

export async function requireAuth(req: IncomingMessage): Promise<Principal> {
  const principal = await authenticate(req)
  if (!principal) {
    const err = new Error('unauthorized') as any
    err.status = 401
    throw err
  }
  return principal
}

export async function requireCorpusScope(principal: Principal, corpusId: string, scope: string): Promise<void> {
  if (principal.scopes.includes('*')) return

  const access = await queryOne<{ scopes: string[] }>(
    `SELECT scopes FROM corpus_access WHERE entity_id = $1 AND corpus_id = $2`,
    [principal.id, corpusId]
  )
  if (!access || !access.scopes.includes(scope)) {
    const err = new Error('forbidden') as any
    err.status = 403
    throw err
  }
}

export function generateApiKey(): { key: string; hash: string } {
  const key = `nxm_${randomBytes(32).toString('hex')}`
  const hash = createHash('sha256').update(key).digest('hex')
  return { key, hash }
}
