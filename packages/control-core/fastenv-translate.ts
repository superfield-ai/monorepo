/**
 * @file fastenv-translate.ts
 *
 * Translates Kubernetes manifests (and docker-compose, parity subset) into a
 * `FastenvManifest`: the engine-agnostic deployment spec consumed by the
 * fastenv deployment-tier runtime (`fastenv up`).
 *
 * This is the TypeScript source of truth for the FastenvManifest wire shape.
 * The Rust consumer in `crates/fastenv/src/deployment.rs` MUST stay in sync
 * field-for-field; both sides are covered by JSON round-trip tests.
 *
 * The translator replaces k8s/compose concepts with fastenv-native equivalents:
 *   Deployment / StatefulSet / compose service → FastenvWorkload (long-lived
 *     process under the manifest supervisor)
 *   Service + cluster DNS → in-process registry + host-local addressing
 *     (NO kube-proxy, NO CoreDNS)
 *   readinessProbe / livenessProbe → FastenvHealthCheck consumed by `doctor`
 *   StatefulSet (Postgres) → workload with `stateful: true` (started before,
 *     and stopped after, the app)
 *
 * Parity subset only. NetworkPolicy, Jobs, secretKeyRef, configMap mounts, and
 * multi-host scheduling are intentionally skipped (not errored).
 *
 * Like manifest-parser.ts, this works on raw YAML text with an
 * indentation-aware line parser — no YAML library dependency and no kubectl.
 */

/**
 * Health probe consumed by the deployment-tier supervisor / doctor surface.
 * Tagged by `kind` to match the Rust `HealthProbe` enum's serde representation.
 */
export type FastenvHealthCheck =
  | { kind: "tcp"; port: number }
  | { kind: "http"; port: number; path: string }
  | { kind: "exec"; command: string[] };

/** A single long-lived workload (app process, Postgres, sidecar, …). */
export interface FastenvWorkload {
  /** Stable workload identifier, unique within the manifest. */
  name: string;
  /** Container image reference (OCI), e.g. "postgres:16". */
  image: string;
  /** Entrypoint command + args. Empty means use the image default. */
  command: string[];
  /** Environment variables for the workload process. */
  env: Record<string, string>;
  /**
   * Whether this workload owns durable state (e.g. Postgres). Stateful
   * workloads start before, and stop after, stateless ones.
   */
  stateful: boolean;
  /** Optional readiness/liveness probe. */
  health?: FastenvHealthCheck;
}

/** Engine-agnostic deployment-tier manifest consumed by `fastenv up`. */
export interface FastenvManifest {
  /** Logical name of the deployment (e.g. "superfield"). */
  name: string;
  /** Long-lived workloads to supervise, in canonical (sorted) order. */
  workloads: FastenvWorkload[];
}

/** Split a multi-document YAML file on `---` separators. */
function splitDocuments(content: string): string[] {
  return content.split(/^---\s*$/m).filter((doc) => doc.trim().length > 0);
}

/** Number of leading spaces on a line (its indentation depth). */
function indent(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Extract the lines of the block that begins at `startIdx` (a `key:` line) and
 * continues while indentation stays strictly greater than the key's. Returns
 * the child lines (excluding the key line itself).
 */
function blockLines(lines: string[], startIdx: number): string[] {
  const base = indent(lines[startIdx] ?? "");
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.trim().length === 0) {
      out.push(line);
      continue;
    }
    if (indent(line) <= base) break;
    out.push(line);
  }
  return out;
}

/** Find the index of the first line matching `key:` at any indentation. */
function findKey(lines: string[], key: string): number {
  return lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
}

/** Read the scalar value of a `key: value` line within `lines`. */
function scalar(lines: string[], key: string): string | undefined {
  const idx = findKey(lines, key);
  if (idx === -1) return undefined;
  const m = new RegExp(`^\\s*${key}:\\s*(.*)$`).exec(lines[idx] ?? "");
  const raw = m?.[1]?.trim();
  if (!raw) return undefined;
  return stripQuotes(raw);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a k8s `env:` list (sequence of `- name:`/`value:` pairs) into a flat
 * record. `valueFrom` (secretKeyRef/configMapKeyRef) entries are skipped — the
 * supervisor injects those via its own secret path (parity subset).
 */
function parseEnv(envBlock: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  let currentName: string | undefined;
  for (const line of envBlock) {
    const nameMatch = /^\s*-\s*name:\s*(.*)$/.exec(line);
    if (nameMatch) {
      currentName = stripQuotes((nameMatch[1] ?? "").trim());
      continue;
    }
    const valueMatch = /^\s*value:\s*(.*)$/.exec(line);
    if (valueMatch && currentName) {
      env[currentName] = stripQuotes((valueMatch[1] ?? "").trim());
      currentName = undefined;
    }
  }
  return env;
}

/**
 * Parse a k8s inline command array (`["sh", "-c", "…"]`) or a YAML block
 * sequence of `- item` lines into a string array.
 */
function parseCommand(lines: string[], startIdx: number): string[] {
  const inline = /^\s*command:\s*\[(.*)\]\s*$/.exec(lines[startIdx] ?? "");
  if (inline) {
    return (inline[1] ?? "")
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s.length > 0);
  }
  // Block form: subsequent `- item` lines more indented than `command:`.
  return blockLines(lines, startIdx)
    .map((l) => /^\s*-\s*(.*)$/.exec(l)?.[1])
    .filter((v): v is string => v !== undefined)
    .map((v) => stripQuotes(v.trim()))
    .filter((v) => v.length > 0);
}

