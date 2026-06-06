import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'

let container: StartedTestContainer | null = null
let ageContainer: StartedTestContainer | null = null

export async function startDb(): Promise<string> {
  container = await new GenericContainer('pgvector/pgvector:pg16')
    .withEnvironment({
      POSTGRES_DB: 'nexum',
      POSTGRES_USER: 'nexum',
      POSTGRES_PASSWORD: 'nexum',
    })
    .withExposedPorts(5432)
    // Wait for the ready message twice: Postgres prints it once during initdb
    // (for template1/template0) and again when it actually starts accepting
    // connections. Waiting for only one occurrence races against the final
    // startup and causes "Connection terminated unexpectedly" errors.
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .start()

  const host = container.getHost()
  const port = container.getMappedPort(5432)
  const url = `postgresql://nexum:nexum@${host}:${port}/nexum`
  process.env.DATABASE_URL = url

  // Mutate the in-memory config snapshot so pool.ts and migrate.ts pick up
  // the testcontainer URL without restarting the process. Mirrors the same
  // pattern used in startAge() for AGE_DATABASE_URL.
  const { config } = await import('../../src/config.js')
  config.DATABASE_URL = url

  // Reset pool so next getPool() creates a fresh connection with the new URL
  const { resetPool } = await import('../../src/db/pool.js')
  resetPool()

  // Run migrations
  const { migrate } = await import('../../src/db/migrate.js')
  await migrate()

  return url
}

export async function stopDb(): Promise<void> {
  const { resetPool } = await import('../../src/db/pool.js')
  resetPool()
  await container?.stop()
  container = null
}

/**
 * Boot an Apache AGE container, set AGE_DATABASE_URL, run AGE migrations.
 * Issue #75: gives the integration suite a real Cypher endpoint to exercise
 * the dual-write seam against without depending on docker-compose.
 *
 * Returns the connection URL on success, or null when the AGE image is not
 * pullable in the test environment (CI without Docker, restricted networks).
 * Tests should `t.skip()` when null is returned rather than failing hard.
 */
export async function startAge(): Promise<string | null> {
  try {
    ageContainer = await new GenericContainer('apache/age:PG16_latest')
      .withEnvironment({
        POSTGRES_DB: 'nexum_age',
        POSTGRES_USER: 'nexum',
        POSTGRES_PASSWORD: 'nexum',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
      .withStartupTimeout(120_000)
      .start()
  } catch {
    ageContainer = null
    return null
  }
  const host = ageContainer.getHost()
  const port = ageContainer.getMappedPort(5432)
  const url = `postgresql://nexum:nexum@${host}:${port}/nexum_age`
  process.env.AGE_DATABASE_URL = url

  // Mutate the in-memory config snapshot so age.ts and migrate.ts see the
  // new URL without restarting the process.
  const { config } = await import('../../src/config.js')
  config.AGE_DATABASE_URL = url

  // The compose setup mounts db/migrations as initdb.d. Testcontainers does
  // not, so run the AGE shim explicitly here.
  const { migrateAge } = await import('../../src/db/migrate.js')
  await migrateAge()

  // Reset the AGE pool so it picks up the new URL on first use.
  const { resetAgePool } = await import('../../src/db/age.js')
  resetAgePool()
  return url
}

export async function stopAge(): Promise<void> {
  const { resetAgePool } = await import('../../src/db/age.js')
  resetAgePool()
  const { config } = await import('../../src/config.js')
  config.AGE_DATABASE_URL = ''
  await ageContainer?.stop()
  ageContainer = null
  delete process.env.AGE_DATABASE_URL
}
