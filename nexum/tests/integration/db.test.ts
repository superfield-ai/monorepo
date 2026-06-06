import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PostgreSqlContainer } from 'testcontainers'

let container: any
let origUrl: string | undefined

before(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('nexum')
    .withUsername('nexum')
    .withPassword('nexum')
    .start()
  origUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = container.getConnectionUri()
})

after(async () => {
  process.env.DATABASE_URL = origUrl
  await container?.stop()
})

test('migration runs cleanly on fresh DB', async () => {
  const { migrate } = await import('../../src/db/migrate.js')
  await assert.doesNotReject(migrate())
})

test('migration is idempotent', async () => {
  const { migrate } = await import('../../src/db/migrate.js')
  await assert.doesNotReject(migrate())
})

test('query helper returns typed rows', async () => {
  const { query } = await import('../../src/db/queries.js')
  const rows = await query<{ one: string }>('SELECT 1 AS one')
  assert.equal(rows[0].one, 1)
})