/** Translate a probe block (livenessProbe/readinessProbe) into a health check. */
function parseProbe(probeBlock: string[]): FastenvHealthCheck | undefined {
  const httpIdx = findKey(probeBlock, "httpGet");
  if (httpIdx !== -1) {
    const http = blockLines(probeBlock, httpIdx);
    const path = scalar(http, "path") ?? "/";
    const port = Number(scalar(http, "port"));
    if (Number.isFinite(port)) return { kind: "http", port, path };
  }
  const tcpIdx = findKey(probeBlock, "tcpSocket");
  if (tcpIdx !== -1) {
    const tcp = blockLines(probeBlock, tcpIdx);
    const port = Number(scalar(tcp, "port"));
    if (Number.isFinite(port)) return { kind: "tcp", port };
  }
  const execIdx = findKey(probeBlock, "exec");
  if (execIdx !== -1) {
    const exec = blockLines(probeBlock, execIdx);
    const cmdIdx = findKey(exec, "command");
    if (cmdIdx !== -1) {
      const command = parseCommand(exec, cmdIdx);
      if (command.length > 0) return { kind: "exec", command };
    }
  }
  return undefined;
}

/**
 * Parse the first container of a Deployment/StatefulSet document into a
 * workload. Returns null when the document is not a translatable workload.
 */
function parseWorkloadDocument(doc: string): FastenvWorkload | null {
  const lines = doc.split("\n");
  const kind = scalar(lines, "kind");
  if (kind !== "Deployment" && kind !== "StatefulSet") return null;

  // metadata.name is the workload name.
  const metaIdx = findKey(lines, "metadata");
  const name =
    (metaIdx !== -1 ? scalar(blockLines(lines, metaIdx), "name") : undefined) ??
    "";
  if (!name) return null;

  // First container under spec.template.spec.containers.
  const containersIdx = findKey(lines, "containers");
  if (containersIdx === -1) return null;
  const containers = blockLines(lines, containersIdx);

  const image = scalar(containers, "image") ?? "";

  const envIdx = findKey(containers, "env");
  const env = envIdx !== -1 ? parseEnv(blockLines(containers, envIdx)) : {};

  // Top-level container command (entrypoint override), if present.
  const cmdIdx = containers.findIndex((l) => /^\s*command:/.test(l));
  const command = cmdIdx !== -1 ? parseCommand(containers, cmdIdx) : [];

  // Prefer readinessProbe, fall back to livenessProbe.
  let health: FastenvHealthCheck | undefined;
  for (const probeKey of ["readinessProbe", "livenessProbe"]) {
    const idx = findKey(containers, probeKey);
    if (idx !== -1) {
      health = parseProbe(blockLines(containers, idx));
      if (health) break;
    }
  }

  // StatefulSet, or a postgres image, owns durable state.
  const stateful = kind === "StatefulSet" || /(^|\/)postgres/i.test(image);

  return { name, image, command, env, stateful, health };
}

/** Sort workloads into canonical order: stateful first, then by name. */
function canonicalize(workloads: FastenvWorkload[]): FastenvWorkload[] {
  return [...workloads].sort((a, b) => {
    if (a.stateful !== b.stateful) return a.stateful ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Translate one or more Kubernetes YAML documents into a `FastenvManifest`.
 *
 * @param yamlText  Raw YAML (may contain multiple `---`-separated documents).
 * @param name      Logical deployment name (defaults to "superfield").
 */
export function translateKubernetesManifest(
  yamlText: string,
  name = "superfield",
): FastenvManifest {
  const workloads: FastenvWorkload[] = [];
  for (const doc of splitDocuments(yamlText)) {
    const workload = parseWorkloadDocument(doc);
    if (workload) workloads.push(workload);
  }
  return { name, workloads: canonicalize(workloads) };
}

/**
 * Translate a docker-compose `services:` block into a `FastenvManifest`
 * (parity subset: image, command, environment, a postgres → stateful heuristic).
 */
export function translateDockerCompose(
  yamlText: string,
  name = "superfield",
): FastenvManifest {
  const lines = yamlText.split("\n");
  const servicesIdx = findKey(lines, "services");
  if (servicesIdx === -1) return { name, workloads: [] };

  const services = blockLines(lines, servicesIdx);
  const serviceBase = services.find((l) => l.trim().length > 0);
  const serviceIndent = serviceBase ? indent(serviceBase) : 2;

  const workloads: FastenvWorkload[] = [];
  for (let i = 0; i < services.length; i++) {
    const line = services[i];
    if (line === undefined) continue;
    const nameMatch = /^(\s*)([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (!nameMatch || indent(line) !== serviceIndent) continue;

    const svcName = nameMatch[2] ?? "";
    const body = blockLines(services, i);
    const image = scalar(body, "image") ?? "";

    // compose `environment:` may be a `KEY: value` map or `- KEY=value` list.
    const env: Record<string, string> = {};
    const envIdx = findKey(body, "environment");
    if (envIdx !== -1) {
      for (const envLine of blockLines(body, envIdx)) {
        const listMatch = /^\s*-\s*([^=]+)=(.*)$/.exec(envLine);
        if (listMatch) {
          env[(listMatch[1] ?? "").trim()] = stripQuotes(
            (listMatch[2] ?? "").trim(),
          );
          continue;
        }
        const mapMatch = /^\s*([A-Za-z0-9._-]+):\s*(.*)$/.exec(envLine);
        if (mapMatch) {
          env[(mapMatch[1] ?? "").trim()] = stripQuotes(
            (mapMatch[2] ?? "").trim(),
          );
        }
      }
    }

    const cmdIdx = body.findIndex((l) => /^\s*command:/.test(l));
    const command = cmdIdx !== -1 ? parseCommand(body, cmdIdx) : [];

    const stateful = /(^|\/)postgres/i.test(image) || /postgres/i.test(svcName);
    workloads.push({ name: svcName, image, command, env, stateful });
  }

  return { name, workloads: canonicalize(workloads) };
}
