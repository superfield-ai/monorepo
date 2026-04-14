import { createSign } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import type {
  AuthDeps,
  GcpCredentialDescriptor,
  GoogleCredentialInfo,
  LocalOAuthCredential,
  ServiceAccountKey,
} from "./types.ts";

export type { AuthDeps, GoogleCredentialInfo };

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

// ---------------------------------------------------------------------------
// Default production deps
// ---------------------------------------------------------------------------

export function makeDefaultAuthDeps(): AuthDeps {
  return {
    env: (name) => process.env[name],
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, contents) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, contents, { mode: 0o600 });
      chmodSync(p, 0o600);
    },
    fileExists: existsSync,
    fetch: globalThis.fetch,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// OAuth token file path
// ---------------------------------------------------------------------------

export function resolveOAuthTokenFilePath(deps: Pick<AuthDeps, "env">): string {
  const fromEnv = deps.env("GCP_OAUTH_TOKEN_FILE");
  if (fromEnv) return fromEnv;
  return join(homedir(), ".config", "superfield", "gcp-oauth-token.json");
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

function resolveCredentialDescriptor(deps: AuthDeps): GcpCredentialDescriptor {
  const { env, readFile, fileExists } = deps;

  // 1. GCP_ACCESS_TOKEN
  if (env("GCP_ACCESS_TOKEN")) {
    return { source: "GCP_ACCESS_TOKEN", type: "access-token" };
  }

  // 2. GCP_OAUTH_TOKEN_FILE (default: ~/.config/superfield/gcp-oauth-token.json)
  const oauthFilePath = resolveOAuthTokenFilePath(deps);
  if (fileExists(oauthFilePath)) {
    const rawCredential = readFile(oauthFilePath);
    return {
      oauth: parseLocalOAuthCredential(rawCredential, oauthFilePath),
      source: oauthFilePath,
      type: "oauth-token-file",
    };
  }

  // 3. GCP_SERVICE_ACCOUNT_JSON (inline JSON)
  const inlineJson = env("GCP_SERVICE_ACCOUNT_JSON");
  if (inlineJson) {
    return {
      key: parseServiceAccountKey(inlineJson, "GCP_SERVICE_ACCOUNT_JSON"),
      source: "GCP_SERVICE_ACCOUNT_JSON",
      type: "service-account-json",
    };
  }

  // 4-5. File-path envs for service account
  const filePathEnvs = [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GCP_SERVICE_ACCOUNT_FILE",
  ];
  for (const envName of filePathEnvs) {
    const value = env(envName);
    if (!value) continue;
    return {
      key: parseServiceAccountKey(readFile(value), envName),
      source: envName,
      type: "service-account-json",
    };
  }

  // 6. GCP_SERVICE_ACCOUNT_KEY_JSON (inline)
  const keyJson = env("GCP_SERVICE_ACCOUNT_KEY_JSON");
  if (keyJson) {
    return {
      key: parseServiceAccountKey(keyJson, "GCP_SERVICE_ACCOUNT_KEY_JSON"),
      source: "GCP_SERVICE_ACCOUNT_KEY_JSON",
      type: "service-account-json",
    };
  }

  // 7. GCP_SERVICE_ACCOUNT_KEY_FILE
  const keyFile = env("GCP_SERVICE_ACCOUNT_KEY_FILE");
  if (keyFile) {
    return {
      key: parseServiceAccountKey(readFile(keyFile), "GCP_SERVICE_ACCOUNT_KEY_FILE"),
      source: "GCP_SERVICE_ACCOUNT_KEY_FILE",
      type: "service-account-json",
    };
  }

  throw new Error(
    `Google credentials are required via GCP_ACCESS_TOKEN, ${oauthFilePath}, ` +
      `GCP_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, GCP_SERVICE_ACCOUNT_FILE, ` +
      `GCP_SERVICE_ACCOUNT_KEY_JSON, or GCP_SERVICE_ACCOUNT_KEY_FILE`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getGoogleAccessToken(deps: AuthDeps): Promise<string> {
  const descriptor = resolveCredentialDescriptor(deps);
  const now = deps.now();

  if (descriptor.type === "access-token") {
    return deps.env("GCP_ACCESS_TOKEN")!;
  }

  if (descriptor.type === "oauth-token-file") {
    const oauth = descriptor.oauth!;

    // Still valid (with 60s buffer)
    if (oauth.access_token && oauth.expires_at_ms && oauth.expires_at_ms - now > 60_000) {
      return oauth.access_token;
    }

    // Try to refresh
    const tokenUri = oauth.token_uri ?? DEFAULT_TOKEN_URI;
    const response = await deps.fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oauth.client_id,
        ...(oauth.client_secret ? { client_secret: oauth.client_secret } : {}),
        refresh_token: oauth.refresh_token,
      }),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Failed to refresh OAuth access token from ${descriptor.source}: ${bodyText}`,
      );
    }

    const refreshed = JSON.parse(bodyText) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
    };
    if (!refreshed.access_token || typeof refreshed.expires_in !== "number") {
      throw new Error(
        `OAuth refresh response from ${descriptor.source} is missing access_token or expires_in`,
      );
    }

    const expiresAtMs = now + refreshed.expires_in * 1_000;
    const updatedCredential: LocalOAuthCredential = {
      ...oauth,
      access_token: refreshed.access_token,
      expires_at_ms: expiresAtMs,
      refresh_token: refreshed.refresh_token ?? oauth.refresh_token,
      scope: refreshed.scope ?? oauth.scope,
      type: refreshed.token_type ?? oauth.type,
      token_uri: tokenUri,
    };

    // Persist the refreshed token back to the file
    const oauthFilePath = resolveOAuthTokenFilePath(deps);
    deps.writeFile(oauthFilePath, `${JSON.stringify(updatedCredential, null, 2)}\n`);

    return refreshed.access_token;
  }

  // Service account JWT flow
  const key = descriptor.key!;
  const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
  const assertion = createSignedJwt(key, tokenUri);

  const response = await deps.fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to mint Google access token: ${bodyText}`);
  }

  const json = JSON.parse(bodyText) as { access_token: string };
  return json.access_token;
}

