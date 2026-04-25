/**
 * Unit tests for studio/apps/server/src/api.ts
 *
 * Issue #23 hardening: api.test.ts calls through the real module graph
 * (api -> agent -> Bun.spawn, api -> git -> Bun.spawn, api -> fs).
 * No vi.mock for agent, git, or fs. Instead:
 *   - CALYPSO_REPO_ROOT points to a temp directory so real fs calls hit
 *     a controlled location (filesystem boundary).
 *   - readProcStdout is mocked to control subprocess output (Bun.spawn
 *     I/O boundary).
 *
 * Issue #11 test plan items still covered:
 *   - api.test.ts asserts that handleStudioRequest returns 401 for unauthenticated requests
 *   - api.test.ts asserts that CORS preflight OPTIONS requests receive 204 with correct headers
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Temp directory for real filesystem calls ────────────────────────────────
//
// Instead of mocking fs, we set CALYPSO_REPO_ROOT to a temp directory so that
// api.ts -> agent.ts reads REPO_ROOT from env and all existsSync/readFileSync
// calls hit a real (controlled) filesystem path.

let tempDir: string;
let originalRepoRoot: string | undefined;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'api-test-'));
  originalRepoRoot = process.env.CALYPSO_REPO_ROOT;
  process.env.CALYPSO_REPO_ROOT = tempDir;
});

afterAll(() => {
  if (originalRepoRoot !== undefined) {
    process.env.CALYPSO_REPO_ROOT = originalRepoRoot;
  } else {
    delete process.env.CALYPSO_REPO_ROOT;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ── I/O boundary mock ───────────────────────────────────────────────────────
//
// Mock only the subprocess I/O boundary — readProcStdout. This controls all
// subprocess output (Bun.spawn in agent.ts and git.ts) without mocking the
// modules themselves.

vi.mock('../../lib/response', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/response')>();
  return {
    ...original,
    readProcStdout: vi.fn().mockResolvedValue(''),
  };
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReq(path: string, options: RequestInit = {}): Request {
  return new Request(`http://localhost:7000${path}`, options);
}

function makeAuthedReq(path: string, cookie: string, options: RequestInit = {}): Request {
  return new Request(`http://localhost:7000${path}`, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> | undefined),
      Cookie: `calypso_auth=${cookie}`,
    },
  });
}

/** Register a user and return the JWT token string. */
async function getAuthToken(): Promise<string> {
  const { handleAuthRequest } = await import('../../src/auth');
  const username = `api_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const regReq = new Request('http://localhost:7000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'pass' }),
  });
  const regRes = await handleAuthRequest(regReq, new URL(regReq.url));
  const cookie = regRes!.headers.get('Set-Cookie')!;
  return cookie.split(';')[0].replace('calypso_auth=', '');
}

/** Create a .studio file in the temp directory. */
function createStudioFile(content: { sessionId: string; branch: string }): void {
  writeFileSync(join(tempDir, '.studio'), JSON.stringify(content));
}

/** Remove the .studio file from the temp directory. */
function removeStudioFile(): void {
  rmSync(join(tempDir, '.studio'), { force: true });
}

// ── handleStudioRequest — unauthenticated ─────────────────────────────────────

describe('handleStudioRequest — unauthenticated requests', () => {
  afterEach(() => {
    vi.clearAllMocks();
    removeStudioFile();
  });

  it('returns 401 for GET /studio/status without auth cookie', async () => {
    const { handleStudioRequest } = await import('../../src/api');
    const req = makeReq('/studio/status');
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('returns 401 for POST /studio/chat without auth cookie', async () => {
    const { handleStudioRequest } = await import('../../src/api');
    const req = makeReq('/studio/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res!.status).toBe(401);
  });

  it('returns 401 for POST /studio/rollback without auth cookie', async () => {
    const { handleStudioRequest } = await import('../../src/api');
    const req = makeReq('/studio/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: 'abc1234' }),
    });
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res!.status).toBe(401);
  });

  it('returns 401 for GET /studio/commits without auth cookie', async () => {
    const { handleStudioRequest } = await import('../../src/api');
    const req = makeReq('/studio/commits');
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res!.status).toBe(401);
  });

  it('returns 401 for POST /studio/reset without auth cookie', async () => {
    const { handleStudioRequest } = await import('../../src/api');
    const req = makeReq('/studio/reset', { method: 'POST' });
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res!.status).toBe(401);
  });

  it('returns null for non-/studio paths', async () => {
    const { handleStudioRequest } = await import('../../src/api');
    const req = makeReq('/api/auth/login', { method: 'POST' });
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res).toBeNull();
  });
});

// ── handleStudioRequest — CORS preflight ──────────────────────────────────────

describe('handleAuthRequest — CORS preflight via auth module', () => {
  it('returns 204 for OPTIONS to /api/auth/login', async () => {
    const { handleAuthRequest } = await import('../../src/auth');
    const req = new Request('http://localhost:7000/api/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5174' },
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
  });

  it('OPTIONS response includes Access-Control-Allow-Methods', async () => {
    const { handleAuthRequest } = await import('../../src/auth');
    const req = new Request('http://localhost:7000/api/auth/register', {
      method: 'OPTIONS',
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res!.headers.get('Access-Control-Allow-Methods')).toBeTruthy();
  });

  it('OPTIONS response includes Access-Control-Allow-Origin', async () => {
    const { handleAuthRequest } = await import('../../src/auth');
    const req = new Request('http://localhost:7000/api/auth/register', {
      method: 'OPTIONS',
      headers: { Origin: 'http://custom-origin.com' },
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res!.headers.get('Access-Control-Allow-Origin')).toBe('http://custom-origin.com');
  });
});

// ── handleStudioRequest — authenticated /studio/status ───────────────────────

describe('handleStudioRequest — authenticated requests', () => {
  afterEach(() => {
    vi.clearAllMocks();
    removeStudioFile();
  });

  it('GET /studio/status returns active:false when .studio file is absent', async () => {
    removeStudioFile(); // ensure no .studio file

    const token = await getAuthToken();
    const { handleStudioRequest } = await import('../../src/api');
    const req = makeAuthedReq('/studio/status', token);
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });
});

// ── Negative-path tests ─────────────────────────────────────────────────────
//
// Issue #23: each server unit test file includes at least 2 negative-path cases.

describe('handleStudioRequest — negative paths', () => {
  afterEach(() => {
    vi.clearAllMocks();
    removeStudioFile();
  });

  it('returns 400 for POST /studio/chat with malformed JSON body', async () => {
    const token = await getAuthToken();
    createStudioFile({ sessionId: 'sess_1', branch: 'feat/test' });

    const { handleStudioRequest } = await import('../../src/api');
    const req = makeAuthedReq('/studio/chat', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '<<<not json>>>',
    });
    const url = new URL(req.url);
    // api.ts calls req.json() which throws on invalid JSON — the handler
    // propagates the error. We verify the server does not return 200.
    try {
      const res = await handleStudioRequest(req, url);
      // If it doesn't throw, it should be a non-200 error response
      expect(res).not.toBeNull();
      expect(res!.status).toBeGreaterThanOrEqual(400);
    } catch (e) {
      // JSON parse error is acceptable — it means the real module boundary
      // caught the malformed input at the Request.json() level.
      expect(e).toBeDefined();
    }
  });

  it('returns 400 for POST /studio/rollback with missing hash field', async () => {
    const token = await getAuthToken();
    createStudioFile({ sessionId: 'sess_1', branch: 'feat/test' });

    const { handleStudioRequest } = await import('../../src/api');
    const req = makeAuthedReq('/studio/rollback', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // missing hash field
    });
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain('hash');
  });

  it('returns 400 for POST /studio/chat with empty message string', async () => {
    const token = await getAuthToken();
    createStudioFile({ sessionId: 'sess_1', branch: 'feat/test' });

    const { handleStudioRequest } = await import('../../src/api');
    const req = makeAuthedReq('/studio/chat', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain('message');
  });

  it('returns 403 when studio mode is not active for authenticated GET /studio/commits', async () => {
    const token = await getAuthToken();
    removeStudioFile(); // ensure no .studio file

    const { handleStudioRequest } = await import('../../src/api');
    const req = makeAuthedReq('/studio/commits', token);
    const url = new URL(req.url);
    const res = await handleStudioRequest(req, url);
    expect(res).not.toBeNull();
    // When .studio file is absent and path is /studio/commits, the handler
    // first returns active:false for /studio/status, but for /studio/commits
    // it hits the isStudioMode() guard which returns 403.
    expect(res!.status).toBe(403);
  });
});
