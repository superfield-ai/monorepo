import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  normalizeTagForName,
  renderMigrateJobManifest,
} from "../../../templates/k8s/render-migrate-job.ts";

const baseOpts = {
  env: "demo",
  tag: "v1.2.3",
  imageRepo: "ghcr.io/foo/bar",
};

describe("renderMigrateJobManifest", () => {
  it("renders valid YAML", () => {
    const out = renderMigrateJobManifest(baseOpts);
    expect(() => parseYaml(out)).not.toThrow();
    const doc = parseYaml(out);
    expect(doc).toBeTypeOf("object");
  });

  it("matches the expected Job schema shape", () => {
    const doc = parseYaml(renderMigrateJobManifest(baseOpts));
    expect(doc.apiVersion).toBe("batch/v1");
    expect(doc.kind).toBe("Job");
    expect(doc.spec.backoffLimit).toBe(0);
    expect(doc.spec.ttlSecondsAfterFinished).toBe(3600);
    expect(doc.spec.template.spec.restartPolicy).toBe("Never");

    const container = doc.spec.template.spec.containers[0];
    expect(container.command).toEqual(["/app", "migrate"]);

    const dbUrl = container.env.find(
      (e: { name: string }) => e.name === "DATABASE_URL",
    );
    expect(dbUrl).toBeDefined();
    expect(dbUrl.valueFrom.secretKeyRef.name).toBe("app-demo");
    expect(dbUrl.valueFrom.secretKeyRef.key).toBe("database_url");

    expect(container.resources.requests.cpu).toBe("100m");
    expect(container.resources.requests.memory).toBe("128Mi");
    expect(container.resources.limits.cpu).toBe("500m");
    expect(container.resources.limits.memory).toBe("512Mi");
  });

  it("substitutes env, tag and imageRepo into name and image", () => {
    const doc = parseYaml(renderMigrateJobManifest(baseOpts));
    expect(doc.metadata.name).toBe("db-migrate-demo-v1.2.3");
    expect(doc.spec.template.spec.containers[0].image).toBe(
      "ghcr.io/foo/bar:v1.2.3",
    );
  });

  it("produces byte-identical output across two renders with same input", () => {
    const a = renderMigrateJobManifest(baseOpts);
    const b = renderMigrateJobManifest(baseOpts);
    expect(a).toBe(b);
  });

  it("normalizes digest-style tags (sha256:abc) for the Job name while keeping raw tag in the image reference", () => {
    const doc = parseYaml(
      renderMigrateJobManifest({
        env: "prod",
        tag: "sha256:abc123",
        imageRepo: "ghcr.io/foo/bar",
      }),
    );
    expect(doc.metadata.name).toBe("db-migrate-prod-sha256-abc123");
    // The image reference must keep the original digest separator.
    expect(doc.spec.template.spec.containers[0].image).toBe(
      "ghcr.io/foo/bar:sha256:abc123",
    );
  });

  it("normalizes tags containing `/` for the Job name", () => {
    const doc = parseYaml(
      renderMigrateJobManifest({
        env: "stg",
        tag: "feature/x",
        imageRepo: "ghcr.io/foo/bar",
      }),
    );
    expect(doc.metadata.name).toBe("db-migrate-stg-feature-x");
  });
});

describe("normalizeTagForName", () => {
  it("leaves clean semver tags unchanged", () => {
    expect(normalizeTagForName("v1.2.3")).toBe("v1.2.3");
  });

  it("replaces `:` and `/` with `-`", () => {
    expect(normalizeTagForName("sha256:abc")).toBe("sha256-abc");
    expect(normalizeTagForName("feature/x")).toBe("feature-x");
  });

  it("lowercases uppercase characters", () => {
    expect(normalizeTagForName("V1.2.3-RC1")).toBe("v1.2.3-rc1");
  });
});
