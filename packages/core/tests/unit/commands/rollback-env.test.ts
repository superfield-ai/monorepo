import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import {
  rollbackEnv,
} from "../../../commands/rollback-env.ts";
import type {
  KubeRunner,
  KubeRunResult,
} from "../../../commands/deploy-env.ts";

/**
 * In-memory recorder used as the production {@link KubeRunner} interface
 * during tests. NOT a mock — implements the real interface and records
 * each invocation so we can assert call order.
 */
class RecorderRunner implements KubeRunner {
  readonly calls: { command: string; stdin?: string }[] = [];
  constructor(
    private readonly respond: (
      command: string,
      stdin: string | undefined,
      callIndex: number,
    ) => KubeRunResult,
  ) {}
  async exec(
    command: string,
    opts?: { stdin?: string },
  ): Promise<KubeRunResult> {
    const idx = this.calls.length;
    this.calls.push({ command, stdin: opts?.stdin });
    return this.respond(command, opts?.stdin, idx);
  }
}

const ok = (stdout = ""): KubeRunResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});
const fail = (stderr = "boom", exitCode = 1): KubeRunResult => ({
  stdout: "",
  stderr,
  exitCode,
});

const REPO = "owner/app";
const HOST = "127.0.0.1";
const APP_DIGEST = "ghcr.io/owner/app@sha256:" + "a".repeat(64);
const WORKER_A_DIGEST = "ghcr.io/owner/app@sha256:" + "b".repeat(64);
const WORKER_B_DIGEST = "ghcr.io/owner/app@sha256:" + "c".repeat(64);

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function githubDeploymentHandlers() {
  let nextId = 2001;
  const statuses: { id: number; state: string; description: string }[] = [];
  return {
    statuses,
    handlers: [
      http.post(
        `https://api.github.com/repos/${REPO}/deployments`,
        async () =>
          HttpResponse.json(
            { id: nextId++, environment: "prod" },
            { status: 201 },
          ),
      ),
      http.post(
        `https://api.github.com/repos/${REPO}/deployments/:id/statuses`,
        async ({ request, params }) => {
          const body = (await request.json()) as {
            state: string;
            description: string;
          };
          statuses.push({
            id: Number(params.id),
            state: body.state,
            description: body.description,
          });
          return HttpResponse.json({ ok: true }, { status: 201 });
        },
      ),
    ],
  };
}

function commonOpts(
  overrides: Partial<Parameters<typeof rollbackEnv>[0]> = {},
) {
  return {
    repo: REPO,
    env: "prod",
    appName: "app",
    workerNames: ["worker-a", "worker-b"],
    host: HOST,
    sshPrivateKeyPem: "-----BEGIN FAKE-----\n-----END FAKE-----\n",
    knownHostsPath: "/tmp/known_hosts.test",
    deps: {
      githubToken: "ghs_test_token",
      trustHostKey: async () => {},
      openTunnel: async () => ({ close: async () => {} }),
    },
    ...overrides,
  };
}

function digestRunner(): RecorderRunner {
  // Returns the per-deployment digest when asked; succeeds for everything else.
  return new RecorderRunner((cmd) => {
    if (!cmd.startsWith("kubectl get ")) return ok();
    if (cmd.includes("deployment/worker-a")) return ok(WORKER_A_DIGEST);
    if (cmd.includes("deployment/worker-b")) return ok(WORKER_B_DIGEST);
    if (cmd.includes("deployment/app")) return ok(APP_DIGEST);
    return ok();
  });
}

