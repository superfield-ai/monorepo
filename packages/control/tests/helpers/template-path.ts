import { resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * Resolve the path to a checkout of `superfield-ai/superfield-starter-ts`.
 *
 * Honours `TEMPLATE_REPO_PATH` from the environment first (CI sets this).
 * Falls back to the sibling `template/` directory next to the cli repo,
 * which is the canonical local-dev layout. Throws if neither exists so
 * tests fail fast with a clear error.
 */
export function resolveTemplatePath(): string {
  const fromEnv = process.env.TEMPLATE_REPO_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `TEMPLATE_REPO_PATH=${fromEnv} does not exist. ` +
          `Check out superfield-ai/superfield-starter-ts to that path before running template-* tests.`,
      );
    }
    return fromEnv;
  }
  const sibling = resolve(import.meta.dirname, "../../../../../template");
  if (existsSync(sibling)) return sibling;
  throw new Error(
    `Could not locate the template repo. Set TEMPLATE_REPO_PATH or place a checkout ` +
      `of superfield-ai/superfield-starter-ts as a sibling of the cli repo at ${sibling}.`,
  );
}

/**
 * Non-throwing variant of {@link resolveTemplatePath}. Returns the resolved
 * path if a template checkout is available, or `null` if none can be located.
 *
 * Use this from test files that should be skipped (rather than fail) when the
 * fixture is not present, e.g. in CI jobs where the template repo isn't
 * checked out.
 */
export function findTemplatePath(): string | null {
  const fromEnv = process.env.TEMPLATE_REPO_PATH;
  if (fromEnv) {
    return existsSync(fromEnv) ? fromEnv : null;
  }
  const sibling = resolve(import.meta.dirname, "../../../../../template");
  return existsSync(sibling) ? sibling : null;
}
