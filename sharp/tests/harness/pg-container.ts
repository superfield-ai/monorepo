/**
 * DIY Testcontainers — spawns a `docker run` of postgres:16 and tears it
 * down when stop() is called. Models on superfield/template/packages/db/
 * pg-container.ts (the established superfield pattern); kept lean for
 * Sharp's harness-only use case.
 *
 * Why not testcontainers? Single off-the-shelf image; we don't need port
 * mapping, network creation, or readiness DSLs. A 200-line bespoke helper
 * is cheaper than a third-party dependency for this scope.
 *
 * Why not docker-compose? Tests own their own container lifecycle so a
 * lane can be torn down per scenario if it ever becomes desirable, and
 * so a developer running a single test does not need a long-running
 * compose stack.
 *
 * Cleanup sentinel lives in $TMPDIR so the source tree stays clean.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';

const PG_USER = 'superfield';
const PG_PASSWORD = 'superfield';
const PG_DB = 'superfield';
const PG_IMAGE = 'postgres:16';
const READY_TIMEOUT_MS = readReadyTimeoutMs();
const POLL_INTERVAL_MS = 250;
const SENTINEL_PATH = join(tmpdir(), 'sharp-pg-sentinel.json');

export interface PgContainer {
  url: string;
  containerId: string;
  stop: () => Promise<void>;
}

interface SentinelRecord {
  containerId: string;
  startedAt: string;
}

interface Sentinel {
  version: 1;
  processes: SentinelRecord[];
}

function readSentinel(): Sentinel {
  if (!existsSync(SENTINEL_PATH)) return { version: 1, processes: [] };
  try {
    return JSON.parse(readFileSync(SENTINEL_PATH, 'utf8')) as Sentinel;
  } catch {
    return { version: 1, processes: [] };
  }
}

function writeSentinel(s: Sentinel): void {
  if (s.processes.length === 0) {
    if (existsSync(SENTINEL_PATH)) unlinkSync(SENTINEL_PATH);
    return;
  }
  writeFileSync(SENTINEL_PATH, JSON.stringify(s, null, 2));
}

function recordContainer(id: string): void {
  const s = readSentinel();
  s.processes.push({ containerId: id, startedAt: new Date().toISOString() });
  writeSentinel(s);
}

function forgetContainer(id: string): void {
  const s = readSentinel();
  s.processes = s.processes.filter((p) => p.containerId !== id);
  writeSentinel(s);
}

/**
 * Reap any containers tracked by a previous run that no longer exist or
 * that we still own. Cheap to call at startup.
 */
export function cleanupStaleContainers(): void {
  const s = readSentinel();
  for (const record of [...s.processes]) {
    spawnSync('docker', ['stop', record.containerId], { encoding: 'utf8' });
  }
  writeSentinel({ version: 1, processes: [] });
}

export async function startPostgres(): Promise<PgContainer> {
  cleanupStaleContainers();
  const networkArgs = getDockerNetworkArgs();

  const runResult = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      ...networkArgs,
      '-e',
      `POSTGRES_USER=${PG_USER}`,
      '-e',
      `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      '-e',
      `POSTGRES_DB=${PG_DB}`,
      PG_IMAGE,
    ],
    { encoding: 'utf8' },
  );

  if (runResult.status !== 0) {
    throw new Error(`failed to start postgres container: ${runResult.stderr || runResult.stdout}`);
  }

  const containerId = runResult.stdout.trim();
  recordContainer(containerId);

  let address: string;
  try {
    address = await waitForContainerAddress(containerId);
    await waitForPostgresReady(address);
  } catch (err) {
    forgetContainer(containerId);
    spawnSync('docker', ['stop', containerId], { encoding: 'utf8' });
    throw err;
  }

  const url = `postgres://${PG_USER}:${PG_PASSWORD}@${address}:5432/${PG_DB}`;

  return {
    url,
    containerId,
    stop: async () => {
      forgetContainer(containerId);
      spawnSync('docker', ['stop', containerId], { encoding: 'utf8' });
    },
  };
}

async function waitForContainerAddress(containerId: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'docker',
      [
        'inspect',
        '-f',
        '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}',
        containerId,
      ],
      { encoding: 'utf8' },
    );
    const ip = result.stdout
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    if (ip) return ip;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for container ${containerId} ip`);
}

async function waitForPostgresReady(host: string, port = 5432): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const url = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const sql = postgres(url, { connect_timeout: 2, max: 1 });
      await sql`SELECT 1`;
      await sql.end();
      return;
    } catch (err) {
      lastError = err;
      await sleep(300);
    }
  }
  throw new Error(
    `postgres at ${host}:${port} did not become ready within ${READY_TIMEOUT_MS}ms: ${(lastError as Error)?.message ?? lastError}`,
  );
}

/**
 * When running inside a Docker container via a mounted socket (DinD),
 * spawned containers are siblings on the host daemon. They land on the
 * default bridge, which is unreachable from the runner's custom network.
 * Connecting the new container to the same network as the current
 * container fixes routing.
 */
function getDockerNetworkArgs(): string[] {
  if (!existsSync('/.dockerenv')) return [];
  const hostname = process.env.HOSTNAME;
  if (!hostname) return [];
  const result = spawnSync(
    'docker',
    [
      'inspect',
      hostname,
      '--format',
      '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const network = result.stdout.trim().split('\n')[0]?.trim() ?? '';
  return network ? ['--network', network] : [];
}

function readReadyTimeoutMs(): number {
  const raw = process.env.SHARP_PG_READY_TIMEOUT_MS?.trim();
  if (!raw) return 180_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 180_000;
}

/** Docker availability check used to skip canary suites on machines without docker. */
export function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim().length > 0;
}
