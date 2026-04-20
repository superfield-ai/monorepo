import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import {
  deleteDeployKey,
  listDeployKeys,
  registerDeployKey,
} from "../../github/deploy-keys.ts";
import type { GitHubHttpDeps } from "../../github/types.ts";
import deployKeyCreated from "../fixtures/github/deploy-key-created.json" with { type: "json" };
import deployKeysEmpty from "../fixtures/github/deploy-keys-empty.json" with { type: "json" };
import deployKeysExisting from "../fixtures/github/deploy-keys-existing.json" with { type: "json" };

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

describe("listDeployKeys", () => {
  it("returns parsed deploy keys", async () => {
    server.use(
      http.get(`${BASE}/repos/${REPO}/keys`, () =>
        HttpResponse.json(deployKeysExisting),
      ),
    );
    const keys = await listDeployKeys(REPO, makeDeps());
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(1234567);
  });
});

describe("deleteDeployKey", () => {
  it("DELETEs the key endpoint", async () => {
    let called = false;
    server.use(
      http.delete(`${BASE}/repos/${REPO}/keys/1234567`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await deleteDeployKey(REPO, 1234567, makeDeps());
    expect(called).toBe(true);
  });
});

describe("registerDeployKey", () => {
  const PUBLIC_KEY =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleDeployKeyMaterial1 deploy@host";

  it("creates a new key and returns its id when none exist", async () => {
    let postBody: { title?: string; key?: string; read_only?: boolean } | null =
      null;
    server.use(
      http.get(`${BASE}/repos/${REPO}/keys`, () =>
        HttpResponse.json(deployKeysEmpty),
      ),
      http.post(`${BASE}/repos/${REPO}/keys`, async ({ request }) => {
        postBody = (await request.json()) as typeof postBody;
        return HttpResponse.json(deployKeyCreated, { status: 201 });
      }),
    );

    const result = await registerDeployKey(
      REPO,
      "deploy-key-prod",
      PUBLIC_KEY,
      true,
      makeDeps(),
    );

    expect(result.id).toBe(1234567);
    expect(postBody).toEqual({
      title: "deploy-key-prod",
      key: PUBLIC_KEY,
      read_only: true,
    });
  });

  it("is idempotent: returns existing id without POSTing on duplicate material", async () => {
    let postCount = 0;
    server.use(
      http.get(`${BASE}/repos/${REPO}/keys`, () =>
        HttpResponse.json(deployKeysExisting),
      ),
      http.post(`${BASE}/repos/${REPO}/keys`, () => {
        postCount += 1;
        return HttpResponse.json(deployKeyCreated, { status: 201 });
      }),
    );

    const result = await registerDeployKey(
      REPO,
      "deploy-key-prod",
      PUBLIC_KEY,
      true,
      makeDeps(),
    );

    expect(result.id).toBe(1234567);
    expect(postCount).toBe(0);
  });

  it("recovers from race-condition 422 by re-listing", async () => {
    let listCalls = 0;
    server.use(
      http.get(`${BASE}/repos/${REPO}/keys`, () => {
        listCalls += 1;
        if (listCalls === 1) {
          return HttpResponse.json(deployKeysEmpty);
        }
        return HttpResponse.json(deployKeysExisting);
      }),
      http.post(`${BASE}/repos/${REPO}/keys`, () =>
        HttpResponse.json(
          { message: "key is already in use" },
          { status: 422 },
        ),
      ),
    );

    const result = await registerDeployKey(
      REPO,
      "deploy-key-prod",
      PUBLIC_KEY,
      true,
      makeDeps(),
    );
    expect(result.id).toBe(1234567);
    expect(listCalls).toBe(2);
  });
});
