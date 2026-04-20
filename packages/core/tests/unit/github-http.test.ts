import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { GitHubApiError, githubRequest } from "../../github/http.ts";
import { listDeployKeys, registerDeployKey } from "../../github/deploy-keys.ts";
import { putRepoSecret } from "../../github/secrets.ts";
import { getRepoVariable, putRepoVariable } from "../../github/variables.ts";
import { openPullRequest } from "../../github/pull-request.ts";
import type { GitHubHttpDeps } from "../../github/types.ts";
import deployKeysEmpty from "../fixtures/github/deploy-keys-empty.json" with { type: "json" };
import deployKeyCreated from "../fixtures/github/deploy-key-created.json" with { type: "json" };
import publicKeyFixture from "../fixtures/github/repo-public-key.json" with { type: "json" };
import variableFixture from "../fixtures/github/repo-variable.json" with { type: "json" };
import branchRefBase from "../fixtures/github/branch-ref-base.json" with { type: "json" };
import prCreated from "../fixtures/github/pr-created.json" with { type: "json" };

const BASE = "https://api.github.com";
const REPO = "test-org/test-repo";

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

describe("githubRequest", () => {
  it("includes Authorization, Accept, and X-GitHub-Api-Version on every request", async () => {
    let captured: Headers | null = null;
    server.use(
      http.get(`${BASE}/zen`, ({ request }) => {
        captured = request.headers;
        return HttpResponse.json({});
      }),
    );

    await githubRequest("/zen", { method: "GET" }, makeDeps());
    expect(captured).not.toBeNull();
    expect(captured!.get("Authorization")).toBe("Bearer test-token");
    expect(captured!.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(captured!.get("Accept")).toBe("application/vnd.github+json");
  });

  it("throws GitHubApiError with status, GitHub message, and URL", async () => {
    server.use(
      http.get(`${BASE}/repos/test-org/test-repo`, () =>
        HttpResponse.json(
          { message: "Resource not accessible by integration" },
          { status: 403 },
        ),
      ),
    );

    let err: unknown;
    try {
      await githubRequest(
        "/repos/test-org/test-repo",
        { method: "GET" },
        makeDeps(),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitHubApiError);
    const apiErr = err as GitHubApiError;
    expect(apiErr.status).toBe(403);
    expect(apiErr.githubMessage).toBe("Resource not accessible by integration");
    expect(apiErr.url).toBe(`${BASE}/repos/test-org/test-repo`);
    expect(apiErr.message).toContain("403");
    expect(apiErr.message).toContain("Resource not accessible");
  });
});

/**
 * Sweep test: every public method must include the X-GitHub-Api-Version
 * header on every outbound request. We capture all requests through MSW and
 * assert the header on each.
 */
describe("X-GitHub-Api-Version header on all methods", () => {
  it("is present on requests issued by every public function", async () => {
    const captured: { url: string; version: string | null }[] = [];

    function record(request: Request) {
      captured.push({
        url: request.url,
        version: request.headers.get("X-GitHub-Api-Version"),
      });
    }

    server.use(
      // deploy keys
      http.get(`${BASE}/repos/${REPO}/keys`, ({ request }) => {
        record(request);
        return HttpResponse.json(deployKeysEmpty);
      }),
      http.post(`${BASE}/repos/${REPO}/keys`, ({ request }) => {
        record(request);
        return HttpResponse.json(deployKeyCreated, { status: 201 });
      }),
      http.delete(`${BASE}/repos/${REPO}/keys/1234567`, ({ request }) => {
        record(request);
        return new HttpResponse(null, { status: 204 });
      }),
      // secrets
      http.get(
        `${BASE}/repos/${REPO}/actions/secrets/public-key`,
        ({ request }) => {
          record(request);
          return HttpResponse.json(publicKeyFixture);
        },
      ),
      http.put(
        `${BASE}/repos/${REPO}/actions/secrets/MY_SECRET`,
        ({ request }) => {
          record(request);
          return new HttpResponse(null, { status: 201 });
        },
      ),
      // variables
      http.get(
        `${BASE}/repos/${REPO}/actions/variables/MY_VAR`,
        ({ request }) => {
          record(request);
          return HttpResponse.json(variableFixture);
        },
      ),
      http.patch(
        `${BASE}/repos/${REPO}/actions/variables/MY_VAR`,
        ({ request }) => {
          record(request);
          return new HttpResponse(null, { status: 204 });
        },
      ),
      // pull request
      http.get(
        `${BASE}/repos/${REPO}/git/ref/heads/feature%2Fapi-version`,
        ({ request }) => {
          record(request);
          return HttpResponse.json({
            ref: "refs/heads/feature/api-version",
            object: { sha: branchRefBase.object.sha, type: "commit" },
          });
        },
      ),
      http.post(`${BASE}/repos/${REPO}/pulls`, ({ request }) => {
        record(request);
        return HttpResponse.json(prCreated, { status: 201 });
      }),
    );

    await listDeployKeys(REPO, makeDeps());
    await registerDeployKey(
      REPO,
      "title",
      "ssh-ed25519 NEWKEY user@host",
      true,
      makeDeps(),
    );
    // listDeployKeys called once already; registerDeployKey calls list+post.
    // The above already exercises GET+POST.
    await (async () => {
      // delete uses captured handler
      const deps = makeDeps();
      const { deleteDeployKey } = await import("../../github/deploy-keys.ts");
      await deleteDeployKey(REPO, 1234567, deps);
    })();
    await putRepoSecret(REPO, "MY_SECRET", "plaintext", makeDeps());
    await putRepoVariable(REPO, "MY_VAR", "v", makeDeps());
    await getRepoVariable(REPO, "MY_VAR", makeDeps());
    await openPullRequest(
      REPO,
      "feature/api-version",
      "main",
      "t",
      "b",
      makeDeps(),
    );

    expect(captured.length).toBeGreaterThan(0);
    for (const entry of captured) {
      expect(
        entry.version,
        `X-GitHub-Api-Version missing for ${entry.url}`,
      ).toBe("2022-11-28");
    }
  });
});
