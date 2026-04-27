/**
 * @file permissions.ts
 *
 * Harness-level permission sandbox for Claude in studio mode.
 *
 * Canonical spec: docs/studio-permissions.md
 *
 * ## Responsibilities
 *
 *   - Define allow-list and deny-list for tools available to Claude in studio
 *     mode.
 *   - Filter the tool set passed to Claude CLI so forbidden tools are never
 *     offered to the model.
 *   - Validate Bash commands against a deny-list of dangerous binaries and
 *     patterns (git, gh, rm, curl, wget, npm, yarn, pnpm, etc.).
 *   - Generate clear, non-silent denial messages when a forbidden action is
 *     attempted.
 *   - Provide the --allowed-tools flag value for the Claude CLI invocation so
 *     enforcement happens at the harness level, not solely via system prompt.
 *
 * ## Permission model
 *
 *   Claude in studio mode operates with neutered permissions. The harness
 *   restricts Claude to:
 *
 *     ALLOWED:
 *       - Read files in the session worktree
 *       - Edit application code files in the session worktree
 *       - Trigger rebuilds via the studio API (POST /studio/rebuild)
 *
 *     DENIED:
 *       - All git subcommands
 *       - gh CLI invocations
 *       - File deletion (rm, unlink, rmdir)
 *       - Package managers (npm, yarn, pnpm, bun install/add/remove)
 *       - System utilities not explicitly exposed
 *       - Outbound HTTP requests (curl, wget, fetch-based tools)
 *       - Bash escape hatches for any of the above
 *
 *   Enforcement is at the harness/tool-filtering level: the --allowed-tools
 *   flag restricts which tools Claude can use, and a Bash command validator
 *   rejects forbidden commands before they execute.
 *
 * ## Integration points
 *
 *   - claude-session.ts: uses getAllowedTools() to build the --allowed-tools
 *     flag when spawning Claude CLI.
 *   - claude-session.ts: uses buildPermissionDeniedMessage() for error
 *     responses when a forbidden tool invocation is detected.
 *   - router.ts: the /studio/rebuild endpoint is the only write-side action
 *     exposed to Claude.
 */

// ── Allowed tools ────────────────────────────────────────────────────────────

/**
 * Tools that Claude is allowed to use in studio mode.
 *
 * These correspond to Claude Code tool names. The Bash tool is intentionally
 * omitted from this list — all Bash access goes through the validated
 * BashWithDenyList wrapper, which only permits safe commands.
 *
 * See: docs/studio-permissions.md — "Tool allow-list"
 */
export const ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
] as const;

/**
 * Bash commands that are explicitly allowed in studio mode.
 *
 * These are safe, read-only or studio-specific commands that Claude can
 * invoke via Bash. Any command not matching this allow-list is denied.
 */
export const ALLOWED_BASH_COMMANDS: readonly string[] = [
  "cat",
  "ls",
  "head",
  "tail",
  "wc",
  "find",
  "echo",
  "pwd",
  "tsc",
  "bun run build",
  "bun run check",
  "bun run lint",
] as const;

/**
 * Patterns that are unconditionally denied in Bash commands.
 *
 * Each entry is either a literal binary name or a regex pattern. If a Bash
 * command matches any of these, it is denied regardless of allow-list status.
 *
 * This is a defense-in-depth layer: even if a command somehow bypasses the
 * allow-list check, the deny-list catches it.
 */
export const DENIED_BASH_PATTERNS: readonly (string | RegExp)[] = [
  // Version control
  "git",
  "gh",
  // File deletion
  "rm",
  "rmdir",
  "unlink",
  "shred",
  // Package managers
  "npm",
  "yarn",
  "pnpm",
  // Network / outbound HTTP
  "curl",
  "wget",
  "fetch",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ssh",
  "scp",
  "rsync",
  // System utilities
  "sudo",
  "su",
  "chmod",
  "chown",
  "chgrp",
  "mount",
  "umount",
  "kill",
  "killall",
  "pkill",
  "reboot",
  "shutdown",
  "systemctl",
  "docker",
  "kubectl",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pip",
  "pip3",
  // Bun-specific dangerous subcommands
  /^bun\s+(install|add|remove|update|link|unlink|pm)\b/,
] as const;

// ── Tool filtering ───────────────────────────────────────────────────────────