export function getGoogleCredentialInfo(deps: AuthDeps): GoogleCredentialInfo {
  const descriptor = resolveCredentialDescriptor(deps);

  if (descriptor.type === "access-token") {
    return { source: descriptor.source, type: descriptor.type };
  }

  if (descriptor.type === "oauth-token-file") {
    return {
      source: descriptor.source,
      type: descriptor.type,
      principal: descriptor.oauth?.client_id,
    };
  }

  return {
    principal: descriptor.key?.client_email,
    projectId: descriptor.key?.project_id,
    source: descriptor.source,
    type: descriptor.type,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseServiceAccountKey(rawJson: string, source: string): ServiceAccountKey {
  let parsed: ServiceAccountKey;
  try {
    parsed = JSON.parse(rawJson) as ServiceAccountKey;
  } catch (error) {
    throw new Error(
      `Failed to parse service account JSON from ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (parsed.type && parsed.type !== "service_account") {
    throw new Error(
      `Credential from ${source} is type "${parsed.type}", but expected a service account JSON key`,
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      `Credential from ${source} is missing client_email or private_key`,
    );
  }
  return parsed;
}

function parseLocalOAuthCredential(rawJson: string, source: string): LocalOAuthCredential {
  let parsed: LocalOAuthCredential;
  try {
    parsed = JSON.parse(rawJson) as LocalOAuthCredential;
  } catch (error) {
    throw new Error(
      `Failed to parse local OAuth token JSON from ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (!parsed.client_id || !parsed.refresh_token) {
    throw new Error(
      `Credential from ${source} is missing client_id or refresh_token`,
    );
  }
  if (parsed.expires_at_ms !== undefined && !Number.isFinite(parsed.expires_at_ms)) {
    throw new Error(`Credential from ${source} has invalid expires_at_ms`);
  }
  return parsed;
}

function createSignedJwt(key: ServiceAccountKey, tokenUri: string): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: key.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: tokenUri,
    exp: issuedAt + 3_600,
    iat: issuedAt,
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(key.private_key, "base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
