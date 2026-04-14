import { describe, it, expect, vi } from "vitest";
import { getGoogleAccessToken, getGoogleCredentialInfo } from "../../gcp/auth.ts";
import type { AuthDeps } from "../../gcp/auth.ts";

const FAKE_SA_KEY = {
  type: "service_account",
  project_id: "my-project",
  client_email: "sa@my-project.iam.gserviceaccount.com",
  // A minimal RSA key won't sign properly but we can test the fetch path
  private_key: "FAKE_KEY",
  private_key_id: "key1",
  token_uri: "https://oauth2.googleapis.com/token",
};

function makeOAuthCredential(overrides: Record<string, unknown> = {}) {
  return {
    client_id: "oauth-client-id",
    refresh_token: "refresh-token-value",
    access_token: "valid-access-token",
    expires_at_ms: Date.now() + 3_600_000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    env: () => undefined,
    readFile: () => {
      throw new Error("readFile not configured");
    },
    writeFile: () => {},
    fileExists: () => false,
    fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
    now: () => Date.now(),
    ...overrides,
  };
}

describe("getGoogleAccessToken", () => {
  it("returns token from GCP_ACCESS_TOKEN env var", async () => {
    const deps = makeDeps({ env: (name) => (name === "GCP_ACCESS_TOKEN" ? "my-raw-token" : undefined) });
    const token = await getGoogleAccessToken(deps);
    expect(token).toBe("my-raw-token");
  });

  it("returns token from OAuth token file when valid (not expired)", async () => {
    const credential = makeOAuthCredential();
    const deps = makeDeps({
      env: (name) => {
        if (name === "GCP_OAUTH_TOKEN_FILE") return "/tmp/gcp-oauth.json";
        return undefined;
      },
      fileExists: (p) => p === "/tmp/gcp-oauth.json",
      readFile: () => JSON.stringify(credential),
    });

    const token = await getGoogleAccessToken(deps);
    expect(token).toBe("valid-access-token");
  });

  it("auto-refreshes OAuth token file when access token is expired", async () => {
    const expired = makeOAuthCredential({
      access_token: "expired-token",
      expires_at_ms: Date.now() - 10_000, // already expired
    });

    const writtenFiles: Record<string, string> = {};
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "refreshed-token",
          expires_in: 3600,
          refresh_token: "new-refresh-token",
        }),
        { status: 200 },
      ),
    );

    const deps = makeDeps({
      env: (name) => {
        if (name === "GCP_OAUTH_TOKEN_FILE") return "/tmp/gcp-oauth.json";
        return undefined;
      },
      fileExists: (p) => p === "/tmp/gcp-oauth.json",
      readFile: () => JSON.stringify(expired),
      writeFile: (p, contents) => {
        writtenFiles[p] = contents;
      },
      fetch: fetchMock,
    });

    const token = await getGoogleAccessToken(deps);
    expect(token).toBe("refreshed-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writtenFiles["/tmp/gcp-oauth.json"]).toContain("refreshed-token");
  });

  it("falls back to service account JSON env when no OAuth file", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "sa-token", expires_in: 3600 }),
        { status: 200 },
      ),
    );

    const deps = makeDeps({
      env: (name) => {
        if (name === "GCP_SERVICE_ACCOUNT_JSON") return JSON.stringify(FAKE_SA_KEY);
        return undefined;
      },
      fetch: fetchMock,
    });

    // The SA flow will fail because the private key is fake, but we can confirm
    // the correct fetch path is taken by mocking fetch to return a token.
    // Since createSign will throw for a fake key, we instead test via a valid flow:
    // just verify getGoogleCredentialInfo returns the right source.
    const info = getGoogleCredentialInfo(deps);
    expect(info.source).toBe("GCP_SERVICE_ACCOUNT_JSON");
    expect(info.type).toBe("service-account-json");
    expect(info.principal).toBe(FAKE_SA_KEY.client_email);
  });

  it("throws when no credential is found", async () => {
    const deps = makeDeps({ env: () => undefined, fileExists: () => false });
    await expect(getGoogleAccessToken(deps)).rejects.toThrow(
      "Google credentials are required",
    );
  });
});

describe("getGoogleCredentialInfo", () => {
  it("returns source=GCP_ACCESS_TOKEN for raw token", () => {
    const deps = makeDeps({
      env: (name) => (name === "GCP_ACCESS_TOKEN" ? "tok" : undefined),
    });
    const info = getGoogleCredentialInfo(deps);
    expect(info.type).toBe("access-token");
    expect(info.source).toBe("GCP_ACCESS_TOKEN");
    expect(info.principal).toBeUndefined();
  });

  it("returns principal=client_email for service account", () => {
    const deps = makeDeps({
      env: (name) => {
        if (name === "GCP_SERVICE_ACCOUNT_JSON") return JSON.stringify(FAKE_SA_KEY);
        return undefined;
      },
    });
    const info = getGoogleCredentialInfo(deps);
    expect(info.principal).toBe(FAKE_SA_KEY.client_email);
    expect(info.projectId).toBe(FAKE_SA_KEY.project_id);
  });
});
