import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEMPLATE_PATH = join(__dirname, "postgres-backup-cronjob.yaml.tpl");

export interface RenderBackupCronJobOptions {
  env: string;
}

/**
 * Render the postgres daily-backup CronJob manifest for the given env.
 *
 * The CronJob schedules a daily `pg_basebackup` against the primary Postgres
 * instance. Output is deterministic: map keys are sorted so two calls with
 * the same env produce byte-identical YAML.
 *
 * See docs/architecture.md §Substrate Reliability for the full runbook.
 */
export function renderBackupCronJobManifest(
  opts: RenderBackupCronJobOptions,
): string {
  const { env } = opts;
  const raw = readFileSync(TEMPLATE_PATH, "utf8");
  const substituted = raw.replace(/\{\{\s*ENV\s*\}\}/g, env);
  const parsed = parseYaml(substituted);
  return stringifyYaml(parsed, { sortMapEntries: true });
}
