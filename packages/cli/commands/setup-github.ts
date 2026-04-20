import {
  readMnemonic,
  registerEnvDeployKey,
} from "@superfield/core";

const USAGE =
  "Usage: superfield setup-github --deploy-key --env <e> --repo <owner/name>";

export interface ParsedSetupGithubArgs {
  deployKey: boolean;
  env?: string;
  repo?: string;
  unknown: string[];
}

export function parseSetupGithubArgs(args: string[]): ParsedSetupGithubArgs {
  let deployKey = false;
  let env: string | undefined;
  let repo: string | undefined;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--deploy-key") {
      deployKey = true;
    } else if (arg === "--env") {
      env = args[++i];
    } else if (arg.startsWith("--env=")) {
      env = arg.slice("--env=".length);
    } else if (arg === "--repo") {
      repo = args[++i];
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else {
      unknown.push(arg);
    }
  }

  return { deployKey, env, repo, unknown };
}

export async function setupGithubCommand(args: string[]): Promise<void> {
  const parsed = parseSetupGithubArgs(args);

  if (
    !parsed.deployKey ||
    !parsed.env ||
    !parsed.repo ||
    parsed.unknown.length > 0
  ) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(parsed.repo)) {
    console.error(`error: --repo must be in owner/name form (got ${parsed.repo})`);
    process.exit(1);
    return;
  }

  const mnemonic = await readMnemonic();
  // `registerEnvDeployKey` passes the buffer to `deriveEd25519Key`, which
  // zeroes it before returning. The defensive `finally` re-zeroes if anything
  // throws before the buffer is consumed.
  try {
    const result = await registerEnvDeployKey({
      repo: parsed.repo,
      env: parsed.env,
      mnemonic,
    });
    const envUpper = parsed.env.toUpperCase();
    console.log(
      `\u2713 Deploy key registered (id ${result.keyId}) on ${parsed.repo}`,
    );
    if (result.secretWritten) {
      console.log(
        `\u2713 Uploaded secret DEPLOY_KEY_${envUpper} and recorded fingerprint in DEPLOY_KEY_${envUpper}_FP`,
      );
    } else {
      console.log(
        `\u2713 DEPLOY_KEY_${envUpper} is already up to date (fingerprint matches)`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exit(1);
  } finally {
    mnemonic.fill(0);
  }
}
