import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import {
  deployEnv,
  resolveTagToDigest,
  type KubeRunner,
  type KubeRunResult,
} from "../../../commands/deploy-env.ts";

/**
 * In-memory recorder used as the production {@link KubeRunner} interface
 * during tests. This is NOT a mock — it implements the real interface and
 * records each invocation so we can assert call order. Behavior per command
 * is supplied by `respond`.
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
const IMAGE_LC = "owner/app";
const TAG = "v1.2.3";
const DIGEST = "sha256:" + "a".repeat(64);
const HOST = "127.0.0.1";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ghcrHandlers(opts: { tag?: string; missing?: boolean } = {}) {
  const tag = opts.tag ?? TAG;
  return [
    http.head(
      `https://ghcr.io/v2/${IMAGE_LC}/manifests/${tag}`,
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
        if (opts.missing) {
          return new HttpResponse(null, { status: 404 });
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
  ];
}

function githubDeploymentHandlers() {
  let nextId = 1001;
  const statuses: { id: number; state: string; description: string }[] = [];
  return {
    statuses,
    handlers: [
      http.post(`https://api.github.com/repos/${REPO}/deployments`, async () =>
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

function commonOpts(overrides: Partial<Parameters<typeof deployEnv>[0]> = {}) {
  return {
    repo: REPO,
    env: "prod",
    tag: TAG,
    appName: "app",
    workerNames: ["worker-a", "worker-b"],
    host: HOST,
    sshPrivateKeyPem: "-----BEGIN FAKE-----\n-----END FAKE-----\n",
    knownHostsPath: "/tmp/known_hosts.test",
    deps: {
      githubToken: "ghs_test_token",
      // Skip the real SSH calls; the test harness controls the runner.
      trustHostKey: async () => {},
      openTunnel: async () => ({ close: async () => {} }),
    },
    ...overrides,
  };
}

describe("resolveTagToDigest (MSW)", () => {
  it("follows WWW-Authenticate token-server flow and returns the digest header", async () => {
    server.use(...ghcrHandlers());
    const digest = await resolveTagToDigest({
      repo: REPO,
      tag: TAG,
      githubToken: "ghs_test",
    });
    expect(digest).toBe(DIGEST);
  });

  it("throws a clear error when the tag is missing", async () => {
    server.use(...ghcrHandlers({ missing: true }));
    await expect(
      resolveTagToDigest({ repo: REPO, tag: TAG, githubToken: "ghs_test" }),
    ).rejects.toThrow(/GHCR tag not found/);
  });
});

describe("deployEnv", () => {
  it("happy path: migrate → app → workers in order, then health passes", async () => {
    const dep = githubDeploymentHandlers();
    server.use(...ghcrHandlers(), ...dep.handlers);

    const runner = new RecorderRunner(() => {
      // `kubectl wait ... Complete` succeeds; `rollout status` succeeds;
      // health probe (kubectl run ... curl ...) succeeds first try.
      return ok();
    });

    const logs: string[] = [];
    const result = await deployEnv(
      commonOpts({
        deps: {
          githubToken: "ghs_test_token",
          trustHostKey: async () => {},
          openTunnel: async () => ({ close: async () => {} }),
          runner,
        },
        onLog: (l) => logs.push(l),
      }),
    );

    expect(result).toEqual({
      digest: DIGEST,
      rolledOut: ["app", "worker-a", "worker-b"],
      healthy: true,
    });

    const cmds = runner.calls.map((c) => c.command);
    // 1. migrate apply (with stdin manifest)
    expect(cmds[0]).toMatch(/^kubectl apply -n default -f -$/);
    expect(runner.calls[0]!.stdin).toMatch(/kind: Job/);
    // 2. wait for migrate Complete
    expect(cmds[1]).toMatch(
      /kubectl wait .* --for=condition=Complete .* job\/db-migrate-prod-/,
    );
    // 3. app set image, then rollout status
    expect(cmds[2]).toMatch(
      /kubectl set image .* deployment\/app app=ghcr\.io\/owner\/app@sha256:/,
    );
    expect(cmds[3]).toMatch(/kubectl rollout status .* deployment\/app/);
    // 4. worker-a, worker-b in order
    expect(cmds[4]).toMatch(
      /deployment\/worker-a worker-a=ghcr\.io\/owner\/app@sha256:/,
    );
    expect(cmds[5]).toMatch(/rollout status .* deployment\/worker-a/);
    expect(cmds[6]).toMatch(
      /deployment\/worker-b worker-b=ghcr\.io\/owner\/app@sha256:/,
    );
    expect(cmds[7]).toMatch(/rollout status .* deployment\/worker-b/);
    // 5. health probe via kubectl run + curl
    expect(cmds[8]).toMatch(
      /kubectl run sf-health-.* --image=curlimages\/curl.* curl -fsS --max-time 5 http:\/\/app\.default\.svc\.cluster\.local\/healthz/,
    );

    // GitHub deployment annotated success.
    expect(dep.statuses).toHaveLength(1);
    expect(dep.statuses[0]!.state).toBe("success");
  });

  it("migration failure: app deployment is NOT touched", async () => {
    server.use(...ghcrHandlers(), ...githubDeploymentHandlers().handlers);

    const runner = new RecorderRunner((cmd) => {
      if (cmd.startsWith("kubectl apply")) return ok();
      if (cmd.startsWith("kubectl wait")) return fail("Failed");
      return ok();
    });

    await expect(
      deployEnv(
        commonOpts({
          deps: {
            githubToken: "ghs_test_token",
            trustHostKey: async () => {},
            openTunnel: async () => ({ close: async () => {} }),
            runner,
          },
        }),
      ),
    ).rejects.toThrow(/migrate Job did not complete/);

    const cmds = runner.calls.map((c) => c.command);
    // exactly two: apply + wait. NO set-image, NO rollout, NO undo.
    expect(cmds).toHaveLength(2);
    expect(cmds.some((c) => c.includes("set image"))).toBe(false);
    expect(cmds.some((c) => c.includes("rollout"))).toBe(false);
  });

  it("health failure: rolls back app + every worker touched", async () => {
    const dep = githubDeploymentHandlers();
    server.use(...ghcrHandlers(), ...dep.handlers);

    const runner = new RecorderRunner((cmd) => {
      if (cmd.startsWith("kubectl run sf-health-")) {
        return fail("connection refused", 22);
      }
      return ok();
    });

    await expect(
      deployEnv(
        commonOpts({
          deps: {
            githubToken: "ghs_test_token",
            trustHostKey: async () => {},
            openTunnel: async () => ({ close: async () => {} }),
            runner,
          },
        }),
      ),
    ).rejects.toThrow(/health-gate/);

    const undoCalls = runner.calls
      .map((c) => c.command)
      .filter((c) => c.includes("rollout undo"));
    expect(undoCalls).toHaveLength(3);
    expect(undoCalls[0]).toMatch(/deployment\/app/);
    expect(undoCalls[1]).toMatch(/deployment\/worker-a/);
    expect(undoCalls[2]).toMatch(/deployment\/worker-b/);

    // Annotated as failure.
    expect(dep.statuses[dep.statuses.length - 1]!.state).toBe("failure");
  }, 60_000);

  it("--dry-run: no kubectl writes; recorder is empty", async () => {
    server.use(...ghcrHandlers());

    const runner = new RecorderRunner(() => ok());

    const result = await deployEnv(
      commonOpts({
        dryRun: true,
        deps: {
          githubToken: "ghs_test_token",
          trustHostKey: async () => {},
          openTunnel: async () => ({ close: async () => {} }),
          runner,
        },
      }),
    );

    expect(result.digest).toBe(DIGEST);
    expect(runner.calls).toHaveLength(0);
  });

  it("tag→digest: missing tag bubbles up before any kubectl runs", async () => {
    server.use(...ghcrHandlers({ missing: true }));

    const runner = new RecorderRunner(() => ok());

    await expect(
      deployEnv(
        commonOpts({
          deps: {
            githubToken: "ghs_test_token",
            trustHostKey: async () => {},
            openTunnel: async () => ({ close: async () => {} }),
            runner,
          },
        }),
      ),
    ).rejects.toThrow(/GHCR tag not found/);

    expect(runner.calls).toHaveLength(0);
  });
});
