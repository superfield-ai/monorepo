/**
 * @file secret-generator.ts
 *
 * Generates ephemeral Kubernetes secrets from manifest references.
 *
 * Studio scans the product's k8s manifests for secretKeyRef references,
 * then generates random values for each key. Every studio start gets
 * fresh secrets — simulating production deployments with ephemeral
 * credentials.
 *
 * Special handling for known key patterns:
 *   - Keys containing "DATABASE_URL" → valid postgres:// connection string
 *   - Keys containing "PASSWORD" → random hex token
 *   - Keys named "POSTGRES_USER" or "POSTGRES_DB" → sensible defaults
 *   - Everything else → random hex token
 */

import { randomBytes } from 'crypto';
import { spawn } from './spawn';
import type { StudioClusterConfig, SecretSpec } from './types';

function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Fill in empty SecretSpec values with generated tokens.
 *
 * Uses key name patterns to generate appropriate values (e.g.
 * DATABASE_URL gets a postgres:// string, not random hex).
 *
 * @param specs       Secret specs with keys but empty values.
 * @param pgHost      Hostname for postgres connections. Default: "superfield-postgres"
 * @param pgPort      Port for postgres connections. Default: 5432
 * @returns           Secret specs with all values populated.
 */
export function generateSecrets(
  specs: SecretSpec[],
  pgHost = 'superfield-postgres',
  pgPort = 5432,
): SecretSpec[] {
  const pgPassword = randomToken();
  const pgUser = 'superfield';
  const pgDb = 'superfield';

  return specs.map((spec) => ({
    name: spec.name,
    literals: Object.fromEntries(
      Object.keys(spec.literals).map((key) => {
        const k = key.toUpperCase();

        if (k === 'POSTGRES_USER') return [key, pgUser];
        if (k === 'POSTGRES_DB') return [key, pgDb];
        if (k === 'POSTGRES_PASSWORD') return [key, pgPassword];

        // DATABASE_URL patterns → postgres connection string.
        if (k.includes('DATABASE_URL')) {
          // Derive a role name from the key prefix.
          const prefix = k.replace(/_?DATABASE_URL$/, '').toLowerCase();
          const role = prefix === '' || prefix === 'database' ? pgUser : prefix.replace(/_/g, '_');
          const db = k.includes('AUDIT') ? 'superfield_audit'
            : k.includes('ANALYTICS') ? 'superfield_analytics'
            : pgDb;
          return [key, `postgresql://${role}:${randomToken()}@${pgHost}:${pgPort}/${db}`];
        }

        // PASSWORD keys → random token.
        if (k.includes('PASSWORD')) return [key, randomToken()];

        // DB name keys.
        if (k === 'APP_DB') return [key, pgDb];
        if (k === 'AUDIT_DB') return [key, 'superfield_audit'];
        if (k === 'ANALYTICS_DB') return [key, 'superfield_analytics'];

        // URL keys → placeholder URL.
        if (k.includes('BASE_URL') || k.includes('API_URL')) {
          return [key, 'http://superfield-app:31415'];
        }

        // Everything else → random token.
        return [key, randomToken()];
      }),
    ),
  }));
}

/**
 * Apply generated secrets to the Kubernetes cluster.
 *
 * Deletes existing secrets first, then creates fresh ones.
 */
export function applySecrets(
  config: StudioClusterConfig,
  secrets: SecretSpec[],
): void {
  for (const spec of secrets) {
    spawn('kubectl', ['delete', 'secret', spec.name,
      `--namespace=${config.namespace}`, '--ignore-not-found']);

    const args = ['create', 'secret', 'generic', spec.name,
      `--namespace=${config.namespace}`];
    for (const [key, value] of Object.entries(spec.literals)) {
      args.push(`--from-literal=${key}=${value}`);
    }
    const result = spawn('kubectl', args);
    if (result.status !== 0) {
      console.error(`\n❌ Failed to create secret ${spec.name}`);
      if (result.stderr) console.error(result.stderr);
      process.exit(1);
    }

    if (config.verbose) {
      console.log(`    Created ${spec.name}: ${Object.keys(spec.literals).join(', ')}`);
    }
  }
}

/**
 * Seed application-specific data after the database is ready.
 *
 * Inserts dummy worker credentials into the worker_credentials table
 * so worker pods can start without real vendor API credentials. Runs
 * SQL directly on the postgres pod via kubectl exec.
 */
export function seedApplicationData(
  config: StudioClusterConfig,
  _secrets: SecretSpec[],
): void {
  // Find the postgres secret to get connection credentials.
  const pgSecret = _secrets.find((s) =>
    Object.keys(s.literals).some((k) => k === 'POSTGRES_USER'),
  );
  if (!pgSecret) return;

  const pgUser = pgSecret.literals['POSTGRES_USER'] ?? 'superfield';
  const pgDb = pgSecret.literals['POSTGRES_DB'] ?? 'superfield';

  // Find the postgres pod (StatefulSet pod naming convention: <name>-0).
  const podResult = spawn('kubectl', [
    'get', 'pods', '-l', 'app=superfield-postgres',
    `--namespace=${config.namespace}`,
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]);
  const pgPod = podResult.stdout.trim();
  if (!pgPod) return;

  // Wait for the pod to be ready before running SQL.
  spawn('kubectl', [
    'wait', '--for=condition=ready', `pod/${pgPod}`,
    `--namespace=${config.namespace}`, '--timeout=60s',
  ]);

  // Seed dummy worker credentials so workers can start.
  const seedSql = `
    INSERT INTO worker_credentials (agent_type, auth_bundle, created_by, expires_at)
    SELECT t.agent_type, 'studio-dummy-credential', 'studio-start', NOW() + INTERVAL '30 days'
    FROM (VALUES ('coding'), ('analysis')) AS t(agent_type)
    WHERE NOT EXISTS (
      SELECT 1 FROM worker_credentials wc
      WHERE wc.agent_type = t.agent_type AND wc.revoked_at IS NULL AND wc.expires_at > NOW()
    );
  `;

  if (config.verbose) {
    console.log(`    Seeding worker credentials via ${pgPod}`);
  }

  spawn('kubectl', [
    'exec', pgPod, `--namespace=${config.namespace}`, '--',
    'psql', '-U', pgUser, '-d', pgDb, '-c', seedSql,
  ]);
}
