/**
 * Minimal radix-style router for Bun.serve().
 *
 * Pattern syntax:
 *   /literal           exact match
 *   /:param            single-segment capture
 *   /*rest             trailing wildcard, captures the remaining slash-
 *                      separated path verbatim (used for ref names like
 *                      refs/heads/main where slashes are part of the name)
 *
 * Routes carry an optional `scope` requirement. The dispatcher applies
 * authentication before invoking the handler and returns 401 / 403 when
 * the token is missing or under-scoped.
 */
import type postgres from 'postgres';
import { lookupPrincipal, parseAuthHeader, scopeAllows, type Principal, type Scope } from './auth';
import { log, type Logger } from './log';

export type Method = 'GET' | 'PUT' | 'POST' | 'HEAD' | 'DELETE';

export interface RouteContext {
  params: Record<string, string>;
  principal?: Principal;
  sql: postgres.Sql;
  log: Logger;
  /** The matched URL pathname (after host); useful for logging. */
  path: string;
}

export type Handler = (req: Request, ctx: RouteContext) => Promise<Response> | Response;

export interface Route {
  method: Method;
  pattern: string;
  scope?: Scope;
  /** When true, the handler is invoked even when no token is presented. Used by /healthz. */
  noAuth?: boolean;
  handler: Handler;
}

interface CompiledSegment {
  kind: 'literal' | 'param' | 'rest';
  value: string;
}

interface CompiledRoute extends Route {
  segments: CompiledSegment[];
}

function compile(pattern: string): CompiledSegment[] {
  if (pattern[0] !== '/') throw new Error(`pattern must start with /: ${pattern}`);
  if (pattern === '/') return [];
  return pattern
    .slice(1)
    .split('/')
    .map((seg): CompiledSegment => {
      if (seg.startsWith(':')) return { kind: 'param', value: seg.slice(1) };
      if (seg.startsWith('*')) return { kind: 'rest', value: seg.slice(1) };
      return { kind: 'literal', value: seg };
    });
}

function matchSegments(
  segments: readonly CompiledSegment[],
  pathSegments: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.kind === 'rest') {
      params[s.value] = pathSegments.slice(i).join('/');
      return params;
    }
    const p = pathSegments[i];
    if (p === undefined) return undefined;
    if (s.kind === 'literal') {
      if (s.value !== p) return undefined;
    } else {
      params[s.value] = decodeURIComponent(p);
    }
  }
  if (pathSegments.length !== segments.length) return undefined;
  return params;
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  constructor(
    private readonly sql: postgres.Sql,
    private readonly opts: { authDisabled?: boolean } = {},
  ) {}

  add(route: Route): this {
    this.routes.push({ ...route, segments: compile(route.pattern) });
    return this;
  }

  async dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathSegments = url.pathname === '/' ? [] : url.pathname.slice(1).split('/');
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
    const reqLog = log.child({ request_id: requestId, method: req.method, path: url.pathname });

    for (const route of this.routes) {
      if (route.method !== req.method && !(req.method === 'HEAD' && route.method === 'GET')) {
        continue;
      }
      const params = matchSegments(route.segments, pathSegments);
      if (!params) continue;

      const start = performance.now();
      try {
        let principal: Principal | undefined;
        if (!route.noAuth && !this.opts.authDisabled) {
          const token = parseAuthHeader(req.headers.get('authorization'));
          if (!token) return jsonError(401, 'unauthorized', 'missing bearer token');
          principal = await lookupPrincipal(this.sql, token);
          if (!principal) return jsonError(401, 'unauthorized', 'invalid token');
          if (route.scope && !scopeAllows(principal.scope, route.scope)) {
            return jsonError(403, 'forbidden', `scope ${route.scope} required`);
          }
        }

        const ctx: RouteContext = {
          params,
          principal,
          sql: this.sql,
          log: reqLog.child({ principal: principal?.principal, scope: principal?.scope }),
          path: url.pathname,
        };
        const response = await route.handler(req, ctx);
        reqLog.info('request', {
          status: response.status,
          latency_ms: Math.round(performance.now() - start),
        });
        return response;
      } catch (e) {
        reqLog.error('request_failed', {
          error: (e as Error).message,
          stack: (e as Error).stack,
          latency_ms: Math.round(performance.now() - start),
        });
        return jsonError(500, 'internal_error', 'see server logs');
      }
    }

    return jsonError(404, 'not_found', `no route for ${req.method} ${url.pathname}`);
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  return jsonResponse(status, body);
}
