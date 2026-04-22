import { githubCommand } from "./commands/github.ts";
import { startCommand, type StartLoop } from "./commands/start.ts";
import { planCommand } from "./commands/plan.ts";
import { featureCommand } from "./commands/feature.ts";
import { deployCommand, type DeployCommandDeps } from "./commands/deploy.ts";
import { destroyCommand } from "./commands/destroy.ts";
import { deployEnvCommand } from "./commands/deploy-env.ts";
import { rollbackEnvCommand } from "./commands/rollback-env.ts";
import { setupGithubCommand } from "./commands/setup-github.ts";
import { syncCommand } from "./commands/sync.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
const BUILD_VERSION = process.env.SUPERFIELD_BUILD_VERSION ?? "dev";
const BUILD_COMMIT = process.env.SUPERFIELD_BUILD_COMMIT ?? "unknown";
const BUILD_DATE = process.env.SUPERFIELD_BUILD_DATE ?? "unknown";
const BUILD_BLUEPRINT_COMMIT =
  process.env.SUPERFIELD_BUILD_BLUEPRINT_COMMIT ?? "unknown";

function usage(): string {
  return `
superfield — GitOps AI orchestrator

Version: ${BUILD_VERSION}
Commit: ${BUILD_COMMIT}
Blueprint: ${BUILD_BLUEPRINT_COMMIT}
Build date: ${BUILD_DATE}

Commands:
  github add    Authenticate and register a repository
  github forget Remove credentials and print app uninstall link
  start <path> [slotCount] [--plan] [--dev] [--doc]
                Begin loop(s). Defaults to all three when no --<loop> flags are provided.
  plan          Replan: group issues into phases, create scouts, write Plan
  feature "..." Evaluate a feature request and create an issue + Plan entry
  deploy [--provision] [target]
                Provision the demo target, then deploy it. Use --provision to run setup only.
  deploy gcp [--project <id>] [--region <r>] [--zone <z>] [--provision] [--image-tag <tag>]
                Provision and/or deploy to GCP. --provision runs infra setup only.
  deploy gcp --login [--client-id <id>]
                Authenticate with Google Cloud via device-code OAuth flow.
  deploy gcp --logout
                Delete the local GCP OAuth token and exit.
  setup-github --deploy-key --env <e> --repo <owner/name>
                Register the per-environment SSH deploy key on the application repo
                and store the matching private key as the DEPLOY_KEY_<ENV> secret.
  setup-github --secrets --env <e> --repo <owner/name> --host <h> --database-url <u>
                Push per-env Actions secrets (DEPLOY_HOST, DATABASE_URL,
                WEBHOOK_SECRET, COOKIE_SECRET) idempotently. Skips uploads
                whose SHA-256 fingerprint matches the recorded variable.
  sync --repo <owner/name> --app-name <name> [--image-repo <r>] [--deployments <a,b,c>]
                Render vendored .github/workflows/{release,deploy,rollback}.yml
                templates and open a PR if the rendered set differs from the
                target repo's current files.
  deploy-env --repo <owner/name> --env <e> --tag <t> --app-name <name>
             [--workers <a,b,c>] [--health-path <p>] [--namespace <ns>]
             [--dry-run] [--json]
                Drive a rolling update on a provisioned VM. Reads DEPLOY_HOST
                and DEPLOY_KEY (or DEPLOY_KEY_FILE) from the environment.
  rollback-env --repo <owner/name> --env <e> --app-name <name>
               [--workers <a,b,c>] [--health-path <p>] [--namespace <ns>]
               [--json]
                Roll each deployment back to its previous revision on a
                provisioned VM. Reads DEPLOY_HOST and DEPLOY_KEY (or
                DEPLOY_KEY_FILE) from the environment. Exits non-zero on
                health-check failure without rolling forward.
  doctor --env <e> --repo <owner/name> [--json]
                Run preflight checks: gh-auth, ghcr-pull, secrets-present,
                secret-fingerprints, ssh-reachable, k3s-healthy, db-reachable.
                Exits 0 if all pass, 1 if any fail.
  init --env <e> --provider <gcp|aws|digitalocean|vultr> --repo <owner/name> --image-tag <t>
       [--managed-db] [--region <r>] [--from-step <n>]
                One-shot environment initialisation: provision, bootstrap,
                deploy-key, secrets, sync, and deploy in sequence.
  destroy --env <e> --provider <gcp|aws|digitalocean|vultr> --repo <owner/name>
          [--yes] [--yes-i-really-mean-it]
                Tear down all provider infrastructure for the given environment
                and remove the associated GitHub Actions secrets. Requires
                --yes-i-really-mean-it when env is "prod".
`.trim();
}

