import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import {
  deployEnv,
  type KubeRunner,
  type KubeRunResult,
} from "../../../commands/deploy-env.ts";

/**
 * In-memory recorder used as the production {@link KubeRunner} interface.
 * Identical pattern to the deploy-env happy-path test — NOT a mock.
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
    this.calls.push({ command, stdin: opts?.stdin });
    return this.respond(command, opts?.stdin, this.calls.length - 1);
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
const IMAGE_LC = "owner/app";
const TAG = "v1.2.3";
const DIGEST = "sha256:" + "b".repeat(64);
const HOST = "127.0.0.1";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ghcrHandlers() {
  return [
    http.head(
      `https://ghcr.io/v2/${IMAGE_LC}/manifests/${TAG}`,
      ({ request }) => {
        const auth = request.headers.get("authorization");
        if (!auth) {
          return new HttpResponse(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${IMAGE_LC}:pull"`,
            },
          });
        }
        return new HttpResponse(null, {
          status: 200,
          headers: { "docker-content-digest": DIGEST },
        });
      },
    ),
    http.get(`https://ghcr.io/token`, () =>
      HttpResponse.json({ token: "ghcr-registry-token" }),
    ),
    http.post(`https://api.github.com/repos/${REPO}/deployments`, async () =>
      HttpResponse.json({ id: 9001 }, { status: 201 }),
    ),
    http.post(
      `https://api.github.com/repos/${REPO}/deployments/:id/statuses`,
      async () => HttpResponse.json({ ok: true }, { status: 201 }),
    ),
  ];
}

const FROZEN_NOW = new Date("2026-04-18T12:34:56.000Z");
const EXPECTED_TIMESTAMP = "20260418123456";

function commonOpts(
  overrides: Partial<Parameters<typeof deployEnv>[0]> = {},
  runner?: KubeRunner,
  logs?: string[],
) {
  return {
    repo: REPO,
    env: "demo",
    tag: TAG,
    appName: "app",
    workerNames: ["worker-a"],
    host: HOST,
    sshPrivateKeyPem: "-----BEGIN FAKE-----\n-----END FAKE-----\n",
    knownHostsPath: "/tmp/known_hosts.test",
    cleanRoom: true,
    dbMode: "local" as const,
    now: () => FROZEN_NOW,
    deps: {
      githubToken: "ghs_test_token",
      trustHostKey: async () => {},
      openTunnel: async () => ({ close: async () => {} }),
      ...(runner ? { runner } : {}),
    },
    ...(logs ? { onLog: (l: string) => logs.push(l) } : {}),
    ...overrides,
  };
}

describe("deployEnv --clean-room", () => {
  it("local mode: applies new PVC, recreates StatefulSet, runs seed Job, then normal flow", async () => {
    server.use(...ghcrHandlers());
    const runner = new RecorderRunner(() => ok());
    const logs: string[] = [];

    const result = await deployEnv(commonOpts({}, runner, logs));

    expect(result.healthy).toBe(true);
    expect(result.digest).toBe(DIGEST);

    const cmds = runner.calls.map((c) => c.command);

    // 1. New PVC apply via stdin (precise lookup: first apply whose stdin
    //    contains a PVC kind).
    const firstApply = runner.calls.findIndex(
      (c) =>
        c.command === "kubectl apply -n default -f -" &&
        (c.stdin?.includes("PersistentVolumeClaim") ?? false),
    );
    expect(firstApply).toBeGreaterThanOrEqual(0);
    expect(runner.calls[firstApply]!.stdin).toContain(
      `postgres-data-demo-${EXPECTED_TIMESTAMP}`,
    );

    // 2. StatefulSet must be recreated with --cascade=orphan because
    //    volumeClaimTemplates is immutable in standard k8s. Look for the
    //    delete and the subsequent apply with the new volumeClaimTemplates
    //    name.
    const stsDelete = cmds.findIndex(
      (c) =>
        c.includes("delete sts") &&
        c.includes("postgres-demo") &&
        c.includes("--cascade=orphan"),
    );
    expect(stsDelete).toBeGreaterThanOrEqual(0);
    const stsApply = runner.calls.findIndex(
      (c, i) =>
        i > stsDelete &&
        c.command === "kubectl apply -n default -f -" &&
        (c.stdin?.includes("kind: StatefulSet") ?? false),
    );
    expect(stsApply).toBeGreaterThan(stsDelete);
    expect(runner.calls[stsApply]!.stdin).toContain(
      `postgres-data-demo-${EXPECTED_TIMESTAMP}`,
    );

    // 3. Wait for postgres pod ready
    const pgReady = cmds.findIndex(
      (c) =>
        c.includes("kubectl wait") &&
        c.includes("--for=condition=Ready") &&
        c.includes("app=postgres,env=demo"),
    );
    expect(pgReady).toBeGreaterThan(stsApply);

    // 4. Seed Job apply + wait
    const seedApply = runner.calls.findIndex(
      (c, i) =>
        i > pgReady &&
        c.command === "kubectl apply -n default -f -" &&
        (c.stdin?.includes("db-seed-demo") ?? false),
    );
    expect(seedApply).toBeGreaterThan(pgReady);
    const seedWait = cmds.findIndex(
      (c, i) =>
        i > seedApply &&
        c.includes("kubectl wait") &&
        c.includes("--for=condition=Complete") &&
        c.includes("job/db-seed-demo-"),
    );
    expect(seedWait).toBeGreaterThan(seedApply);

    // 5. After seed: normal migrate Job, then app rollout
    const migrateApply = runner.calls.findIndex(
      (c, i) =>
        i > seedWait &&
        c.command === "kubectl apply -n default -f -" &&
        (c.stdin?.includes("db-migrate-demo") ?? false),
    );
    expect(migrateApply).toBeGreaterThan(seedWait);
    const setImage = cmds.findIndex(
      (c, i) =>
        i > migrateApply &&
        c.includes("set image") &&
        c.includes("deployment/app"),
    );
    expect(setImage).toBeGreaterThan(migrateApply);

    // Old PVC NOT deleted by the deploy.
    const deletePvc = cmds.find((c) => c.startsWith("kubectl delete pvc"));
    expect(deletePvc).toBeUndefined();

    // End-of-run output mentions old PVC name(s) and the delete hint.
    const joined = logs.join("\n");
    expect(joined).toMatch(/postgres-data-demo(?!-2026)/); // original (unsuffixed) PVC
    expect(joined).toMatch(/kubectl delete pvc/);
  });

  it("managed mode: aborts before any kubectl write", async () => {
    server.use(...ghcrHandlers());
    const runner = new RecorderRunner(() => ok());

    await expect(
      deployEnv(commonOpts({ dbMode: "managed" }, runner)),
    ).rejects.toThrow(/clean-room.*managed/i);

    expect(runner.calls).toHaveLength(0);
  });

  it("seed Job failure aborts before app rollout", async () => {
    server.use(...ghcrHandlers());

    const runner = new RecorderRunner((cmd) => {
      // Fail the wait for the seed Job; everything else succeeds.
      if (cmd.includes("kubectl wait") && cmd.includes("job/db-seed-demo-")) {
        return fail("Failed");
      }
      return ok();
    });

    await expect(deployEnv(commonOpts({}, runner))).rejects.toThrow(/seed/i);

    const cmds = runner.calls.map((c) => c.command);
    // No app rollout / set-image happened.
    expect(cmds.some((c) => c.includes("set image"))).toBe(false);
    expect(cmds.some((c) => c.includes("rollout status"))).toBe(false);
    // Old PVC still not deleted.
    expect(cmds.some((c) => c.startsWith("kubectl delete pvc"))).toBe(false);
  });
});
