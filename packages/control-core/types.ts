/**
 * @file types.ts
 *
 * Shared type definitions for the studio cluster management layer.
 *
 * These types form the contract between the studio start script, the
 * verification helpers, and the runtime cluster manager. They are
 * intentionally decoupled from any specific product's k8s manifests.
 */

// ── Studio configuration ──────────────────────────────────────────────────────

/**
 * Top-level configuration that studio reads at startup.
 *
 * Resolved from CLI arguments and environment variables.
 */
export interface StudioClusterConfig {
  /**
   * Absolute path to the product source directory.
   *
   * Studio passes this to Claude for code editing. Claude creates worktrees
   * from this directory but the directory itself always tracks main.
   */
  sourceDir: string;

  /**
   * Path to the product's Kubernetes deployment files, relative to sourceDir.
   *
   * Default: "k8s/"
   */
  k8sDir: string;

  /** kubectl namespace for the studio cluster. Default: "default" */
  namespace: string;

  /** Enable verbose diagnostic logging. */
  verbose: boolean;
}

// ── K8s resource types ────────────────────────────────────────────────────────

/**
 * A Kubernetes resource discovered by parsing the product's k8s manifests.
 */
export interface K8sResource {
  /** Kubernetes kind: Deployment, StatefulSet, Job, Service, etc. */
  kind: string;
  /** metadata.name from the manifest. */
  name: string;
}

// ── Ephemeral secrets ─────────────────────────────────────────────────────────

/**
 * A Kubernetes Secret that studio must create before applying manifests.
 *
 * Discovered by scanning the product's k8s manifests for secretKeyRef
 * references. Studio generates random values for each key.
 */
export interface SecretSpec {
  /** The Secret resource name (e.g. "superfield-secrets"). */
  name: string;
  /** Key-value pairs to populate. Values are generated at runtime. */
  literals: Record<string, string>;
}

// ── Service health ────────────────────────────────────────────────────────────

/**
 * Health status of a single cluster workload, as reported by the
 * health polling loop.
 */
export interface ServiceHealth {
  kind: string;
  name: string;
  ready: boolean;
  /** Human-readable detail: "ready", "0/1 available — CrashLoopBackOff", etc. */
  detail: string;
}

// ── Verification result ───────────────────────────────────────────────────────

/**
 * Result of a single verification check.
 */
export interface VerifyCheck {
  name: string;
  ok: boolean;
  message: string;
}

/**
 * Aggregate verification result.
 */
export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}
