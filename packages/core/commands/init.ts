/**
 * One-shot `init` command: provision + bootstrap + GitHub wiring + deploy,
 * composing all prior phases into a single operator-facing entry point.
 *
 * Steps (1-indexed, matching --from-step):
 *   1. provision   — create VM + optional managed DB on the target cloud
 *   2. bootstrap   — run install.sh on the fresh VM and wait for k3s
 *   3. deploy-key  — register per-env SSH deploy key on the app repo
 *   4. secrets     — push DEPLOY_HOST / DATABASE_URL / WEBHOOK_SECRET / COOKIE_SECRET
 *   5. sync        — open a PR updating the vendored workflow templates
 *   6. deploy      — roll out the requested image tag
 */

import { bootstrapHost } from "../bootstrap/orchestrator.ts";
import { deriveEd25519Key, readMnemonic } from "../secrets/index.ts";
import { registerEnvDeployKey, pushEnvSecrets } from "./setup-github.ts";
import { syncWorkflows } from "./sync-workflows.ts";
import { deployEnv } from "./deploy-env.ts";

// Type used as the common shape across all providers.
export interface ProvisionResult {
  host: string;
  initialPrivateKeyPem: string;
  databaseUrl?: string;
}

// ── Public types ─────────────────────────────────────────────────────────────

export type InitProvider = "gcp" | "aws" | "digitalocean" | "vultr";

export interface InitOpts {
  env: string;
  provider: InitProvider;
  /** owner/name form */
  repo: string;
  imageTag: string;
  managedDb?: boolean;
  region?: string;
  /** 1-indexed step number to resume from. Steps before this are skipped. */
  fromStep?: number;
  /** Injection point for all underlying steps — used exclusively in tests. */
  deps?: InitDeps;
}

export interface InitResult {
  host: string;
  deployUrl: string;
}

/**
 * Dependency-injection bag. Every field is optional; omitting a field means
 * "use the real implementation". Tests supply fakes for every field so no
 * network/SSH calls are made.
 *
 * When `fromStep > 1` the caller MUST supply `deps.provision` returning a
 * cached `ProvisionResult` — otherwise the host address is unknowable.
 */
export interface InitDeps {
  /** Override the provision step. Required when fromStep > 1. */
  provision?: (
    opts: InitOpts & {
      derivedDeployKeyPublicOpenSsh: string;
      mnemonic?: Buffer;
    },
  ) => Promise<ProvisionResult>;
  /** Override the bootstrap step. */
  bootstrapHost?: typeof bootstrapHost;
  /** Override the registerEnvDeployKey step. */
  registerEnvDeployKey?: typeof registerEnvDeployKey;
  /** Override the pushEnvSecrets step. */
  pushEnvSecrets?: typeof pushEnvSecrets;
  /** Override the syncWorkflows step. */
  syncWorkflows?: typeof syncWorkflows;
  /** Override the deployEnv step. */
  deployEnv?: typeof deployEnv;
  /** Override readMnemonic (so tests never touch the TTY or env). */
  readMnemonic?: () => Promise<Buffer>;
  /** Log callback. Defaults to process.stdout. */
  log?: (line: string) => void;
}

// ── Step metadata ─────────────────────────────────────────────────────────────

const STEPS = [
  "provision",
  "bootstrap",
  "deploy-key",
  "secrets",
  "sync",
  "deploy",
] as const;

type StepName = (typeof STEPS)[number];

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Run (or resume) the full environment initialisation sequence.
 *
 * Each step is printed before execution so operators can follow progress.
 * Pass `fromStep` (1-indexed) to skip already-completed steps.
 */
