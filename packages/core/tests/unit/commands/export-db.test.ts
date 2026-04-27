import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  detectDbMode,
  detectProvider,
  exportDb,
  type ExportDbDeps,
  type SshClientLike,
} from "../../../commands/export-db.ts";

// ---------------------------------------------------------------------------
// MSW server for managed-mode API calls
// ---------------------------------------------------------------------------

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// detectDbMode — unit tests
// ---------------------------------------------------------------------------

describe("detectDbMode", () => {
  it("returns 'local' for a k8s short service name (no dots)", () => {
    expect(detectDbMode("postgresql://postgres-prod:5432/app")).toBe("local");
  });

  it("returns 'local' for .svc suffix", () => {
    expect(detectDbMode("postgresql://postgres.default.svc:5432/app")).toBe(
      "local",
    );
  });

  it("returns 'local' for .cluster.local suffix", () => {
    expect(
      detectDbMode("postgresql://postgres.default.svc.cluster.local:5432/app"),
    ).toBe("local");
  });

  it("returns 'managed' for an external hostname", () => {
    expect(
      detectDbMode(
        "postgresql://mydb.xxxx.us-east-1.rds.amazonaws.com:5432/app",
      ),
    ).toBe("managed");
  });

  it("returns 'managed' for a GCP AlloyDB hostname", () => {
    expect(detectDbMode("postgresql://10.0.0.5:5432/app")).toBe("managed");
  });

  it("returns 'managed' for DigitalOcean managed DB URL", () => {
    expect(
      detectDbMode(
        "postgresql://user:pass@mydb.db.ondigitalocean.com:25060/defaultdb",
      ),
    ).toBe("managed");
  });

  it("returns 'managed' for unparseable URL", () => {
    expect(detectDbMode("not-a-url")).toBe("managed");
  });
});

// ---------------------------------------------------------------------------
// detectProvider — unit tests
// ---------------------------------------------------------------------------

