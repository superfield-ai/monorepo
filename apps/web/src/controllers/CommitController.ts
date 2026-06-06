/**
 * @file CommitController
 *
 * Pure TypeScript controller for commit history and rollback. No React imports.
 *
 * Responsibilities:
 *  - Fetch the commit log from /studio/status
 *  - Trigger a rollback via POST /studio/rollback
 *  - Refresh commit history after each chat turn
 *  - Notify subscribers on every state change
 *
 * Canonical docs: docs/studio-mode.md — "Rollback"
 *
 * Browser-native APIs used: fetch
 * No React imports.
 */

export interface Commit {
  hash: string;
  message: string;
  /** ISO 8601 timestamp of the checkpoint commit. */
  timestamp?: string;
}

/** A timeline entry includes a timestamp alongside the commit data. */
export interface TimelineEntry {
  hash: string;
  message: string;
  timestamp: string;
}

export interface CommitControllerState {
  commits: Commit[];
  /** Timeline entries with timestamps, in chronological order (oldest first). */
  timeline: TimelineEntry[];
  loading: boolean;
  error: string | null;
}

export type CommitControllerListener = (state: CommitControllerState) => void;

/**
 * CommitController manages commit history and rollback for the StudioChat panel.
 *
 * Usage:
 *   const ctrl = new CommitController({ fixtureId: 'optional-fixture-id' });
 *   const unsub = ctrl.subscribe(setState);
 *   await ctrl.fetchStatus();
 *   await ctrl.rollback('abc1234');
 *   ctrl.setCommits(newCommits); // called by ChatController after each chat turn
 *   unsub();
 */
export class CommitController {
  private state: CommitControllerState = {
    commits: [],
    timeline: [],
    loading: false,
    error: null,
  };
  private listeners: Set<CommitControllerListener> = new Set();
  private readonly fixtureId?: string;

  constructor({ fixtureId }: { fixtureId?: string } = {}) {
    this.fixtureId = fixtureId;
  }

  /** Register a listener. Returns unsubscribe function. */
  subscribe(listener: CommitControllerListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): CommitControllerState {
    return { ...this.state, commits: [...this.state.commits], timeline: [...this.state.timeline] };
  }

  /** Fetch studio status and extract commit list. */
  async fetchStatus(): Promise<{ active: boolean; sessionId?: string; branch?: string }> {
    this.setState({ loading: true, error: null });
    try {
      const url = this.withFixtureId('/studio/status');
      const res = await fetch(url);
      if (!res.ok) throw new Error('status request failed');
      const data = (await res.json()) as {
        active: boolean;
        sessionId?: string;
        branch?: string;
        commits?: Commit[];
        timeline?: TimelineEntry[];
      };
      this.setState({ commits: data.commits ?? [], timeline: data.timeline ?? [], loading: false });
      return { active: data.active, sessionId: data.sessionId, branch: data.branch };
    } catch {
      this.setState({ loading: false, error: 'Failed to fetch studio status' });
      return { active: false };
    }
  }

  /**
   * Trigger a rollback to the given commit hash.
   * Returns the updated commit list on success, or null on failure.
   */
  async rollback(hash: string): Promise<Commit[] | null> {
    this.setState({ error: null });
    try {
      const url = this.withFixtureId('/studio/rollback');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      });
      if (!res.ok) {
        this.setState({ error: 'Studio could not roll back that change. Try again.' });
        return null;
      }
      const data = (await res.json()) as { commits?: Commit[]; timeline?: TimelineEntry[] };
      if (!Array.isArray(data.commits)) {
        this.setState({ error: 'Studio could not roll back that change. Try again.' });
        return null;
      }
      this.setState({ commits: data.commits, timeline: data.timeline ?? [] });
      return data.commits;
    } catch {
      this.setState({ error: 'Studio could not roll back that change. Try again.' });
      return null;
    }
  }

  /**
   * Directly set the commit list — called by the chat layer after
   * a successful chat turn that returns updated commits.
   */
  setCommits(commits: Commit[]): void {
    this.setState({ commits });
  }

  /**
   * Directly set the timeline entries — called by the chat layer after
   * a successful chat turn that returns updated timeline data.
   */
  setTimeline(timeline: TimelineEntry[]): void {
    this.setState({ timeline });
  }

  private withFixtureId(path: string): string {
    if (!this.fixtureId) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}fixtureId=${encodeURIComponent(this.fixtureId)}`;
  }

  private setState(partial: Partial<CommitControllerState>): void {
    this.state = { ...this.state, ...partial };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
