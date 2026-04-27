/**
 * Minimal AWS SigV4 request signer using Node's built-in `crypto` module.
 *
 * Signs a single HTTP request and returns the Authorization header plus the
 * required `x-amz-date` (and optionally `x-amz-security-token`) headers.
 * Only the Query API POST pattern is exercised in this codebase (EC2, RDS,
 * SSM) but the function is general enough for other services.
 *
 * Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 */

import { createHmac, createHash } from "node:crypto";

export interface SignRequestOpts {
  method: string;
  url: string;
  body: string;
  region: string;
  service: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/** Returns the additional headers required by SigV4 (do not include in the fetch call separately). */
export function signRequest(opts: SignRequestOpts): Record<string, string> {
  const { method, url, body, region, service, credentials } = opts;
  const parsed = new URL(url);
  const host = parsed.host;

  // 1. Create a date string in the format YYYYMMDD'T'HHMMSS'Z'
  const now = new Date();
  const isoDate = now
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = isoDate.slice(0, 8); // YYYYMMDD

  // 2. Build the set of headers we will sign.
  const headers: Record<string, string> = {
    host,
    "x-amz-date": isoDate,
  };
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  // 3. Canonical headers: sorted lowercase key: trimmed value\n
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  // 4. Hash the payload.
  const payloadHash = sha256Hex(body);

  // 5. Canonical URI — percent-encode path components (but not slashes).
  const canonicalUri = encodePath(parsed.pathname) || "/";

  // 6. Canonical query string — sort lexicographically, encode keys and values.
  const canonicalQueryString = buildCanonicalQueryString(parsed.searchParams);

  // 7. Canonical request.
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // 8. String to sign.
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    isoDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // 9. Signing key.
  const signingKey = deriveSigningKey(
    credentials.secretAccessKey,
    dateStamp,
    region,
    service,
  );

  // 10. Signature.
  const signature = hmacHex(signingKey, stringToSign);

  // 11. Authorization header.
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const result: Record<string, string> = {
    authorization,
    "x-amz-date": isoDate,
  };
  if (credentials.sessionToken) {
    result["x-amz-security-token"] = credentials.sessionToken;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Percent-encode each path segment individually, leaving "/" delimiters as-is.
 */
function encodePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Build a canonical query string: sort by encoded key (then encoded value),
 * encode both sides with encodeURIComponent.
 */
function buildCanonicalQueryString(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    pairs.push([encodeURIComponent(k), encodeURIComponent(v)]);
  }
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}
