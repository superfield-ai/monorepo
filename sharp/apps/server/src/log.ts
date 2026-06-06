/**
 * Structured JSON logger. Writes one record per call to stdout.
 *
 * Fields are flat — no nesting beyond `meta` — so log aggregators can
 * filter without parsing nested JSON. Request-scoped context (request id,
 * route, repo) is folded in by the middleware that creates a child logger.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function readLevel(): LogLevel {
  const raw = process.env.SHARP_LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

const minLevel = LEVELS[readLevel()];

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

function createLogger(context: Record<string, unknown> = {}): Logger {
  function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < minLevel) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      message,
      ...context,
      ...(meta ?? {}),
    };
    process.stdout.write(JSON.stringify(record) + '\n');
  }
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}

export const log = createLogger();
