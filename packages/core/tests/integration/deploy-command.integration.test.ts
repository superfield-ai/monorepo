import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runDeployCommand,
  type DeployProcessStep,
} from "../../commands/deploy.ts";

describe("runDeployCommand — demo wiring", () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("runs the demo provision and deploy steps in order without spawning real processes", async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "superfield-deploy-"));
    await fsp.mkdir(path.join(tmpDir, "deploy", "env", "local"), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(tmpDir, "deploy", "env", "local", "secrets.yaml.template"),
      "apiVersion: v1\nkind: Secret\n",
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
        checkPvcExists: async () => false,
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

  it("skips volume prompt when no postgres PVC exists", async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "superfield-deploy-"));
    await fsp.mkdir(path.join(tmpDir, "deploy", "env", "local"), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(tmpDir, "deploy", "env", "local", "secrets.yaml.template"),
      "apiVersion: v1\nkind: Secret\n",
    );

    let promptCalled = false;
    await runDeployCommand(
      { demoRoot: tmpDir },
      {
        runProcess: async () => undefined,
        probeIngress: async () => undefined,
        checkPvcExists: async () => false,
        promptVolumeReuse: async () => {
          promptCalled = true;
          return true;
        },
      },
    );

    expect(promptCalled).toBe(false);
  });

  it("reuses existing postgres PVC when user confirms", async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "superfield-deploy-"));
    await fsp.mkdir(path.join(tmpDir, "deploy", "env", "local"), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(tmpDir, "deploy", "env", "local", "secrets.yaml.template"),
      "apiVersion: v1\nkind: Secret\n",
    );

    const steps: DeployProcessStep[] = [];
    await runDeployCommand(
      { demoRoot: tmpDir },
      {
        runProcess: async (step) => {
          steps.push(step);
        },
        probeIngress: async () => undefined,
        checkPvcExists: async () => true,
        promptVolumeReuse: async () => true,
      },
    );

    expect(steps.some((s) => s.args.includes("delete"))).toBe(false);
  });

  it("deletes existing postgres PVC when user requests clean start", async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "superfield-deploy-"));
    await fsp.mkdir(path.join(tmpDir, "deploy", "env", "local"), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(tmpDir, "deploy", "env", "local", "secrets.yaml.template"),
      "apiVersion: v1\nkind: Secret\n",
    );

    const steps: DeployProcessStep[] = [];
    await runDeployCommand(
      { demoRoot: tmpDir },
      {
        runProcess: async (step) => {
          steps.push(step);
        },
        probeIngress: async () => undefined,
        checkPvcExists: async () => true,
        promptVolumeReuse: async () => false,
      },
    );

    const deleteStep = steps.find(
      (s) => s.command === "kubectl" && s.args.includes("delete"),
    );
    expect(deleteStep).toBeDefined();
    expect(deleteStep?.args).toEqual(["delete", "pvc", "postgres-data"]);
    expect(deleteStep?.phase).toBe("deploy");
    // delete must come before apply
    const applyStep = steps.find((s) => s.args.includes("apply"));
    expect(steps.indexOf(deleteStep!)).toBeLessThan(steps.indexOf(applyStep!));
  });
});
