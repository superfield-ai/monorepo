import { describe, it, expect, vi } from "vitest";
import { runDeviceCodeFlow } from "../../gcp/login.ts";
import type { LoginDeps } from "../../gcp/login.ts";

function makeDeviceCodeResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    device_code: "device-code-abc",
    user_code: "ABCD-1234",
    verification_url: "https://accounts.google.com/device",
    expires_in: 1800,
    interval: 5,
    ...overrides,
  });
}

function makeSuccessTokenResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    access_token: "new-access-token",
    expires_in: 3600,
    refresh_token: "new-refresh-token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    token_type: "Bearer",
    ...overrides,
  });
}

function makeErrorTokenResponse(error: string) {
  return JSON.stringify({ error });
}

function makeDeps(overrides: Partial<LoginDeps> = {}): LoginDeps {
  return {
    env: () => undefined,
    readFile: () => {
      throw new Error("readFile not configured");
    },
    writeFile: () => {},
    fileExists: () => false,
    fetch: async () => new Response("{}", { status: 200 }),
    now: () => Date.now(),
    log: () => {},
    sleep: async () => {},
    ...overrides,
  };
}

describe("runDeviceCodeFlow", () => {
  it("happy path: writes token file on success", async () => {
    const writtenFiles: Record<string, string> = {};

    // First call returns device code, second returns success token
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(makeDeviceCodeResponse(), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(makeSuccessTokenResponse(), { status: 200 }),
      );

    const deps = makeDeps({
      fetch: fetchMock,
      writeFile: (p, c) => {
        writtenFiles[p] = c;
      },
      env: (name) =>
        name === "GCP_OAUTH_TOKEN_FILE" ? "/tmp/sf-oauth.json" : undefined,
    });

    await runDeviceCodeFlow(
      {
        clientId: "client-id",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        timeoutMs: 60_000,
        tokenFilePath: "/tmp/sf-oauth.json",
      },
      deps,
    );

    expect(writtenFiles["/tmp/sf-oauth.json"]).toBeDefined();
    const written = JSON.parse(writtenFiles["/tmp/sf-oauth.json"]!);
    expect(written.access_token).toBe("new-access-token");
    expect(written.refresh_token).toBe("new-refresh-token");
    expect(written.client_id).toBe("client-id");
  });

  it("handles authorization_pending correctly (keeps polling)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(makeDeviceCodeResponse(), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(makeErrorTokenResponse("authorization_pending"), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(makeErrorTokenResponse("authorization_pending"), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(makeSuccessTokenResponse(), { status: 200 }),
      );

    const deps = makeDeps({
      fetch: fetchMock,
      writeFile: () => {},
    });

    await runDeviceCodeFlow(
      {
        clientId: "client-id",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        timeoutMs: 60_000,
        tokenFilePath: "/tmp/sf-oauth.json",
      },
      deps,
    );

    // 1 device code request + 3 poll requests
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("handles slow_down (increases interval)", async () => {
    const sleepCalls: number[] = [];
    let callCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (_url: string) => {
      callCount += 1;
      if (callCount === 1) {
        // device code request
        return new Response(makeDeviceCodeResponse({ interval: 5 }), {
          status: 200,
        });
      }
      if (callCount === 2) {
        return new Response(makeErrorTokenResponse("slow_down"), {
          status: 400,
        });
      }
      return new Response(makeSuccessTokenResponse(), { status: 200 });
    });

    const deps = makeDeps({
      fetch: fetchMock,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      writeFile: () => {},
    });

    await runDeviceCodeFlow(
      {
        clientId: "client-id",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        timeoutMs: 60_000,
        tokenFilePath: "/tmp/sf-oauth.json",
      },
      deps,
    );

    // First sleep: 5*1000=5000, after slow_down it should be 10000
    expect(sleepCalls[0]).toBe(5_000);
    expect(sleepCalls[1]).toBe(10_000);
  });

  it("throws on access_denied", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(makeDeviceCodeResponse(), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(makeErrorTokenResponse("access_denied"), { status: 400 }),
      );

    const deps = makeDeps({ fetch: fetchMock });

    await expect(
      runDeviceCodeFlow(
        {
          clientId: "client-id",
          scope: "https://www.googleapis.com/auth/cloud-platform",
          timeoutMs: 60_000,
          tokenFilePath: "/tmp/sf-oauth.json",
        },
        deps,
      ),
    ).rejects.toThrow("denied by the user");
  });

  it("throws on timeout", async () => {
    let nowValue = 1_000_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(makeDeviceCodeResponse(), { status: 200 }),
      )
      // Each poll returns pending; now() advances past timeout
      .mockResolvedValue(
        new Response(makeErrorTokenResponse("authorization_pending"), {
          status: 400,
        }),
      );

    const deps = makeDeps({
      fetch: fetchMock,
      // Advance time by more than timeoutMs on each sleep call
      sleep: async () => {
        nowValue += 100_000;
      },
      now: () => nowValue,
    });

    await expect(
      runDeviceCodeFlow(
        {
          clientId: "client-id",
          scope: "https://www.googleapis.com/auth/cloud-platform",
          timeoutMs: 60_000,
          tokenFilePath: "/tmp/sf-oauth.json",
        },
        deps,
      ),
    ).rejects.toThrow("Timed out");
  });
});