export async function init(opts: InitOpts): Promise<InitResult> {
  const log = opts.deps?.log ?? defaultLog;
  const from = opts.fromStep ?? 1;
  const knownHostsPath = `${process.env.HOME ?? ""}/.ssh/known_hosts.superfield`;

  function shouldRun(stepIndex: number): boolean {
    return stepIndex >= from;
  }

  function printStep(index: number, name: StepName): void {
    log(`[step ${index}/${STEPS.length}] ${name}`);
  }

  function skipStep(index: number, name: StepName): void {
    log(`[skip step ${index}/${STEPS.length}] ${name}`);
  }

  // Read the mnemonic once up front (before any network calls).
  const readMnemonicFn = opts.deps?.readMnemonic ?? readMnemonic;
  const mnemonic = await readMnemonicFn();

  // Derive the SSH deploy keypair from the mnemonic. `deriveEd25519Key`
  // zeroes the Buffer it receives, so we work on a copy and keep the
  // original for downstream steps (registerEnvDeployKey, pushEnvSecrets).
  const mnemonicForDerive = Buffer.from(mnemonic);
  const {
    publicKeyOpenSsh: derivedDeployKeyPublicOpenSsh,
    privateKeyPem: derivedDeployKeyPrivatePem,
  } = deriveEd25519Key(mnemonicForDerive, opts.env, "ssh-deploy-key");

  // Resolve the provision function — either injected or the default for the provider.
  const provisionFn =
    opts.deps?.provision ?? makeDefaultProvision(opts.provider);

  // ── Step 1: provision ──────────────────────────────────────────────────────
  let provisionResult: ProvisionResult;
  if (shouldRun(1)) {
    printStep(1, "provision");
    try {
      provisionResult = await provisionFn({
        ...opts,
        derivedDeployKeyPublicOpenSsh,
        mnemonic: opts.managedDb ? Buffer.from(mnemonic) : undefined,
      });
    } catch (err) {
      mnemonic.fill(0);
      throw wrapStepError(1, "provision", err);
    }
  } else {
    skipStep(1, "provision");
    // When skipping provision the caller MUST supply a deps.provision that
    // returns the cached result (host + initialPrivateKeyPem + optional databaseUrl).
    // Without deps.provision the host address cannot be known.
    try {
      provisionResult = await provisionFn({
        ...opts,
        derivedDeployKeyPublicOpenSsh,
        mnemonic: undefined,
      });
    } catch (err) {
      mnemonic.fill(0);
      throw new Error(
        `Step 1 (provision) was skipped but deps.provision returned an error or was not supplied. ` +
          `When using --from-step > 1, inject deps.provision with a function that returns the cached ProvisionResult. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { host, initialPrivateKeyPem, databaseUrl } = provisionResult;

  // ── Step 2: bootstrap ──────────────────────────────────────────────────────
  if (shouldRun(2)) {
    printStep(2, "bootstrap");
    try {
      const bootstrapFn = opts.deps?.bootstrapHost ?? bootstrapHost;
      await bootstrapFn({
        host,
        user: "root",
        initialPrivateKeyPem,
        derivedDeployKeyPublicOpenSsh,
        derivedDeployKeyPrivatePem,
        knownHostsPath,
      });
    } catch (err) {
      mnemonic.fill(0);
      throw wrapStepError(2, "bootstrap", err);
    }
  } else {
    skipStep(2, "bootstrap");
  }

  // ── Step 3: deploy-key ────────────────────────────────────────────────────
  if (shouldRun(3)) {
    printStep(3, "deploy-key");
    try {
      const registerFn =
        opts.deps?.registerEnvDeployKey ?? registerEnvDeployKey;
      await registerFn({
        repo: opts.repo,
        env: opts.env,
        mnemonic: Buffer.from(mnemonic),
      });
    } catch (err) {
      mnemonic.fill(0);
      throw wrapStepError(3, "deploy-key", err);
    }
  } else {
    skipStep(3, "deploy-key");
  }

  // ── Step 4: secrets ───────────────────────────────────────────────────────
  if (shouldRun(4)) {
    printStep(4, "secrets");
    try {
      const pushFn = opts.deps?.pushEnvSecrets ?? pushEnvSecrets;
      await pushFn({
        repo: opts.repo,
        env: opts.env,
        host,
        databaseUrl: databaseUrl ?? localDatabaseUrl(opts.env),
        mnemonic: Buffer.from(mnemonic),
      });
    } catch (err) {
      mnemonic.fill(0);
      throw wrapStepError(4, "secrets", err);
    }
  } else {
    skipStep(4, "secrets");
  }

  // Zero the original mnemonic now that all mnemonic-dependent steps are done.
  mnemonic.fill(0);

  // ── Step 5: sync ──────────────────────────────────────────────────────────
  if (shouldRun(5)) {
    printStep(5, "sync");
    try {
      const syncFn = opts.deps?.syncWorkflows ?? syncWorkflows;
      await syncFn({
        repo: opts.repo,
        appName: opts.repo.split("/")[1] ?? opts.repo,
      });
    } catch (err) {
      throw wrapStepError(5, "sync", err);
    }
  } else {
    skipStep(5, "sync");
  }

  // ── Step 6: deploy ────────────────────────────────────────────────────────
  let deployUrl: string;
  if (shouldRun(6)) {
    printStep(6, "deploy");
    try {
      const deployFn = opts.deps?.deployEnv ?? deployEnv;
      // The SSH private key is read from DEPLOY_KEY / DEPLOY_KEY_FILE in
      // production. Tests always inject deps.deployEnv so this path is not
      // exercised in unit tests.
      const { readFileSync } = await import("node:fs");
      let sshPrivateKeyPem = process.env.DEPLOY_KEY ?? "";
      if (!sshPrivateKeyPem) {
        const keyFile = process.env.DEPLOY_KEY_FILE;
        if (keyFile) {
          sshPrivateKeyPem = readFileSync(keyFile, "utf8");
        }
      }

      const appName = opts.repo.split("/")[1] ?? opts.repo;
      await deployFn({
        repo: opts.repo,
        env: opts.env,
        tag: opts.imageTag,
        appName,
        host,
        sshPrivateKeyPem,
        knownHostsPath,
      });
      deployUrl = `https://${host}`;
    } catch (err) {
      throw wrapStepError(6, "deploy", err);
    }
  } else {
    skipStep(6, "deploy");
    deployUrl = `https://${host}`;
  }

  log(`init complete: host=${host} deployUrl=${deployUrl}`);
  return { host, deployUrl };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

function wrapStepError(index: number, name: StepName, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const hint = stepHint(name);
  return new Error(
    `[step ${index}/${STEPS.length}] ${name} failed: ${msg}${hint ? `\n  hint: ${hint}` : ""}`,
  );
}

function stepHint(name: StepName): string {
  switch (name) {
    case "provision":
      return "Check cloud credentials and quota. Re-run with --from-step 1 to retry.";
    case "bootstrap":
      return "SSH into the host and check /var/log/syslog. Re-run with --from-step 2 to retry bootstrap.";
    case "deploy-key":
      return "Verify GITHUB_TOKEN has repo write access. Re-run with --from-step 3.";
    case "secrets":
      return "Verify GITHUB_TOKEN has secrets write access. Re-run with --from-step 4.";
    case "sync":
      return "Verify GITHUB_TOKEN has contents write access. Re-run with --from-step 5.";
    case "deploy":
      return "Check DEPLOY_KEY / DEPLOY_KEY_FILE and GITHUB_TOKEN. Re-run with --from-step 6.";
  }
}

/** In-cluster postgres URL used when managedDb is false. */
function localDatabaseUrl(env: string): string {
  return `postgresql://app:app@postgres-${env}.default.svc.cluster.local:5432/app`;
}

/**
 * Build a provider-specific provision function. The provider modules are
 * imported dynamically so only the selected provider's transitive
 * dependencies are pulled in.
 *
 * For GCP, the provision helper requires platform credentials (OAuth token).
 * Production callers should inject deps.provision with a fully-wired function
 * (e.g. constructed in the `deploy gcp` command). The default here throws a
 * clear actionable error for the GCP case.
 */
function makeDefaultProvision(
  provider: InitProvider,
): (
  opts: InitOpts & { derivedDeployKeyPublicOpenSsh: string; mnemonic?: Buffer },
) => Promise<ProvisionResult> {
  return async (opts): Promise<ProvisionResult> => {
    switch (provider) {
      case "gcp": {
        throw new Error(
          "GCP provision requires platform authentication. " +
            "Inject deps.provision with a GCP-authenticated provision function " +
            "or use the `deploy gcp` subcommand for GCP environments.",
        );
      }
      case "aws": {
        const { provision } = await import("../providers/aws/provision.js");
        return provision({
          env: opts.env,
          managedDb: opts.managedDb ?? false,
          derivedDeployKeyPublicOpenSsh: opts.derivedDeployKeyPublicOpenSsh,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.mnemonic ? { mnemonic: opts.mnemonic } : {}),
        });
      }
      case "digitalocean": {
        const { provision } =
          await import("../providers/digitalocean/index.ts");
        return provision({
          env: opts.env,
          managedDb: opts.managedDb ?? false,
          derivedDeployKeyPublicOpenSsh: opts.derivedDeployKeyPublicOpenSsh,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.mnemonic ? { mnemonic: opts.mnemonic } : {}),
        });
      }
      case "vultr": {
        const { provision } = await import("../providers/vultr/index.ts");
        return provision({
          env: opts.env,
          managedDb: opts.managedDb ?? false,
          derivedDeployKeyPublicOpenSsh: opts.derivedDeployKeyPublicOpenSsh,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.mnemonic ? { mnemonic: opts.mnemonic } : {}),
        });
      }
    }
  };
}
