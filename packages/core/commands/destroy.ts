import { createInterface } from "node:readline";

import { deleteRepoSecret } from "../github/secrets.ts";
import { deleteRepoVariable } from "../github/variables.ts";
import { makeDefaultGithubDeps } from "../github/index.ts";
import type { GitHubHttpDeps } from "../github/types.ts";

export type Provider = "gcp" | "aws" | "digitalocean" | "vultr";

export interface DestroyOpts {
  env: string;
  provider: Provider;
  repo: string;
  /** Skip the interactive yes/no confirmation prompt. */
  yes?: boolean;
  /** Required to destroy "prod" — protects against accidental data loss. */
  yesIReallyMeanIt?: boolean;
}

export interface DestroyDeps {
  /** Override the GitHub HTTP client (for tests). */
  githubDeps?: GitHubHttpDeps;
  /** Override stdin prompt (for tests). */
  confirm?: (message: string) => Promise<boolean>;
  /** Override the provider destroy function (for tests). */
  providerDestroy?: (opts: { env: string }) => Promise<void>;
  /** Override stdout logger. */
  log?: (msg: string) => void;
}

/** Names of Actions secrets deleted for every environment. */
const SECRET_NAMES = [
  "DEPLOY_HOST",
  "DATABASE_URL",
  "WEBHOOK_SECRET",
  "COOKIE_SECRET",
  "DEPLOY_KEY",
] as const;

/**
 * Tear down a superfield environment: provider resources + GitHub Actions
 * secrets. Deploy keys themselves are NOT deleted (instructions are printed).
 *
 * Safety gates:
 *  - If `env === "prod"` and `yesIReallyMeanIt` is not set, throws immediately.
 *  - Unless `yes` is set, prompts the user for interactive confirmation.
 */
export async function destroy(
  opts: DestroyOpts,
  deps: DestroyDeps = {},
): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.log(msg));

  // 1. Prod safety gate.
  if (opts.env === "prod" && !opts.yesIReallyMeanIt) {
    throw new Error(
      "Refusing to destroy the prod environment without --yes-i-really-mean-it. " +
        "Pass that flag only if you are absolutely certain.",
    );
  }

  // 2. Interactive confirmation (unless --yes).
  if (!opts.yes) {
    const envUpper = opts.env.toUpperCase();
    const secretLines = SECRET_NAMES.map((s) => `  • ${s}_${envUpper}`).join(
      "\n",
    );
    const message =
      `This will permanently destroy:\n` +
      `  • All ${opts.provider.toUpperCase()} infrastructure for env "${opts.env}" in repo ${opts.repo}\n` +
      `  • GitHub Actions secrets:\n${secretLines}\n` +
      `\nType "yes" to confirm: `;

    const confirmed = await (deps.confirm ?? defaultConfirm)(message);
    if (!confirmed) {
      log("Destroy cancelled.");
      return;
    }
  }

  // 3. Call provider destroy.
  const providerDestroy =
    deps.providerDestroy ?? (await resolveProviderDestroy(opts.provider));
  log(
    `Destroying ${opts.provider.toUpperCase()} resources for env "${opts.env}"…`,
  );
  await providerDestroy({ env: opts.env });
  log(`${opts.provider.toUpperCase()} resources destroyed.`);

  // 4. Remove GitHub Actions secrets + fingerprint variables for the env.
  const ghDeps = deps.githubDeps ?? makeDefaultGithubDeps();
  const envUpper = opts.env.toUpperCase();

  log(`Removing GitHub Actions secrets for env "${opts.env}"…`);
  for (const base of SECRET_NAMES) {
    const secretName = `${base}_${envUpper}`;
    const fpVarName = `${secretName}_FP`;
    await deleteRepoSecret(opts.repo, secretName, ghDeps);
    await deleteRepoVariable(opts.repo, fpVarName, ghDeps);
    log(
      `  Deleted secret ${secretName} and fingerprint variable ${fpVarName}.`,
    );
  }

  // 5. Print deploy key removal instructions (do NOT delete the key).
  log(
    `\nNOTE: The deploy key "superfield-deploy-${opts.env}" on repo ${opts.repo} was NOT deleted automatically.\n` +
      `Remove it manually at: https://github.com/${opts.repo}/settings/keys`,
  );
}

/**
 * Lazily import the appropriate provider module and return its `destroy`
 * function. Importers can override this via `deps.providerDestroy` for tests.
 */
async function resolveProviderDestroy(
  provider: Provider,
): Promise<(opts: { env: string }) => Promise<void>> {
  switch (provider) {
    case "gcp": {
      const mod = await import("../providers/gcp/index.ts");
      return async (opts) => {
        const { makeDefaultAuthDeps, makeDefaultHttpDeps } =
          await import("../gcp/index.js");
        const authDeps = makeDefaultAuthDeps();
        const { getGoogleAccessToken } = await import("../gcp/index.js");
        const httpDeps = makeDefaultHttpDeps({
          ...authDeps,
          getAccessToken: () => getGoogleAccessToken(authDeps),
        });
        const projectId = process.env["GCP_PROJECT_ID"];
        const region = process.env["GCP_REGION"] ?? "us-central1";
        const zone = process.env["GCP_ZONE"] ?? "us-central1-a";
        if (!projectId) {
          throw new Error(
            "GCP_PROJECT_ID environment variable is required for gcp provider destroy",
          );
        }
        await mod.destroy(
          { projectId, region, zone, env: opts.env },
          { ...httpDeps, log: console.log },
        );
      };
    }
    case "aws": {
      const mod = await import("../providers/aws/index.js");
      return async (opts) => {
        await mod.destroy({ env: opts.env });
      };
    }
    case "digitalocean": {
      const mod = await import("../providers/digitalocean/index.ts");
      return async (opts) => {
        await mod.destroy({ env: opts.env });
      };
    }
    case "vultr": {
      const mod = await import("../providers/vultr/index.ts");
      return async (opts) => {
        await mod.destroy({ env: opts.env });
      };
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}

async function defaultConfirm(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    process.stdout.write(message);
    rl.once("line", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
    rl.once("close", () => resolve(false));
  });
}
