/**
 * @file FeaturePaneController
 *
 * Merges two data sources into a single feature list:
 *   - /analytics/slots  — issues currently running in the dev loop (have a live sessionId)
 *   - /studio/issues    — local DB records (draft / queued / blocked)
 *
 * Three intent-based actions:
 *   createFeature(title)             → POST /studio/issues
 *   patchFeature(number, body)       → PATCH /studio/issues/:number
 *   steer(context, sessionId)        → POST /studio/steer
 */

import type { SlotInfo } from "./OrchestratorController";
import { fetchJson } from "../lib/net";

export type FeatureSource = "slot" | "db";
export type FeatureStatus =
  | "active"
  | "draft"
  | "open"
  | "in_progress"
  | "blocked"
  | "done";

export interface FeatureItem {
  issueNumber: number;
  title: string;
  body?: string;
  sessionId?: string;
  source: FeatureSource;
  status: FeatureStatus;
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
  readonly issuesUrl?: string;
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
  private readonly issuesUrl: string;
  private readonly pollIntervalMs: number;

  constructor({
    slotsUrl = "/analytics/slots",
    issuesUrl = "/studio/issues",
    pollIntervalMs = 10_000,
  }: FeaturePaneControllerOptions = {}) {
    this.slotsUrl = slotsUrl;
    this.issuesUrl = issuesUrl;
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

  async createFeature(title: string): Promise<void> {
    this.state = { ...this.state, error: null };
    this.notify();
    try {
      const res = await fetch(this.issuesUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, pushToGithub: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        this.state = { ...this.state, error: body.error ?? "CREATE FAILED" };
        this.notify();
        return;
      }
      const created = (await res.json()) as { number: number };
      await this.fetch();
      this.state = {
        ...this.state,
        selectedIssueNumber: created.number,
        error: null,
      };
    } catch {
      this.state = { ...this.state, error: "CREATE REQUEST FAILED" };
    }
    this.notify();
  }

  async patchFeature(issueNumber: number, body: string): Promise<void> {
    this.state = { ...this.state, error: null };
    this.notify();
    try {
      const res = await fetch(`${this.issuesUrl}/${issueNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        this.state = { ...this.state, error: json.error ?? "PATCH FAILED" };
        this.notify();
        return;
      }
      await this.fetch();
    } catch {
      this.state = { ...this.state, error: "PATCH REQUEST FAILED" };
      this.notify();
    }
  }

  async steer(context: string, sessionId: string): Promise<void> {
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
        };
        this.state = {
          ...this.state,
          error: body.error ?? body.message ?? "STEER REQUEST REJECTED",
        };
        this.notify();
        return;
      }
      this.state = { ...this.state, error: null };
    } catch {
      this.state = { ...this.state, error: "STEER REQUEST FAILED" };
    }
    this.notify();
  }

  private async fetch(): Promise<void> {
    this.state = { ...this.state, loading: true };
    this.notify();

    try {
      const [slotsResult, issuesResult] = await Promise.all([
        fetchJson<{ slots?: SlotInfo[] }>(this.slotsUrl),
        fetchJson<{ issues?: DbIssue[] }>(this.issuesUrl),
      ]);

      // Active slots from the dev loop
      const slotFeatures: FeatureItem[] = slotsResult.ok
        ? (slotsResult.value.slots ?? []).map((slot) => ({
            issueNumber: slot.issueNumber,
            title: `Issue #${slot.issueNumber}`,
            sessionId: slot.sessionId,
            source: "slot" as FeatureSource,
            status: "active" as FeatureStatus,
          }))
        : [];

      const activeNumbers = new Set(slotFeatures.map((f) => f.issueNumber));

      // Local DB records that are not already in the slot list
      const dbFeatures: FeatureItem[] = issuesResult.ok
        ? (issuesResult.value.issues ?? [])
            .filter((i) => !activeNumbers.has(i.number))
            .filter((i) => i.status !== "done")
            .map((i) => ({
              issueNumber: i.number,
              title: i.title,
              body: i.body,
              source: "db" as FeatureSource,
              status: i.status as FeatureStatus,
            }))
        : [];

      const features = [...slotFeatures, ...dbFeatures];

      // Preserve title/body from DB for slot items when available
      if (issuesResult.ok) {
        const dbMap = new Map(
          (issuesResult.value.issues ?? []).map((i) => [i.number, i]),
        );
        for (const f of slotFeatures) {
          const db = dbMap.get(f.issueNumber);
          if (db) {
            f.title = db.title;
            f.body = db.body;
          }
        }
      }

      this.state = {
        ...this.state,
        features,
        loading: false,
        error: slotsResult.ok ? null : slotsResult.error.message,
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

interface DbIssue {
  number: number;
  title: string;
  body?: string;
  status: string;
}