describe("detectProvider", () => {
  it("detects gcp from alloydb hostname", () => {
    expect(detectProvider("postgresql://alloydb.googleapis.com:5432/app")).toBe(
      "gcp",
    );
  });

  it("detects aws from rds.amazonaws.com hostname", () => {
    expect(
      detectProvider(
        "postgresql://mydb.abc.us-east-1.rds.amazonaws.com:5432/app",
      ),
    ).toBe("aws");
  });

  it("detects digitalocean from db.ondigitalocean.com", () => {
    expect(
      detectProvider(
        "postgresql://user:p@db.ondigitalocean.com:25060/defaultdb",
      ),
    ).toBe("digitalocean");
  });

  it("returns undefined for unknown hostname", () => {
    expect(
      detectProvider("postgresql://myhost.example.com:5432/app"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fake SshClientLike for local-mode tests
// ---------------------------------------------------------------------------

class FakeSshClient implements SshClientLike {
  readonly calls: { command: string; outPath: string }[] = [];
  private content: string;
  private exitCode: number;

  constructor(opts: { content?: string; exitCode?: number } = {}) {
    this.content = opts.content ?? "PGDUMP_BINARY_CONTENT";
    this.exitCode = opts.exitCode ?? 0;
  }

  async execToFile(command: string, outPath: string): Promise<number> {
    this.calls.push({ command, outPath });
    if (this.exitCode === 0) {
      await fsp.writeFile(outPath, this.content, "utf8");
    }
    return this.exitCode;
  }
}

// ---------------------------------------------------------------------------
// Helper: make a temp output path
// ---------------------------------------------------------------------------

async function makeTmpOut(suffix = ".dump"): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "export-db-test-"));
  return path.join(dir, `out${suffix}`);
}

// ---------------------------------------------------------------------------
// Local mode tests
// ---------------------------------------------------------------------------

describe("exportDb — local mode", () => {
  it("calls SshClient with correct kubectl exec command for the given env", async () => {
    const fake = new FakeSshClient();
    const outPath = await makeTmpOut();

    const result = await exportDb({
      repo: "owner/app",
      env: "prod",
      out: outPath,
      deps: buildLocalDeps(fake, "postgresql://postgres-prod:5432/app"),
    });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.command).toContain("kubectl exec");
    expect(call.command).toContain("postgres-prod-0");
    expect(call.command).toContain("pg_dump -Fc app");
    expect(call.outPath).toBe(outPath);
    expect(result.outPath).toBe(outPath);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("uses env name in the pod name", async () => {
    const fake = new FakeSshClient();
    const outPath = await makeTmpOut();

    await exportDb({
      repo: "owner/app",
      env: "staging",
      out: outPath,
      deps: buildLocalDeps(fake, "postgresql://postgres-staging:5432/app"),
    });

    expect(fake.calls[0]!.command).toContain("postgres-staging-0");
  });

  it("throws if SshClient returns non-zero exit code", async () => {
    const fake = new FakeSshClient({ exitCode: 1 });
    const outPath = await makeTmpOut();

    await expect(
      exportDb({
        repo: "owner/app",
        env: "prod",
        out: outPath,
        deps: buildLocalDeps(fake, "postgresql://postgres-prod:5432/app"),
      }),
    ).rejects.toThrow(/pg_dump over SSH failed/);
  });

  it("reports correct file size and sha256 in result", async () => {
    const content = "FAKE_PG_DUMP_DATA_12345";
    const fake = new FakeSshClient({ content });
    const outPath = await makeTmpOut();

    const result = await exportDb({
      repo: "owner/app",
      env: "prod",
      out: outPath,
      deps: buildLocalDeps(fake, "postgresql://postgres-prod:5432/app"),
    });

    const stat = await fsp.stat(outPath);
    expect(result.bytes).toBe(stat.size);
    expect(result.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("throws if DEPLOY_HOST is not set and no sshHost dep provided", async () => {
    const outPath = await makeTmpOut();
    const originalHost = process.env["DEPLOY_HOST"];
    delete process.env["DEPLOY_HOST"];

    try {
      await expect(
        exportDb({
          repo: "owner/app",
          env: "prod",
          out: outPath,
          deps: {
            getRepoSecret: async () => "postgresql://postgres-prod:5432/app",
            sshPrivateKeyPem: "FAKE_KEY",
            // no sshHost, no makeSshClient
          },
        }),
      ).rejects.toThrow(/DEPLOY_HOST/);
    } finally {
      if (originalHost !== undefined) {
        process.env["DEPLOY_HOST"] = originalHost;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Managed mode — GCP AlloyDB
// ---------------------------------------------------------------------------

describe("exportDb — managed mode, GCP AlloyDB", () => {
  it("triggers a backup via POST and writes a receipt JSON", async () => {
    const operationName =
      "projects/my-project/locations/us-central1/operations/op-123";

    // Use a regex to match the URL — path-to-regexp can't handle `:cluster:backup`
    server.use(
      http.post(
        /https:\/\/alloydb\.googleapis\.com\/v1\/projects\/.+\/clusters.+/,
        () => HttpResponse.json({ name: operationName }, { status: 200 }),
      ),
    );

    const outPath = await makeTmpOut(".json");
    const logs: string[] = [];

    const result = await exportDb({
      repo: "owner/app",
      env: "prod",
      provider: "gcp",
      out: outPath,
      deps: buildManagedGcpDeps(logs),
    });

    const content = await fsp.readFile(outPath, "utf8");
    const receipt = JSON.parse(content) as Record<string, unknown>;
    expect(receipt.provider).toBe("gcp");
    expect(receipt.operationName).toBe(operationName);
    expect(receipt.env).toBe("prod");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("throws when GCP backup API returns an error", async () => {
    server.use(
      http.post(
        /https:\/\/alloydb\.googleapis\.com\/v1\/projects\/.+\/clusters.+/,
        () =>
          HttpResponse.json(
            { error: { message: "Permission denied" } },
            { status: 403 },
          ),
      ),
    );

    const outPath = await makeTmpOut(".json");

    await expect(
      exportDb({
        repo: "owner/app",
        env: "prod",
        provider: "gcp",
        out: outPath,
        deps: buildManagedGcpDeps([]),
      }),
    ).rejects.toThrow(/GCP AlloyDB backup API failed.*403/);
  });
});

// ---------------------------------------------------------------------------
// Managed mode — AWS RDS
// ---------------------------------------------------------------------------

describe("exportDb — managed mode, AWS RDS", () => {
  it("triggers CreateDBSnapshot and writes a receipt JSON", async () => {
    server.use(
      http.post("https://rds.us-east-1.amazonaws.com/", async ({ request }) => {
        const text = await request.text();
        const params = new URLSearchParams(text);
        if (params.get("Action") === "CreateDBSnapshot") {
          const snapshotId = params.get("DBSnapshotIdentifier") ?? "";
          return HttpResponse.xml(
            `<CreateDBSnapshotResponse><CreateDBSnapshotResult><DBSnapshot><DBSnapshotIdentifier>${snapshotId}</DBSnapshotIdentifier></DBSnapshot></CreateDBSnapshotResult></CreateDBSnapshotResponse>`,
          );
        }
        return new HttpResponse(null, { status: 400 });
      }),
    );

    const outPath = await makeTmpOut(".json");
    const logs: string[] = [];

    const result = await exportDb({
      repo: "owner/app",
      env: "staging",
      provider: "aws",
      out: outPath,
      deps: buildManagedAwsDeps(logs, "us-east-1"),
    });

    const content = await fsp.readFile(outPath, "utf8");
    const receipt = JSON.parse(content) as Record<string, unknown>;
    expect(receipt.provider).toBe("aws");
    expect(typeof receipt.snapshotId).toBe("string");
    expect(receipt.snapshotId as string).toContain("superfield-staging");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("throws when AWS RDS API returns a non-ok response", async () => {
    server.use(
      http.post(
        "https://rds.us-west-2.amazonaws.com/",
        () => new HttpResponse("AccessDenied", { status: 403 }),
      ),
    );

    const outPath = await makeTmpOut(".json");

    await expect(
      exportDb({
        repo: "owner/app",
        env: "prod",
        provider: "aws",
        out: outPath,
        deps: buildManagedAwsDeps([], "us-west-2"),
      }),
    ).rejects.toThrow(/AWS RDS CreateDBSnapshot failed.*403/);
  });
});

// ---------------------------------------------------------------------------
// Managed mode — DigitalOcean / Vultr (SSH fallback)
// ---------------------------------------------------------------------------

describe("exportDb — managed mode, DigitalOcean/Vultr SSH fallback", () => {
  it("falls back to pg_dump over SSH for DigitalOcean", async () => {
    const fake = new FakeSshClient();
    const outPath = await makeTmpOut();

    await exportDb({
      repo: "owner/app",
      env: "prod",
      provider: "digitalocean",
      out: outPath,
      deps: {
        getRepoSecret: async () =>
          "postgresql://user:p@mydb.db.ondigitalocean.com:25060/defaultdb",
        makeSshClient: () => fake,
        sshHost: "10.0.0.1",
        sshPrivateKeyPem: "FAKE_KEY",
      },
    });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.command).toContain("pg_dump -Fc app");
  });

  it("falls back to pg_dump over SSH for Vultr", async () => {
    const fake = new FakeSshClient();
    const outPath = await makeTmpOut();

    await exportDb({
      repo: "owner/app",
      env: "staging",
      provider: "vultr",
      out: outPath,
      deps: {
        getRepoSecret: async () =>
          "postgresql://user:p@mydb.vultr.example.com:5432/defaultdb",
        makeSshClient: () => fake,
        sshHost: "10.0.0.2",
        sshPrivateKeyPem: "FAKE_KEY",
      },
    });

    expect(fake.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mode detection integration: getRepoSecret drives mode
// ---------------------------------------------------------------------------

describe("exportDb — mode detection from secret", () => {
  it("uses local mode when DATABASE_URL_<ENV> is a k8s service URL", async () => {
    const fake = new FakeSshClient();
    const outPath = await makeTmpOut();

    await exportDb({
      repo: "owner/app",
      env: "prod",
      out: outPath,
      deps: {
        getRepoSecret: async (_repo, name) => {
          if (name === "DATABASE_URL_PROD") {
            return "postgresql://postgres-prod:5432/app";
          }
          return undefined;
        },
        makeSshClient: () => fake,
        sshHost: "10.0.0.1",
        sshPrivateKeyPem: "FAKE_KEY",
      },
    });

    expect(fake.calls).toHaveLength(1);
  });

  it("uses managed mode when DATABASE_URL_<ENV> is an external URL", async () => {
    server.use(
      http.post(
        /https:\/\/alloydb\.googleapis\.com\/v1\/projects\/.+\/clusters.+/,
        () => HttpResponse.json({ name: "op-999" }, { status: 200 }),
      ),
    );

    const outPath = await makeTmpOut(".json");
    const logs: string[] = [];

    await exportDb({
      repo: "owner/app",
      env: "prod",
      out: outPath,
      deps: {
        getRepoSecret: async (_repo, name) => {
          if (name === "DATABASE_URL_PROD") {
            return "postgresql://alloydb.googleapis.com:5432/app";
          }
          return undefined;
        },
        fetch: globalThis.fetch,
        getGcpAccessToken: async () => "test-token",
        onLog: (line) => logs.push(line),
      },
    });

    expect(logs.some((l) => l.includes("managed"))).toBe(true);
  });

  it("throws when no DATABASE_URL secret is found and no env var set", async () => {
    const outPath = await makeTmpOut();
    const savedEnv = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];

    try {
      await expect(
        exportDb({
          repo: "owner/app",
          env: "prod",
          out: outPath,
          deps: {
            getRepoSecret: async () => undefined,
          },
        }),
      ).rejects.toThrow(/DATABASE_URL_PROD.*not found/);
    } finally {
      if (savedEnv !== undefined) process.env["DATABASE_URL"] = savedEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Output path and sha256 reporting
// ---------------------------------------------------------------------------

describe("exportDb — output path and hash reporting", () => {
  it("resolves relative out path to absolute", async () => {
    const fake = new FakeSshClient({ content: "data" });
    const tmpDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "export-db-resolve-"),
    );
    const outPath = path.join(tmpDir, "out.dump");

    const result = await exportDb({
      repo: "owner/app",
      env: "prod",
      out: outPath,
      deps: buildLocalDeps(fake, "postgresql://postgres-prod:5432/app"),
    });

    expect(path.isAbsolute(result.outPath)).toBe(true);
  });

  it("includes a valid sha256 in result", async () => {
    const fake = new FakeSshClient({ content: "known content" });
    const outPath = await makeTmpOut();

    const result = await exportDb({
      repo: "owner/app",
      env: "prod",
      out: outPath,
      deps: buildLocalDeps(fake, "postgresql://postgres-prod:5432/app"),
    });

    expect(result.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildLocalDeps(
  fake: FakeSshClient,
  databaseUrl: string,
): ExportDbDeps {
  return {
    getRepoSecret: async () => databaseUrl,
    makeSshClient: () => fake,
    sshHost: "10.0.0.1",
    sshPrivateKeyPem: "-----BEGIN FAKE KEY-----\nFAKE\n-----END FAKE KEY-----",
  };
}

function buildManagedGcpDeps(logs: string[]): ExportDbDeps {
  // Override env vars used by the GCP path
  process.env["GCP_PROJECT_ID"] = "my-project";
  process.env["GCP_REGION"] = "us-central1";
  process.env["ALLOYDB_CLUSTER_ID"] = "superfield-db";
  process.env["ALLOYDB_INSTANCE_ID"] = "superfield-db-primary";

  return {
    getRepoSecret: async () => "postgresql://alloydb.googleapis.com:5432/app",
    fetch: globalThis.fetch,
    getGcpAccessToken: async () => "fake-gcp-token",
    onLog: (line) => logs.push(line),
  };
}

function buildManagedAwsDeps(logs: string[], region: string): ExportDbDeps {
  process.env["RDS_DB_INSTANCE_ID"] = "superfield-prod";

  return {
    getRepoSecret: async () =>
      `postgresql://superfield-prod.abc.${region}.rds.amazonaws.com:5432/app`,
    fetch: globalThis.fetch,
    getAwsCredentials: async () => ({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region,
    }),
    onLog: (line) => logs.push(line),
  };
}
