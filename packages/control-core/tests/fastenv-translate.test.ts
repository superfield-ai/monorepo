import { describe, it, expect } from "vitest";

import {
  translateKubernetesManifest,
  translateDockerCompose,
  type FastenvManifest,
} from "../fastenv-translate";

const POSTGRES_DEPLOYMENT = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:15-alpine
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_USER
              value: "superfield"
            - name: POSTGRES_DB
              value: "superfield_db"
          livenessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - superfield
`;

const API_DEPLOYMENT = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  template:
    spec:
      containers:
        - name: api-server
          image: k3d-superfield-reg:5000/api-server:dev
          ports:
            - containerPort: 8080
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
`;

describe("translateKubernetesManifest", () => {
  it("translates a Deployment into a workload with image, env, and an exec probe", () => {
    const manifest = translateKubernetesManifest(POSTGRES_DEPLOYMENT);
    expect(manifest.workloads).toHaveLength(1);
    const pg = manifest.workloads[0]!;
    expect(pg.name).toBe("postgres");
    expect(pg.image).toBe("postgres:15-alpine");
    expect(pg.env).toEqual({
      POSTGRES_USER: "superfield",
      POSTGRES_DB: "superfield_db",
    });
    expect(pg.stateful).toBe(true); // postgres image → durable state
    expect(pg.health).toEqual({
      kind: "exec",
      command: ["pg_isready", "-U", "superfield"],
    });
  });

  it("translates an httpGet probe into an http health check", () => {
    const manifest = translateKubernetesManifest(API_DEPLOYMENT);
    const api = manifest.workloads[0]!;
    expect(api.stateful).toBe(false);
    expect(api.health).toEqual({ kind: "http", port: 8080, path: "/health" });
  });

  it("canonicalises workloads: stateful first, then by name", () => {
    const manifest = translateKubernetesManifest(
      [API_DEPLOYMENT, POSTGRES_DEPLOYMENT].join("\n---\n"),
    );
    expect(manifest.workloads.map((w) => w.name)).toEqual([
      "postgres", // stateful sorts first
      "api-server",
    ]);
  });

  it("treats StatefulSet as stateful regardless of image", () => {
    const ss = `
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ledger
spec:
  template:
    spec:
      containers:
        - name: ledger
          image: ledger:1
`;
    const manifest = translateKubernetesManifest(ss);
    expect(manifest.workloads[0]!.stateful).toBe(true);
  });

  it("skips non-workload documents (Service, Ingress, …) without erroring", () => {
    const svc = `
apiVersion: v1
kind: Service
metadata:
  name: api-server
spec:
  ports:
    - port: 8080
`;
    const manifest = translateKubernetesManifest(
      [svc, API_DEPLOYMENT].join("\n---\n"),
    );
    expect(manifest.workloads.map((w) => w.name)).toEqual(["api-server"]);
  });

  it("produces a JSON shape that matches the Rust FastenvManifest contract", () => {
    const manifest: FastenvManifest = translateKubernetesManifest(
      [POSTGRES_DEPLOYMENT, API_DEPLOYMENT].join("\n---\n"),
      "superfield",
    );
    const json = JSON.parse(JSON.stringify(manifest));
    // Top-level fields the Rust deserializer reads.
    expect(json).toHaveProperty("name", "superfield");
    expect(Array.isArray(json.workloads)).toBe(true);
    const pg = json.workloads.find(
      (w: { name: string }) => w.name === "postgres",
    );
    // Field-for-field with crates/fastenv/src/deployment.rs::Workload.
    expect(Object.keys(pg).sort()).toEqual(
      ["command", "env", "health", "image", "name", "stateful"].sort(),
    );
    // HealthProbe is `{ kind: "...", ... }` to match serde tag = "kind".
    expect(pg.health.kind).toBe("exec");
  });
});

describe("translateDockerCompose", () => {
  it("translates a compose services block (parity subset)", () => {
    const compose = `
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: app
  api:
    image: superfield/api:dev
    command: ["serve", "--port", "8080"]
    environment:
      - LOG_LEVEL=info
`;
    const manifest = translateDockerCompose(compose);
    expect(manifest.workloads.map((w) => w.name)).toEqual(["db", "api"]);
    const db = manifest.workloads.find((w) => w.name === "db")!;
    expect(db.image).toBe("postgres:16");
    expect(db.stateful).toBe(true);
    expect(db.env).toEqual({ POSTGRES_DB: "app" });
    const api = manifest.workloads.find((w) => w.name === "api")!;
    expect(api.command).toEqual(["serve", "--port", "8080"]);
    expect(api.env).toEqual({ LOG_LEVEL: "info" });
  });
});
