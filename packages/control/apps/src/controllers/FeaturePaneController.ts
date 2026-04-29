/**
 * @file FeaturePaneController
 *
 * Fetches active slots from /analytics/slots and issue metadata from the
 * orchestrator. Manages selected feature state for the FeaturePane component.
 *
 * No React imports — pure TypeScript controller.
 */

import type { SlotInfo } from "./OrchestratorController";
import { fetchJson } from "../lib/net";

export interface FeatureItem {
  issueNumber: number;
  title: string;
  body?: string;
  sessionId?: string;
}

export interface FeaturePaneState {
  features: FeatureItem[];
  selectedIssueNumber: number | null;
  loading: boolean;
  error: string | null;
}

export type FeaturePaneListener = (state: FeaturePaneState) => void;

export interface FeaturePaneControllerOptions {
  readonly slotsUrl?: string;
  readonly statusUrl?: string;
  pollIntervalMs?: number;
}

export class FeaturePaneController {
  private state: FeaturePaneState = {
    features: [],
    selectedIssueNumber: null,
    loading: false,
    error: null,
  };
  private listeners: Set<FeaturePaneListener> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly slotsUrl: string;
  private readonly statusUrl: string;
  private readonly pollIntervalMs: number;

  constructor({
    slotsUrl = "/analytics/slots",
    statusUrl = "/studio/status",
    pollIntervalMs = 10_000,
  }: FeaturePaneControllerOptions = {}) {
    this.slotsUrl = slotsUrl;
    this.statusUrl = statusUrl;
    this.pollIntervalMs = pollIntervalMs;
  }

  subscribe(listener: FeaturePaneListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): FeaturePaneState {
    return {
      ...this.state,
      features: [...this.state.features],
    };
  }

  start(): void {
    void this.fetch();
    this.pollTimer = setInterval(() => void this.fetch(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  selectFeature(issueNumber: number | null): void {
    this.state = { ...this.state, selectedIssueNumber: issueNumber };
    this.notify();
  }

  async steer(context: string, sessionId?: string): Promise<void> {
    if (!sessionId) {
      this.state = {
        ...this.state,
        error: "SELECT A RUNNING ISSUE BEFORE STEERING",
      };
      this.notify();
      return;
    }

    this.state = { ...this.state, error: null };
    this.notify();

    try {
      const res = await fetch("/studio/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, sessionId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
          detail?: string;
        };
        this.state = {
          ...this.state,
          error:
            body.error ??
            body.message ??
            body.detail ??
            "STEER REQUEST REJECTED",
        };
        this.notify();
        return;
      }
      this.state = { ...this.state, error: null };
      this.notify();
    } catch {
      this.state = { ...this.state, error: "STEER REQUEST FAILED" };
      this.notify();
    }
  }

  private async fetch(): Promise<void> {
    this.state = { ...this.state, loading: true };
    this.notify();

    try {
      const result = await fetchJson<{ slots?: SlotInfo[] }>(this.slotsUrl);
      if (!result.ok) {
        this.state = {
          ...this.state,
          loading: false,
          error: result.error.message,
        };
        this.notify();
        return;
      }

      const slotsBody = result.value;
      const slots = slotsBody.slots ?? [];

      const features: FeatureItem[] = slots.map((slot) => ({
        issueNumber: slot.issueNumber,
        title: `Issue #${slot.issueNumber}`,
        sessionId: slot.sessionId,
      }));

      // Deduplicate by issue number — keep first occurrence
      const seen = new Set<number>();
      const unique = features.filter((f) => {
        if (seen.has(f.issueNumber)) return false;
        seen.add(f.issueNumber);
        return true;
      });

      this.state = {
        ...this.state,
        features: unique,
        loading: false,
        error: null,
      };
    } catch (err) {
      this.state = {
        ...this.state,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.notify();
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
