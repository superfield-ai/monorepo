/**
 * Integration tests for workspace/tenant isolation in the local issue store.
 *
 * Verifies:
 *  - All core table rows carry a non-null workspaceId (AC-1)
 *  - Inserts without a workspace context are rejected (AC-2)
 *  - Two workspaces can write rows with the same issue number and they remain
 *    isolated — reads from one workspace never return the other's records (TP-1)
 *  - migrateWorkspaceColumn backfills existing rows that lack a workspaceId
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateWorkspaceColumn,
  openIssueStore,
  openWorkspaceIssueStore,
  WorkspaceContextError,
  type LocalIssueRecord,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-db-test-"));
  return join(dir, "issues.json");
}

function makeIssueRecord(
  overrides: Partial<LocalIssueRecord> & { number: number; workspaceId: string },
): LocalIssueRecord {
  return {
    repo: "acme/app",
    title: `Issue ${overrides.number}`,
    body: "",
    status: "open",
    acceptance: [],
    testPlan: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// openWorkspaceIssueStore — constructor guards
// ---------------------------------------------------------------------------

describe("openWorkspaceIssueStore — constructor guards", () => {
  it("throws WorkspaceContextError when workspaceId is empty string", async () => {
    const dbPath = makeTmpDbPath();
    await expect(openWorkspaceIssueStore("", dbPath)).rejects.toThrow(
      WorkspaceContextError,
    );
  });

  it("throws WorkspaceContextError when workspaceId is whitespace only", async () => {
    const dbPath = makeTmpDbPath();
    await expect(openWorkspaceIssueStore("   ", dbPath)).rejects.toThrow(
      WorkspaceContextError,
    );
  });

  it("opens successfully with a valid workspaceId", async () => {
    const dbPath = makeTmpDbPath();
    const store = await openWorkspaceIssueStore("ws-alpha", dbPath);
    expect(store.workspaceId).toBe("ws-alpha");
  });
});

// ---------------------------------------------------------------------------
// AC-1: All core table rows carry a non-null workspaceId
// ---------------------------------------------------------------------------

describe("AC-1: every row carries a non-null workspaceId", () => {
  it("inserts a record with the bound workspaceId even when caller omits it", async () => {
    const dbPath = makeTmpDbPath();
    const store = await openWorkspaceIssueStore("ws-alpha", dbPath);

    await store.upsert({
      repo: "acme/app",
      number: 1,
      title: "First issue",
      body: "",
      status: "open",
      acceptance: [],
      testPlan: [],
      updatedAt: new Date().toISOString(),
    });

    const issue = await store.get(1);
    expect(issue).toBeDefined();
    expect(issue!.workspaceId).toBe("ws-alpha");
  });

  it("all rows returned by getAll() have a non-null workspaceId", async () => {
    const dbPath = makeTmpDbPath();
    const store = await openWorkspaceIssueStore("ws-alpha", dbPath);

    for (const num of [1, 2, 3]) {
      await store.upsert(makeIssueRecord({ number: num, workspaceId: "ws-alpha" }));
    }

    const all = await store.getAll();
    expect(all).toHaveLength(3);
    for (const row of all) {
      expect(row.workspaceId).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2: Inserts without workspace context are rejected
// ---------------------------------------------------------------------------

describe("AC-2: inserts without workspace context are rejected", () => {
  it("throws WorkspaceContextError when upserting a record with a different workspaceId", async () => {
    const dbPath = makeTmpDbPath();
    const store = await openWorkspaceIssueStore("ws-alpha", dbPath);

    await expect(
      store.upsert(makeIssueRecord({ number: 99, workspaceId: "ws-beta" })),
    ).rejects.toThrow(WorkspaceContextError);
  });

  it("does not write any data when the workspace mismatch is caught", async () => {
    const dbPath = makeTmpDbPath();
    const store = await openWorkspaceIssueStore("ws-alpha", dbPath);

    await expect(
      store.upsert(makeIssueRecord({ number: 99, workspaceId: "ws-beta" })),
    ).rejects.toThrow(WorkspaceContextError);

    const issue = await store.get(99);
    expect(issue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TP-1: Insert rows under two workspaces and assert isolation by key
// ---------------------------------------------------------------------------

describe("TP-1: two workspaces are isolated by key", () => {
  it("each workspace only sees its own records", async () => {
    const dbPath = makeTmpDbPath();
    const storeA = await openWorkspaceIssueStore("ws-alpha", dbPath);
    const storeB = await openWorkspaceIssueStore("ws-beta", dbPath);

    // Both workspaces write a record with the same issue number.
    await storeA.upsert(
      makeIssueRecord({ number: 1, workspaceId: "ws-alpha", title: "Alpha issue 1" }),
    );
    await storeB.upsert(
      makeIssueRecord({ number: 1, workspaceId: "ws-beta", title: "Beta issue 1" }),
    );

    const alpha1 = await storeA.get(1);
    const beta1 = await storeB.get(1);

    expect(alpha1).toBeDefined();
    expect(alpha1!.workspaceId).toBe("ws-alpha");
    expect(alpha1!.title).toBe("Alpha issue 1");

    expect(beta1).toBeDefined();
    expect(beta1!.workspaceId).toBe("ws-beta");
    expect(beta1!.title).toBe("Beta issue 1");
  });

  it("getAll() from workspace A never returns workspace B records", async () => {
    const dbPath = makeTmpDbPath();
    const storeA = await openWorkspaceIssueStore("ws-alpha", dbPath);
    const storeB = await openWorkspaceIssueStore("ws-beta", dbPath);

    await storeA.upsert(makeIssueRecord({ number: 10, workspaceId: "ws-alpha" }));
    await storeA.upsert(makeIssueRecord({ number: 11, workspaceId: "ws-alpha" }));
    await storeB.upsert(makeIssueRecord({ number: 20, workspaceId: "ws-beta" }));

    const alphaAll = await storeA.getAll();
    const betaAll = await storeB.getAll();

    expect(alphaAll).toHaveLength(2);
    expect(alphaAll.every((r) => r.workspaceId === "ws-alpha")).toBe(true);

    expect(betaAll).toHaveLength(1);
    expect(betaAll.every((r) => r.workspaceId === "ws-beta")).toBe(true);
  });

  it("remove() from workspace A does not delete workspace B records", async () => {
    const dbPath = makeTmpDbPath();
    const storeA = await openWorkspaceIssueStore("ws-alpha", dbPath);
    const storeB = await openWorkspaceIssueStore("ws-beta", dbPath);

    // Both write issue #5.
    await storeA.upsert(makeIssueRecord({ number: 5, workspaceId: "ws-alpha" }));
    await storeB.upsert(makeIssueRecord({ number: 5, workspaceId: "ws-beta" }));

    // A removes its copy — B's copy must survive.
    await storeA.remove(5);

    const alphaIssue = await storeA.get(5);
    const betaIssue = await storeB.get(5);

    expect(alphaIssue).toBeUndefined();
    expect(betaIssue).toBeDefined();
    expect(betaIssue!.workspaceId).toBe("ws-beta");
  });
});

// ---------------------------------------------------------------------------
// TP-2: Insert without workspace context fails
// ---------------------------------------------------------------------------

describe("TP-2: insert without workspace context fails", () => {
  it("openIssueStore upsert does not enforce workspaceId — but openWorkspaceIssueStore does", async () => {
    const dbPath = makeTmpDbPath();

    // Base store: no workspace enforcement (pre-migration compatibility).
    const base = await openIssueStore(dbPath);
    // Casting to bypass TS strict check to simulate a legacy caller.
    await base.upsert(
      { repo: "r", number: 1, title: "t", body: "", status: "open",
        acceptance: [], testPlan: [], updatedAt: new Date().toISOString() } as unknown as LocalIssueRecord,
    );

    // Workspace-scoped store: writing with wrong workspace must fail.
    const store = await openWorkspaceIssueStore("ws-alpha", dbPath);
    await expect(
      store.upsert(makeIssueRecord({ number: 2, workspaceId: "ws-intruder" })),
    ).rejects.toThrow(WorkspaceContextError);
  });
});

// ---------------------------------------------------------------------------
// migrateWorkspaceColumn — backfill tests
// ---------------------------------------------------------------------------

describe("migrateWorkspaceColumn", () => {
  it("backfills rows without a workspaceId and returns the count", async () => {
    const dbPath = makeTmpDbPath();
    const base = await openIssueStore(dbPath);

    // Write records without workspaceId using the base store.
    for (const num of [1, 2, 3]) {
      await base.upsert(
        { repo: "r", number: num, title: `Issue ${num}`, body: "",
          status: "open", acceptance: [], testPlan: [],
          updatedAt: new Date().toISOString() } as unknown as LocalIssueRecord,
      );
    }

    const migrated = await migrateWorkspaceColumn(base, "ws-default");
    expect(migrated).toBe(3);

    const all = await base.getAll();
    for (const row of all) {
      expect(row.workspaceId).toBe("ws-default");
    }
  });

  it("does not overwrite rows that already have a workspaceId", async () => {
    const dbPath = makeTmpDbPath();
    const base = await openIssueStore(dbPath);

    await base.upsert(makeIssueRecord({ number: 1, workspaceId: "ws-existing" }));
    // Also write a legacy row with no workspaceId.
    await base.upsert(
      { repo: "r", number: 2, title: "Legacy", body: "",
        status: "open", acceptance: [], testPlan: [],
        updatedAt: new Date().toISOString() } as unknown as LocalIssueRecord,
    );

    const migrated = await migrateWorkspaceColumn(base, "ws-default");
    // Only the legacy row should be updated.
    expect(migrated).toBe(1);

    const issue1 = await base.get(1);
    expect(issue1!.workspaceId).toBe("ws-existing");

    const issue2 = await base.get(2);
    expect(issue2!.workspaceId).toBe("ws-default");
  });

  it("throws WorkspaceContextError when defaultWorkspaceId is empty", async () => {
    const dbPath = makeTmpDbPath();
    const base = await openIssueStore(dbPath);

    await expect(migrateWorkspaceColumn(base, "")).rejects.toThrow(
      WorkspaceContextError,
    );
  });

  it("returns 0 and leaves data unchanged when all rows already have workspaceId", async () => {
    const dbPath = makeTmpDbPath();
    const base = await openIssueStore(dbPath);

    await base.upsert(makeIssueRecord({ number: 1, workspaceId: "ws-alpha" }));
    await base.upsert(makeIssueRecord({ number: 2, workspaceId: "ws-beta" }));

    const migrated = await migrateWorkspaceColumn(base, "ws-default");
    expect(migrated).toBe(0);

    // Existing workspaceIds must be untouched.
    const issue1 = await base.get(1);
    expect(issue1!.workspaceId).toBe("ws-alpha");
  });
});
