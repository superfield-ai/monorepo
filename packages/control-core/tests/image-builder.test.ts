/**
 * @file packages/core/tests/image-builder.test.ts
 *
 * Unit tests for image-builder module — product image detection and
 * image tag rewriting.
 *
 * Issue #21 test plan items:
 *   - Unit: isProductImage() returns true for ghcr.io and <owner> patterns
 *   - Unit: image tag regex handles angle-bracket placeholders
 *
 * Issue #67: k3d image import replaces sudo k3s ctr images import.
 *   - No sudo call remains in the import path.
 *   - importToK3d throws an actionable error on non-zero exit.
 *
 * @see packages/core/image-builder.ts
 * @see docs/cluster-definition.md — "Container image convention"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// We need to test isProductImage which is not exported. We test it
// indirectly through buildImages by mocking spawn and existsSync.

// Mock the spawn module before importing image-builder.
vi.mock('../spawn', () => ({
  spawn: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

describe('image-builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('importToK3d error handling (via buildImages)', () => {
    it('throws an actionable error when k3d image import exits non-zero', async () => {
      const { spawn: spawnMock } = await import('../spawn');
      // docker build → status 0, k3d image import → status 1
      (spawnMock as Mock)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // docker build
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'cluster not found' }); // k3d import

      const { buildImages } = await import('../image-builder');

      expect(() =>
        buildImages(
          { sourceDir: '/test', k8sDir: 'k8s', namespace: 'default', verbose: false },
          ['ghcr.io/myorg/superfield-starter-ts:latest'],
        ),
      ).toThrow(/k3d image import failed/);
    });

    it('throws with k3d installation guidance when k3d import fails', async () => {
      const { spawn: spawnMock } = await import('../spawn');
      (spawnMock as Mock)
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // docker build
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' }); // k3d import

      const { buildImages } = await import('../image-builder');

      expect(() =>
        buildImages(
          { sourceDir: '/test', k8sDir: 'k8s', namespace: 'default', verbose: false },
          ['ghcr.io/myorg/superfield-starter-ts:latest'],
        ),
      ).toThrow(/k3d\.io/);
    });

    it('does not invoke sudo at any point during image import', async () => {
      const { spawn: spawnMock } = await import('../spawn');
      (spawnMock as Mock).mockReturnValue({ status: 0, stdout: '', stderr: '' });

      const { buildImages } = await import('../image-builder');

      buildImages(
        { sourceDir: '/test', k8sDir: 'k8s', namespace: 'default', verbose: false },
        ['ghcr.io/myorg/superfield-starter-ts:latest'],
      );

      const sudoCalls = (spawnMock as Mock).mock.calls.filter(
        (call) => call[0] === 'sudo',
      );
      expect(sudoCalls).toHaveLength(0);
    });
  });

  describe('isProductImage (via buildImages)', () => {
    it('identifies ghcr.io images as product images', async () => {
      const { buildImages } = await import('../image-builder');

      const imageMap = buildImages(
        { sourceDir: '/test', k8sDir: 'k8s', namespace: 'default', verbose: false },
        ['ghcr.io/myorg/superfield-starter-ts:latest'],
      );

      expect(imageMap['ghcr.io/myorg/superfield-starter-ts:latest']).toBe('superfield-release:studio');
    });

    it('identifies <owner> placeholder images as product images', async () => {
      const { buildImages } = await import('../image-builder');

      const imageMap = buildImages(
        { sourceDir: '/test', k8sDir: 'k8s', namespace: 'default', verbose: false },
        ['ghcr.io/<owner>/superfield-starter-ts:latest'],
      );

      expect(imageMap['ghcr.io/<owner>/superfield-starter-ts:latest']).toBe('superfield-release:studio');
    });

    it('skips third-party bare images like postgres:16-alpine', async () => {
      const { buildImages } = await import('../image-builder');

      const imageMap = buildImages(
        { sourceDir: '/test', k8sDir: 'k8s', namespace: 'default', verbose: false },
        ['postgres:16-alpine'],
      );

      expect(imageMap['postgres:16-alpine']).toBeUndefined();
    });

    it('skips docker.io official images', async () => {
      const { buildImages } = await import('../image-builder');

      const imageMap = buildImages(
        { sourceDir: '/test', k8sDir: 'k8s', namespace: 'default', verbose: false },
        ['docker.io/library/nginx:latest'],
      );

      expect(imageMap['docker.io/library/nginx:latest']).toBeUndefined();
    });

    it('maps multiple product images to the same studio tag', async () => {
      const { buildImages } = await import('../image-builder');

      const imageMap = buildImages(
        { sourceDir: '/test', k8sDir: 'k8s', namespace: 'default', verbose: false },
        [
          'ghcr.io/myorg/superfield-starter-ts:latest',
          'ghcr.io/<owner>/superfield-starter-ts:v1.0',
          'postgres:16-alpine',
        ],
      );

      expect(imageMap['ghcr.io/myorg/superfield-starter-ts:latest']).toBe('superfield-release:studio');
      expect(imageMap['ghcr.io/<owner>/superfield-starter-ts:v1.0']).toBe('superfield-release:studio');
      expect(imageMap['postgres:16-alpine']).toBeUndefined();
    });
  });
});
