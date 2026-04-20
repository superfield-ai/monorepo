import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, stringify } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const POSTGRES_TEMPLATE_PATH = join(__dirname, "postgres.yaml.tpl");

/**
 * Substitute `{{ ENV }}` placeholders (with arbitrary internal whitespace)
 * with the supplied env value. The env string itself is inserted verbatim,
 * so callers must validate it before invoking the renderer.
 */
function substituteEnv(template: string, env: string): string {
  return template.replace(/\{\{\s*ENV\s*\}\}/g, env);
}

/**
 * Render the postgres StatefulSet + Service manifest for the given env.
 *
 * Output is deterministic: YAML documents are re-emitted with sorted map
 * keys so two calls with the same env produce byte-identical output, which
 * keeps `kubectl diff` output minimal across deploys.
 */
export function renderPostgresManifest(env: string): string {
  const template = readFileSync(POSTGRES_TEMPLATE_PATH, "utf8");
  const substituted = substituteEnv(template, env);
  const docs = parseAllDocuments(substituted);
  const rendered = docs
    .map((doc) =>
      stringify(doc.toJS(), {
        sortMapEntries: true,
        indent: 2,
        lineWidth: 0,
      }),
    )
    .join("---\n");
  return rendered;
}
