import { describe, it, expect } from "vitest";
import { resolveEnvCredentials } from "../../../commands/env-credentials.ts";

// ---------------------------------------------------------------------------
// resolveEnvCredentials — unit tests
//
// No mocks: we pass an explicit `envOverride` map to each call so real
// process.env is never read or mutated.
// ---------------------------------------------------------------------------

describe("resolveEnvCredentials — env-suffixed form takes priority", () => {
  it("returns the suffixed DEPLOY_HOST_<ENV> when both forms are present", () => {
    const creds = resolveEnvCredentials("prod", {
      DEPLOY_HOST_PROD: "10.0.0.1",
      DEPLOY_HOST: "9.9.9.9",
    });
    expect(creds.deployHost).toBe("10.0.0.1");
  });

  it("returns the suffixed DEPLOY_KEY_<ENV> when both forms are present", () => {
    const creds = resolveEnvCredentials("staging", {
      DEPLOY_KEY_STAGING:
        "-----BEGIN EC PRIVATE KEY-----\nsuffixed\n-----END EC PRIVATE KEY-----",
      DEPLOY_KEY: "plain-key",
    });
    expect(creds.deployKey).toBe(
      "-----BEGIN EC PRIVATE KEY-----\nsuffixed\n-----END EC PRIVATE KEY-----",
    );
  });

  it("returns the suffixed DEPLOY_KEY_FILE_<ENV> when both forms are present", () => {
    const creds = resolveEnvCredentials("prod", {
      DEPLOY_KEY_FILE_PROD: "/etc/keys/prod.pem",
      DEPLOY_KEY_FILE: "/etc/keys/default.pem",
    });
    expect(creds.deployKeyFile).toBe("/etc/keys/prod.pem");
  });

  it("returns the suffixed DATABASE_URL_<ENV> when both forms are present", () => {
    const creds = resolveEnvCredentials("prod", {
      DATABASE_URL_PROD: "postgresql://app:secret@prod-db:5432/app",
      DATABASE_URL: "postgresql://app:secret@default-db:5432/app",
    });
    expect(creds.databaseUrl).toBe("postgresql://app:secret@prod-db:5432/app");
  });
});

describe("resolveEnvCredentials — plain fallback when suffixed is absent", () => {
  it("falls back to DEPLOY_HOST when DEPLOY_HOST_<ENV> is not set", () => {
    const creds = resolveEnvCredentials("prod", {
      DEPLOY_HOST: "192.168.1.1",
    });
    expect(creds.deployHost).toBe("192.168.1.1");
  });

  it("falls back to DEPLOY_KEY when DEPLOY_KEY_<ENV> is not set", () => {
    const creds = resolveEnvCredentials("staging", {
      DEPLOY_KEY: "plain-fallback-key",
    });
    expect(creds.deployKey).toBe("plain-fallback-key");
  });

  it("falls back to DEPLOY_KEY_FILE when DEPLOY_KEY_FILE_<ENV> is not set", () => {
    const creds = resolveEnvCredentials("prod", {
      DEPLOY_KEY_FILE: "/etc/keys/default.pem",
    });
    expect(creds.deployKeyFile).toBe("/etc/keys/default.pem");
  });

  it("falls back to DATABASE_URL when DATABASE_URL_<ENV> is not set", () => {
    const creds = resolveEnvCredentials("staging", {
      DATABASE_URL: "postgresql://app:secret@fallback-db:5432/app",
    });
    expect(creds.databaseUrl).toBe(
      "postgresql://app:secret@fallback-db:5432/app",
    );
  });
});

describe("resolveEnvCredentials — returns undefined when neither form is set", () => {
  it("returns undefined for deployHost", () => {
    const creds = resolveEnvCredentials("prod", {});
    expect(creds.deployHost).toBeUndefined();
  });

  it("returns undefined for deployKey", () => {
    const creds = resolveEnvCredentials("prod", {});
    expect(creds.deployKey).toBeUndefined();
  });

  it("returns undefined for deployKeyFile", () => {
    const creds = resolveEnvCredentials("prod", {});
    expect(creds.deployKeyFile).toBeUndefined();
  });

  it("returns undefined for databaseUrl", () => {
    const creds = resolveEnvCredentials("prod", {});
    expect(creds.databaseUrl).toBeUndefined();
  });
});

describe("resolveEnvCredentials — env name normalisation", () => {
  it("treats 'prod' and 'PROD' as the same key", () => {
    const lower = resolveEnvCredentials("prod", {
      DEPLOY_HOST_PROD: "10.0.0.1",
    });
    const upper = resolveEnvCredentials("PROD", {
      DEPLOY_HOST_PROD: "10.0.0.1",
    });
    expect(lower.deployHost).toBe("10.0.0.1");
    expect(upper.deployHost).toBe("10.0.0.1");
  });

  it("treats 'staging' and 'Staging' and 'STAGING' identically", () => {
    const env = { DEPLOY_HOST_STAGING: "172.16.0.1" };
    expect(resolveEnvCredentials("staging", env).deployHost).toBe("172.16.0.1");
    expect(resolveEnvCredentials("Staging", env).deployHost).toBe("172.16.0.1");
    expect(resolveEnvCredentials("STAGING", env).deployHost).toBe("172.16.0.1");
  });
});

describe("resolveEnvCredentials — all fields resolved together", () => {
  it("resolves all four credentials in one call using suffixed vars", () => {
    const creds = resolveEnvCredentials("prod", {
      DEPLOY_HOST_PROD: "10.0.0.1",
      DEPLOY_KEY_PROD: "my-pem-key",
      DEPLOY_KEY_FILE_PROD: "/keys/prod.pem",
      DATABASE_URL_PROD: "postgresql://app:s@prod-db:5432/app",
    });
    expect(creds.deployHost).toBe("10.0.0.1");
    expect(creds.deployKey).toBe("my-pem-key");
    expect(creds.deployKeyFile).toBe("/keys/prod.pem");
    expect(creds.databaseUrl).toBe("postgresql://app:s@prod-db:5432/app");
  });

  it("resolves all four credentials via plain fallback", () => {
    const creds = resolveEnvCredentials("prod", {
      DEPLOY_HOST: "10.0.0.2",
      DEPLOY_KEY: "fallback-pem-key",
      DEPLOY_KEY_FILE: "/keys/default.pem",
      DATABASE_URL: "postgresql://app:s@default-db:5432/app",
    });
    expect(creds.deployHost).toBe("10.0.0.2");
    expect(creds.deployKey).toBe("fallback-pem-key");
    expect(creds.deployKeyFile).toBe("/keys/default.pem");
    expect(creds.databaseUrl).toBe("postgresql://app:s@default-db:5432/app");
  });
});
