/**
 * Unit tests for `packages/core/commands/init.ts`.
 *
 * All underlying steps are replaced by in-memory fakes via the `deps`
 * injection bag — no SSH, HTTP, or filesystem calls are made.
 */

import { describe, expect, it } from "vitest";
import { init } from "../../../commands/init.ts";
import type {
  InitDeps,
  InitOpts,
  ProvisionResult,
} from "../../../commands/init.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_PROVISION_RESULT: ProvisionResult = {
  host: "1.2.3.4",
  initialPrivateKeyPem:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
  databaseUrl: "postgresql://app:secret@1.2.3.4:5432/app",
};

/** A valid 12-word BIP-39 mnemonic (public test vector). */
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Build a minimal set of fakes covering all 6 steps. */
function makeDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    readMnemonic: async () => Buffer.from(TEST_MNEMONIC, "utf8"),
    provision: async (_opts) => ({ ...FAKE_PROVISION_RESULT }),
    bootstrapHost: async (_opts) => ({ k3sReady: true as const }),
    registerEnvDeployKey: async (_opts) => ({ keyId: 1, secretWritten: true }),
    pushEnvSecrets: async (_opts) => ({
      uploaded: ["DEPLOY_HOST_DEMO"],
      skipped: [],
    }),
    syncWorkflows: async (_opts) => ({
      changed: [".github/workflows/deploy.yml"],
      unchanged: [],
    }),
    deployEnv: async (_opts) => ({
      digest: "sha256:abc",
      rolledOut: ["my-app"],
      healthy: true as const,
    }),
    log: () => {},
    ...overrides,
  };
}

function baseOpts(overrides: Partial<InitOpts> = {}): InitOpts {
  return {
    env: "demo",
    provider: "aws",
    repo: "acme/my-app",
    imageTag: "v1.0.0",
    ...overrides,
  };
}

// ── Happy path ─────────────────────────────────────────────────────────────────

describe("init — happy path", () => {
  it("returns host and deployUrl from provision and deploy", async () => {
    const result = await init(baseOpts({ deps: makeDeps() }));
    expect(result.host).toBe("1.2.3.4");
    expect(result.deployUrl).toBe("https://1.2.3.4");
  });

  it("calls each step in order with correct args", async () => {
    const calls: string[] = [];

    const deps = makeDeps({
      provision: async (opts) => {
        calls.push("provision");
        expect(opts.env).toBe("demo");
        expect(opts.repo).toBe("acme/my-app");
        return { ...FAKE_PROVISION_RESULT };
      },
      bootstrapHost: async (opts) => {
        calls.push("bootstrap");
        expect(opts.host).toBe("1.2.3.4");
        expect(opts.user).toBe("root");
        return { k3sReady: true as const };
      },
      registerEnvDeployKey: async (opts) => {
        calls.push("deploy-key");
        expect(opts.repo).toBe("acme/my-app");
        expect(opts.env).toBe("demo");
        return { keyId: 1, secretWritten: true };
      },
      pushEnvSecrets: async (opts) => {
        calls.push("secrets");
        expect(opts.repo).toBe("acme/my-app");
        expect(opts.env).toBe("demo");
        expect(opts.host).toBe("1.2.3.4");
        expect(opts.databaseUrl).toBe(
          "postgresql://app:secret@1.2.3.4:5432/app",
        );
        return { uploaded: [], skipped: [] };
      },
      syncWorkflows: async (opts) => {
        calls.push("sync");
        expect(opts.repo).toBe("acme/my-app");
        expect(opts.appName).toBe("my-app");
        return { changed: [], unchanged: [] };
      },
      deployEnv: async (opts) => {
        calls.push("deploy");
        expect(opts.repo).toBe("acme/my-app");
        expect(opts.env).toBe("demo");
        expect(opts.tag).toBe("v1.0.0");
        expect(opts.appName).toBe("my-app");
        expect(opts.host).toBe("1.2.3.4");
        return {
          digest: "sha256:abc",
          rolledOut: ["my-app"],
          healthy: true as const,
        };
      },
    });

    await init(baseOpts({ deps }));
    expect(calls).toEqual([
      "provision",
      "bootstrap",
      "deploy-key",
      "secrets",
      "sync",
      "deploy",
    ]);
  });

  it("uses localDatabaseUrl when provision returns no databaseUrl", async () => {
    let capturedDbUrl: string | undefined;
    const deps = makeDeps({
      provision: async () => ({
        host: "1.2.3.4",
        initialPrivateKeyPem: "fake-pem",
      }),
      pushEnvSecrets: async (opts) => {
        capturedDbUrl = opts.databaseUrl;
        return { uploaded: [], skipped: [] };
      },
    });

    await init(baseOpts({ deps }));
    expect(capturedDbUrl).toMatch(/postgres-demo/);
  });

  it("passes managedDb=true mnemonic copy to provision", async () => {
    let capturedMnemonic: Buffer | undefined;
    const deps = makeDeps({
      provision: async (opts) => {
        capturedMnemonic = opts.mnemonic;
        return { ...FAKE_PROVISION_RESULT };
      },
    });
    await init(baseOpts({ deps, managedDb: true }));
    expect(capturedMnemonic).toBeDefined();
    expect(capturedMnemonic!.length).toBeGreaterThan(0);
  });
});

