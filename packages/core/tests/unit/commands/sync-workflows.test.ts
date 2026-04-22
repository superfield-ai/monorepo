import { Buffer } from "node:buffer";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import YAML from "yaml";

import {
  syncWorkflows,
  normalizeWhitespace,
} from "../../../commands/sync-workflows.ts";
import type { GitHubHttpDeps } from "../../../github/types.ts";

const BASE = "https://api.github.com";
const REPO = "test-org/test-app";
const APP = "test-app";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeDeps(): GitHubHttpDeps {
  return {
    fetch: globalThis.fetch,
    getToken: async () => "test-token",
  };
}

interface FakeRepo {
  /** Decoded file contents on the default branch, by path. */
  files: Map<string, string>;
  /** Decoded file contents written via PUT, by path. */
  written: Map<string, string>;
  branchesCreated: string[];
  prs: Array<{
    title: string;
    body: string;
    head: string;
    base: string;
  }>;
}

function newRepo(): FakeRepo {
  return {
    files: new Map(),
    written: new Map(),
    branchesCreated: [],
    prs: [],
  };
}

const MAIN_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function installFakeGithub(state: FakeRepo): void {
  server.use(
    // Read content from default branch (used by syncWorkflows to compare).
    http.get(`${BASE}/repos/${REPO}/contents/:p1/:p2/:p3`, ({ params, request }) => {
      const url = new URL(request.url);
      const ref = url.searchParams.get("ref");
      const pathStr = `${params.p1}/${params.p2}/${params.p3}`;
      // Distinguish between the read against base (ref=main) and the read
      // against the new branch (ref=superfield/sync-...) which openPullRequest
      // performs to find an existing sha. For reads against the new branch,
      // always 404 (file does not yet exist on the freshly created branch).
      if (ref && ref.startsWith("superfield/sync-")) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      const content = state.files.get(pathStr);
      if (content === undefined) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return HttpResponse.json({
        type: "file",
        sha: "sha-" + pathStr,
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64"),
      });
    }),
    // Branch ref lookups for openPullRequest.ensureBranch.
    http.get(`${BASE}/repos/${REPO}/git/ref/heads/main`, () =>
      HttpResponse.json({
        ref: "refs/heads/main",
        object: { sha: MAIN_SHA, type: "commit" },
      }),
    ),
    http.get(
      `${BASE}/repos/${REPO}/git/ref/heads/superfield%2Fsync-:rest`,
      () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
    // Create branch ref.
    http.post(`${BASE}/repos/${REPO}/git/refs`, async ({ request }) => {
      const body = (await request.json()) as { ref: string; sha: string };
      state.branchesCreated.push(body.ref);
      return HttpResponse.json(
        { ref: body.ref, object: { sha: body.sha, type: "commit" } },
        { status: 201 },
      );
    }),
    // PUT file (commit on new branch).
    http.put(
      `${BASE}/repos/${REPO}/contents/:p1/:p2/:p3`,
      async ({ request, params }) => {
        const body = (await request.json()) as { content: string };
        const pathStr = `${params.p1}/${params.p2}/${params.p3}`;
        state.written.set(
          pathStr,
          Buffer.from(body.content, "base64").toString("utf8"),
        );
        return HttpResponse.json(
          { content: { path: pathStr, sha: "newsha-" + pathStr } },
          { status: 201 },
        );
      },
    ),
    // Open PR.
    http.post(`${BASE}/repos/${REPO}/pulls`, async ({ request }) => {
      const body = (await request.json()) as {
        title: string;
        body: string;
        head: string;
        base: string;
      };
      state.prs.push(body);
      return HttpResponse.json(
        {
          number: 42,
          html_url: `https://github.com/${REPO}/pull/42`,
        },
        { status: 201 },
      );
    }),
  );
}

describe("normalizeWhitespace", () => {
  it("collapses runs of whitespace", () => {
    expect(normalizeWhitespace("a   b\n\nc\t d")).toBe("a b c d");
  });
});

describe("syncWorkflows — first sync against empty repo", () => {
  it("opens a PR adding all three workflow files", async () => {
    const state = newRepo();
    installFakeGithub(state);

    const result = await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 1_700_000_000_000,
    });

    expect(result.prUrl).toBe(`https://github.com/${REPO}/pull/42`);
    expect(result.changed.sort()).toEqual([
      ".github/workflows/deploy.yml",
      ".github/workflows/release.yml",
      ".github/workflows/rollback.yml",
    ]);
    expect(result.unchanged).toEqual([]);

    expect(state.prs).toHaveLength(1);
    expect(state.prs[0]!.title).toBe(
      "chore(superfield): sync workflow templates",
    );
    expect(state.prs[0]!.head).toBe("superfield/sync-1700000000");
    expect(state.prs[0]!.base).toBe("main");
    expect(state.branchesCreated).toEqual([
      "refs/heads/superfield/sync-1700000000",
    ]);

    // All three rendered files were committed.
    expect(state.written.size).toBe(3);
    for (const p of [
      ".github/workflows/release.yml",
      ".github/workflows/deploy.yml",
      ".github/workflows/rollback.yml",
    ]) {
      expect(state.written.has(p)).toBe(true);
    }
  });
});

