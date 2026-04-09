import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedGitHub, type SeededGitHub } from "./github-msw.ts";
import { GitHubClient } from "../../../../github/client.ts";
import { getSession, upsertSession, deleteSession } from "../../../sessions.ts";

const OWNER = "test-org";
const REPO = "test-repo";
const PLAN_BODY =
  "## Plan\n\n- #2 — feat(core): sample feature (2026-04-08T00:00:00.000Z)\n";

let seeded: SeededGitHub;

function freshClient(): GitHubClient {
  return new GitHubClient("test-token");
}

beforeEach(() => {
  seeded = seedGitHub({
    owner: OWNER,
    repo: REPO,
    planBody: PLAN_BODY,
    issues: [
      {
        number: 2,
        title: "feat(core): sample feature",
        body: "Original body",
        state: "open",
        labels: ["feature"],
      },
    ],
  });
  seeded.server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  seeded.server.close();
});

describe("seedGitHub — stateful in-memory GitHub fake", () => {
  it("seeds a default Plan issue with the supplied planBody and plan label", () => {
    const plan = seeded.state.getIssue(1);
    expect(plan).toBeDefined();
    expect(plan?.body).toBe(PLAN_BODY);
    expect(plan?.labels).toContain("plan");
  });

  it("listIssues filter by label returns only matching issues", async () => {
    const client = freshClient();
    const planIssues = await client.listIssues(OWNER, REPO, ["plan"]);
    expect(planIssues).toHaveLength(1);
    expect(planIssues[0]!.number).toBe(1);
  });

  it("round-trips an issue body via PATCH", async () => {
    const client = freshClient();
    await client.updateIssueBody({
      owner: OWNER,
      repo: REPO,
      issue_number: 2,
      body: "rewritten body",
    });
    expect(seeded.state.getIssue(2)?.body).toBe("rewritten body");
    const reread = await client.getIssue(OWNER, REPO, 2);
    expect(reread.body).toBe("rewritten body");
  });

  it("post → list → patch → list session comment lifecycle", async () => {
    const client = freshClient();
    const sessionBody = [
      "<!-- superfield-session:",
      JSON.stringify(
        {
          sessionId: "abc",
          role: "primary",
          slot: 1,
          startedAt: "2026-04-09T00:00:00.000Z",
        },
        null,
        2,
      ),
      "-->",
    ].join("\n");

    const created = await client.createIssueComment(
      OWNER,
      REPO,
      2,
      sessionBody,
    );
    expect(created.id).toBeGreaterThanOrEqual(1);

    const listed = await client.listIssueComments(OWNER, REPO, 2);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.body).toContain("<!-- superfield-session:");

    await client.updateIssueComment(
      OWNER,
      REPO,
      created.id,
      sessionBody.replace("abc", "xyz"),
    );

    const reread = await client.listIssueComments(OWNER, REPO, 2);
    expect(reread).toHaveLength(1);
    expect(reread[0]!.id).toBe(created.id); // ID persists across PATCH
    expect(reread[0]!.body).toContain("xyz");

    await client.deleteIssueComment(OWNER, REPO, created.id);
    const after = await client.listIssueComments(OWNER, REPO, 2);
    expect(after).toHaveLength(0);
  });

  it("real GitHubClient can round-trip a session comment via sessions.ts helpers", async () => {
    const client = freshClient();
    await upsertSession(client, OWNER, REPO, 2, {
      sessionId: "11111111-2222-3333-4444-555555555555",
      role: "primary",
      slot: 1,
      startedAt: new Date().toISOString(),
    });
    const found = await getSession(client, OWNER, REPO, 2);
    expect(found).not.toBeNull();
    expect(found?.session.sessionId).toBe(
      "11111111-2222-3333-4444-555555555555",
    );

    // Upsert again → updates in place (still one comment)
    await upsertSession(client, OWNER, REPO, 2, {
      sessionId: "11111111-2222-3333-4444-555555555555",
      role: "primary",
      slot: 1,
      startedAt: new Date().toISOString(),
      blueprintEscalated: true,
    });
    const comments = await client.listIssueComments(OWNER, REPO, 2);
    expect(comments).toHaveLength(1);

    await deleteSession(client, OWNER, REPO, 2);
    const afterDelete = await client.listIssueComments(OWNER, REPO, 2);
    expect(afterDelete).toHaveLength(0);
  });

  it("open + merge PR closes the linked issue", async () => {
    const client = freshClient();
    const pr = await client.createPullRequest({
      owner: OWNER,
      repo: REPO,
      title: "feat: sample",
      head: "feat/2-sample",
      base: "main",
      body: "closes #2",
    });
    expect(pr.number).toBeGreaterThanOrEqual(1);
    expect(seeded.state.getPRForIssue(2)?.number).toBe(pr.number);
    expect(seeded.state.getIssue(2)?.state).toBe("open");

    // Merge by hitting the endpoint directly (GitHubClient has no merge method)
    const resp = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${pr.number}/merge`,
      { method: "PUT", headers: { "content-type": "application/json" } },
    );
    expect(resp.status).toBe(200);

    const state = seeded.state;
    expect(state.getIssue(2)?.state).toBe("closed");
    expect(state.getPRForIssue(2)?.merged).toBe(true);
    expect(state.getPRForIssue(2)?.state).toBe("closed");
  });

  it("default check-run returns success when nothing seeded", async () => {
    const client = freshClient();
    const runs = await client.getCheckRuns(OWNER, REPO, "abcdef0");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.conclusion).toBe("success");
  });

  it("check-run handler returns seeded conclusion for the requested SHA", async () => {
    seeded.server.close();
    seeded = seedGitHub({
      owner: OWNER,
      repo: REPO,
      planBody: PLAN_BODY,
      checks: [
        {
          sha: "deadbeef",
          name: "test:unit",
          status: "completed",
          conclusion: "failure",
        },
      ],
    });
    seeded.server.listen({ onUnhandledRequest: "error" });
    const client = freshClient();
    const runs = await client.getCheckRuns(OWNER, REPO, "deadbeef");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.conclusion).toBe("failure");
    expect(runs[0]!.name).toBe("test:unit");
  });

  it("unknown endpoint returns a clear error", async () => {
    const resp = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/does-not-exist`,
    );
    expect(resp.status).toBe(500);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toContain("no MSW handler for GET");
    expect(json.error).toContain("does-not-exist");
    expect(json.error).toContain("helpers/github-msw.ts");
  });
});
