/**
 * @file OrchestratorController
 *
 * Polls /orchestrator/status and /analytics/loops every 5 s.
 * Streams /orchestrator/logs via SSE.
 * Exposes start/stop controls.
 *
 * No React imports — pure TypeScript controller.
 */

export type ProcessState = "stopped" | "starting" | "running" | "stopping";

/** One entry in a slot's heartbeat history timeline. */
export interface HeartbeatEntry {
  /** Unix timestamp (ms) when this heartbeat was recorded. */
  at: number;
  /** Slot state at this heartbeat moment. */
  state: "idle" | "running" | "done";
}

export interface LoopHealth {
  lastTickAt?: number;
  lastTickDurationMs?: number;
  idleReason?: string;
  circuitTripped: boolean;
  consecutiveFailures: number;
}

export interface SlotInfo {
  slot: number;
  issueNumber: number;
  role: "primary" | "speculative";
  sessionId: string;
  backend: string;
  model: string;
  startedAt: string;
  elapsedMs: number;
  heartbeatAt?: number;
}

/** Maximum heartbeat history entries retained per slot. */
const MAX_HEARTBEAT_HISTORY = 20;

export interface OrchestratorState {
  processState: ProcessState;
  pid: number | null;
  apiReachable: boolean;
  uptimeMs: number;
  loops: Record<"plan" | "dev" | "doc", LoopHealth>;
  slots: SlotInfo[];
  /** Heartbeat history per slot key (slot index as string). At most MAX_HEARTBEAT_HISTORY entries. */
  heartbeatHistory: Record<string, HeartbeatEntry[]>;
  logs: string[];
  error: string | null;
}

export type OrchestratorListener = (state: OrchestratorState) => void;

const POLL_INTERVAL_MS = 5_000;
const MAX_LOGS = 200;

const DEFAULT_LOOP_HEALTH: LoopHealth = {
  circuitTripped: false,
  consecutiveFailures: 0,
};

export class OrchestratorController {
  private state: OrchestratorState = {
    processState: "stopped",
    pid: null,
    apiReachable: false,
    uptimeMs: 0,
    loops: {
      plan: { ...DEFAULT_LOOP_HEALTH },
      dev: { ...DEFAULT_LOOP_HEALTH },
      doc: { ...DEFAULT_LOOP_HEALTH },
    },
    slots: [],
    heartbeatHistory: {},
    logs: [],
    error: null,
  };
  private listeners: Set<OrchestratorListener> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private logEs: EventSource | null = null;
  private readonly statusUrl: string;
  private readonly loopsUrl: string;
  private readonly slotsUrl: string;
  private readonly logsUrl: string;
  private readonly startUrl: string;
  private readonly stopUrl: string;

  constructor({
    statusUrl = "/orchestrator/status",
    loopsUrl = "/analytics/loops",
    slotsUrl = "/analytics/slots",
    logsUrl = "/orchestrator/logs",
    startUrl = "/orchestrator/start",
    stopUrl = "/orchestrator/stop",
  } = {}) {
    this.statusUrl = statusUrl;
    this.loopsUrl = loopsUrl;
    this.slotsUrl = slotsUrl;
    this.logsUrl = logsUrl;
    this.startUrl = startUrl;
    this.stopUrl = stopUrl;
  }

  subscribe(listener: OrchestratorListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): OrchestratorState {
    return {
      ...this.state,
      logs: [...this.state.logs],
      slots: [...this.state.slots],
      heartbeatHistory: { ...this.state.heartbeatHistory },
    };
  }

  start(): void {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.startLogStream();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.logEs?.close();
    this.logEs = null;
  }