describe("syncWorkflows — second sync with identical files", () => {
  it("opens no PR and reports all unchanged", async () => {
    // First, do a full sync to capture the rendered output.
    const seedState = newRepo();
    installFakeGithub(seedState);
    await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 1_700_000_000_000,
    });
    server.resetHandlers();

    // Now seed the "current" repo with those exact contents and re-sync.
    const state = newRepo();
    for (const [p, c] of seedState.written) state.files.set(p, c);
    installFakeGithub(state);

    const result = await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 1_700_000_001_000,
    });

    expect(result.prUrl).toBeUndefined();
    expect(result.changed).toEqual([]);
    expect(result.unchanged.sort()).toEqual([
      ".github/workflows/deploy.yml",
      ".github/workflows/release.yml",
      ".github/workflows/rollback.yml",
    ]);
    expect(state.prs).toEqual([]);
    expect(state.branchesCreated).toEqual([]);
    expect(state.written.size).toBe(0);
  });

  it("treats whitespace-only differences as unchanged", async () => {
    const seedState = newRepo();
    installFakeGithub(seedState);
    await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 1,
    });
    server.resetHandlers();

    const state = newRepo();
    for (const [p, c] of seedState.written) {
      // Mangle whitespace: extra blank lines + trailing spaces.
      state.files.set(p, c.replace(/\n/g, "  \n\n"));
    }
    installFakeGithub(state);

    const result = await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 2,
    });

    expect(result.prUrl).toBeUndefined();
    expect(result.changed).toEqual([]);
  });
});

describe("syncWorkflows — appName change rerenders only affected files", () => {
  it("opens a PR containing only the file(s) whose content changed", async () => {
    // Seed with the rendered output for appName=test-app.
    const seedState = newRepo();
    installFakeGithub(seedState);
    await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 100,
    });
    server.resetHandlers();

    const state = newRepo();
    for (const [p, c] of seedState.written) state.files.set(p, c);
    installFakeGithub(state);

    // Re-sync with a different appName. Every template references APP_NAME,
    // so all three should change. Verify all three appear in `changed`
    // and only those files are PUT to the branch.
    const result = await syncWorkflows({
      repo: REPO,
      appName: "renamed-app",
      deps: makeDeps(),
      now: () => 200,
    });

    expect(result.prUrl).toBeDefined();
    expect(result.changed.length).toBeGreaterThan(0);
    expect(state.written.size).toBe(result.changed.length);
    for (const p of result.changed) {
      expect(state.written.has(p)).toBe(true);
      // The new appName is present in the committed body.
      expect(state.written.get(p)).toContain("renamed-app");
    }
  });

  it("opens a PR with only the changed file when seed differs in just one workflow", async () => {
    // Seed two of three with identical-rendered content, leave release.yml
    // intentionally different by simulating it had a stale appName.
    const renderedState = newRepo();
    installFakeGithub(renderedState);
    await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 1,
    });
    server.resetHandlers();

    const state = newRepo();
    for (const [p, c] of renderedState.written) {
      if (p.endsWith("release.yml")) {
        // Stale: prior render had different APP_NAME.
        state.files.set(p, c.replace(/test-app/g, "old-app"));
      } else {
        state.files.set(p, c);
      }
    }
    installFakeGithub(state);

    const result = await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 2,
    });

    expect(result.changed).toEqual([".github/workflows/release.yml"]);
    expect(result.unchanged.sort()).toEqual([
      ".github/workflows/deploy.yml",
      ".github/workflows/rollback.yml",
    ]);
    expect(state.written.size).toBe(1);
    expect(state.written.has(".github/workflows/release.yml")).toBe(true);
  });
});

describe("syncWorkflows — generated YAML", () => {
  it("each rendered workflow parses as YAML", async () => {
    const state = newRepo();
    installFakeGithub(state);
    await syncWorkflows({
      repo: REPO,
      appName: APP,
      deployments: ["test-app", "test-app-worker"],
      deps: makeDeps(),
      now: () => 1,
    });

    expect(state.written.size).toBe(3);
    for (const [p, content] of state.written) {
      let doc: unknown;
      expect(() => {
        doc = YAML.parse(content);
      }, `parses ${p}`).not.toThrow();
      expect(doc, `${p} has top-level mapping`).toBeTypeOf("object");
      expect((doc as Record<string, unknown>).name).toBeDefined();
      expect((doc as Record<string, unknown>).jobs).toBeDefined();
    }
  });

  it("deploy.yml references the per-env secrets created by setup-github", async () => {
    const state = newRepo();
    installFakeGithub(state);
    await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 1,
    });

    const deploy = state.written.get(".github/workflows/deploy.yml");
    expect(deploy).toBeDefined();
    for (const env of ["DEMO", "STAGING", "PROD"]) {
      expect(deploy).toContain(`secrets.DEPLOY_HOST_${env}`);
      expect(deploy).toContain(`secrets.DEPLOY_KEY_${env}`);
      expect(deploy).toContain(`secrets.DATABASE_URL_${env}`);
    }
  });

  it("substitutes IMAGE_REPO default to ghcr.io/<repo>", async () => {
    const state = newRepo();
    installFakeGithub(state);
    await syncWorkflows({
      repo: REPO,
      appName: APP,
      deps: makeDeps(),
      now: () => 1,
    });

    const release = state.written.get(".github/workflows/release.yml")!;
    expect(release).toContain(`ghcr.io/${REPO}`);
    expect(release).not.toContain("{{ IMAGE_REPO }}");
    expect(release).not.toContain("{{ APP_NAME }}");
  });

  it("expands DEPLOYMENTS into deploy.yml's rollout loop", async () => {
    const state = newRepo();
    installFakeGithub(state);
    await syncWorkflows({
      repo: REPO,
      appName: APP,
      deployments: ["app", "worker", "scheduler"],
      deps: makeDeps(),
      now: () => 1,
    });

    const deploy = state.written.get(".github/workflows/deploy.yml")!;
    expect(deploy).toContain('DEPLOYMENTS: "app,worker,scheduler"');
    const rollback = state.written.get(".github/workflows/rollback.yml")!;
    expect(rollback).toContain('DEPLOYMENTS: "app,worker,scheduler"');
  });
});
