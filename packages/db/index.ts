import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JSONFilePreset } from "lowdb/node";

/**
 * Local Superfield issue storage.
 *
 * The embedded DB is the source of truth for feature issue state, subtasks,
 * and sync metadata. GitHub issues are projections generated from these local
 * records.
 *
 * ## Workspace isolation
 *
 * Every record carries a `workspaceId` that identifies the owning workspace.
 * Writes without a workspace context are rejected at the store layer. This is
 * the prerequisite for row-level security (RLS) when we graduate to a
 * server-side store.
 *
 * Use `openWorkspaceIssueStore(filePath, workspaceId)` to get a workspace-
 * scoped store. Writes from that store automatically stamp the given
 * `workspaceId` and reject records belonging to a different workspace. Use
 * `migrateWorkspaceColumn(store, defaultWorkspaceId)` once to backfill
 * existing rows that pre-date workspace support.
 */

/**
 * Governed embedding standard for all Superfield stores.
 *
 * All vector columns across every store must declare `vector(384)` and use
 * vectors produced by this model. No other embedding model or dimensionality
 * is permitted without a superseding architecture decision.
 *
 * @see docs/architecture.md §Governed Embedding Standard (closes #360)
 */
export const GOVERNED_EMBEDDING = {
  model: "Xenova/all-MiniLM-L6-v2" as const,
  dimensions: 384 as const,
  distanceFunction: "cosine" as const,
  indexType: "hnsw" as const,
} as const;

export type GovernedEmbeddingModel = typeof GOVERNED_EMBEDDING.model;

/**
 * Proposed Rust workspace crate boundaries for the single-binary migration.
 *
 * Each entry names a Cargo crate and the shared concern it will own once the
 * Rust workspace absorbs Sharp, Nexum, FastEnv, and the CLI orchestration
 * core.  This stub documents the target layout so that downstream feature
 * issues can reference concrete crate names when writing seams.
 *
 * The `db` crate listed here owns:
 *  - The unified migration runner (versioned SQL, `schema_migrations` table,
 *    transactions — modelled on Sharp's existing runner)
 *  - One `PgPool` shared across all component crates
 *  - `CREATE SCHEMA IF NOT EXISTS <component>` as the first migration step
 *
 * @see docs/scout/387-existing-service-runtimes-and-shared-boundaries.md
 */
export interface RustWorkspaceCrate {
  /** Cargo crate name inside the workspace. */
  name: string;
  /** The shared concern this crate owns. */
  concern: string;
  /** PostgreSQL schema this crate owns (undefined for non-DB crates). */
  pgSchema?: string;
}

/**
 * Target Rust workspace crate plan (issue #387 scout).
 *
 * Not used at runtime — acts as a typed anchor so the scout findings are
 * reachable from TypeScript tooling and doc generators.
 *
 * @see docs/scout/387-existing-service-runtimes-and-shared-boundaries.md
 */
export const RUST_WORKSPACE_PLAN: readonly RustWorkspaceCrate[] = [
  {
    name: "db",
    concern: "unified migration runner + connection pool",
    pgSchema: undefined,
  },
  {
    name: "config",
    concern: "config file read/write, env overlay, SUPERFIELD_DEV flag",
    pgSchema: undefined,
  },
  {
    name: "auth",
    concern: "sessions, oauth_tokens, app_installations",
    pgSchema: "auth",
  },
  {
    name: "embeddings",
    concern: "Xenova/all-MiniLM-L6-v2 ONNX inference (384-dim cosine)",
    pgSchema: undefined,
  },
  {
    name: "sharp",
    concern: "agent-native VCS: repos, objects, refs, commits, projections",
    pgSchema: "sharp",
  },
  {
    name: "nexum",
    concern: "knowledge graph: corpora, documents, blocks, links",
    pgSchema: "nexum",
  },
  {
    name: "episodes",
    concern: "orchestrator behavioral traces",
    pgSchema: "episodes",
  },
  {
    name: "fastenv",
    concern: "OCI copy-on-write workspace forking (containerd overlayfs)",
    pgSchema: undefined,
  },
  {
    name: "api",
    concern: "HTTP API server replacing Node http servers in Sharp and Nexum",
    pgSchema: undefined,
  },
  {
    name: "cli",
    concern: "Clap entrypoint, command dispatch, feature flags",
    pgSchema: undefined,
  },
] as const;

export interface MigrateOptions {
  databaseUrl?: string;
}

export interface IssueTaskItem {
  title: string;
  done: boolean;
}

