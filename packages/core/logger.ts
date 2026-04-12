import { writeToLog } from "./file-logger.ts";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export function resolveLogLevel(): LogLevel {
  const raw = (
    process.env.SUPERFIELD_LOG_LEVEL ??
    process.env.LOG_LEVEL ??
    "info"
  )
    .trim()
    .toLowerCase();
  if (
    raw === "error" ||
    raw === "warn" ||
    raw === "info" ||
    raw === "debug" ||
    raw === "trace"
  ) {
    return raw;
  }
  console.warn(
    `[warn] Ignoring invalid SUPERFIELD_LOG_LEVEL=${JSON.stringify(
      process.env.SUPERFIELD_LOG_LEVEL ?? process.env.LOG_LEVEL,
    )}; using "info"`,
  );
  return "info";
}

export interface Logger {
  emit: (level: LogLevel, message: string) => void;
  currentLevel: LogLevel;
}

export function makeLogger(scope: string): Logger {
  const currentLevel = resolveLogLevel();
  return {
    currentLevel,
    emit: (level, message) => {
      const line = `[${level}] ${scope} ${message}`;
      writeToLog(line);
      if (level === "error") {
        console.error(line);
        return;
      }
      if (level === "warn") {
        console.warn(line);
        return;
      }
      if (LOG_LEVEL_RANK[level] <= LOG_LEVEL_RANK[currentLevel]) {
        console.log(line);
      }
    },
  };
}