export interface RunCLIDeps {
  deployCommandDeps?: DeployCommandDeps;
}

export async function runCLI(
  args: string[],
  deps: RunCLIDeps = {},
): Promise<void> {
  const [cmd, sub, third] = args;

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(usage());
    return;
  }

  if (cmd === "github") {
    await githubCommand(sub, third);
    return;
  }

  if (cmd === "start") {
    const parsed = parseStartArgs(args.slice(1));
    if (parsed.unknown.length > 0) {
      console.error(
        `[error] Unknown start argument(s): ${parsed.unknown.join(" ")}`,
      );
      process.exit(1);
      return;
    }
    const slotCount = parseSlotCount(parsed.slotCountRaw);
    if (parsed.slotCountRaw !== undefined && slotCount === null) {
      console.warn(
        `[warn] Ignoring invalid slot count ${JSON.stringify(parsed.slotCountRaw)}; using the default slot count`,
      );
    }
    await startCommand(parsed.repoPath, {
      ...(slotCount !== null ? { slotCount } : {}),
      loops: parsed.loops,
    });
    return;
  }

  if (cmd === "plan") {
    await planCommand(sub);
    return;
  }

  if (cmd === "feature") {
    await featureCommand(sub, third);
    return;
  }

  if (cmd === "deploy") {
    await deployCommand(args.slice(1), deps.deployCommandDeps);
    return;
  }

  if (cmd === "setup-github") {
    await setupGithubCommand(args.slice(1));
    return;
  }

  if (cmd === "sync") {
    await syncCommand(args.slice(1));
    return;
  }

  if (cmd === "deploy-env") {
    await deployEnvCommand(args.slice(1));
    return;
  }

  if (cmd === "rollback-env") {
    await rollbackEnvCommand(args.slice(1));
    return;
  }

  if (cmd === "doctor") {
    await doctorCommand(args.slice(1));
    return;
  }

  if (cmd === "init") {
    await initCommand(args.slice(1));
    return;
  }

  if (cmd === "destroy") {
    await destroyCommand(args.slice(1));
    return;
  }

  console.log(usage());
  process.exit(cmd ? 1 : 0);
}

export function parseSlotCount(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export interface ParsedStartArgs {
  repoPath: string | undefined;
  slotCountRaw: string | undefined;
  loops: StartLoop[];
  unknown: string[];
}

export function parseStartArgs(args: string[]): ParsedStartArgs {
  const loopSet = new Set<StartLoop>();
  const positionals: string[] = [];
  const unknown: string[] = [];

  for (const arg of args) {
    if (arg === "--plan") {
      loopSet.add("plan");
      continue;
    }
    if (arg === "--dev") {
      loopSet.add("dev");
      continue;
    }
    if (arg === "--doc") {
      loopSet.add("doc");
      continue;
    }
    if (arg.startsWith("--")) {
      unknown.push(arg);
      continue;
    }
    positionals.push(arg);
  }

  if (positionals.length > 2) {
    unknown.push(...positionals.slice(2));
  }

  const loops: StartLoop[] =
    loopSet.size > 0 ? Array.from(loopSet) : ["plan", "dev", "doc"];

  return {
    repoPath: positionals[0],
    slotCountRaw: positionals[1],
    loops,
    unknown,
  };
}
