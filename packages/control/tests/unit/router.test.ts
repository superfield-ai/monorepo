/**
 * Unit tests for studio/apps/server/src/router.ts
 *
 * Issue #164 test plan items covered:
 *   - Unit test: route matching serves static assets on /*, proxies /app/ and /api/
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONFIG = {
  port: 7000,
  logDir: '../studio-logs',
  clusterContext: 'default',
  openBrowser: false,
  webServiceUrl: 'http://127.0.0.1:8080',
  apiServiceUrl: 'http://127.0.0.1:31415',
  assetsDir: undefined as string | undefined,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(path: string, method = 'GET'): Request {
  return new Request(`http://localhost:7000${path}`, { method });
}

// ── proxyRequest ──────────────────────────────────────────────────────────────

describe('proxyRequest', () => {
  it('strips /app prefix and forwards to webServiceUrl', async () => {
    const { proxyRequest } = await import('../../src/router');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('upstream-body', { status: 200 }));

    const req = makeReq('/app/dashboard');
    const url = new URL(req.url);
    await proxyRequest(req, url, 'http://127.0.0.1:8080', '/app');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/dashboard',
      expect.objectContaining({ method: 'GET' }),
    );

    fetchSpy.mockRestore();
  });

  it('forwards /api/* to apiServiceUrl keeping the full path', async () => {
    const { proxyRequest } = await import('../../src/router');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const req = makeReq('/api/auth/login', 'POST');
    const url = new URL(req.url);
    await proxyRequest(req, url, 'http://127.0.0.1:31415', '');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:31415/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );

    fetchSpy.mockRestore();
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const { proxyRequest } = await import('../../src/router');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const req = makeReq('/app/broken');
    const url = new URL(req.url);
    const res = await proxyRequest(req, url, 'http://127.0.0.1:8080', '/app');

    expect(res.status).toBe(502);

    fetchSpy.mockRestore();
  });

  it('preserves the upstream response status code', async () => {
    const { proxyRequest } = await import('../../src/router');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const req = makeReq('/app/missing');
    const url = new URL(req.url);
    const res = await proxyRequest(req, url, 'http://127.0.0.1:8080', '/app');

    expect(res.status).toBe(404);

    vi.restoreAllMocks();
  });

  it('preserves the upstream query string', async () => {
    const { proxyRequest } = await import('../../src/router');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const req = makeReq('/app/search?q=hello&page=2');
    const url = new URL(req.url);
    await proxyRequest(req, url, 'http://127.0.0.1:8080', '/app');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/search?q=hello&page=2',
      expect.anything(),
    );

    fetchSpy.mockRestore();
  });
});

// ── serveStaticAsset ──────────────────────────────────────────────────────────

describe('serveStaticAsset', () => {
  it('returns a placeholder 200 when assetsDir is not configured', async () => {
    const { serveStaticAsset } = await import('../../src/router');

    const res = await serveStaticAsset('/', undefined);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Studio Server');
  });
});

// ── route ─────────────────────────────────────────────────────────────────────

describe('route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes /app/* to the web service proxy', async () => {
    const { route } = await import('../../src/router');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('app-body', { status: 200 }));

    const req = makeReq('/app/home');
    const res = await route(req, BASE_CONFIG);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:8080/home'),
      expect.anything(),
    );
    expect(res.status).toBe(200);
  });

  it('routes /api/* to the api service proxy', async () => {
    const { route } = await import('../../src/router');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const req = makeReq('/api/healthz');
    const res = await route(req, BASE_CONFIG);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:31415/api/healthz'),
      expect.anything(),
    );
    expect(res.status).toBe(200);
  });

  it('serves static assets on /* when no assetsDir is configured', async () => {
    const { route } = await import('../../src/router');

    const req = makeReq('/');
    const res = await route(req, { ...BASE_CONFIG, assetsDir: undefined });

    // Placeholder HTML returned when assetsDir is not configured.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Studio Server');
  });

  it('routes /app exactly (no trailing slash) to the web service', async () => {
    const { route } = await import('../../src/router');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const req = makeReq('/app');
    await route(req, BASE_CONFIG);

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('routes POST /studio/rebuild to the rebuild endpoint', async () => {
    // Mock the image-builder module so we don't actually run docker build.
    vi.doMock('../../../../packages/core/image-builder', () => ({
      rebuildAndRestart: vi.fn(),
    }));

    const { route } = await import('../../src/router');

    const req = makeReq('/studio/rebuild', 'POST');
    const res = await route(req, { ...BASE_CONFIG, verbose: false });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain('Rebuild');

    vi.doUnmock('../../../../packages/core/image-builder');
  });
});
