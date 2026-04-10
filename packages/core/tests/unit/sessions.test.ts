import { describe, it, expect, vi } from "vitest";
import {
  getSession,
  upsertSession,
  deleteSession,
  classifyStartupSessions,
  findIssuesWithSessions,
  findStaleSessions,
  type AgentSession,
} from "../../sessions.ts";
import type { GitHubClient } from "@superfield/github";

const sampleSession: AgentSession = {
  sessionId: "01JNSESSION",
  role: "primary",
  slot: 1,
  startedAt: "2026-04-08T01:00:00.000Z",
  version: 0,
};

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    listIssues: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as GitHubClient;
}

function sessionCommentBody(s: AgentSession): string {
  return `<!-- superfield-session:\n${JSON.stringify(s, null, 2)}\n-->`;
}

describe("getSession", () => {
  it("returns null when no session comment exists", async () => {
    const client = makeClient();
    expect(await getSession(client, "o", "r", 10)).toBeNull();
  });

  it("parses an existing session comment", async () => {
    const client = makeClient({
      listIssueComments: vi.fn().mockResolvedValue([
        { id: 1, body: "unrelated" },
        { id: 2, body: sessionCommentBody(sampleSession) },
      ]),
    });
    const found = await getSession(client, "o", "r", 10);
    expect(found?.session).toEqual(sampleSession);
    expect(found?.commentId).toBe(2);
  });

  it("defaults version to 0 for legacy comments without version field", async () => {
    const legacySession = { ...sampleSession };
    delete (legacySession as Record<string, unknown>).version;
    const client = makeClient({
      listIssueComments: vi.fn().mockResolvedValue([
        { id: 1, body: sessionCommentBody(legacySession) },
      ]),
    });
    const found = await getSession(client, "o", "r", 10);
    expect(found?.session.version).toBe(0);
  });

  it("skips malformed session comments", async () => {
    const client = makeClient({
      listIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 1, body: "<!-- superfield-session:\nnot json\n-->" },
        ]),
    });
    expect(await getSession(client, "o", "r", 10)).toBeNull();
  });
});

describe("upsertSession", () => {
  it("creates a new comment with version 1 when none exists", async () => {
    const client = makeClient();
    await upsertSession(client, "o", "r", 10, sampleSession);
    expect(client.createIssueComment).toHaveBeenCalledTimes(1);
    const args = (client.createIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(args[3]).toContain('"version": 1');
  });

  it("updates an existing comment when one exists", async () => {
    const client = makeClient({
      listIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 99, body: sessionCommentBody({ ...sampleSession, slot: 2 }) },
        ]),
    });
    await upsertSession(client, "o", "r", 10, sampleSession);
    expect(client.updateIssueComment).toHaveBeenCalledWith(
      "o",
      "r",
      99,
      expect.any(String),
    );
    expect(client.createIssueComment).not.toHaveBeenCalled();
  });

  it("increments version sequentially 0→1→2", async () => {
    // Start with no comment, then track creates/updates
    let storedBody: string | null = null;
    const client = makeClient({
      listIssueComments: vi.fn().mockImplementation(() => {
        if (!storedBody) return Promise.resolve([]);
        return Promise.resolve([{ id: 42, body: storedBody }]);
      }),
      createIssueComment: vi.fn().mockImplementation((_o, _r, _n, body) => {
        storedBody = body;
        return Promise.resolve({ id: 42 });
      }),
      updateIssueComment: vi.fn().mockImplementation((_o, _r, _id, body) => {
        storedBody = body;
        return Promise.resolve(undefined);
      }),
    });

    // First upsert: no existing → creates with version 1
    await upsertSession(client, "o", "r", 10, sampleSession);
    expect(storedBody).toContain('"version": 1');

    // Second upsert: existing version 1 → updates with version 2
    await upsertSession(client, "o", "r", 10, sampleSession);
    expect(storedBody).toContain('"version": 2');
  });

  it("retries on version conflict and succeeds", async () => {
    // Simulate: first read returns version 1, recheck returns version 2
    // (someone else wrote), second attempt reads version 2, recheck matches.
    const v1Body = sessionCommentBody({ ...sampleSession, version: 1 });
    const v2Body = sessionCommentBody({ ...sampleSession, version: 2 });
    const listMock = vi
      .fn()
      // attempt 0: initial read → v1
      .mockResolvedValueOnce([{ id: 42, body: v1Body }])
      // attempt 0: recheck → v2 (conflict!)
      .mockResolvedValueOnce([{ id: 42, body: v2Body }])
      // attempt 1: initial read → v2
      .mockResolvedValueOnce([{ id: 42, body: v2Body }])
      // attempt 1: recheck → v2 (match)
      .mockResolvedValueOnce([{ id: 42, body: v2Body }]);

    const client = makeClient({
      listIssueComments: listMock,
    });

    await upsertSession(client, "o", "r", 10, sampleSession);
    // Should have called updateIssueComment once (on the successful retry)
    expect(client.updateIssueComment).toHaveBeenCalledTimes(1);
    const body = (client.updateIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]![3] as string;
    expect(body).toContain('"version": 3');
  });

  it("falls back to last-writer-wins after 3 conflicts", async () => {
    // Every recheck returns a higher version than initial read
    const listMock = vi.fn();
    for (let i = 0; i < 4; i++) {
      const readV = i + 1;
      const recheckV = i + 2;
      listMock
        .mockResolvedValueOnce([
          { id: 42, body: sessionCommentBody({ ...sampleSession, version: readV }) },
        ])
        .mockResolvedValueOnce([
          { id: 42, body: sessionCommentBody({ ...sampleSession, version: recheckV }) },
        ]);
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient({ listIssueComments: listMock });

    await upsertSession(client, "o", "r", 10, sampleSession);
    expect(client.updateIssueComment).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("exhausted"),
    );
    warnSpy.mockRestore();
  });

  it("treats legacy comments without version as version 0", async () => {
    // Session without version field
    const legacySession = { ...sampleSession };
    delete (legacySession as Record<string, unknown>).version;
    const legacyBody = sessionCommentBody(legacySession);
    const client = makeClient({
      listIssueComments: vi
        .fn()
        .mockResolvedValue([{ id: 42, body: legacyBody }]),
    });

    await upsertSession(client, "o", "r", 10, sampleSession);
    const body = (client.updateIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]![3] as string;
    // Legacy version 0 → write version 1
    expect(body).toContain('"version": 1');
  });
});

