import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JSONFilePreset } from "lowdb/node";

/**
 * Local Superfield issue storage.
 *
 * The embedded DB is the source of truth for feature issue state, subtasks,
 * and sync metadata. GitHub issues are projections generated from these local
 * records.
 */

export interface MigrateOptions {
  databaseUrl?: string;
}

export interface IssueTaskItem {
  title: string;
  done: boolean;
}

export interface LocalIssueRecord {
  repo: string;
  number: number;
  title: string;
  body: string;
  status: "draft" | "open" | "in_progress" | "blocked" | "done";
  acceptance: IssueTaskItem[];
  testPlan: IssueTaskItem[];
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  prNumber?: number;
  prUrl?: string;
  syncedAt?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface LocalIssueDb {
  version: 1;
  updatedAt: string;
  issues: LocalIssueRecord[];
}

export interface LocalIssueStore {
  getAll(): Promise<LocalIssueRecord[]>;
  get(number: number): Promise<LocalIssueRecord | undefined>;
  upsert(issue: LocalIssueRecord): Promise<void>;
  patch(
    number: number,
    updater: (issue: LocalIssueRecord) => LocalIssueRecord,
  ): Promise<LocalIssueRecord | undefined>;
  remove(number: number): Promise<void>;
  replaceAll(issues: readonly LocalIssueRecord[]): Promise<void>;
  snapshot(): Promise<LocalIssueDb>;
}

export function resolveIssueDbPath(repoRoot = process.cwd()): string {
  return resolve(repoRoot, ".superfield", "issues.json");
}

export interface ClaudeSessionDb {
  version: 1;
  updatedAt: string;
  sessionId: string | null;
}

export interface ClaudeSessionStore {
  getSessionId(): Promise<string | null>;
  setSessionId(sessionId: string): Promise<void>;
  clearSessionId(): Promise<void>;
  snapshot(): Promise<ClaudeSessionDb>;
}

export function resolveClaudeSessionDbPath(
  baseDir = process.env.CONTROL_LOG_DIR ?? "../studio-logs",
): string {
  return resolve(baseDir, "claude-session.json");
}

function createDefaultIssueDb(): LocalIssueDb {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    issues: [],
  };
}

/**
 * Open the embedded local issue store.
 *
 * lowdb gives us a small file-backed object store with typed reads/writes and
 * no server dependency, which is enough for the first pass of Studio issue
 * state.
 */
export async function openIssueStore(
  filePath = resolveIssueDbPath(),
): Promise<LocalIssueStore> {
  await mkdir(dirname(filePath), { recursive: true });
  const db = await JSONFilePreset<LocalIssueDb>(
    filePath,
    createDefaultIssueDb(),
  );

  return {
    async getAll() {
      return [...db.data.issues];
    },
    async get(number) {
      return db.data.issues.find((issue) => issue.number === number);
    },
    async upsert(issue) {
      const updatedAt = new Date().toISOString();
      await db.update((data) => {
        const index = data.issues.findIndex(
          (entry) => entry.number === issue.number,
        );
        const next = { ...issue, updatedAt };
        if (index === -1) {
          data.issues.push(next);
        } else {
          data.issues[index] = next;
        }
        data.updatedAt = updatedAt;
      });
    },
    async patch(number, updater) {
      let nextIssue: LocalIssueRecord | undefined;
      const updatedAt = new Date().toISOString();
      await db.update((data) => {
        const index = data.issues.findIndex((issue) => issue.number === number);
        if (index === -1) return;
        const current = data.issues[index];
        if (!current) return;
        nextIssue = { ...updater({ ...current }), updatedAt };
        data.issues[index] = nextIssue;
        data.updatedAt = updatedAt;
      });
      return nextIssue;
    },
    async remove(number) {
      await db.update((data) => {
        data.issues = data.issues.filter((issue) => issue.number !== number);
        data.updatedAt = new Date().toISOString();
      });
    },
    async replaceAll(issues) {
      const updatedAt = new Date().toISOString();
      await db.update((data) => {
        data.issues = issues.map((issue) => ({ ...issue, updatedAt }));
        data.updatedAt = updatedAt;
      });
    },
    async snapshot() {
      return {
        version: db.data.version,
        updatedAt: db.data.updatedAt,
        issues: [...db.data.issues],
      };
    },
  };
}

function createDefaultClaudeSessionDb(): ClaudeSessionDb {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    sessionId: null,
  };
}

/**
 * Open the embedded Claude session store.
 *
 * The server keeps the active Claude session id here so the first turn starts
 * a fresh Claude conversation, subsequent turns can resume it, and reset can
 * clear the stored id.
 */
export async function openClaudeSessionStore(
  filePath = resolveClaudeSessionDbPath(),
): Promise<ClaudeSessionStore> {
  await mkdir(dirname(filePath), { recursive: true });
  const db = await JSONFilePreset<ClaudeSessionDb>(
    filePath,
    createDefaultClaudeSessionDb(),
  );

  return {
    async getSessionId() {
      return db.data.sessionId;
    },
    async setSessionId(sessionId) {
      const updatedAt = new Date().toISOString();
      await db.update((data) => {
        data.sessionId = sessionId;
        data.updatedAt = updatedAt;
      });
    },
    async clearSessionId() {
      const updatedAt = new Date().toISOString();
      await db.update((data) => {
        data.sessionId = null;
        data.updatedAt = updatedAt;
      });
    },
    async snapshot() {
      return {
        version: db.data.version,
        updatedAt: db.data.updatedAt,
        sessionId: db.data.sessionId,
      };
    },
  };
}

/**
 * Compatibility shim retained for bootstrap callers that still expect a
 * migrate step.
 */
export async function migrate(_opts?: MigrateOptions): Promise<void> {
  // The embedded issue store initializes itself on demand.
}
