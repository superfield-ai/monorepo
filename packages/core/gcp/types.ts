export interface ServiceAccountKey {
  type?: string;
  project_id?: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

export interface LocalOAuthCredential {
  access_token?: string;
  client_id: string;
  client_secret?: string;
  expires_at_ms?: number;
  refresh_token: string;
  scope?: string;
  token_uri?: string;
  type?: string;
}

export type GcpCredentialType =
  | "service-account-json"
  | "access-token"
  | "oauth-token-file";

export interface GcpCredentialDescriptor {
  key?: ServiceAccountKey;
  oauth?: LocalOAuthCredential;
  source: string;
  type: GcpCredentialType;
}

export interface GoogleCredentialInfo {
  principal?: string;
  projectId?: string;
  source: string;
  type: GcpCredentialType;
}

export interface AuthDeps {
  env: (name: string) => string | undefined;
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, contents: string) => void;
  fileExists: (filePath: string) => boolean;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now: () => number;
}
