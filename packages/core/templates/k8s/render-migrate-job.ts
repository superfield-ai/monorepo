import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEMPLATE_PATH = join(__dirname, "db-migrate-job.yaml.tpl");

export interface RenderMigrateJobOptions {
  env: string;
  tag: string;
  imageRepo: string;
}

/**
 * Normalize a container image tag for use inside a kubernetes resource name.
 *
 * Kubernetes resource names must be lowercase RFC 1123 labels and may not
 * contain `:` (digest separator) or `/`. We replace any character that is not
 * `[a-z0-9.-]` with `-` so digest-style tags like `sha256:abc123` become
 * `sha256-abc123` while plain semver tags like `v1.2.3` are unchanged.
 */
export function normalizeTagForName(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
}

/**
 * Render the vendored db-migrate Job manifest with the given parameters.
 *
 * The result is re-emitted via `yaml.stringify({ sortMapEntries: true })` so
 * that two calls with identical inputs produce byte-identical output.
 */
export function renderMigrateJobManifest(
  opts: RenderMigrateJobOptions,
): string {
  const { env, tag, imageRepo } = opts;
  const nameTag = normalizeTagForName(tag);

  const raw = readFileSync(TEMPLATE_PATH, "utf8");
  // Order matters: the `{{ NAME_TAG }}` sentinel is substituted only inside
  // the rendered Job metadata.name (see template) so digest-style tags do not
  // make the resource name invalid. Other `{{ TAG }}` occurrences keep the raw
  // tag for image references and version labels.
  const substituted = raw
    .replace(/\{\{\s*ENV\s*\}\}/g, env)
    .replace(/\{\{\s*NAME_TAG\s*\}\}/g, nameTag)
    .replace(/\{\{\s*TAG\s*\}\}/g, tag)
    .replace(/\{\{\s*IMAGE_REPO\s*\}\}/g, imageRepo);

  // Re-emit with sorted map entries for byte-deterministic output.
  const parsed = parseYaml(substituted);
  return stringifyYaml(parsed, { sortMapEntries: true });
}
