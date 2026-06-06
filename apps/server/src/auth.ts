/**
 * @file auth.ts
 *
 * Standalone authentication module for the Studio Server.
 *
 * Provides lightweight JWT-based session auth and CORS helpers for studio
 * routes. Uses an in-memory user store — suitable for development and
 * integration tests where a persistent user database is not required.
 *
 * For production studio deployments, replace the in-memory store with a
 * persistent backend and harden password hashing per the security policy.
 */

// ── Key generation ──────────────────────────────────────────────────────────

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Module-level HMAC key, generated once at startup. */
let _hmacKey: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
  if (_hmacKey) return _hmacKey;
  const secret = process.env.JWT_SECRET ?? 'studio-dev-secret';
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  _hmacKey = keyMaterial;
  return keyMaterial;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── JWT helpers ─────────────────────────────────────────────────────────────

const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = base64UrlEncode(ENCODER.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(
    ENCODER.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS })),
  );
  const key = await getHmacKey();
  const sigBytes = await crypto.subtle.sign('HMAC', key, ENCODER.encode(`${header}.${body}`));
  const sig = base64UrlEncode(new Uint8Array(sigBytes));
  return `${header}.${body}.${sig}`;
}

async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await getHmacKey();
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlDecode(sig),
    ENCODER.encode(`${header}.${body}`),
  );
  if (!valid) return null;
  try {
    const payload = JSON.parse(DECODER.decode(base64UrlDecode(body))) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── In-memory user store ────────────────────────────────────────────────────

interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
}

const users = new Map<string, UserRecord>();
let _userIdCounter = 0;

async function hashPassword(password: string): Promise<string> {
  const key = await getHmacKey();
  const sigBytes = await crypto.subtle.sign('HMAC', key, ENCODER.encode(password));
  return base64UrlEncode(new Uint8Array(sigBytes));
}

export async function registerUser(
  username: string,
  password: string,
): Promise<{ id: string; username: string } | null> {
  if (users.has(username)) return null; // already exists
  const id = `user_${++_userIdCounter}`;
  const passwordHash = await hashPassword(password);
  users.set(username, { id, username, passwordHash });
  return { id, username };
}

async function authenticateUser(
  username: string,
  password: string,
): Promise<{ id: string; username: string } | null> {
  const record = users.get(username);
  if (!record) return null;
  const passwordHash = await hashPassword(password);
  if (record.passwordHash !== passwordHash) return null;
  return { id: record.id, username: record.username };
}

// ── Cookie helpers ──────────────────────────────────────────────────────────

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const cookie of cookieHeader.split(';')) {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
  return cookies;
}

const COOKIE_NAME = 'calypso_auth';
// Cookie and JWT share the same lifetime so they expire together.
const COOKIE_MAX_AGE = JWT_EXPIRY_SECONDS;

function makeAuthCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns CORS headers for the given request.
 */
export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? 'http://localhost:5174';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
  };
}

/**
 * Reads the session cookie from the request, verifies the JWT, and returns
 * the authenticated user. Returns `null` if the request is unauthenticated.
 */
export async function getAuthenticatedUser(
  req: Request,
): Promise<{ id: string; username: string } | null> {
  const cookies = parseCookies(req.headers.get('Cookie'));
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const payload = await verifyJwt(token);
  if (!payload) return null;
  if (typeof payload.id !== 'string' || typeof payload.username !== 'string') return null;
  return { id: payload.id, username: payload.username };
}

/**
 * Handles `/api/auth/register` and `/api/auth/login` requests.
 * Returns `null` for unrecognized paths so callers can chain handlers.
 */
export async function handleAuthRequest(req: Request, url: URL): Promise<Response | null> {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
    });
  }

  // POST /api/auth/register
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    let username: string;
    let password: string;
    try {
      const body = (await req.json()) as { username?: string; password?: string };
      username = (body.username ?? '').trim();
      password = body.password ?? '';
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!username || !password) {
      return new Response(JSON.stringify({ error: 'username and password required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const user = await registerUser(username, password);
    if (!user) {
      return new Response(JSON.stringify({ error: 'username already taken' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = await signJwt({ id: user.id, username: user.username });
    return new Response(JSON.stringify({ id: user.id, username: user.username }), {
      status: 201,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Set-Cookie': makeAuthCookieHeader(token),
      },
    });
  }

  // POST /api/auth/login
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    let username: string;
    let password: string;
    try {
      const body = (await req.json()) as { username?: string; password?: string };
      username = (body.username ?? '').trim();
      password = body.password ?? '';
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = await signJwt({ id: user.id, username: user.username });
    return new Response(JSON.stringify({ id: user.id, username: user.username }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Set-Cookie': makeAuthCookieHeader(token),
      },
    });
  }

  return null;
}