describe("rollbackEnv", () => {
  it("happy path: undo + status for app and each worker, captures digests", async () => {
    const dep = githubDeploymentHandlers();
    server.use(...dep.handlers);

    const runner = digestRunner();
    const result = await rollbackEnv(
      commonOpts({
        deps: {
          githubToken: "ghs_test_token",
          trustHostKey: async () => {},
          openTunnel: async () => ({ close: async () => {} }),
          runner,
        },
      }),
    );

    expect(result.healthy).toBe(true);
    expect(result.rolledBackTo).toEqual({
      app: APP_DIGEST,
      "worker-a": WORKER_A_DIGEST,
      "worker-b": WORKER_B_DIGEST,
    });

    const cmds = runner.calls.map((c) => c.command);
    // app: undo, status, get
    expect(cmds[0]).toMatch(/^kubectl rollout undo -n default deployment\/app$/);
    expect(cmds[1]).toMatch(
      /^kubectl rollout status -n default deployment\/app --timeout=5m$/,
    );
    expect(cmds[2]).toMatch(
      /^kubectl get -n default deployment\/app -o jsonpath=/,
    );
    // worker-a
    expect(cmds[3]).toMatch(/rollout undo .* deployment\/worker-a/);
    expect(cmds[4]).toMatch(/rollout status .* deployment\/worker-a/);
    expect(cmds[5]).toMatch(/get .* deployment\/worker-a/);
    // worker-b
    expect(cmds[6]).toMatch(/rollout undo .* deployment\/worker-b/);
    expect(cmds[7]).toMatch(/rollout status .* deployment\/worker-b/);
    expect(cmds[8]).toMatch(/get .* deployment\/worker-b/);
    // health probe via kubectl run + curl
    expect(cmds[9]).toMatch(
      /kubectl run sf-health-.* --image=curlimages\/curl.* curl -fsS --max-time 5 http:\/\/app\.default\.svc\.cluster\.local\/healthz/,
    );

    // No second set-image (no roll-forward).
    expect(cmds.some((c) => c.includes("set image"))).toBe(false);

    expect(dep.statuses[dep.statuses.length - 1]!.state).toBe("success");
  });

  it("workers rolled back in order, sequentially", async () => {
    server.use(...githubDeploymentHandlers().handlers);
    const runner = digestRunner();

    await rollbackEnv(
      commonOpts({
        workerNames: ["w1", "w2", "w3"],
        deps: {
          githubToken: "ghs_test_token",
          trustHostKey: async () => {},
          openTunnel: async () => ({ close: async () => {} }),
          runner,
        },
      }),
    );

    const undos = runner.calls
      .map((c) => c.command)
      .filter((c) => c.includes("rollout undo"));
    expect(undos.map((c) => c.match(/deployment\/(\S+)/)![1])).toEqual([
      "app",
      "w1",
      "w2",
      "w3",
    ]);

    // Sequential: each deployment's three commands appear contiguously.
    const cmds = runner.calls.map((c) => c.command);
    for (const [i, name] of ["app", "w1", "w2", "w3"].entries()) {
      expect(cmds[i * 3]).toContain(`rollout undo`);
      expect(cmds[i * 3]).toContain(`deployment/${name}`);
      expect(cmds[i * 3 + 1]).toContain(`rollout status`);
      expect(cmds[i * 3 + 1]).toContain(`deployment/${name}`);
      expect(cmds[i * 3 + 2]).toContain(`get`);
      expect(cmds[i * 3 + 2]).toContain(`deployment/${name}`);
    }
  });

  it("health failure: returns { healthy: false } with rolledBackTo populated; no roll-forward", async () => {
    const dep = githubDeploymentHandlers();
    server.use(...dep.handlers);

    const runner = new RecorderRunner((cmd) => {
      if (cmd.startsWith("kubectl get ")) {
        if (cmd.includes("deployment/worker-a")) return ok(WORKER_A_DIGEST);
        if (cmd.includes("deployment/worker-b")) return ok(WORKER_B_DIGEST);
        if (cmd.includes("deployment/app")) return ok(APP_DIGEST);
      }
      if (cmd.startsWith("kubectl run sf-health-")) {
        return fail("connection refused", 22);
      }
      return ok();
    });

    const result = await rollbackEnv(
      commonOpts({
        deps: {
          githubToken: "ghs_test_token",
          trustHostKey: async () => {},
          openTunnel: async () => ({ close: async () => {} }),
          runner,
        },
      }),
    );

    expect(result.healthy).toBe(false);
    expect(result.rolledBackTo).toEqual({
      app: APP_DIGEST,
      "worker-a": WORKER_A_DIGEST,
      "worker-b": WORKER_B_DIGEST,
    });

    const cmds = runner.calls.map((c) => c.command);
    expect(cmds.some((c) => c.includes("set image"))).toBe(false);

    expect(dep.statuses[dep.statuses.length - 1]!.state).toBe("failure");
  }, 60_000);

  it("rollout status non-zero throws with the failing step name", async () => {
    server.use(...githubDeploymentHandlers().handlers);
    const runner = new RecorderRunner((cmd) => {
      if (cmd.startsWith("kubectl rollout status")) return fail("timeout");
      return ok();
    });

    await expect(
      rollbackEnv(
        commonOpts({
          deps: {
            githubToken: "ghs_test_token",
            trustHostKey: async () => {},
            openTunnel: async () => ({ close: async () => {} }),
            runner,
          },
        }),
      ),
    ).rejects.toThrow(/app-rollout-status/);
  });

  it("rollout undo non-zero throws with the failing step name", async () => {
    server.use(...githubDeploymentHandlers().handlers);
    const runner = new RecorderRunner((cmd) => {
      if (cmd.startsWith("kubectl rollout undo")) return fail("not found");
      return ok();
    });

    await expect(
      rollbackEnv(
        commonOpts({
          deps: {
            githubToken: "ghs_test_token",
            trustHostKey: async () => {},
            openTunnel: async () => ({ close: async () => {} }),
            runner,
          },
        }),
      ),
    ).rejects.toThrow(/app-rollout-undo/);
  });
});
