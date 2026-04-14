import { unlinkSync } from "node:fs";
import type { AuthDeps, LocalOAuthCredential } from "./types.ts";
import { resolveOAuthTokenFilePath, makeDefaultAuthDeps } from "./auth.ts";

export interface LoginDeps extends AuthDeps {
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function makeDefaultLoginDeps(): LoginDeps {
  return {
    ...makeDefaultAuthDeps(),
    log: (message) => console.log(message),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

const GOOGLE_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenPollResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

type CompletedTokenResponse = Required<
  Pick<DeviceTokenPollResponse, "access_token" | "expires_in" | "refresh_token">
> &
  DeviceTokenPollResponse;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runDeviceCodeFlow(
  params: {
    clientId: string;
    clientSecret?: string;
    scope: string;
    timeoutMs: number;
    tokenFilePath?: string;
  },
  deps: LoginDeps,
): Promise<void> {
  const deviceCodeResponse = await requestDeviceCode(
    { clientId: params.clientId, scope: params.scope },
    deps,
  );

  deps.log("");
  deps.log("Visit the following URL to authorize Superfield Google Cloud access:");
  deps.log(`  ${deviceCodeResponse.verification_url}`);
  deps.log("");
  deps.log(`Enter this code when prompted: ${deviceCodeResponse.user_code}`);
  deps.log("");
  deps.log("Waiting for authorization...");

  const tokenResponse = await pollDeviceCodeToken(
    {
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      deviceCode: deviceCodeResponse.device_code,
      intervalMs: deviceCodeResponse.interval * 1_000,
      timeoutMs: params.timeoutMs,
    },
    deps,
  );

  const tokenFilePath =
    params.tokenFilePath ?? resolveOAuthTokenFilePath(deps);

  await writeLocalOAuthCredentialFile(
    {
      access_token: tokenResponse.access_token,
      client_id: params.clientId,
      ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
      expires_at_ms: deps.now() + tokenResponse.expires_in * 1_000,
      refresh_token: tokenResponse.refresh_token,
      scope: tokenResponse.scope ?? params.scope,
      token_uri: GOOGLE_TOKEN_URL,
      type: tokenResponse.token_type ?? "Bearer",
    },
    tokenFilePath,
    deps,
  );

  deps.log(`OAuth token cache written: ${tokenFilePath}`);
  deps.log("Google scripts will now auto-refresh from this credential file.");
}

export async function writeLocalOAuthCredentialFile(
  credential: LocalOAuthCredential,
  filePath: string,
  deps: Pick<AuthDeps, "writeFile">,
): Promise<void> {
  deps.writeFile(filePath, `${JSON.stringify(credential, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// --login / --logout flag handling
// ---------------------------------------------------------------------------

export interface LoginLogoutFlags {
  login?: boolean;
  logout?: boolean;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  timeoutMs?: number;
}

export interface HandleLoginLogoutDeps extends LoginDeps {
  deleteFile?: (filePath: string) => void;
}

/**
 * Handles --login and --logout flags. Returns true if either flag was handled
 * (caller should exit after --logout, or continue with the refreshed token
 * after --login). Returns false if neither flag was set.
 */
export async function handleLoginLogout(
  flags: LoginLogoutFlags,
  deps: HandleLoginLogoutDeps,
): Promise<boolean> {
  const tokenFilePath = resolveOAuthTokenFilePath(deps);
  const deleteFileFn = deps.deleteFile ?? unlinkSync;

  if (flags.logout) {
    if (deps.fileExists(tokenFilePath)) {
      deleteFileFn(tokenFilePath);
      deps.log(`Logged out. Removed ${tokenFilePath}.`);
    } else {
      deps.log("No OAuth token file found — already logged out.");
    }
    return true;
  }

  if (flags.login) {
    if (!flags.clientId) {
      throw new Error(
        "--login requires --client-id (or GCP_OAUTH_CLIENT_ID env var)",
      );
    }
    await runDeviceCodeFlow(
      {
        clientId: flags.clientId,
        clientSecret: flags.clientSecret,
        scope: flags.scope ?? "https://www.googleapis.com/auth/cloud-platform",
        timeoutMs: flags.timeoutMs ?? 300_000,
        tokenFilePath,
      },
      deps,
    );
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function requestDeviceCode(
  params: { clientId: string; scope: string },
  deps: Pick<LoginDeps, "fetch">,
): Promise<DeviceCodeResponse> {
  const response = await deps.fetch(GOOGLE_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: params.clientId,
      scope: params.scope,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Device code request failed: ${bodyText}`);
  }

  const parsed = JSON.parse(bodyText) as Partial<DeviceCodeResponse>;
  if (
    !parsed.device_code ||
    !parsed.user_code ||
    !parsed.verification_url ||
    typeof parsed.expires_in !== "number" ||
    typeof parsed.interval !== "number"
  ) {
    throw new Error(`Device code response is missing required fields: ${bodyText}`);
  }

  return parsed as DeviceCodeResponse;
}

async function pollDeviceCodeToken(
  params: {
    clientId: string;
    clientSecret?: string;
    deviceCode: string;
    intervalMs: number;
    timeoutMs: number;
  },
  deps: Pick<LoginDeps, "fetch" | "sleep" | "now">,
): Promise<CompletedTokenResponse> {
  const deadline = deps.now() + params.timeoutMs;
  let intervalMs = params.intervalMs;

  while (deps.now() < deadline) {
    await deps.sleep(intervalMs);

    const response = await deps.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: params.clientId,
        ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
        device_code: params.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const bodyText = await response.text();
    const parsed = JSON.parse(bodyText) as DeviceTokenPollResponse;

    if (response.ok && parsed.access_token) {
      if (!parsed.refresh_token) {
        throw new Error(
          "Device code token response did not include refresh_token. " +
            "Ensure the OAuth client is configured for offline access.",
        );
      }
      if (typeof parsed.expires_in !== "number") {
        throw new Error("Device code token response is missing expires_in");
      }
      return parsed as CompletedTokenResponse;
    }

    const errorCode = parsed.error;

    if (errorCode === "authorization_pending") {
      continue;
    }

    if (errorCode === "slow_down") {
      intervalMs += 5_000;
      continue;
    }

    if (errorCode === "access_denied") {
      throw new Error("Device code authorization was denied by the user.");
    }

    if (errorCode === "expired_token") {
      throw new Error(
        "Device code has expired. Re-run the login command to obtain a new code.",
      );
    }

    throw new Error(
      `Device code token poll failed: ${parsed.error_description ?? errorCode ?? bodyText}`,
    );
  }

  throw new Error(
    `Timed out waiting for device code authorization after ${Math.round(params.timeoutMs / 1_000)} seconds.`,
  );
}