export interface LocalIssueRecord {
  /** Workspace (tenant) that owns this record. Required; never null. */
  workspaceId: string;
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

/**
 * A workspace-scoped view of the issue store.
 *
 * All writes are automatically stamped with the bound `workspaceId`. Attempts
 * to upsert a record whose `workspaceId` does not match the bound workspace
 * throw `WorkspaceContextError`. Reads are filtered to the bound workspace so
 * one workspace cannot observe another workspace's records.
 */
export interface WorkspaceAwareIssueStore {
  /** The workspace this store is bound to. */
  readonly workspaceId: string;
  /** Return all records that belong to this workspace. */
  getAll(): Promise<LocalIssueRecord[]>;
  /** Return a record by issue number, or undefined if it belongs to a different workspace. */
  get(number: number): Promise<LocalIssueRecord | undefined>;
  /**
   * Insert or update a record scoped to this workspace.
   *
   * @throws {WorkspaceContextError} if `issue.workspaceId` does not match the
   *   bound workspace. Pass `issue` without `workspaceId` and the store will
   *   set it automatically.
   */
  upsert(
    issue: Omit<LocalIssueRecord, "workspaceId"> & { workspaceId?: string },
  ): Promise<void>;
  /** Patch a record by issue number within this workspace. */
  patch(
    number: number,
    updater: (issue: LocalIssueRecord) => LocalIssueRecord,
  ): Promise<LocalIssueRecord | undefined>;
  /** Remove a record by issue number within this workspace. */
  remove(number: number): Promise<void>;
}

/**
 * Thrown when a write is attempted without the correct workspace context.
 */
export class WorkspaceContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceContextError";
  }
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
 *
 * Scout finding (#386): this shim is a deliberate no-op. The embedded
 * lowdb store self-initializes on demand. The `databaseUrl` parameter
 * is accepted for API compatibility only — no Postgres connection is
 * opened here. The unified migration runner (substrate-foundations phase)
 * will own real Postgres migrations; this package will not grow a runner.
 *
 * @see docs/scout/386-postgres-provisioning-migration-schemas.md
 */
export async function migrate(_opts?: MigrateOptions): Promise<void> {
  // The embedded issue store initializes itself on demand.
}

/**
 * Open a workspace-scoped view of the issue store.
 *
 * The returned store automatically stamps every write with `workspaceId` and
 * rejects writes belonging to a different workspace. Reads are filtered to the
 * bound workspace so one workspace cannot observe another's records.
 *
 * @param workspaceId - The workspace to bind this store to. Must be a
 *   non-empty string; throws `WorkspaceContextError` otherwise.
 * @param filePath - Path to the backing JSON file (defaults to the project
 *   default).
 */
export async function openWorkspaceIssueStore(
  workspaceId: string,
  filePath = resolveIssueDbPath(),
): Promise<WorkspaceAwareIssueStore> {
  if (!workspaceId || workspaceId.trim() === "") {
    throw new WorkspaceContextError(
      "workspaceId is required and must be non-empty",
    );
  }

  const base = await openIssueStore(filePath);

  return {
    workspaceId,

    async getAll() {
      const all = await base.getAll();
      return all.filter((issue) => issue.workspaceId === workspaceId);
    },

    async get(number) {
      const issue = await base.get(number);
      if (!issue) return undefined;
      if (issue.workspaceId !== workspaceId) return undefined;
      return issue;
    },

    async upsert(issue) {
      if (
        issue.workspaceId !== undefined &&
        issue.workspaceId !== workspaceId
      ) {
        throw new WorkspaceContextError(
          `Cannot write issue #${issue.number} to workspace "${workspaceId}": ` +
            `record belongs to workspace "${issue.workspaceId}"`,
        );
      }
      await base.upsert({ ...issue, workspaceId });
    },

    async patch(number, updater) {
      // Only patch if the record belongs to this workspace.
      const current = await base.get(number);
      if (!current || current.workspaceId !== workspaceId) return undefined;
      return base.patch(number, (rec) => {
        const updated = updater(rec);
        if (updated.workspaceId !== workspaceId) {
          throw new WorkspaceContextError(
            `Patch updater must not change workspaceId (was "${workspaceId}", ` +
              `got "${updated.workspaceId}")`,
          );
        }
        return updated;
      });
    },

    async remove(number) {
      const current = await base.get(number);
      if (!current || current.workspaceId !== workspaceId) return;
      await base.remove(number);
    },
  };
}

/**
 * Backfill `workspaceId` on all existing records that lack it.
 *
 * Call once during application startup or as part of a migration script.
 * Rows that already have a `workspaceId` are left unchanged.
 *
 * @param store - The base (non-workspace-scoped) issue store.
 * @param defaultWorkspaceId - The workspace to assign to rows with no
 *   `workspaceId`. Must be a non-empty string.
 * @returns The number of rows that were updated.
 */
export async function migrateWorkspaceColumn(
  store: LocalIssueStore,
  defaultWorkspaceId: string,
): Promise<number> {
  if (!defaultWorkspaceId || defaultWorkspaceId.trim() === "") {
    throw new WorkspaceContextError(
      "defaultWorkspaceId is required and must be non-empty",
    );
  }

  const all = await store.getAll();
  let migrated = 0;

  for (const issue of all) {
    // Records written before workspace support used an undefined workspaceId.
    if (!issue.workspaceId) {
      await store.upsert({ ...issue, workspaceId: defaultWorkspaceId });
      migrated++;
    }
  }

  return migrated;
}

// Nexum schema migration — creates nexum.* tables in the shared instance
// and provides the data cutover path from the standalone Nexum DB.
// @see packages/db/nexum-migration.ts
// @see docs/architecture.md §6
// @see issue #368
export type {
  QueryExecutor,
  SchemaMigrationResult,
  NexumDataCutoverOptions,
  DataCutoverResult,
} from "./nexum-migration.ts";
export {
  runNexumSchemaMigration,
  runNexumDataCutover,
} from "./nexum-migration.ts";

// Row-Level Security — workspace context helpers for PostgreSQL RLS.
// @see packages/db/rls.ts
// @see packages/db/migrations/0001_rls_workspace_isolation.sql
// @see issue #430
export type { PgQueryable } from "./rls.ts";
export {
  RlsContextError,
  setWorkspaceContext,
  clearWorkspaceContext,
  getWorkspaceContext,
  withWorkspaceTransaction,
} from "./rls.ts";