// ── --from-step ────────────────────────────────────────────────────────────────

describe("init — --from-step", () => {
  it("skips steps 1-2 when fromStep=3", async () => {
    const calls: string[] = [];

    const deps = makeDeps({
      provision: async () => {
        calls.push("provision");
        return { ...FAKE_PROVISION_RESULT };
      },
      bootstrapHost: async () => {
        calls.push("bootstrap");
        return { k3sReady: true as const };
      },
      registerEnvDeployKey: async () => {
        calls.push("deploy-key");
        return { keyId: 1, secretWritten: true };
      },
      pushEnvSecrets: async () => {
        calls.push("secrets");
        return { uploaded: [], skipped: [] };
      },
      syncWorkflows: async () => {
        calls.push("sync");
        return { changed: [], unchanged: [] };
      },
      deployEnv: async () => {
        calls.push("deploy");
        return { digest: "sha256:abc", rolledOut: [], healthy: true as const };
      },
    });

    await init(baseOpts({ deps, fromStep: 3 }));

    // provision is still called (to recover the host), bootstrap is skipped.
    expect(calls).toContain("deploy-key");
    expect(calls).toContain("secrets");
    expect(calls).toContain("sync");
    expect(calls).toContain("deploy");
    expect(calls).not.toContain("bootstrap");
  });

  it("skips all preceding steps when fromStep=6", async () => {
    const calls: string[] = [];

    const deps = makeDeps({
      provision: async () => {
        calls.push("provision");
        return { ...FAKE_PROVISION_RESULT };
      },
      bootstrapHost: async () => {
        calls.push("bootstrap");
        return { k3sReady: true as const };
      },
      registerEnvDeployKey: async () => {
        calls.push("deploy-key");
        return { keyId: 1, secretWritten: true };
      },
      pushEnvSecrets: async () => {
        calls.push("secrets");
        return { uploaded: [], skipped: [] };
      },
      syncWorkflows: async () => {
        calls.push("sync");
        return { changed: [], unchanged: [] };
      },
      deployEnv: async () => {
        calls.push("deploy");
        return { digest: "sha256:abc", rolledOut: [], healthy: true as const };
      },
    });

    await init(baseOpts({ deps, fromStep: 6 }));

    expect(calls).toContain("deploy");
    expect(calls).not.toContain("bootstrap");
    expect(calls).not.toContain("deploy-key");
    expect(calls).not.toContain("secrets");
    expect(calls).not.toContain("sync");
  });

  it("returns correct host even when skipping to fromStep=4", async () => {
    const deps = makeDeps({
      provision: async () => ({ ...FAKE_PROVISION_RESULT, host: "9.8.7.6" }),
    });

    const result = await init(baseOpts({ deps, fromStep: 4 }));
    expect(result.host).toBe("9.8.7.6");
  });
});