/**
 * Returns the list of tool names that Claude is allowed to use in studio mode.
 *
 * This list is passed to the Claude CLI via the --allowed-tools flag so that
 * the harness physically prevents Claude from seeing or invoking forbidden
 * tools. This is the primary enforcement mechanism — prompt-level instructions
 * are a secondary safeguard.
 *
 * @returns Array of tool name strings for the --allowed-tools flag.
 */
export function getAllowedTools(): string[] {
  return [...ALLOWED_TOOLS];
}

/**
 * Check whether a given tool name is permitted in studio mode.
 *
 * @param toolName  The tool name to check (e.g. 'Read', 'Bash', 'git').
 * @returns         true if the tool is in the allow-list.
 */
export function isToolAllowed(toolName: string): boolean {
  return ALLOWED_TOOLS.includes(toolName);
}

/**
 * Filter a list of tool names to only those permitted in studio mode.
 *
 * This is the primary tool-filtering function. It takes the full set of tools
 * that Claude would normally have access to and returns only the permitted
 * subset.
 *
 * @param tools  Full list of tool names (e.g. from Claude's default toolset).
 * @returns      Filtered list containing only allowed tools.
 */
export function filterTools(tools: string[]): string[] {
  return tools.filter((tool) => ALLOWED_TOOLS.includes(tool));
}

// ── Bash command validation ──────────────────────────────────────────────────

/**
 * Result of a Bash command validation check.
 */
export interface BashValidationResult {
  /** Whether the command is permitted. */
  allowed: boolean;
  /** Human-readable reason for denial (empty string when allowed). */
  reason: string;
}

/**
 * Extract the primary binary/command from a Bash command string.
 *
 * Handles common patterns:
 *   - Simple commands: "ls -la" → "ls"
 *   - Piped commands: "cat foo | grep bar" → "cat" (first command)
 *   - Chained commands: "cd /tmp && rm -rf ." → ["cd", "rm"] (all commands)
 *   - Subshells: "$(git status)" → "git"
 *   - Env prefix: "FOO=bar git status" → "git"
 *
 * @param command  Raw Bash command string.
 * @returns        Array of binary names found in the command.
 */
