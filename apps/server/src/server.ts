/**
 * Bun.serve()-based HTTP server. The constructor wires the storage layer
 * to a router and returns a handle the caller (CLI entry, tests) can
 * stop. The server itself owns nothing beyond the routing surface; the
 * Postgres connection is the caller's responsibility.
 */
import postgres from 'postgres';
import { registerRoutes } from './routes';
import { registerEpisodeRoutes } from './routes-episodes';
import { registerProjectionRoutes } from './routes-projections';
import { Router } from './router';
import { runMigrations } from './migrate';
import { verifyHashSafety } from './cas';
import { log } from './log';

export interface ServerOptions {
  dsn: string;
  port?: number;
  hostname?: string;
  migrate?: boolean;
  authDisabled?: boolean;
  allowRawSha1?: boolean;
}

export interface ServerHandle {
  port: number;
  url: string;
  sql: postgres.Sql;
  stop: () => Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  verifyHashSafety({ allowRawSha1: opts.allowRawSha1 ?? false });

  const sql = postgres(opts.dsn, { onnotice: () => {} });
  if (opts.migrate ?? true) {
    const result = await runMigrations(sql);
    if (result.applied.length > 0) {
      log.info('migrations_applied', { count: result.applied.length });
    }
  }

  const router = new Router(sql, { authDisabled: opts.authDisabled });
  registerRoutes(router);
  registerEpisodeRoutes(router);
  registerProjectionRoutes(router);

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? '127.0.0.1',
    fetch: (req) => router.dispatch(req),
  });

  const port = server.port ?? opts.port ?? 0;
  const url = `http://${server.hostname}:${port}`;
  log.info('server_started', { port, url });

  return {
    port,
    url,
    sql,
    stop: async () => {
      server.stop(true);
      await sql.end({ timeout: 2 });
    },
  };
}
