import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RETENTION_DAYS = 7;
const DEFAULT_LOG_DIR = path.join(os.homedir(), ".superfield", "logs");

/** Rotate chunk when file exceeds this size (10 MB). */
const MAX_CHUNK_BYTES = 10 * 1024 * 1024;
/** Rotate chunk when line count exceeds this value (100k lines). */
const MAX_CHUNK_LINES = 100_000;

let logDir: string | null = null;
let stream: fs.WriteStream | null = null;
let currentLogPath: string | null = null;
let chunkIndex = 0;
let linesWritten = 0;
let bytesWritten = 0;

/**
 * Initialises the file logger. Called once at startup by the CLI.
 * Creates the log directory if needed, deletes files older than
 * RETENTION_DAYS, and opens the first chunk of today's log file.
 *
 * Safe to call multiple times — subsequent calls re-open the file.
 */
export function initFileLogger(): void {
  logDir = resolveLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  pruneOldLogs(logDir);
  chunkIndex = nextChunkIndex(logDir);
  openChunk();
}

/** Writes a line to the log file with a timestamp prefix. No-op if not initialised. */
export function writeToLog(line: string): void {
  if (!stream || !logDir) return;
  const entry = `${new Date().toISOString()} ${line}\n`;
  stream.write(entry);
  linesWritten++;
  bytesWritten += entry.length;
  if (bytesWritten >= MAX_CHUNK_BYTES || linesWritten >= MAX_CHUNK_LINES) {
    chunkIndex++;
    linesWritten = 0;
    bytesWritten = 0;
    openChunk();
  }
}

/** Returns the current log file path, or null if not initialised. */
export function currentLogFile(): string | null {
  return currentLogPath;
}

function openChunk(): void {
  if (!logDir) return;
  if (stream) {
    stream.end();
    stream = null;
  }
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const suffix = chunkIndex === 0 ? "" : `.${chunkIndex}`;
  const logFile = path.join(logDir, `superfield-${today}${suffix}.log`);
  stream = fs.createWriteStream(logFile, { flags: "a" });
  currentLogPath = logFile;
}

/**
 * Find the highest existing chunk index for today so we continue
 * from where a previous run left off rather than overwriting.
 */
function nextChunkIndex(dir: string): number {
  const today = new Date().toISOString().slice(0, 10);
  let max = 0;
  try {
    for (const file of fs.readdirSync(dir)) {
      const base = `superfield-${today}`;
      if (!file.startsWith(base) || !file.endsWith(".log")) continue;
      const inner = file.slice(base.length, -4); // "" or ".N"
      if (inner === "") {
        max = Math.max(max, 0);
      } else {
        const n = parseInt(inner.slice(1), 10);
        if (!isNaN(n)) max = Math.max(max, n);
      }
    }
  } catch {
    // best effort
  }
  return max;
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
