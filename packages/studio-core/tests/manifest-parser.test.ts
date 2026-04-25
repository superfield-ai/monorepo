import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { discoverResources, discoverSecretRefs, discoverImages, discoverServicePort } from '../manifest-parser';

// Point at the actual product k8s directory.
const K8S_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'k8s');

describe('discoverResources', () => {
  it('discovers all workloads from the product k8s directory', () => {
    const resources = discoverResources(K8S_DIR);
    const kinds = resources.map((r) => r.kind);
    const names = resources.map((r) => r.name);

    // Should find the core workloads.
    expect(kinds).toContain('Deployment');
    expect(kinds).toContain('StatefulSet');
    expect(kinds).toContain('Job');
    expect(names).toContain('calypso-app');
    expect(names).toContain('calypso-postgres');
    expect(names).toContain('calypso-db-init');
  });

  it('discovers worker deployments', () => {
    const resources = discoverResources(K8S_DIR);
    const names = resources.map((r) => r.name);
    expect(names).toContain('calypso-worker-coding');
    expect(names).toContain('calypso-worker-analysis');
  });

  it('discovers services and network policies', () => {
    const resources = discoverResources(K8S_DIR);
    const kinds = resources.map((r) => r.kind);
    expect(kinds).toContain('Service');
    expect(kinds).toContain('NetworkPolicy');
  });

  it('returns empty array for nonexistent directory', () => {
    expect(() => discoverResources('/nonexistent')).toThrow();
  });
});

describe('discoverSecretRefs', () => {
  it('finds the calypso-secrets secret', () => {
    const secrets = discoverSecretRefs(K8S_DIR);
    const names = secrets.map((s) => s.name);
    expect(names).toContain('calypso-secrets');
  });

  it('finds expected keys in calypso-secrets', () => {
    const secrets = discoverSecretRefs(K8S_DIR);
    const calypsoSecrets = secrets.find((s) => s.name === 'calypso-secrets');
    expect(calypsoSecrets).toBeDefined();
    expect(Object.keys(calypsoSecrets!.literals)).toContain('DATABASE_URL');
    expect(Object.keys(calypsoSecrets!.literals)).toContain('POSTGRES_PASSWORD');
  });

  it('finds worker secrets', () => {
    const secrets = discoverSecretRefs(K8S_DIR);
    const names = secrets.map((s) => s.name);
    expect(names).toContain('calypso-worker-coding-secret');
    expect(names).toContain('calypso-worker-analysis-secret');
  });

  it('finds db-init secret', () => {
    const secrets = discoverSecretRefs(K8S_DIR);
    const names = secrets.map((s) => s.name);
    expect(names).toContain('calypso-db-init-secret');
  });

  it('values are empty strings (caller fills them)', () => {
    const secrets = discoverSecretRefs(K8S_DIR);
    for (const secret of secrets) {
      for (const value of Object.values(secret.literals)) {
        expect(value).toBe('');
      }
    }
  });
});

describe('discoverServicePort', () => {
  // Use the hello-app fixture — a self-contained k8s dir within the studio
  // repo that represents a calypso app's k8s directory.
  const FIXTURE_K8S_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'hello-app', 'k8s');

  it('returns the port for a named Service', () => {
    const port = discoverServicePort(FIXTURE_K8S_DIR, 'web');
    expect(port).toBe(80);
  });

  it('returns null for an unknown service name', () => {
    const port = discoverServicePort(FIXTURE_K8S_DIR, 'nonexistent');
    expect(port).toBeNull();
  });

  it('throws for a nonexistent directory', () => {
    expect(() => discoverServicePort('/nonexistent', 'web')).toThrow();
  });
});

describe('discoverImages', () => {
  it('finds container images', () => {
    const images = discoverImages(K8S_DIR);
    expect(images.length).toBeGreaterThan(0);
  });

  it('finds unique images (no duplicates)', () => {
    const images = discoverImages(K8S_DIR);
    expect(new Set(images).size).toBe(images.length);
  });

  it('does not include commented-out images', () => {
    const images = discoverImages(K8S_DIR);
    // The app.yaml has a commented image line — it should not appear twice.
    const appImages = images.filter((i) => i.includes('calypso-starter-ts'));
    expect(appImages.length).toBeLessThanOrEqual(1);
  });
});