describe("deleteSession", () => {
  it("deletes the existing session comment", async () => {
    const client = makeClient({
      listIssueComments: vi
        .fn()
        .mockResolvedValue([
          { id: 99, body: sessionCommentBody(sampleSession) },
        ]),
    });
    await deleteSession(client, "o", "r", 10);
    expect(client.deleteIssueComment).toHaveBeenCalledWith("o", "r", 99);
  });

  it("is a no-op when no session comment exists", async () => {
    const client = makeClient();
    await deleteSession(client, "o", "r", 10);
    expect(client.deleteIssueComment).not.toHaveBeenCalled();
  });
});

describe("findIssuesWithSessions", () => {
  it("returns open issues that carry session comments", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([{ number: 10 }, { number: 20 }]),
      listIssueComments: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 1, body: sessionCommentBody(sampleSession) },
        ])
        .mockResolvedValueOnce([{ id: 2, body: "regular comment" }]),
    });

    const found = await findIssuesWithSessions(client, "o", "r");

    expect(found).toEqual([
      { issueNumber: 10, commentId: 1, session: sampleSession },
    ]);
  });

  it("skips malformed session comments while continuing the scan", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([{ number: 10 }, { number: 20 }]),
      listIssueComments: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 1, body: "<!-- superfield-session:\nnot json\n-->" },
        ])
        .mockResolvedValueOnce([
          { id: 2, body: sessionCommentBody(sampleSession) },
        ]),
    });

    const found = await findIssuesWithSessions(client, "o", "r");

    expect(found).toEqual([
      { issueNumber: 20, commentId: 2, session: sampleSession },
    ]);
  });
});

describe("findStaleSessions", () => {
  it("returns sessions older than the timeout", async () => {
    const oldSession: AgentSession = {
      ...sampleSession,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([{ number: 10 }, { number: 20 }]),
      listIssueComments: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 1, body: sessionCommentBody(oldSession) },
        ])
        .mockResolvedValueOnce([
          {
            id: 2,
            body: sessionCommentBody({
              ...sampleSession,
              startedAt: new Date().toISOString(),
            }),
          },
        ]),
    });
    const stale = await findStaleSessions(client, "o", "r", 30_000);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.issueNumber).toBe(10);
  });

  it("returns empty when all sessions are fresh", async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([{ number: 10 }]),
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 1,
          body: sessionCommentBody({
            ...sampleSession,
            startedAt: new Date().toISOString(),
          }),
        },
      ]),
    });
    const stale = await findStaleSessions(client, "o", "r", 30_000);
    expect(stale).toEqual([]);
  });
});

describe("classifyStartupSessions", () => {
  it("prioritizes fresh in-plan sessions in plan order", async () => {
    const freshSession: AgentSession = {
      ...sampleSession,
      startedAt: new Date().toISOString(),
    };
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([{ number: 11 }, { number: 10 }]),
      listIssueComments: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 1, body: sessionCommentBody(freshSession) },
        ])
        .mockResolvedValueOnce([
          { id: 2, body: sessionCommentBody(freshSession) },
        ]),
    });

    const result = await classifyStartupSessions(
      client,
      "o",
      "r",
      [10, 11],
      30_000,
    );

    expect(result.prioritizedIssueNumbers).toEqual([10, 11]);
    expect(result.reapedIssueNumbers).toEqual([]);
  });

  it("reaps stale sessions and fresh sessions that are not in the plan", async () => {
    const staleSession: AgentSession = {
      ...sampleSession,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const freshSession: AgentSession = {
      ...sampleSession,
      startedAt: new Date().toISOString(),
    };
    const client = makeClient({
      listIssues: vi
        .fn()
        .mockResolvedValue([{ number: 10 }, { number: 20 }, { number: 30 }]),
      listIssueComments: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 1, body: sessionCommentBody(staleSession) },
        ])
        .mockResolvedValueOnce([
          { id: 2, body: sessionCommentBody(freshSession) },
        ])
        .mockResolvedValueOnce([
          { id: 3, body: sessionCommentBody(freshSession) },
        ]),
    });

    const result = await classifyStartupSessions(
      client,
      "o",
      "r",
      [30],
      30_000,
    );

    expect(result.prioritizedIssueNumbers).toEqual([30]);
    expect(result.reapedIssueNumbers).toEqual([10, 20]);
    expect(result.reapedSessions.map((session) => session.commentId)).toEqual([
      1, 2,
    ]);
  });
});
