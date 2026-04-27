/**
 * Integration tests for loadConfig() webPort fallback behavior.
 *
 * Spec: cli/docs/control-template-integration.md §2.2 #5.
 *
 * When SUPERFIELD_REPO_ROOT points at a directory that has no k8s/ subdir
 * (or an empty one), loadConfig() must fall back to webPort 80 silently
 * instead of throwing. CONTROL_WEB_SERVICE_PORT, when set, takes precedence
 * over both manifest discovery and the fallback.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { findTemplatePath } from "../helpers/template-path";

const d = findTemplatePath() ? describe : describe.skip;

// ── helpers ───────────────────────────────────────────────────────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const original: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    original[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

d("loadConfig — webPort fallback when k8s/ is missing or empty", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("falls back to port 80 when SUPERFIELD_REPO_ROOT has no k8s/ subdir", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "superfield-tmpl-"));
    withEnv(
      {
        SUPERFIELD_REPO_ROOT: tmpDir,
        CONTROL_WEB_SERVICE_PORT: undefined,
        CONTROL_WEB_SERVICE_HOST: undefined,
      },
      () => {
        const config = loadConfig();
        expect(config.webServiceUrl.endsWith(":80")).toBe(true);
      },
    );
  });

  it("falls back to port 80 when SUPERFIELD_REPO_ROOT has an empty k8s/ subdir", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "superfield-tmpl-"));
    mkdirSync(join(tmpDir, "k8s"));
    withEnv(
      {
        SUPERFIELD_REPO_ROOT: tmpDir,
        CONTROL_WEB_SERVICE_PORT: undefined,
        CONTROL_WEB_SERVICE_HOST: undefined,
      },
      () => {
        const config = loadConfig();
        expect(config.webServiceUrl.endsWith(":80")).toBe(true);
      },
    );
  });

  it("honors CONTROL_WEB_SERVICE_PORT override over fallback", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "superfield-tmpl-"));
    withEnv(
      {
        SUPERFIELD_REPO_ROOT: tmpDir,
        CONTROL_WEB_SERVICE_PORT: "8080",
        CONTROL_WEB_SERVICE_HOST: undefined,
      },
      () => {
        const config = loadConfig();
        expect(config.webServiceUrl.endsWith(":8080")).toBe(true);
      },
    );
  });
});
