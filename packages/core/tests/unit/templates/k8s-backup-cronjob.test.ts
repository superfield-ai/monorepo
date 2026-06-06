import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderBackupCronJobManifest } from "../../../templates/k8s/render-backup-cronjob.ts";

describe("renderBackupCronJobManifest", () => {
  it("produces YAML that parses cleanly", () => {
    const out = renderBackupCronJobManifest({ env: "dev" });
    expect(() => parseYaml(out)).not.toThrow();
    const doc = parseYaml(out);
    expect(doc).toBeTypeOf("object");
  });

  it("renders a CronJob with the expected schema shape", () => {
    const doc = parseYaml(renderBackupCronJobManifest({ env: "demo" }));
    expect(doc.apiVersion).toBe("batch/v1");
    expect(doc.kind).toBe("CronJob");
    expect(doc.metadata.name).toBe("postgres-backup-demo");
    expect(doc.metadata.labels.env).toBe("demo");
    expect(doc.spec.schedule).toBe("0 2 * * *");
    expect(doc.spec.concurrencyPolicy).toBe("Forbid");
  });

  it("configures backoffLimit and ttlSecondsAfterFinished on the job template", () => {
    const doc = parseYaml(renderBackupCronJobManifest({ env: "dev" }));
    const jobSpec = doc.spec.jobTemplate.spec;
    expect(jobSpec.backoffLimit).toBe(1);
    expect(jobSpec.ttlSecondsAfterFinished).toBe(86400);
    expect(jobSpec.template.spec.restartPolicy).toBe("Never");
  });

  it("uses the postgres:16-alpine image for the pg-basebackup container", () => {
    const doc = parseYaml(renderBackupCronJobManifest({ env: "staging" }));
    const container = doc.spec.jobTemplate.spec.template.spec.containers[0];
    expect(container.name).toBe("pg-basebackup");
    expect(container.image).toBe("postgres:16-alpine");
  });

  it("injects replication credentials from a k8s Secret", () => {
    const doc = parseYaml(renderBackupCronJobManifest({ env: "prod" }));
    const container = doc.spec.jobTemplate.spec.template.spec.containers[0];
    const pwdEnv = container.env.find(
      (e: { name: string }) => e.name === "PGPASSWORD",
    );
    const userEnv = container.env.find(
      (e: { name: string }) => e.name === "PGUSER",
    );
    expect(pwdEnv.valueFrom.secretKeyRef.name).toBe(
      "postgres-replication-prod",
    );
    expect(pwdEnv.valueFrom.secretKeyRef.key).toBe("replication_password");
    expect(userEnv.valueFrom.secretKeyRef.name).toBe(
      "postgres-replication-prod",
    );
    expect(userEnv.valueFrom.secretKeyRef.key).toBe("replication_user");
  });

  it("substitutes env into resource names and secret references", () => {
    const doc = parseYaml(renderBackupCronJobManifest({ env: "qa" }));
    const container = doc.spec.jobTemplate.spec.template.spec.containers[0];
    const pwdEnv = container.env.find(
      (e: { name: string }) => e.name === "PGPASSWORD",
    );
    expect(pwdEnv.valueFrom.secretKeyRef.name).toBe("postgres-replication-qa");
  });

  it("does not leave unsubstituted placeholders", () => {
    const out = renderBackupCronJobManifest({ env: "prod" });
    expect(out).not.toMatch(/\{\{\s*ENV\s*\}\}/);
    expect(out).toContain("postgres-backup-prod");
    expect(out).toContain("postgres-replication-prod");
  });

  it("renders deterministically across calls", () => {
    const a = renderBackupCronJobManifest({ env: "dev" });
    const b = renderBackupCronJobManifest({ env: "dev" });
    expect(a).toBe(b);
  });

  it("sets resource requests and limits on the container", () => {
    const doc = parseYaml(renderBackupCronJobManifest({ env: "dev" }));
    const container = doc.spec.jobTemplate.spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe("200m");
    expect(container.resources.requests.memory).toBe("256Mi");
    expect(container.resources.limits.cpu).toBe("1");
    expect(container.resources.limits.memory).toBe("512Mi");
  });
});
