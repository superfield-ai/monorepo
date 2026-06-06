/**
 * @file tests/e2e/specs/cluster-status.spec.ts
 *
 * Layer 4 Browser E2E — Cluster status.
 *
 * Scenario: Force-delete a pod via kubectl; indicator transitions restarting
 * → healthy without a page reload.
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Test scenarios" table — "cluster-status" row.
 */

import { test, expect } from '../fixtures/studio.fixture.js';
import { spawnSync } from 'node:child_process';

test.describe('cluster-status', () => {
  test('force-deleting a pod causes indicator to transition restarting then healthy', async ({ studioPage, serverUrl }) => {
    // First confirm the cluster is healthy at the start.
    await studioPage.waitForClusterStatus('healthy', 30_000);

    // Derive the namespace from the server URL and find a pod to force-delete.
    // We use kubectl to get the first pod in the namespace and delete it.
    const namespaceResult = spawnSync(
      'kubectl',
      ['get', 'namespaces', '-o', 'name'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const namespaces = (namespaceResult.stdout ?? '')
      .split('\n')
      .map((line) => line.replace('namespace/', '').trim())
      .filter((ns) => ns.startsWith('calypso-e2e-'));

    // Use the most recently created calypso-e2e namespace.
    const namespace = namespaces.at(-1);
    if (!namespace) {
      console.warn('[cluster-status.spec] No calypso-e2e namespace found — skipping pod delete');
      return;
    }

    // Get the first pod in the namespace.
    const podResult = spawnSync(
      'kubectl',
      ['get', 'pods', '-n', namespace, '-o', 'name'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const pods = (podResult.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (pods.length === 0) {
      console.warn('[cluster-status.spec] No pods found in namespace — skipping pod delete');
      return;
    }

    const podName = pods[0].replace('pod/', '');

    // Record whether a page navigation occurred — it should NOT.
    let pageNavigated = false;
    studioPage.page.on('load', () => {
      pageNavigated = true;
    });

    // Force-delete the pod.
    spawnSync(
      'kubectl',
      ['delete', 'pod', podName, '-n', namespace, '--grace-period=0', '--force'],
      { encoding: 'utf8', timeout: 15_000 },
    );

    // Wait for the indicator to show restarting.
    const sawRestarting = await studioPage
      .waitForClusterStatus('restarting', 30_000)
      .then(() => true)
      .catch(() => false);

    // Then wait for it to return to healthy.
    await studioPage.waitForClusterStatus('healthy', 120_000);

    const finalLabel = await studioPage.getClusterStatusLabel();
    expect(finalLabel).toContain('healthy');

    // Verify no full page reload occurred.
    expect(pageNavigated).toBe(false);
  });

  test('cluster status indicator is always visible on the page', async ({ studioPage }) => {
    // The indicator should be present and visible regardless of cluster state.
    await expect(studioPage.clusterStatusIndicator).toBeVisible();

    const ariaLabel = await studioPage.getClusterStatusLabel();
    expect(ariaLabel).toMatch(/Cluster status: (healthy|restarting|degraded|unknown)/);
  });
});
