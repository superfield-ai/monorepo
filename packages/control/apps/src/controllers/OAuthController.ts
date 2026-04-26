/**
 * @file OAuthController
 *
 * Pure TypeScript controller for the Claude OAuth connection flow. No React imports.
 *
 * Responsibilities:
 *  - Fetch current OAuth status from /api/auth/oauth/status
 *  - Initiate OAuth flow by fetching the authorization URL from /api/auth/oauth/init
 *  - Complete OAuth flow by POSTing the confirmation code to /api/auth/oauth/complete
 *  - Persist connected state via localStorage (key: 'oauth_connected')
 *  - Expose status: 'disconnected' | 'pending' | 'connected' | 'error'
 *  - Notify subscribers on every state change
 *
 * Canonical docs: docs/studio-mode.md — "OAuth"
 *
 * Browser-native APIs used: fetch, localStorage
 * No React imports.
 */

export type OAuthStatus = "disconnected" | "pending" | "connected" | "error";

export interface OAuthControllerState {
  status: OAuthStatus;
  /** Authorization URL returned by /api/auth/oauth/init */
  oauthUrl: string | null;
  /** Error message when status is 'error' */
  error: string | null;
  /** True when a request is in flight */
  loading: boolean;
}

export type OAuthControllerListener = (state: OAuthControllerState) => void;

const STORAGE_KEY = "oauth_connected";

/**
 * OAuthController manages the Claude OAuth authentication flow.
 *
 * Usage:
 *   const ctrl = new OAuthController({ baseUrl: '' });
 *   const unsub = ctrl.subscribe(setState);
 *   await ctrl.checkStatus();
 *   await ctrl.initiateOAuth();
 *   await ctrl.completeOAuth('confirmation-code');
 *   unsub();
 */
export class OAuthController {
  private state: OAuthControllerState = {
    status: "disconnected",
    oauthUrl: null,
    error: null,
    loading: true,
  };
  private listeners: Set<OAuthControllerListener> = new Set();
  private readonly baseUrl: string;

  constructor({ baseUrl = "" }: { baseUrl?: string } = {}) {
    this.baseUrl = baseUrl;
  }

  /** Register a listener. Returns unsubscribe function. */
  subscribe(listener: OAuthControllerListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): OAuthControllerState {
    return { ...this.state };
  }

  /**
   * Check the current OAuth status from the server.
   * Also reads localStorage to seed initial connected state.
   */
  async checkStatus(): Promise<void> {
    this.setState({ loading: true, error: null });
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/oauth/status`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { connected: boolean };
        const connected = data.connected;
        if (connected) {
          localStorage.setItem(STORAGE_KEY, "true");
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
        this.setState({
          status: connected ? "connected" : "disconnected",
          loading: false,
        });
      } else {
        this.setState({ status: "disconnected", loading: false });
      }
    } catch {
      // Seed from localStorage on network error
      const persisted = localStorage.getItem(STORAGE_KEY) === "true";
      this.setState({
        status: persisted ? "connected" : "disconnected",
        loading: false,
      });
    }
  }

  /**
   * Initiate the OAuth flow. Fetches the authorization URL and transitions
   * to 'pending' state while the user completes external auth.
   */
  async initiateOAuth(): Promise<void> {
    this.setState({ error: null, oauthUrl: null });
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/oauth/init`, {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        this.setState({
          error: data.error ?? "Failed to initiate OAuth",
          status: "error",
        });
        return;
      }
      const data = (await res.json()) as { url: string };
      this.setState({ oauthUrl: data.url, status: "pending" });
    } catch {
      this.setState({
        error: "Failed to connect. Please try again.",
        status: "error",
      });
    }
  }

  /**
   * Complete the OAuth flow by submitting the confirmation code.
   * On success, transitions to 'connected' and persists the state.
   */
  async completeOAuth(confirmationCode: string): Promise<void> {
    if (!confirmationCode.trim()) {
      this.setState({
        error: "Please enter the confirmation code",
        status: "error",
      });
      return;
    }

    this.setState({ loading: true, error: null });

    try {
      const res = await fetch(`${this.baseUrl}/api/auth/oauth/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: confirmationCode.trim() }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        this.setState({
          error: data.error ?? "Failed to complete authentication",
          status: "error",
          loading: false,
        });
        return;
      }

      localStorage.setItem(STORAGE_KEY, "true");
      this.setState({
        status: "connected",
        oauthUrl: null,
        loading: false,
        error: null,
      });
    } catch {
      this.setState({
        error: "Failed to complete authentication. Please try again.",
        status: "error",
        loading: false,
      });
    }
  }

  /** Clear OAuth URL — called when user cancels the pending flow. */
  cancelPending(): void {
    this.setState({ oauthUrl: null, status: "disconnected", error: null });
  }

  private setState(partial: Partial<OAuthControllerState>): void {
    this.state = { ...this.state, ...partial };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
