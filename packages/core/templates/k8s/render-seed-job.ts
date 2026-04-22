import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { normalizeTagForName } from "./render-migrate-job.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEMPLATE_PATH = join(__dirname, "db-seed-job.yaml.tpl");

export interface RenderSeedJobOptions {
  env: string;
  tag: string;
  imageRepo: string;
}

/**
 * Render the vendored db-seed Job manifest with the given parameters.
 *
 * Mirrors {@link renderMigrateJobManifest}: the container command is
 * `["/app", "seed"]` rather than `migrate`. Output is byte-deterministic via
 * `yaml.stringify({ sortMapEntries: true })`.
 */
export function renderSeedJobManifest(opts: RenderSeedJobOptions): string {
  const { env, tag, imageRepo } = opts;
  const nameTag = normalizeTagForName(tag);

  const raw = readFileSync(TEMPLATE_PATH, "utf8");
  const substituted = raw
    .replace(/\{\{\s*ENV\s*\}\}/g, env)
    .replace(/\{\{\s*NAME_TAG\s*\}\}/g, nameTag)
    .replace(/\{\{\s*TAG\s*\}\}/g, tag)
    .replace(/\{\{\s*IMAGE_REPO\s*\}\}/g, imageRepo);

  const parsed = parseYaml(substituted);
  return stringifyYaml(parsed, { sortMapEntries: true });
}

/**
 * Render a standalone PVC manifest for the postgres data volume. Used by the
 * clean-room flow to provision a fresh PVC named with a timestamp suffix
 * before the postgres StatefulSet is re-pointed at it.
 *
 * Size and storageClass mirror the vendored postgres template
 * (`postgres.yaml.tpl`): 20Gi on `local-path`.
 */
export function renderCleanRoomPvcManifest(opts: {
  env: string;
  pvcName: string;
}): string {
  const doc = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      labels: {
        app: "postgres",
        env: opts.env,
      },
      name: opts.pvcName,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: {
        requests: {
          storage: "20Gi",
        },
      },
      storageClassName: "local-path",
    },
  };
  return stringifyYaml(doc, { sortMapEntries: true });
}
