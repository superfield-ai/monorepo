/**
 * DIY Testcontainers — spins up an isolated postgres:16 Docker container
 * and tears it down on request. Used by studio integration tests.
 *
 * Usage:
 *   const pg = await startPostgres();
 *   // pg.url — DATABASE_URL for this container
 *   // pg.containerId — for reference
 *   // pg.stop() — removes the container
 */

import { spawnSync } from 'child_process';

const PG_USER = 'calypso';
const PG_PASSWORD = 'calypso';
const PG_DB = 'calypso';
const PG_IMAGE = 'postgres:16';
const READY_TIMEOUT_MS = 30_000;
const PORT_POLL_INTERVAL_MS = 250;

export interface PgContainer {
  url: string;
  containerId: string;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<PgContainer> {
  const runResult = spawnSync('docker', [
    'run',
    '-d',
    '--rm',
    '-e',
    `POSTGRES_USER=${PG_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e',
    `POSTGRES_DB=${PG_DB}`,
    '-p',
    '0:5432',
    PG_IMAGE,
  ], { stdio: 'pipe' });

  if (runResult.status !== 0) {
    throw new Error(
      `Failed to start postgres container: ${runResult.stderr.toString()}`,
    );
  }

  const containerId = runResult.stdout.toString().trim();
  const port = await getContainerPortWithRetry(containerId);
  await waitForPostgres(containerId, port);

  const url = `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${port}/${PG_DB}`;

  return {
    url,
    containerId,
    stop: async () => {
      spawnSync('docker', ['stop', containerId]);
    },
  };
}

async function getContainerPortWithRetry(containerId: string): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = spawnSync('docker', ['port', containerId, '5432'], { stdio: 'pipe' });
    const output = result.stdout.toString().trim();
    try {
      return parseDockerPortOutput(output);
    } catch {
      await new Promise<void>((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
    }
  }
  throw new Error(`Timed out waiting for docker to publish port for container ${containerId}`);
}

async function waitForPostgres(containerId: string, port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = spawnSync(
      'pg_isready',
      ['-h', 'localhost', '-p', String(port), '-U', PG_USER],
      { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, stdio: 'pipe' },
    );
    if (result.status === 0) return;

    // Fallback: check container logs for "ready to accept connections"
    const logs = spawnSync('docker', ['logs', '--tail', '10', containerId], { stdio: 'pipe' });
    const out = logs.stdout.toString() + logs.stderr.toString();
    if (out.includes('ready to accept connections')) return;

    await new Promise<void>((r) => setTimeout(r, 300));
  }
  throw new Error(`Postgres container did not become ready within ${READY_TIMEOUT_MS}ms`);
}

export function parseDockerPortOutput(output: string): number {
  if (!output.trim()) {
    throw new Error('Could not parse port from docker port output: ""');
  }
  const firstLine = output.split('\n')[0].trim();
  const port = parseInt(firstLine.split(':').at(-1) ?? '', 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Could not parse port from docker port output: "${output}"`);
  }
  return port;
}
