import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  handleDeployRequest,
  _resetRollbackJobs,
  _injectKubectlLogs,
} from "../../src/deploy";

beforeEach(() => {
  _resetRollbackJobs();
  _injectKubectlLogs(null);
});

afterEach(() => {
  _injectKubectlLogs(null);
});

function makeReq(method: string, pathname: string, body?: object): Request {
  const url = `http://localhost${pathname}`;
  if (body) {
    return new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new Request(url, { method });
}

function makeUrl(pathname: string): URL {
  return new URL(`http://localhost${pathname}`);
}

describe("handleDeployRequest — routing", () => {
  it("returns null for unrelated paths", async () => {
    const res = await handleDeployRequest(
      makeReq("GET", "/studio/other"),
      makeUrl("/studio/other"),
    );
    expect(res).toBeNull();
  });

  it("returns 404-style envelope for unknown deploy sub-path", async () => {
    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/unknown"),
      makeUrl("/studio/deploy/unknown"),
    );
    expect(res).not.toBeNull();
    const body = (await res!.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("not_found");
  });
});

describe("GET /studio/deploy/envs", () => {
  it("returns a non-empty env list (real or fallback)", async () => {
    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/envs"),
      makeUrl("/studio/deploy/envs"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      envs: string[];
      source: string;
    };
    expect(Array.isArray(body.envs)).toBe(true);
    expect(body.envs.length).toBeGreaterThan(0);
    expect(["github", "fallback"]).toContain(body.source);
  });
});

describe("GET /studio/deploy/secrets/:env", () => {
  it("returns a checks array with all required secret names", async () => {
    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/secrets/dev"),
      makeUrl("/studio/deploy/secrets/dev"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      env: string;
      checks: { name: string; present: boolean; detail: string }[];
    };
    expect(body.env).toBe("dev");
    const names = body.checks.map((c) => c.name);
    expect(names).toContain("DEPLOY_HOST_DEV");
    expect(names).toContain("DEPLOY_KEY_DEV");
    expect(names).toContain("DATABASE_URL_DEV");
  });
});

describe("GET /studio/deploy/ci", () => {
  it("returns a runs array (possibly empty)", async () => {
    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/ci"),
      makeUrl("/studio/deploy/ci"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { runs: unknown[]; source: string };
    expect(Array.isArray(body.runs)).toBe(true);
  });
});

describe("POST /studio/deploy/rollback/:env", () => {
  it("rejects without { confirm: true }", async () => {
    const res = await handleDeployRequest(
      makeReq("POST", "/studio/deploy/rollback/dev", {}),
      makeUrl("/studio/deploy/rollback/dev"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation");
  });

  it("returns a jobId when confirmed", async () => {
    const res = await handleDeployRequest(
      makeReq("POST", "/studio/deploy/rollback/dev", { confirm: true }),
      makeUrl("/studio/deploy/rollback/dev"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { jobId: string; env: string };
    expect(typeof body.jobId).toBe("string");
    expect(body.env).toBe("dev");
  });
});

describe("GET /studio/deploy/rollback-log", () => {
  it("400s when job param is missing", async () => {
    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/rollback-log"),
      makeUrl("/studio/deploy/rollback-log"),
    );
    expect(res!.status).toBe(400);
  });

  it("404s for unknown job id", async () => {
    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/rollback-log?job=missing"),
      makeUrl("/studio/deploy/rollback-log?job=missing"),
    );
    expect(res!.status).toBe(404);
  });

  it("streams the buffered log of an in-flight job", async () => {
    const startRes = await handleDeployRequest(
      makeReq("POST", "/studio/deploy/rollback/dev", { confirm: true }),
      makeUrl("/studio/deploy/rollback/dev"),
    );
    const { jobId } = (await startRes!.json()) as { jobId: string };
    // Wait for the synthetic job to complete.
    await new Promise((r) => setTimeout(r, 250));
    const logRes = await handleDeployRequest(
      makeReq("GET", `/studio/deploy/rollback-log?job=${jobId}`),
      makeUrl(`/studio/deploy/rollback-log?job=${jobId}`),
    );
    expect(logRes!.status).toBe(200);
    expect(logRes!.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await logRes!.text();
    expect(text).toContain("rollback request accepted");
    expect(text).toContain("event: done");
  });
});

describe("GET /studio/deploy/migration-log", () => {
  it("400s when env param is missing", async () => {
    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/migration-log"),
      makeUrl("/studio/deploy/migration-log"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation");
  });

  it("streams injected log lines and emits done event", async () => {
    async function* fakeLines(_env: string): AsyncIterable<string> {
      yield "2024-01-01T00:00:00Z migrating schema";
      yield "2024-01-01T00:00:01Z migration complete";
    }
    _injectKubectlLogs(fakeLines);

    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/migration-log?env=dev"),
      makeUrl("/studio/deploy/migration-log?env=dev"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res!.text();
    expect(text).toContain("data: 2024-01-01T00:00:00Z migrating schema");
    expect(text).toContain("data: 2024-01-01T00:00:01Z migration complete");
    expect(text).toContain("event: done");
    expect(text).toContain("data: complete");
  });

  it("emits error event when injected generator throws", async () => {
    async function* failingLines(_env: string): AsyncIterable<string> {
      yield "starting";
      throw new Error("migration job not found");
    }
    _injectKubectlLogs(failingLines);

    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/migration-log?env=staging"),
      makeUrl("/studio/deploy/migration-log?env=staging"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const text = await res!.text();
    expect(text).toContain("event: error");
    expect(text).toContain("migration job not found");
  });

  it("passes the correct env to the kubectl injection", async () => {
    const seen: string[] = [];
    async function* captureEnv(env: string): AsyncIterable<string> {
      seen.push(env);
      yield `env-was: ${env}`;
    }
    _injectKubectlLogs(captureEnv);

    const res = await handleDeployRequest(
      makeReq("GET", "/studio/deploy/migration-log?env=prod"),
      makeUrl("/studio/deploy/migration-log?env=prod"),
    );
    // consume the stream so the generator runs
    await res!.text();
    expect(seen).toContain("prod");
  });
});