  async startDevLoop(repo: string, slotCount?: number): Promise<void> {
    try {
      const res = await fetch(this.startUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, slotCount }),
      });
      const body = (await res.json()) as { ok: boolean; reason?: string };
      if (!body.ok) {
        this.setError(body.reason ?? "UNABLE — START DEV LOOP");
      }
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
    }
    await this.poll();
  }

  async stopDevLoop(): Promise<void> {
    try {
      await fetch(this.stopUrl, { method: "POST" });
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
    }
    await this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const [statusRes, loopsRes, slotsRes] = await Promise.all([
        fetch(this.statusUrl),
        fetch(this.loopsUrl),
        fetch(this.slotsUrl),
      ]);

      const status = (await statusRes.json()) as {
        process?: ProcessState;
        pid?: number | null;
        apiReachable?: boolean;
        uptimeMs?: number;
      };
      const loopsBody = (await loopsRes.json()) as {
        loops?: Record<string, LoopHealth>;
      };
      const slotsBody = (await slotsRes.json()) as { slots?: SlotInfo[] };

      const newSlots = slotsBody.slots ?? [];
      const updatedHistory = this.buildHeartbeatHistory(newSlots);

      this.state = {
        ...this.state,
        processState: status.process ?? "stopped",
        pid: status.pid ?? null,
        apiReachable: status.apiReachable ?? false,
        uptimeMs: status.uptimeMs ?? 0,
        loops: {
          plan: loopsBody.loops?.["plan"] ?? { ...DEFAULT_LOOP_HEALTH },
          dev: loopsBody.loops?.["dev"] ?? { ...DEFAULT_LOOP_HEALTH },
          doc: loopsBody.loops?.["doc"] ?? { ...DEFAULT_LOOP_HEALTH },
        },
        slots: newSlots,
        heartbeatHistory: updatedHistory,
        error: null,
      };
      this.notify();
    } catch {
      // Network errors are transient — don't surface as errors.
    }
  }

  /**
   * Accumulate heartbeat history for each slot.
   * Infers slot state: "running" if a heartbeatAt timestamp is present and
   * recent (< 30 s), otherwise "idle". The state "done" is appended when a
   * slot that previously had an entry is no longer present in the new list.
   */
  private buildHeartbeatHistory(
    newSlots: SlotInfo[],
  ): Record<string, HeartbeatEntry[]> {
    const now = Date.now();
    const prev = this.state.heartbeatHistory;
    const updated: Record<string, HeartbeatEntry[]> = { ...prev };

    // Mark missing slots as "done".
    const newKeys = new Set(newSlots.map((s) => String(s.slot)));
    for (const key of Object.keys(updated)) {
      if (!newKeys.has(key)) {
        const history = updated[key];
        const last = history[history.length - 1];
        if (last && last.state !== "done") {
          updated[key] = [
            ...history,
            { at: now, state: "done" as const },
          ].slice(-MAX_HEARTBEAT_HISTORY);
        }
      }
    }

    // Update or initialise entries for current slots.
    for (const slot of newSlots) {
      const key = String(slot.slot);
      const history = updated[key] ?? [];
      const heartbeatAge = slot.heartbeatAt ? now - slot.heartbeatAt : Infinity;
      const state: HeartbeatEntry["state"] =
        heartbeatAge < 30_000 ? "running" : "idle";
      const last = history[history.length - 1];
      // Only append when state changes or this is the first entry.
      if (!last || last.state !== state) {
        updated[key] = [...history, { at: now, state }].slice(
          -MAX_HEARTBEAT_HISTORY,
        );
      }
    }

    return updated;
  }

  private startLogStream(): void {
    if (this.logEs) return;
    this.logEs = new EventSource(this.logsUrl);
    this.logEs.onmessage = (event: MessageEvent<string>) => {
      const logs = [...this.state.logs, event.data];
      this.state = { ...this.state, logs: logs.slice(-MAX_LOGS) };
      this.notify();
    };
    this.logEs.onerror = () => {
      // SSE will auto-reconnect; no action needed.
    };
  }

  private setError(msg: string): void {
    this.state = { ...this.state, error: msg };
    this.notify();
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
