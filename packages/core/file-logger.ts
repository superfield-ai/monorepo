import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RETENTION_DAYS = 7;
const DEFAULT_LOG_DIR = path.join(os.homedir(), ".superfield", "logs");

let stream: fs.WriteStream | null = null;
let currentLogPath: string | null = null;

/**
 * Initialises the file logger. Called once at startup by the CLI.
 * Creates the log directory if needed, deletes files older than
 * RETENTION_DAYS, and opens today's log file for appending.
 *
 * Safe to call multiple times — subsequent calls re-open the file.
 */
export function initFileLogger(): void {
  const dir = resolveLogDir();
  fs.mkdirSync(dir, { recursive: true });
  pruneOldLogs(dir);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = path.join(dir, `superfield-${today}.log`);
  if (stream) {
    stream.end();
    stream = null;
  }
  stream = fs.createWriteStream(logFile, { flags: "a" });
  currentLogPath = logFile;
}

/** Writes a line to the log file with a timestamp prefix. No-op if not initialised. */
export function writeToLog(line: string): void {
  if (!stream) return;
  stream.write(`${new Date().toISOString()} ${line}\n`);
}

/** Returns the current log file path, or null if not initialised. */
export function currentLogFile(): string | null {
  return currentLogPath;
}

/**
 * Resolves the log directory for this session.
 *
 * Priority:
 *   1. SUPERFIELD_LOG_DIR env var — explicit override, always respected.
 *   2. SUPERFIELD_DEV=1 — dev/debug run via `bun run start`; use a fresh
 *      randomized temp dir so debug sessions never touch ~/.superfield.
 *   3. Default: ~/.superfield/logs
 */
function resolveLogDir(): string {
  const explicit = process.env.SUPERFIELD_LOG_DIR?.trim();
  if (explicit) return explicit;
  if (process.env.SUPERFIELD_DEV === "1") {
    return fs.mkdtempSync(path.join(os.tmpdir(), "superfield-"));
  }
  return DEFAULT_LOG_DIR;
}

function pruneOldLogs(dir: string): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith("superfield-") || !file.endsWith(".log")) continue;
      const filePath = path.join(dir, file);
      try {
        const { mtimeMs } = fs.statSync(filePath);
        if (mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch {
        // skip files we can't stat or delete
      }
    }
  } catch {
    // best effort — don't crash startup if log dir is unreadable
  }
}