// ── Error handling ─────────────────────────────────────────────────────────────

describe("init — error handling", () => {
  it("wraps provision error with step name and hint", async () => {
    const deps = makeDeps({
      provision: async () => {
        throw new Error("quota exceeded");
      },
    });

    await expect(init(baseOpts({ deps }))).rejects.toThrow(
      /\[step 1\/6\] provision failed: quota exceeded/,
    );
  });

  it("wraps bootstrap error with step name and hint", async () => {
    const deps = makeDeps({
      bootstrapHost: async () => {
        throw new Error("SSH timeout");
      },
    });

    await expect(init(baseOpts({ deps }))).rejects.toThrow(
      /\[step 2\/6\] bootstrap failed: SSH timeout/,
    );
  });

  it("wraps deploy-key error with step name and hint", async () => {
    const deps = makeDeps({
      registerEnvDeployKey: async () => {
        throw new Error("403 Forbidden");
      },
    });

    await expect(init(baseOpts({ deps }))).rejects.toThrow(
      /\[step 3\/6\] deploy-key failed: 403 Forbidden/,
    );
  });

  it("wraps secrets error with step name and hint", async () => {
    const deps = makeDeps({
      pushEnvSecrets: async () => {
        throw new Error("token expired");
      },
    });

    await expect(init(baseOpts({ deps }))).rejects.toThrow(
      /\[step 4\/6\] secrets failed: token expired/,
    );
  });

  it("wraps sync error with step name and hint", async () => {
    const deps = makeDeps({
      syncWorkflows: async () => {
        throw new Error("network error");
      },
    });

    await expect(init(baseOpts({ deps }))).rejects.toThrow(
      /\[step 5\/6\] sync failed: network error/,
    );
  });

  it("wraps deploy error with step name and hint", async () => {
    const deps = makeDeps({
      deployEnv: async () => {
        throw new Error("rollout timeout");
      },
    });

    await expect(init(baseOpts({ deps }))).rejects.toThrow(
      /\[step 6\/6\] deploy failed: rollout timeout/,
    );
  });

  it("error messages include a human-readable hint", async () => {
    const deps = makeDeps({
      bootstrapHost: async () => {
        throw new Error("install.sh failed");
      },
    });

    let caught: Error | undefined;
    try {
      await init(baseOpts({ deps }));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/hint:/);
  });
});

// ── Logging ───────────────────────────────────────────────────────────────────

describe("init — step transition logging", () => {
  it("logs each step transition", async () => {
    const lines: string[] = [];
    const deps = makeDeps({ log: (l) => lines.push(l) });

    await init(baseOpts({ deps }));

    expect(lines.some((l) => l.includes("provision"))).toBe(true);
    expect(lines.some((l) => l.includes("bootstrap"))).toBe(true);
    expect(lines.some((l) => l.includes("deploy-key"))).toBe(true);
    expect(lines.some((l) => l.includes("secrets"))).toBe(true);
    expect(lines.some((l) => l.includes("sync"))).toBe(true);
    expect(lines.some((l) => l.includes("deploy"))).toBe(true);
  });

  it("logs skip messages for skipped steps", async () => {
    const lines: string[] = [];
    const deps = makeDeps({ log: (l) => lines.push(l) });

    await init(baseOpts({ deps, fromStep: 4 }));

    // Steps 2 and 3 should be marked as skipped.
    expect(
      lines.some(
        (l) => l.toLowerCase().includes("skip") && l.includes("bootstrap"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) => l.toLowerCase().includes("skip") && l.includes("deploy-key"),
      ),
    ).toBe(true);
  });
});
