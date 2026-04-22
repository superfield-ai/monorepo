import {
  readMnemonic,
  registerEnvDeployKey,
  pushEnvSecrets,
} from "@superfield/core";

const USAGE = [
  "Usage: superfield setup-github --deploy-key --env <e> --repo <owner/name>",
  "       superfield setup-github --secrets --env <e> --repo <owner/name> --host <h> --database-url <u>",
].join("\n");

export interface ParsedSetupGithubArgs {
  deployKey: boolean;
  secrets: boolean;
  env?: string;
  repo?: string;
  host?: string;
  databaseUrl?: string;
  unknown: string[];
}

export function parseSetupGithubArgs(args: string[]): ParsedSetupGithubArgs {
  let deployKey = false;
  let secrets = false;
  let env: string | undefined;
  let repo: string | undefined;
  let host: string | undefined;
  let databaseUrl: string | undefined;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--deploy-key") {
      deployKey = true;
    } else if (arg === "--secrets") {
      secrets = true;
    } else if (arg === "--env") {
      env = args[++i];
    } else if (arg.startsWith("--env=")) {
      env = arg.slice("--env=".length);
    } else if (arg === "--repo") {
      repo = args[++i];
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--host") {
      host = args[++i];
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--database-url") {
      databaseUrl = args[++i];
    } else if (arg.startsWith("--database-url=")) {
      databaseUrl = arg.slice("--database-url=".length);
    } else {
      unknown.push(arg);
    }
  }

  return { deployKey, secrets, env, repo, host, databaseUrl, unknown };
}

export async function setupGithubCommand(args: string[]): Promise<void> {
  const parsed = parseSetupGithubArgs(args);

  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!parsed.deployKey && !parsed.secrets) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!parsed.env || !parsed.repo) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (parsed.secrets && (!parsed.host || !parsed.databaseUrl)) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(parsed.repo)) {
    console.error(
      `error: --repo must be in owner/name form (got ${parsed.repo})`,
    );
    process.exit(1);
    return;
  }

  const mnemonic = await readMnemonic();
  try {
    if (parsed.deployKey) {
      // `registerEnvDeployKey` passes the buffer to `deriveEd25519Key`, which
      // zeroes it before returning. The defensive `finally` re-zeroes if anything
      // throws before the buffer is consumed.
      const result = await registerEnvDeployKey({
        repo: parsed.repo,
        env: parsed.env,
        mnemonic,
      });
      const envUpper = parsed.env.toUpperCase();
      console.log(
        `✓ Deploy key registered (id ${result.keyId}) on ${parsed.repo}`,
      );
      if (result.secretWritten) {
        console.log(
          `✓ Uploaded secret DEPLOY_KEY_${envUpper} and recorded fingerprint in DEPLOY_KEY_${envUpper}_FP`,
        );
      } else {
        console.log(
          `✓ DEPLOY_KEY_${envUpper} is already up to date (fingerprint matches)`,
        );
      }
    } else {
      const result = await pushEnvSecrets({
        repo: parsed.repo,
        env: parsed.env,
        host: parsed.host!,
        databaseUrl: parsed.databaseUrl!,
        mnemonic,
      });

      // CRITICAL: only print secret NAMES and the action — never the values.
      for (const name of result.uploaded) {
        console.log(`✓ ${name} uploaded`);
      }
      for (const name of result.skipped) {
        console.log(`✓ ${name} skipped (fingerprint matches)`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exit(1);
  } finally {
    mnemonic.fill(0);
  }
}
