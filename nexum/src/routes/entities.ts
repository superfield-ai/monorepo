import { route, send, readBody } from '../server.js'
import { execute } from '../db/queries.js'
import { generateApiKey } from '../auth/middleware.js'
import { randomUUID } from 'node:crypto'

route('POST', '/entities', async (req, res) => {
  const body = await readBody(req) as any
  if (!['user', 'agent'].includes(body?.type)) {
    return send(res, 400, { error: 'type must be user or agent' })
  }
  if (!body?.name) return send(res, 400, { error: 'name is required' })

  const { key, hash } = generateApiKey()
  const id = randomUUID()

  await execute(
    `INSERT INTO entities (id, type, name, api_key_hash, scopes) VALUES ($1, $2, $3, $4, $5)`,
    [id, body.type, body.name, hash, body.scopes ?? []]
  )

  // Return api_key once — never stored in plaintext
  send(res, 201, { id, type: body.type, name: body.name, scopes: body.scopes ?? [], api_key: key })
})
