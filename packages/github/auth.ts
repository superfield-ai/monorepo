export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface AccessTokenResponse {
  accessToken: string;
  tokenType: string;
  scope?: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
}

export interface DeviceFlowError extends Error {
  name:
    | "authorization_pending"
    | "slow_down"
    | "expired_token"
    | "access_denied"
    | "device_flow_disabled"
    | "incorrect_client_credentials"
    | "incorrect_device_code"
    | "unsupported_grant_type"
    | "unknown_error";
}

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export async function requestGitHubAppDeviceCode(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  const url = new URL(DEVICE_CODE_URL);
  url.searchParams.set("client_id", clientId);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });

  const data = await parseFormResponse(response);

  return {
    deviceCode: requireString(data, "device_code"),
    userCode: requireString(data, "user_code"),
    verificationUri: requireString(data, "verification_uri"),
    expiresIn: requireNumber(data, "expires_in"),
    interval: requireNumber(data, "interval"),
  };
}

export async function pollGitHubAppAccessToken(
  clientId: string,
  deviceCode: string,
  interval: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessTokenResponse> {
  let currentInterval = interval;

  while (true) {
    await sleep(currentInterval * 1000);

    const url = new URL(ACCESS_TOKEN_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("device_code", deviceCode);
    url.searchParams.set(
      "grant_type",
      "urn:ietf:params:oauth:grant-type:device_code",
    );

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
    });

    const data = await parseFormResponse(response);
    const error = data.error?.toString();

    if (!error) {
      return {
        accessToken: requireString(data, "access_token"),
        tokenType: requireString(data, "token_type"),
        scope: optionalString(data, "scope"),
        expiresIn: optionalNumber(data, "expires_in"),
        refreshToken: optionalString(data, "refresh_token"),
        refreshTokenExpiresIn: optionalNumber(data, "refresh_token_expires_in"),
      };
    }

    if (error === "authorization_pending") {
      continue;
    }

    if (error === "slow_down") {
      currentInterval += 5;
      continue;
    }

    throw deviceFlowError(error);
  }
}

async function parseFormResponse(
  response: Response,
): Promise<Record<string, string>> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" || typeof value === "number") {
        result[key] = String(value);
      }
    }
    return result;
  }

  const params = new URLSearchParams(text);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function requireString(data: Record<string, string>, key: string): string {
  const value = data[key];
  if (!value) {
    throw new Error(`Missing ${key} in GitHub response`);
  }
  return value;
}

function requireNumber(data: Record<string, string>, key: string): number {
  const value = data[key];
  if (!value) {
    throw new Error(`Missing ${key} in GitHub response`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${key} in GitHub response`);
  }
  return parsed;
}

function optionalString(
  data: Record<string, string>,
  key: string,
): string | undefined {
  return data[key] || undefined;
}

function optionalNumber(
  data: Record<string, string>,
  key: string,
): number | undefined {
  const value = data[key];
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function deviceFlowError(name: string): DeviceFlowError {
  const error = new Error(
    `GitHub device flow failed: ${name}`,
  ) as DeviceFlowError;
  error.name =
    name === "authorization_pending" ||
    name === "slow_down" ||
    name === "expired_token" ||
    name === "access_denied" ||
    name === "device_flow_disabled" ||
    name === "incorrect_client_credentials" ||
    name === "incorrect_device_code" ||
    name === "unsupported_grant_type"
      ? (name as DeviceFlowError["name"])
      : "unknown_error";
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
