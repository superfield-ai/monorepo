export interface SlotInfo {
  slot: number;
  issueNumber: number;
  role: "primary" | "speculative";
  sessionId: string;
  backend: string;
  model: string;
  startedAt: string; // ISO timestamp
  elapsedMs: number;
  heartbeatAt?: number; // Date.now() of last heartbeat
}

export interface LoopHealth {
  lastTickAt?: number;
  lastTickDurationMs?: number;
  idleReason?: string;
  circuitTripped: boolean;
  consecutiveFailures: number;
}

export interface CostAccumulator {
  totalUsd: number;
  byBackend: Record<string, number>;
  agentCount: number;
  errorCount: number;
}

export interface PendingSteer {
  requestId: string;
  context: string;
  queuedAt: number;
}

export interface PendingEscalate {
  requestId: string;
  queuedAt: number;
}

export class ApiState {
  slots = new Map<number, SlotInfo>();
  loops: Record<"plan" | "dev" | "doc", LoopHealth> = {
    plan: { circuitTripped: false, consecutiveFailures: 0 },
    dev: { circuitTripped: false, consecutiveFailures: 0 },
    doc: { circuitTripped: false, consecutiveFailures: 0 },
  };
  costs: CostAccumulator = {
    totalUsd: 0,
    byBackend: {},
    agentCount: 0,
    errorCount: 0,
  };
  // sessionId → pending steer (consumed once by the loop)
  pendingSteers = new Map<string, PendingSteer>();
  // issueNumber → pending escalation
  pendingEscalations = new Map<number, PendingEscalate>();

  // --- Loop-facing mutators ---

  recordAgentStart(info: Omit<SlotInfo, "elapsedMs" | "heartbeatAt">): void {
    this.slots.set(info.slot, { ...info, elapsedMs: 0 });
  }

  recordAgentEnd(
    slot: number,
    costUsd: number,
    backend: string,
    isError: boolean,
  ): void {
    this.slots.delete(slot);
    this.costs.totalUsd += costUsd;
    this.costs.byBackend[backend] =
      (this.costs.byBackend[backend] ?? 0) + costUsd;
    this.costs.agentCount += 1;
    if (isError) this.costs.errorCount += 1;
  }

  recordHeartbeat(slot: number, elapsedMs: number): void {
    const s = this.slots.get(slot);
    if (s) {
      s.elapsedMs = elapsedMs;
      s.heartbeatAt = Date.now();
    }
  }

  recordLoopTick(
    loop: "plan" | "dev" | "doc",
    durationMs: number,
    idleReason?: string,
  ): void {
    this.loops[loop].lastTickAt = Date.now();
    this.loops[loop].lastTickDurationMs = durationMs;
    this.loops[loop].idleReason = idleReason;
  }

  recordCircuitTripped(consecutiveFailures: number): void {
    this.loops.dev.circuitTripped = true;
    this.loops.dev.consecutiveFailures = consecutiveFailures;
  }

  recordCircuitReset(): void {
    this.loops.dev.circuitTripped = false;
    this.loops.dev.consecutiveFailures = 0;
  }

  // --- Steer consumers (called by loop on each heartbeat) ---

  consumeSteer(sessionId: string): PendingSteer | undefined {
    const s = this.pendingSteers.get(sessionId);
    if (s) this.pendingSteers.delete(sessionId);
    return s;
  }

  consumeEscalation(issueNumber: number): PendingEscalate | undefined {
    const e = this.pendingEscalations.get(issueNumber);
    if (e) this.pendingEscalations.delete(issueNumber);
    return e;
  }
}
