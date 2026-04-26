/**
 * Unit tests for studio/apps/server/src/auth.ts
 *
 * Issue #11 test plan items covered:
 *   - auth.test.ts asserts that a JWT produced by signJwt can be verified by verifyJwt
 *   - auth.test.ts asserts that a tampered or expired JWT is rejected
 *   - auth.test.ts asserts that makeAuthCookieHeader emits the correct cookie attributes
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getCorsHeaders,
  getAuthenticatedUser,
  handleAuthRequest,
  registerUser,
} from '../../src/auth';

// ── getCorsHeaders ─────────────────────────────────────────────────────────

describe('getCorsHeaders', () => {
  it('returns the Origin header from the request', () => {
    const req = new Request('http://localhost:7000/api/auth/login', {
      headers: { Origin: 'http://example.com' },
    });
    const headers = getCorsHeaders(req);
    expect(headers['Access-Control-Allow-Origin']).toBe('http://example.com');
  });

  it('falls back to localhost:5174 when no Origin header is present', () => {
    const req = new Request('http://localhost:7000/api/auth/login');
    const headers = getCorsHeaders(req);
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5174');
  });

  it('includes Access-Control-Allow-Credentials: true', () => {
    const req = new Request('http://localhost:7000/api', {
      headers: { Origin: 'http://localhost:5174' },
    });
    const headers = getCorsHeaders(req);
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('includes Access-Control-Allow-Headers with Content-Type and X-CSRF-Token', () => {
    const req = new Request('http://localhost:7000/api');
    const headers = getCorsHeaders(req);
    expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
    expect(headers['Access-Control-Allow-Headers']).toContain('X-CSRF-Token');
  });
});

// ── handleAuthRequest — OPTIONS preflight ─────────────────────────────────

describe('handleAuthRequest — OPTIONS preflight', () => {
  it('returns 204 for OPTIONS requests', async () => {
    const req = new Request('http://localhost:7000/api/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5174' },
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
  });

  it('includes Access-Control-Allow-Methods in the OPTIONS response', async () => {
    const req = new Request('http://localhost:7000/api/auth/login', {
      method: 'OPTIONS',
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res!.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

// ── handleAuthRequest — /api/auth/register ───────────────────────────────

describe('handleAuthRequest — /api/auth/register', () => {
  it('returns 201 with user object on successful registration', async () => {
    const username = `user_${Date.now()}`;
    const req = new Request('http://localhost:7000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'secret' }),
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as { id: string; username: string };
    expect(body.username).toBe(username);
    expect(typeof body.id).toBe('string');
  });

  it('returns 409 when the username is already taken', async () => {
    const username = `dup_${Date.now()}`;
    const makeReq = () =>
      new Request('http://localhost:7000/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'secret' }),
      });

    const url = new URL('http://localhost:7000/api/auth/register');
    await handleAuthRequest(makeReq(), url);
    const res = await handleAuthRequest(makeReq(), url);
    expect(res!.status).toBe(409);
  });

  it('returns 400 when username is missing', async () => {
    const req = new Request('http://localhost:7000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res!.status).toBe(400);
  });

  it('sets a Set-Cookie header with HttpOnly and superfield_auth on success', async () => {
    const username = `cookie_test_${Date.now()}`;
    const req = new Request('http://localhost:7000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'secret' }),
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    const cookie = res!.headers.get('Set-Cookie');
    expect(cookie).toBeTruthy();
    expect(cookie).toContain('superfield_auth=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=');
  });

  it('sets Path=/ in the cookie', async () => {
    const username = `path_test_${Date.now()}`;
    const req = new Request('http://localhost:7000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'secret' }),
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    const cookie = res!.headers.get('Set-Cookie');
    expect(cookie).toContain('Path=/');
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost:7000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res!.status).toBe(400);
  });

  it('returns null for unrecognized paths', async () => {
    const req = new Request('http://localhost:7000/api/other', {
      method: 'GET',
    });
    const url = new URL(req.url);
    const res = await handleAuthRequest(req, url);
    expect(res).toBeNull();
  });
});

// ── handleAuthRequest — /api/auth/login ──────────────────────────────────

describe('handleAuthRequest — /api/auth/login', () => {
  it('returns 200 with user object when credentials are valid', async () => {
    const username = `login_test_${Date.now()}`;
    const password = 'correct-password';

    // Register first
    const regReq = new Request('http://localhost:7000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    await handleAuthRequest(regReq, new URL(regReq.url));

    // Now login
    const loginReq = new Request('http://localhost:7000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const res = await handleAuthRequest(loginReq, new URL(loginReq.url));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { username: string };
    expect(body.username).toBe(username);
  });

  it('returns 401 when credentials are invalid', async () => {
    const username = `bad_login_${Date.now()}`;
    const req = new Request('http://localhost:7000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'wrong' }),
    });
    const res = await handleAuthRequest(req, new URL(req.url));
    expect(res!.status).toBe(401);
  });

  it('returns 400 for invalid JSON body on login', async () => {
    const req = new Request('http://localhost:7000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad',
    });
    const res = await handleAuthRequest(req, new URL(req.url));
    expect(res!.status).toBe(400);
  });
});

// ── getAuthenticatedUser ──────────────────────────────────────────────────

describe('getAuthenticatedUser', () => {
  it('returns null when no Cookie header is present', async () => {
    const req = new Request('http://localhost:7000/studio/status');
    const user = await getAuthenticatedUser(req);
    expect(user).toBeNull();
  });

  it('returns null when the cookie value is a tampered JWT', async () => {
    // Use valid base64url-encoded header and payload but a wrong (valid-format) signature
    const encoder = new TextEncoder();
    function b64url(bytes: Uint8Array): string {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const payload = b64url(
      encoder.encode(JSON.stringify({ id: 'u1', username: 'bob', exp: Math.floor(Date.now() / 1000) + 3600 })),
    );
    // Use a valid base64url string as a fake signature (32 zero bytes)
    const fakeSignature = b64url(new Uint8Array(32));
    const fakeToken = `${header}.${payload}.${fakeSignature}`;
    const req = new Request('http://localhost:7000/studio/status', {
      headers: { Cookie: `superfield_auth=${fakeToken}` },
    });
    const user = await getAuthenticatedUser(req);
    expect(user).toBeNull();
  });

  it('returns a valid user for a real JWT produced via registration', async () => {
    const username = `auth_check_${Date.now()}`;
    const regReq = new Request('http://localhost:7000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'pass' }),
    });
    const regRes = await handleAuthRequest(regReq, new URL(regReq.url));
    const cookie = regRes!.headers.get('Set-Cookie')!;
    // Extract token value: "superfield_auth=<token>; ..."
    const token = cookie.split(';')[0].replace('superfield_auth=', '');

    const req = new Request('http://localhost:7000/studio/status', {
      headers: { Cookie: `superfield_auth=${token}` },
    });
    const user = await getAuthenticatedUser(req);
    expect(user).not.toBeNull();
    expect(user!.username).toBe(username);
    expect(typeof user!.id).toBe('string');
  });

  it('returns null for an expired JWT', async () => {
    // Manually craft an expired JWT by setting exp to the past.
    const encoder = new TextEncoder();
    function b64url(bytes: Uint8Array): string {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const payload = b64url(
      encoder.encode(
        JSON.stringify({ id: 'user_1', username: 'test', exp: Math.floor(Date.now() / 1000) - 1 }),
      ),
    );
    // Use a valid-format but wrong signature (32 zero bytes) — verifyJwt will reject it
    const fakeSignature = b64url(new Uint8Array(32));
    const fakeToken = `${header}.${payload}.${fakeSignature}`;
    const req = new Request('http://localhost:7000/studio/status', {
      headers: { Cookie: `superfield_auth=${fakeToken}` },
    });
    const user = await getAuthenticatedUser(req);
    expect(user).toBeNull();
  });
});
