/**
 * @file packages/core/tests/cluster-manager.test.ts
 *
 * Unit tests for cluster-manager module — manifest application with
 * image tag rewriting, including angle-bracket placeholder handling.
 *
 * Issue #21 test plan items:
 *   - Unit: image tag regex handles angle-bracket placeholders
 *   - Unit: spawn wrapper correctly pipes stdin to child process (verified
 *     indirectly — applyManifests now uses spawn with input option)
 *
 * @see packages/core/cluster-manager.ts
 * @see docs/cluster-definition.md — "Container image convention"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture spawn calls to verify stdin piping.
const spawnMock = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));

vi.mock('../spawn', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(() => ['app.yaml']),
    readFileSync: vi.fn(() => ''),
  };
});

import { readFileSync } from 'fs';

describe('applyManifests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const config = {
    sourceDir: '/product',
    k8sDir: 'k8s',
    namespace: 'default',
    verbose: false,
  };

  it('pipes YAML content via stdin to kubectl apply', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - image: postgres:16-alpine\n',
    );

    const { applyManifests } = await import('../cluster-manager');

    applyManifests(config, '/product/k8s', {});

    // The spawn call for kubectl apply should include input option.
    const kubectlCall = spawnMock.mock.calls.find(
      (call) => call[0] === 'kubectl' && (call[1] as string[]).includes('apply'),
    );
    expect(kubectlCall).toBeDefined();
    expect(kubectlCall![2]).toHaveProperty('input');
    expect(typeof kubectlCall![2].input).toBe('string');
  });

  it('rewrites ghcr.io image tags to studio tag', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      'spec:\n  template:\n    spec:\n      containers:\n        - image: ghcr.io/myorg/superfield-starter-ts:latest\n',
    );

    const { applyManifests } = await import('../cluster-manager');

    applyManifests(config, '/product/k8s', {
      'ghcr.io/myorg/superfield-starter-ts:latest': 'superfield-release:studio',
    });

    const kubectlCall = spawnMock.mock.calls.find(
      (call) => call[0] === 'kubectl' && (call[1] as string[]).includes('apply'),
    );
    const piped = kubectlCall![2].input as string;
    expect(piped).toContain('superfield-release:studio');
    expect(piped).not.toContain('ghcr.io/myorg/superfield-starter-ts');
  });

  it('rewrites <owner> angle-bracket placeholder image tags', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      'spec:\n  template:\n    spec:\n      containers:\n        - image: ghcr.io/<owner>/superfield-starter-ts:latest\n',
    );

    const { applyManifests } = await import('../cluster-manager');

    applyManifests(config, '/product/k8s', {
      'ghcr.io/<owner>/superfield-starter-ts:latest': 'superfield-release:studio',
    });

    const kubectlCall = spawnMock.mock.calls.find(
      (call) => call[0] === 'kubectl' && (call[1] as string[]).includes('apply'),
    );
    const piped = kubectlCall![2].input as string;
    expect(piped).toContain('superfield-release:studio');
    expect(piped).not.toContain('<owner>');
  });

  it('does not rewrite third-party images', async () => {
    vi.mocked(readFileSync).mockReturnValue(
      'spec:\n  template:\n    spec:\n      containers:\n        - image: postgres:16-alpine\n',
    );

    const { applyManifests } = await import('../cluster-manager');

    applyManifests(config, '/product/k8s', {
      'ghcr.io/myorg/superfield-starter-ts:latest': 'superfield-release:studio',
    });

    const kubectlCall = spawnMock.mock.calls.find(
      (call) => call[0] === 'kubectl' && (call[1] as string[]).includes('apply'),
    );
    const piped = kubectlCall![2].input as string;
    expect(piped).toContain('postgres:16-alpine');
  });
});
