import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { getRepoVariable, putRepoVariable } from "../../github/variables.ts";
import type { GitHubHttpDeps } from "../../github/types.ts";
import variableFixture from "../fixtures/github/repo-variable.json" with { type: "json" };

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

describe("getRepoVariable", () => {
  it("returns the value when present", async () => {
    server.use(
      http.get(
        `${BASE}/repos/${REPO}/actions/variables/DEPLOY_KEY_PROD_FP`,
        () => HttpResponse.json(variableFixture),
      ),
    );
    const value = await getRepoVariable(REPO, "DEPLOY_KEY_PROD_FP", makeDeps());
    expect(value).toBe("sha256:abc123def456");
  });

  it("returns null on 404", async () => {
    server.use(
      http.get(`${BASE}/repos/${REPO}/actions/variables/MISSING`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const value = await getRepoVariable(REPO, "MISSING", makeDeps());
    expect(value).toBeNull();
  });
});

describe("putRepoVariable", () => {
  it("POSTs when variable does not exist", async () => {
    let postBody: unknown = null;
    server.use(
      http.get(`${BASE}/repos/${REPO}/actions/variables/NEW_VAR`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
      http.post(
        `${BASE}/repos/${REPO}/actions/variables`,
        async ({ request }) => {
          postBody = await request.json();
          return new HttpResponse(null, { status: 201 });
        },
      ),
    );

    await putRepoVariable(REPO, "NEW_VAR", "value-1", makeDeps());
    expect(postBody).toEqual({ name: "NEW_VAR", value: "value-1" });
  });

  it("PATCHes when variable already exists", async () => {
    let patchBody: unknown = null;
    server.use(
      http.get(`${BASE}/repos/${REPO}/actions/variables/EXISTING`, () =>
        HttpResponse.json(variableFixture),
      ),
      http.patch(
        `${BASE}/repos/${REPO}/actions/variables/EXISTING`,
        async ({ request }) => {
          patchBody = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    await putRepoVariable(REPO, "EXISTING", "value-2", makeDeps());
    expect(patchBody).toEqual({ name: "EXISTING", value: "value-2" });
  });
});
