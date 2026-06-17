import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runDeployCommand,
  type DeployProcessStep,
} from "../../commands/deploy.ts";

// A minimal but realistic deploy/base: stateful Postgres + a stateless app, the
// same shape the k3s path consumes. The fastenv backend translates these into a
// FastenvManifest and drives `fastenv up` — never kubectl/docker/k3d.
const POSTGRES_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: superfield-postgres
spec:
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:16
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_DB
              value: "app"
          livenessProbe:
            exec:
              command:
                - pg_isready
`;

const API_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: superfield-api
spec:
  template:
    spec:
      containers:
        - name: api-server
          image: superfield/api:dev
          ports:
            - containerPort: 8080
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
`;

async function makeDemoRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "superfield-fastenv-"));
  await fsp.mkdir(path.join(dir, "deploy", "base"), { recursive: true });
  await fsp.mkdir(path.join(dir, "deploy", "env", "local"), {
    recursive: true,
  });
  await fsp.writeFile(
    path.join(dir, "deploy", "base", "postgres.yaml"),
    POSTGRES_YAML,
  );
  await fsp.writeFile(
    path.join(dir, "deploy", "base", "deployments.yaml"),
    API_YAML,
  );
  await fsp.writeFile(
    path.join(dir, "deploy", "env", "local", "secrets.yaml.template"),
    "apiVersion: v1\nkind: Secret\n",
  );
  return dir;
}

describe("deploy on the fastenv backend (#660 criterion 4)", () => {
  let demoRoot: string | null = null;

  afterEach(async () => {
    if (demoRoot) {
      await fsp.rm(demoRoot, { recursive: true, force: true });
      demoRoot = null;
    }
  });

  it("runs init -> deploy-env -> health gate with NO kubectl/docker/k3d in the command trace", async () => {
    demoRoot = await makeDemoRoot();

    const steps: DeployProcessStep[] = [];
    const probed: string[] = [];
    let writtenManifest: string | null = null;

    await runDeployCommand(
      { demoRoot, backend: "fastenv" },
      {
        runProcess: async (step) => {
          steps.push(step);
        },
        probeIngress: async (url) => {
          probed.push(url);
        },
        writeManifest: (_p, contents) => {
          writtenManifest = contents;
        },
      },
    );

    const commandTrace = steps.map(
      (s) => `${s.phase}:${s.command} ${s.args.join(" ")}`,
    );

    // ---- Acceptance criterion 4: trace is free of the k8s/docker stack -----
    const forbidden = ["kubectl", "docker", "k3d", "k3s"];
    for (const line of commandTrace) {
      for (const tool of forbidden) {
        expect(
          line.includes(`:${tool} `) || line.startsWith(`${tool} `),
          `command trace must not invoke ${tool}: "${line}"`,
        ).toBe(false);
      }
    }
    // Every recorded command must be the fastenv binary.
    for (const step of steps) {
      expect(step.command).toBe("fastenv");
    }

    // ---- The deployment tier drove the real fastenv runtime path -----------
    // provision: fastenv doctor (host runtime readiness, replaces docker/k3d).
    expect(commandTrace).toContain("provision:fastenv doctor");
    // deploy: workload up + health gate (init -> deploy-env -> health gate).
    const upStep = steps.find((s) => s.args[0] === "up");
    expect(upStep, "expected a `fastenv up` step").toBeTruthy();
    expect(upStep!.args).toContain("--health-gate");
    expect(upStep!.args).toContain("--manifest");

    // The ingress was probed once the health gate passed.
    expect(probed).toEqual(["http://localhost:58080/"]);

    // ---- The translated FastenvManifest is the real engine-agnostic spec ----
    expect(writtenManifest).toBeTruthy();
    const manifest = JSON.parse(writtenManifest!);
    expect(manifest.name).toBe("superfield");
    const names = manifest.workloads.map((w: { name: string }) => w.name);
    expect(names).toEqual(["superfield-postgres", "superfield-api"]); // stateful first
    const pg = manifest.workloads.find(
      (w: { name: string }) => w.name === "superfield-postgres",
    );
    expect(pg.stateful).toBe(true);
    expect(pg.health.kind).toBe("exec");
  });

  it("default backend (k3s) still drives the kubectl/docker path", async () => {
    demoRoot = await makeDemoRoot();
    const steps: DeployProcessStep[] = [];

    await runDeployCommand(
      { demoRoot }, // no backend → defaults to k3s
      {
        runProcess: async (step) => {
          steps.push(step);
        },
        probeIngress: async () => undefined,
      },
    );

    const commands = new Set(steps.map((s) => s.command));
    // The legacy path coexists: it still uses docker/k3d/kubectl.
    expect(commands.has("kubectl")).toBe(true);
    expect(commands.has("fastenv")).toBe(false);
  });
});
