/**
 * Integration tests for loadConfig() web service port discovery from the
 * template repo's k8s manifests.
 *
 * Spec: cli/docs/control-template-integration.md §1.1.1 (Option A) and §2.2 #4.
 *
 * Verifies that:
 *   1. With SUPERFIELD_REPO_ROOT pointed at the template and
 *      CONTROL_WEB_SERVICE_NAME=superfield-app, the web port is discovered
 *      from template/k8s/app.yaml (port 80).
 *   2. With CONTROL_WEB_SERVICE_NAME unset (default "web"), discovery does not
 *      find a matching service in the template, so webPort falls back to 80.
 *   3. CONTROL_WEB_SERVICE_PORT explicitly set overrides discovery entirely.
 */

import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config";
import { resolveTemplatePath } from "../helpers/template-path";

const TEMPLATE = resolveTemplatePath();

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

describe("loadConfig — template k8s service discovery", () => {
  it("discovers webPort=80 from template/k8s/app.yaml when CONTROL_WEB_SERVICE_NAME=superfield-app", () => {
    withEnv(
      {
        SUPERFIELD_REPO_ROOT: TEMPLATE,
        CONTROL_WEB_SERVICE_NAME: "superfield-app",
        CONTROL_WEB_SERVICE_PORT: undefined,
        CONTROL_WEB_SERVICE_HOST: undefined,
      },
      () => {
        const config = loadConfig();
        expect(config.webServiceUrl.endsWith(":80")).toBe(true);
      },
    );
  });

  it("falls back to webPort=80 when CONTROL_WEB_SERVICE_NAME is unset (default 'web' not found in template)", () => {
    withEnv(
      {
        SUPERFIELD_REPO_ROOT: TEMPLATE,
        CONTROL_WEB_SERVICE_NAME: undefined,
        CONTROL_WEB_SERVICE_PORT: undefined,
        CONTROL_WEB_SERVICE_HOST: undefined,
      },
      () => {
        const config = loadConfig();
        expect(config.webServiceUrl).toBe("http://127.0.0.1:80");
      },
    );
  });

  it("CONTROL_WEB_SERVICE_PORT overrides discovery", () => {
    withEnv(
      {
        SUPERFIELD_REPO_ROOT: TEMPLATE,
        CONTROL_WEB_SERVICE_NAME: "superfield-app",
        CONTROL_WEB_SERVICE_PORT: "9999",
        CONTROL_WEB_SERVICE_HOST: undefined,
      },
      () => {
        const config = loadConfig();
        expect(config.webServiceUrl).toBe("http://127.0.0.1:9999");
      },
    );
  });
});
