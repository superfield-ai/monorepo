/**
 * @file tests/integration/app-proxy.test.ts
 *
 * Layer 3 Integration — App proxy end-to-end.
 *
 * Verifies that studio:
 *   1. Discovers the web service endpoint from the app's k8s manifests
 *      (not from hardcoded assumptions).
 *   2. Proxies GET /app/* to the k8s-deployed web service.
 *
 * The web service is always deployed to k3s — never mocked or run locally.
 * The fixture at tests/fixtures/hello-app/k8s/ plays the role of a calypso
 * app's k8s directory.
 *
 * Run in isolation:
 *   node --test tests/integration/app-proxy.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { discoverServicePort } from '../../packages/core/manifest-parser.js';
import {
  clusterAvailable,
  createNamespace,
  deleteNamespace,
  applyManifests,
  capturePodLogs,
} from './helpers/cluster.js';
import { portForward } from './helpers/port-forward.js';
import { waitReady } from './helpers/wait-ready.js';

// The hello-app fixture acts as the calypso app being pointed at by studio.
// It defines a "web" Service — studio reads its port from this directory.
const HELLO_APP_K8S = resolve(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/hello-app/k8s');

const NAMESPACE = `calypso-proxy-${Date.now()}`;
const TIMEOUT_MS = 120_000;

describe('app-proxy', { timeout: TIMEOUT_MS + 10_000 }, () => {
  before(function () {
    if (!clusterAvailable()) {
      this.skip();
    }
  });

  before(() => {
    createNamespace(NAMESPACE);
    // Deploy the studio server (from k8s/base/) — this is the studio program.
    applyManifests(NAMESPACE, 'k8s/base');
    // Deploy the hello-app web service — this simulates the calypso app being
    // developed. It is always k8s (nginx), never a local mock.
    applyManifests(NAMESPACE, HELLO_APP_K8S);
  });

  after(() => {
    capturePodLogs(NAMESPACE);
    deleteNamespace(NAMESPACE);
  });

  it('discovers web service port from app k8s manifests', () => {
    // Studio reads the web endpoint from the app's k8s YAML.
    // This must not be null — if it is, studio would have no way to proxy.
    const port = discoverServicePort(HELLO_APP_K8S, 'web');
    assert.ok(port !== null, 'discoverServicePort should find the web Service');
    assert.strictEqual(port, 80, 'web Service port should match the manifest');
  });

  it('all deployments reach Available', async () => {
    await assert.doesNotReject(
      () => waitReady(NAMESPACE, TIMEOUT_MS),
    );
  });

  it('GET /app/ proxies to the k8s web service', async () => {
    // Port-forward to the studio api service — all traffic goes through studio.
    const studioFwd = await portForward(NAMESPACE, 'svc/api', 0, 3000);
    try {
      const res = await fetch(`http://${studioFwd.host}:${studioFwd.port}/app/`);
      assert.strictEqual(res.status, 200, '/app/ should return 200 from the k8s nginx web service');
    } finally {
      studioFwd.close();
    }
  });
});
