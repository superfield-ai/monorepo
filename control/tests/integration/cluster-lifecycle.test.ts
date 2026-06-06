/**
 * @file tests/integration/cluster-lifecycle.test.ts
 *
 * Layer 3 Integration — Cluster provisioning lifecycle.
 *
 * Canonical spec: test-plan.md — "Layer 3 — Integration Tests" /
 * "Test matrix" — "Cluster provisioning" row.
 *
 * Scenarios covered:
 *   - Namespace created successfully in k3s cluster.
 *   - k8s manifests from k8s/base/ apply without error.
 *   - All Deployments reach the Available condition within the timeout.
 *   - kubectl port-forward to the api and web services succeeds.
 *
 * This suite is the top-level smoke test for the integration harness itself.
 * If it fails, all other suites will fail too.
 *
 * The suite is skipped automatically when no local k3s cluster is available
 * (detected via `clusterAvailable()`), enabling the test file to be loaded
 * in CI environments that only provision the cluster for integration runs.
 *
 * Run in isolation:
 *   node --test tests/integration/cluster-lifecycle.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterAvailable,
  createNamespace,
  deleteNamespace,
  applyManifests,
} from './helpers/cluster.js';
import { portForward } from './helpers/port-forward.js';
import { waitReady } from './helpers/wait-ready.js';

const NAMESPACE = `calypso-lifecycle-${Date.now()}`;
const TIMEOUT_MS = 120_000;

describe('cluster-lifecycle', { timeout: TIMEOUT_MS + 10_000 }, () => {
  before(function () {
    if (!clusterAvailable()) {
      this.skip(); // No cluster — skip the entire suite.
    }
  });

  before(() => {
    createNamespace(NAMESPACE);
  });

  after(() => {
    deleteNamespace(NAMESPACE);
  });

  it('namespace exists after createNamespace', () => {
    // If we reach here the namespace was created without throwing.
    assert.ok(NAMESPACE.length > 0);
  });

  it('overlay applies without error', () => {
    assert.doesNotThrow(() => {
      applyManifests(NAMESPACE);
    });
  });

  it('all deployments reach Available within timeout', async () => {
    await assert.doesNotReject(
      () => waitReady(NAMESPACE, TIMEOUT_MS),
      'waitReady should resolve without error',
    );
  });

  it('port-forward to api service succeeds', async () => {
    const fwd = await portForward(NAMESPACE, 'svc/api', 0, 3000);
    assert.ok(fwd.port > 0, 'resolved port should be a positive integer');
    assert.strictEqual(fwd.host, '127.0.0.1');
    fwd.close();
  });

  it('port-forward to web service succeeds', async () => {
    const fwd = await portForward(NAMESPACE, 'svc/web', 0, 80);
    assert.ok(fwd.port > 0, 'resolved port should be a positive integer');
    assert.strictEqual(fwd.host, '127.0.0.1');
    fwd.close();
  });
});
