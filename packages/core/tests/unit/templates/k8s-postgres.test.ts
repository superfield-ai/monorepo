import { describe, it, expect } from "vitest";
import { parseAllDocuments } from "yaml";
import { renderPostgresManifest } from "../../../templates/k8s/render.ts";

describe("renderPostgresManifest", () => {
  it("produces YAML that parses cleanly", () => {
    const out = renderPostgresManifest("dev");
    const docs = parseAllDocuments(out);
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc.errors).toEqual([]);
    }
  });

  it("substitutes env into resource names", () => {
    const out = renderPostgresManifest("demo");
    const docs = parseAllDocuments(out).map((d) => d.toJS());
    const kinds = docs.map((d) => d.kind);
    expect(kinds).toContain("StatefulSet");
    expect(kinds).toContain("Service");

    const statefulSet = docs.find((d) => d.kind === "StatefulSet");
    expect(statefulSet.metadata.name).toBe("postgres-demo");
    expect(statefulSet.apiVersion).toBe("apps/v1");
    expect(statefulSet.spec.replicas).toBe(1);
    expect(statefulSet.spec.serviceName).toBe("postgres-demo");

    const vct = statefulSet.spec.volumeClaimTemplates[0];
    expect(vct.metadata.name).toBe("postgres-data-demo");
    expect(vct.spec.storageClassName).toBe("local-path");
    expect(vct.spec.resources.requests.storage).toBe("20Gi");

    const container = statefulSet.spec.template.spec.containers[0];
    expect(container.image).toBe("postgres:16-alpine");
    expect(container.resources.requests).toEqual({
      cpu: "200m",
      memory: "256Mi",
    });
    expect(container.resources.limits).toEqual({
      cpu: "1",
      memory: "1Gi",
    });
    expect(container.livenessProbe.exec.command.join(" ")).toContain(
      "pg_isready",
    );
    expect(container.readinessProbe.exec.command.join(" ")).toContain(
      "pg_isready",
    );

    const passwordEnv = container.env.find(
      (e: { name: string }) => e.name === "POSTGRES_PASSWORD",
    );
    expect(passwordEnv.valueFrom.secretKeyRef).toEqual({
      key: "password",
      name: "postgres-demo",
    });

    const service = docs.find((d) => d.kind === "Service");
    expect(service.metadata.name).toBe("postgres-demo");
    expect(service.spec.type).toBe("ClusterIP");
    expect(service.spec.ports[0].port).toBe(5432);
    expect(service.apiVersion).toBe("v1");
  });

  it("renders deterministically across calls", () => {
    const a = renderPostgresManifest("dev");
    const b = renderPostgresManifest("dev");
    expect(a).toBe(b);
  });

  it("does not leave any unsubstituted placeholders", () => {
    const out = renderPostgresManifest("prod");
    expect(out).not.toMatch(/\{\{\s*ENV\s*\}\}/);
    expect(out).toContain("postgres-prod");
    expect(out).toContain("postgres-data-prod");
  });
});
