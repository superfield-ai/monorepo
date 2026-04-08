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
  it("creates a new comment when none exists", async () => {
    const client = makeClient();
    await upsertSession(client, "o", "r", 10, sampleSession);
    expect(client.createIssueComment).toHaveBeenCalledTimes(1);
    const args = (client.createIssueComment as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(args[0]).toBe("o");
    expect(args[1]).toBe("r");
    expect(args[2]).toBe(10);
    expect(args[3]).toContain("<!-- superfield-session:");
    expect(args[3]).toContain('"sessionId": "01JNSESSION"');
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
