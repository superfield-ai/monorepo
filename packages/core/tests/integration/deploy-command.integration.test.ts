import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runDeployCommand,
  type DeployProcessStep,
} from "../../commands/deploy.ts";

const POSTGRES_YAML_WITH_HOSTPATH = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:16
      volumes:
        - name: postgres-data
          hostPath:
            path: /tmp/calypso-postgres-data
            type: DirectoryOrCreate
`;

async function makeTmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "superfield-deploy-"));
  await fsp.mkdir(path.join(dir, "deploy", "env", "local"), {
    recursive: true,
  });
  await fsp.writeFile(
    path.join(dir, "deploy", "env", "local", "secrets.yaml.template"),
    "apiVersion: v1\nkind: Secret\n",
  );
  return dir;
}

describe("runDeployCommand — demo wiring", () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("runs the demo provision and deploy steps in order without spawning real processes", async () => {
    tmpDir = await makeTmpDir();
    await fsp.mkdir(path.join(tmpDir, "deploy", "base"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "deploy", "base", "postgres.yaml"),
      POSTGRES_YAML_WITH_HOSTPATH,
    );

    const steps: DeployProcessStep[] = [];
    const probedUrls: string[] = [];

    await runDeployCommand(
      { demoRoot: tmpDir },
      {
        runProcess: async (step) => {
          steps.push(step);
        },
        probeIngress: async (url) => {
          probedUrls.push(url);
        },
        readFile: (p) => {
          if (p.endsWith("postgres.yaml")) return POSTGRES_YAML_WITH_HOSTPATH;
          return "";
        },
        // data dir does not exist → no prompt; everything else uses real fs
        fileExists: (p) =>
          p.endsWith("calypso-postgres-data") ? false : existsSync(p),
      },
    );

    expect(
      await fsp.readFile(
        path.join(tmpDir, "deploy", "env", "local", "secrets.yaml"),
        "utf8",
      ),
    ).toContain("kind: Secret");

    expect(
      steps.map(
        (step) => `${step.phase}:${step.command} ${step.args.join(" ")}`,
      ),
    ).toEqual([
      "provision:docker --version",
      "provision:k3d version",
      "provision:kubectl version --client",
      "provision:docker info",
      'provision:bun --eval import { ensureCluster } from "./scripts/local-demo.ts"; await ensureCluster();',
      "deploy:bash scripts/build-images.sh",
      "deploy:kubectl apply -f deploy/base/ -f deploy/env/local/",
      "deploy:kubectl apply -f deploy/env/local/secrets.yaml",
      "deploy:kubectl wait --for=condition=ready pod -l app=postgres --timeout=120s",
      "deploy:kubectl wait --for=condition=ready pod -l app=api-server --timeout=120s",
      "deploy:kubectl wait --for=condition=ready pod -l app=static-web --timeout=120s",
      "deploy:kubectl wait --for=condition=ready pod -l app=worker --timeout=120s",
    ]);
    expect(steps[5]?.env).toMatchObject({
      PUSH: "true",
      REGISTRY: "localhost:5000",
      TAG: "dev",
    });
    expect(probedUrls).toEqual(["http://localhost:58080/"]);
  });

  it("skips prompt when no hostPath is defined in the postgres manifest", async () => {
    tmpDir = await makeTmpDir();
    let promptCalled = false;

    await runDeployCommand(
      { demoRoot: tmpDir },
      {
        runProcess: async () => undefined,
        probeIngress: async () => undefined,
        fileExists: () => true,
        readFile: () => "volumes:\n  - name: postgres-data\n    emptyDir: {}\n",
        promptDeleteDataDir: async () => {
          promptCalled = true;
          return false;
        },
        deleteDataDir: () => undefined,
      },
    );

    expect(promptCalled).toBe(false);
  });

  it("skips prompt when hostPath exists in manifest but data dir does not exist on disk", async () => {
    tmpDir = await makeTmpDir();
    let promptCalled = false;

    await runDeployCommand(
      { demoRoot: tmpDir },
      {
        runProcess: async () => undefined,
        probeIngress: async () => undefined,
        fileExists: (p) => !p.endsWith("calypso-postgres-data"),
        readFile: () => POSTGRES_YAML_WITH_HOSTPATH,
        promptDeleteDataDir: async () => {
          promptCalled = true;
          return false;
        },
        deleteDataDir: () => undefined,
      },
    );

    expect(promptCalled).toBe(false);
  });

  it("does not delete data dir when user declines", async () => {
    tmpDir = await makeTmpDir();
    let deleted = false;

    await runDeployCommand(
      { demoRoot: tmpDir },
      {
        runProcess: async () => undefined,
        probeIngress: async () => undefined,
        fileExists: () => true,
        readFile: () => POSTGRES_YAML_WITH_HOSTPATH,
        promptDeleteDataDir: async () => false,
        deleteDataDir: () => {
          deleted = true;
        },
      },
    );

    expect(deleted).toBe(false);
  });

  it("deletes data dir before kubectl apply when user confirms", async () => {
    tmpDir = await makeTmpDir();
    const events: string[] = [];

    await runDeployCommand(
      { demoRoot: tmpDir },
      {
        runProcess: async (step) => {
          if (step.command === "kubectl" && step.args[0] === "apply") {
            events.push("apply");
          }
        },
        probeIngress: async () => undefined,
        fileExists: () => true,
        readFile: () => POSTGRES_YAML_WITH_HOSTPATH,
        promptDeleteDataDir: async () => true,
        deleteDataDir: () => {
          events.push("delete");
        },
      },
    );

    expect(events.indexOf("delete")).toBeLessThan(events.indexOf("apply"));
  });
});