export function extractCommandBinaries(command: string): string[] {
  const binaries: string[] = [];

  // Split on pipes, semicolons, &&, ||, and newlines to get individual commands
  const segments = command.split(/\s*(?:\|{1,2}|&&|;|\n)\s*/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Strip leading env variable assignments (KEY=value ...)
    const withoutEnv = trimmed.replace(/^(?:[A-Z_][A-Z0-9_]*=[^\s]*\s+)+/, "");

    // Extract the first word (the binary name)
    const match = withoutEnv.match(/^([^\s]+)/);
    if (match?.[1]) {
      binaries.push(match[1]);
    }
  }

  // Also scan for subshell/backtick commands: $(...) or `...`
  const subshellMatches = command.matchAll(/\$\(([^)]+)\)/g);
  for (const m of subshellMatches) {
    if (!m[1]) continue;
    binaries.push(...extractCommandBinaries(m[1]));
  }

  const backtickMatches = command.matchAll(/`([^`]+)`/g);
  for (const m of backtickMatches) {
    if (!m[1]) continue;
    binaries.push(...extractCommandBinaries(m[1]));
  }

  return binaries;
}

/**
 * Validate a Bash command against the studio permission sandbox.
 *
 * The validation runs two checks:
 *   1. **Deny-list check**: Every binary in the command is tested against
 *      DENIED_BASH_PATTERNS. If any match, the command is denied.
 *   2. **Full command pattern check**: The entire command string is tested
 *      against regex patterns in the deny-list (for multi-word patterns like
 *      "bun install").
 *
 * @param command  The Bash command string to validate.
 * @returns        Validation result with allowed flag and denial reason.
 */
export function validateBashCommand(command: string): BashValidationResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: true, reason: "" };
  }

  const binaries = extractCommandBinaries(trimmed);

  // Check each binary against the deny-list
  for (const binary of binaries) {
    // Strip path prefixes (e.g. /usr/bin/git → git)
    const baseName = binary.split("/").pop() ?? binary;

    for (const pattern of DENIED_BASH_PATTERNS) {
      if (typeof pattern === "string") {
        if (baseName === pattern) {
          return {
            allowed: false,
            reason:
              `Command '${baseName}' is not permitted in studio mode. ` +
              `Studio restricts Claude to file reading and editing operations only.`,
          };
        }
      }
    }
  }

  // Check the full command against regex patterns
  for (const pattern of DENIED_BASH_PATTERNS) {
    if (pattern instanceof RegExp && pattern.test(trimmed)) {
      return {
        allowed: false,
        reason:
          `Command '${trimmed.slice(0, 60)}${trimmed.length > 60 ? "..." : ""}' ` +
          `matches a denied pattern in studio mode. ` +
          `Studio restricts Claude to file reading and editing operations only.`,
      };
    }
  }

  return { allowed: true, reason: "" };
}

// ── Denial messages ──────────────────────────────────────────────────────────

/**
 * Build a clear, non-silent denial message for a forbidden tool invocation.
 *
 * The message is designed to be returned to Claude so it understands why its
 * action was blocked and can suggest an alternative approach to the user.
 *
 * @param toolName  The tool that was denied.
 * @param detail    Optional additional context about the denial.
 * @returns         A formatted denial message string.
 */
export function buildPermissionDeniedMessage(
  toolName: string,
  detail?: string,
): string {
  const base = `[Studio Permission Denied] The tool '${toolName}' is not available in studio mode.`;
  const explanation =
    "Studio mode restricts Claude to file reading, editing, and " +
    "studio-exposed build commands. Git operations, file deletion, package managers, " +
    "network requests, and system utilities are blocked at the harness level.";
  const detailLine = detail ? ` Reason: ${detail}` : "";
  return `${base}${detailLine}\n\n${explanation}`;
}

// ── Mode-aware tool filtering ────────────────────────────────────────────────

/**
 * Returns the list of tool names allowed for a given studio mode.
 *
 * - 'design' mode: full ALLOWED_TOOLS set (read + write)
 * - 'question' mode: read-only tools (no Edit, Write)
 *
 * @param mode  The studio agent mode. Defaults to 'design' for backwards
 *              compatibility.
 * @returns     Array of tool name strings for the given mode.
 */
export function getAllowedToolsForMode(
  mode: "design" | "question" = "design",
): string[] {
  if (mode === "question") {
    // Question mode: read-only — strip Edit and Write
    return ALLOWED_TOOLS.filter(
      (tool) => tool !== "Edit" && tool !== "Write",
    ) as string[];
  }
  return [...ALLOWED_TOOLS];
}

/**
 * Check whether a given tool name is permitted for a specific mode.
 *
 * @param toolName  The tool name to check.
 * @param mode      The studio agent mode.
 * @returns         true if the tool is allowed in the given mode.
 */
export function isToolAllowedForMode(
  toolName: string,
  mode: "design" | "question" = "design",
): boolean {
  return getAllowedToolsForMode(mode).includes(toolName);
}

// ── CLI flag builder ─────────────────────────────────────────────────────────

/**
 * Build the --allowed-tools flag value for the Claude CLI invocation.
 *
 * Returns the comma-separated list of tool names that should be passed to
 * Claude's --allowed-tools flag. This is the harness-level enforcement
 * mechanism: Claude physically cannot access tools not in this list.
 *
 * @param mode  The studio agent mode. Defaults to 'design'.
 * @returns Comma-separated tool names string.
 */
export function buildAllowedToolsFlag(
  mode: "design" | "question" = "design",
): string {
  return getAllowedToolsForMode(mode).join(",");
}

// ── Studio system prompt addendum ────────────────────────────────────────────

/**
 * Permission-aware addendum to the studio system prompt.
 *
 * This is a secondary safeguard. The primary enforcement is via --allowed-tools
 * at the CLI level. This prompt addendum ensures Claude is aware of the
 * restrictions and can communicate them to the user.
 */
export const STUDIO_PERMISSION_PROMPT_ADDENDUM = `
## Studio Permission Boundaries

You are operating in studio mode with restricted permissions. The following
restrictions are enforced at the harness level (not just prompt-level):

**Allowed:**
- Read any file in the worktree
- Edit application code files
- Write new files (no deletions)
- Search files with Glob and Grep
- Trigger rebuilds via the studio API

**Denied (harness-enforced):**
- Git commands (git, gh)
- File deletion (rm, rmdir, unlink)
- Package managers (npm, yarn, pnpm, bun install/add/remove)
- Network requests (curl, wget, ssh)
- System utilities (sudo, docker, kubectl, chmod, etc.)

If a user asks you to perform a denied action, explain that it is not
available in studio mode and suggest an alternative approach.
`.trim();
