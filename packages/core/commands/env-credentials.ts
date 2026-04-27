/**
 * Shared helper for resolving deployment credentials from environment variables.
 *
 * Convention: env-suffixed form (`DEPLOY_HOST_PROD`) takes priority over the
 * plain form (`DEPLOY_HOST`).  This lets operators set a single env var for
 * single-env setups while multi-env setups can pin per-environment values.
 */

export interface EnvCredentials {
  /** SSH host for the deploy target (undefined if not set). */
  deployHost: string | undefined;
  /** SSH private key PEM (undefined if not set). */
  deployKey: string | undefined;
  /** Path to an SSH private key file (undefined if not set). */
  deployKeyFile: string | undefined;
  /** Database URL (undefined if not set). */
  databaseUrl: string | undefined;
}

/**
 * Resolve deployment credentials for the given environment name.
 *
 * For each credential, the env-suffixed form is checked first:
 *   `DEPLOY_HOST_<ENV>` → `DEPLOY_HOST`
 *   `DEPLOY_KEY_<ENV>`  → `DEPLOY_KEY`
 *   `DEPLOY_KEY_FILE_<ENV>` → `DEPLOY_KEY_FILE`
 *   `DATABASE_URL_<ENV>` → `DATABASE_URL`
 *
 * @param env  Environment name, e.g. `"prod"` or `"staging"`.
 * @param envOverride  Optional env-var map (defaults to `process.env`).
 *                     Injected by tests so no real env vars are mutated.
 */
export function resolveEnvCredentials(
  env: string,
  envOverride?: Record<string, string | undefined>,
): EnvCredentials {
  const e = env.toUpperCase();
  const vars = envOverride ?? process.env;

  function pick(suffixed: string, plain: string): string | undefined {
    return vars[suffixed] ?? vars[plain] ?? undefined;
  }

  return {
    deployHost: pick(`DEPLOY_HOST_${e}`, "DEPLOY_HOST"),
    deployKey: pick(`DEPLOY_KEY_${e}`, "DEPLOY_KEY"),
    deployKeyFile: pick(`DEPLOY_KEY_FILE_${e}`, "DEPLOY_KEY_FILE"),
    databaseUrl: pick(`DATABASE_URL_${e}`, "DATABASE_URL"),
  };
}
