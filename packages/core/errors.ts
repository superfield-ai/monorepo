/**
 * @file errors.ts
 *
 * Typed error hierarchy for @superfield/core.
 *
 * Every failure that crosses a public function boundary should throw one of
 * the classes defined here (or a subclass). Each error carries:
 *
 *   - `code`: a stable string discriminator. Callers branch on `error.code`,
 *     never on `error.message`.
 *   - `cause`: optional underlying error for diagnostics. Preserved through
 *     re-throws so the original stack is not lost.
 *
 * The base class is `SuperfieldError`. Use `instanceof SuperfieldError` to
 * check for "any superfield error", or check the specific subclass for a
 * narrower category.
 *
 * # Categories
 *
 * - `ConfigError`        — invalid or missing configuration (env vars, ~/.superfield/config.yaml).
 * - `UserInputError`     — bad CLI arg, missing required flag, malformed input.
 * - `ProviderError`      — cloud-provider call failed (GCP, AWS, DigitalOcean, Vultr).
 * - `GitError`           — git or worktree operation failed.
 * - `GitHubApiError`     — GitHub REST/GraphQL call failed (re-exported from github/http).
 * - `AgentError`         — agent CLI invocation failed.
 * - `InternalError`      — invariant violation; indicates a bug.
 *
 * # When to use which
 *
 * Use the category that most accurately describes *the layer at which the
 * failure originated*, not where it bubbles up. A network error from a GCP
 * call is `ProviderError`, not `InternalError`, even though the immediate
 * symptom is `fetch` rejecting. A missing `--repo` flag is `UserInputError`,
 * not `ConfigError`, because the user could fix it on the next command.
 */

export type ErrorCode =
  | "config"
  | "user_input"
  | "provider"
  | "git"
  | "github_api"
  | "agent"
  | "internal";

export interface SuperfieldErrorOpts {
  cause?: unknown;
  /** Optional structured context for diagnostics. Logged verbatim. */
  context?: Record<string, unknown>;
}

/** Base class for every typed error thrown by @superfield/core. */
export class SuperfieldError extends Error {
  readonly code: ErrorCode;
  override readonly cause: unknown;
  readonly context: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: SuperfieldErrorOpts = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.cause = opts.cause;
    this.context = opts.context;
  }
}

/** Invalid or missing configuration (env var, config.yaml, repo metadata). */
export class ConfigError extends SuperfieldError {
  constructor(message: string, opts: SuperfieldErrorOpts = {}) {
    super("config", message, opts);
  }
}

/** Bad CLI arg, missing required flag, or malformed user input. */
export class UserInputError extends SuperfieldError {
  constructor(message: string, opts: SuperfieldErrorOpts = {}) {
    super("user_input", message, opts);
  }
}

/** Cloud-provider call failed (GCP, AWS, DigitalOcean, Vultr). */
export class ProviderError extends SuperfieldError {
  readonly provider: string;
  constructor(
    provider: string,
    message: string,
    opts: SuperfieldErrorOpts = {},
  ) {
    super("provider", message, opts);
    this.provider = provider;
  }
}

/** Git or worktree operation failed. */
export class GitError extends SuperfieldError {
  constructor(message: string, opts: SuperfieldErrorOpts = {}) {
    super("git", message, opts);
  }
}

/** Agent CLI invocation failed (claude, codex, opencode). */
export class AgentError extends SuperfieldError {
  constructor(message: string, opts: SuperfieldErrorOpts = {}) {
    super("agent", message, opts);
  }
}

/** Invariant violation. Indicates a bug, not an environmental issue. */
export class InternalError extends SuperfieldError {
  constructor(message: string, opts: SuperfieldErrorOpts = {}) {
    super("internal", message, opts);
  }
}

/**
 * Convenience: extract a stable `code` from any thrown value.
 * Returns "internal" for non-SuperfieldError values so callers always
 * receive a concrete code.
 */
export function errorCode(err: unknown): ErrorCode {
  return err instanceof SuperfieldError ? err.code : "internal";
}

/**
 * Convenience: format an error chain into a single multi-line string for
 * logging. Walks `.cause` to surface nested context.
 */
export function formatErrorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n  caused by: ");
}
