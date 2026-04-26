/**
 * @file OrchestratorView
 *
 * Studio orchestrator panel — route /studio/orchestrator
 *
 * Sections:
 *   - Process status badge + Start/Stop buttons
 *   - Loop status bar: plan / dev / doc — last tick, circuit state
 *   - Active slots list: issue, role, backend, elapsed, heartbeat indicator
 *   - Log tail pane: last N lines, auto-scroll, SSE-streamed
 *
 * No external dependencies — uses browser-native APIs and Tailwind classes
 * that match the existing studio UI palette.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  OrchestratorController,
  type OrchestratorState,
  type ProcessState,
} from '../controllers/OrchestratorController';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function relativeTime(ts?: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  return `${formatMs(diff)} ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: ProcessState }) {
  const colours: Record<ProcessState, string> = {
    stopped: 'bg-gray-200 text-gray-600',
    starting: 'bg-yellow-100 text-yellow-700',
    running: 'bg-green-100 text-green-700',
    stopping: 'bg-orange-100 text-orange-700',
  };
  return (
    <span
      data-testid="process-state-badge"
      className={`inline-block rounded px-2 py-0.5 text-xs font-mono font-semibold ${colours[state]}`}
    >
      {state}
    </span>
  );
}

function LoopRow({
  name,
  health,
}: {
  name: string;
  health: OrchestratorState['loops']['plan'];
}) {
  return (
    <tr className="border-t border-gray-100 text-sm">
      <td className="py-1 pr-4 font-mono text-gray-500">{name}</td>
      <td className="py-1 pr-4 text-gray-700">{relativeTime(health.lastTickAt)}</td>
      <td className="py-1 pr-4 text-gray-500">
        {health.lastTickDurationMs != null ? formatMs(health.lastTickDurationMs) : '—'}
      </td>
      <td className="py-1 pr-4 text-gray-400 italic text-xs">{health.idleReason ?? ''}</td>
      <td className="py-1">
        <span
          className={`rounded px-1 py-0.5 text-xs font-semibold ${
            health.circuitTripped ? 'bg-red-100 text-red-600' : 'bg-green-50 text-green-600'
          }`}
        >
          {health.circuitTripped ? `tripped (${health.consecutiveFailures})` : 'closed'}
        </span>
      </td>
    </tr>
  );
}

function SlotCard({ slot }: { slot: OrchestratorState['slots'][number] }) {
  const heartbeatAge = slot.heartbeatAt ? Date.now() - slot.heartbeatAt : Infinity;
  const heartbeatOk = heartbeatAge < 30_000;

  return (
    <div className="rounded border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-gray-800">#{slot.issueNumber}</span>
        <span
          className={`ml-2 h-2 w-2 rounded-full ${
            heartbeatOk ? 'bg-green-400' : 'bg-gray-300'
          }`}
          title={heartbeatOk ? 'heartbeat ok' : 'no recent heartbeat'}
        />
      </div>
      <div className="mt-1 text-xs text-gray-500">
        <span className="mr-2">{slot.role}</span>
        <span className="mr-2">{slot.backend}</span>
        <span className="mr-2">{slot.model}</span>
        <span>{formatMs(slot.elapsedMs)}</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface OrchestratorViewProps {
  controller?: OrchestratorController;
  repo?: string;
}

export function OrchestratorView({ controller: controllerProp, repo = '' }: OrchestratorViewProps) {
  const controllerRef = useRef<OrchestratorController>(
    controllerProp ?? new OrchestratorController(),
  );
  const [state, setState] = useState<OrchestratorState>(controllerRef.current.getState());
  const logEndRef = useRef<HTMLDivElement>(null);
  const [repoInput, setRepoInput] = useState(repo);

  useEffect(() => {
    const ctrl = controllerRef.current;
    const unsub = ctrl.subscribe(setState);
    ctrl.start();
    return () => {
      unsub();
      ctrl.stop();
    };
  }, []);

  // Auto-scroll log pane.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.logs]);

  const canStart = state.processState === 'stopped';
  const canStop = state.processState === 'running' || state.processState === 'starting';

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4 font-sans">
      {/* Process controls */}
      <section className="flex items-center gap-4 rounded border border-gray-200 bg-white px-4 py-3 shadow-sm">
        <StateBadge state={state.processState} />
        {state.pid && (
          <span className="text-xs text-gray-400">pid {state.pid}</span>
        )}
        {state.uptimeMs > 0 && (
          <span className="text-xs text-gray-400">up {formatMs(state.uptimeMs)}</span>
        )}
        <span
          className={`ml-auto text-xs ${state.apiReachable ? 'text-green-600' : 'text-gray-400'}`}
        >
          API {state.apiReachable ? 'reachable' : 'unreachable'}
        </span>
        <input
          data-testid="repo-input"
          className="ml-4 w-48 rounded border border-gray-200 px-2 py-1 text-xs"
          placeholder="/path/to/repo"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
        />
        <button
          data-testid="start-button"
          className="rounded bg-green-600 px-3 py-1 text-xs text-white disabled:opacity-40"
          disabled={!canStart || !repoInput}
          onClick={() => controllerRef.current.startDevLoop(repoInput)}
        >
          Start
        </button>
        <button
          data-testid="stop-button"
          className="rounded bg-red-500 px-3 py-1 text-xs text-white disabled:opacity-40"
          disabled={!canStop}
          onClick={() => controllerRef.current.stopDevLoop()}
        >
          Stop
        </button>
        {state.error && (
          <span className="ml-2 text-xs text-red-500">{state.error}</span>
        )}
      </section>

      {/* Loop status bar */}
      <section className="rounded border border-gray-200 bg-white px-4 py-3 shadow-sm">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Loops
        </h2>
        <table className="w-full" data-testid="loop-table">
          <thead>
            <tr className="text-left text-xs text-gray-400">
              <th className="pb-1 pr-4">Loop</th>
              <th className="pb-1 pr-4">Last tick</th>
              <th className="pb-1 pr-4">Duration</th>
              <th className="pb-1 pr-4">Idle reason</th>
              <th className="pb-1">Circuit</th>
            </tr>
          </thead>
          <tbody>
            <LoopRow name="plan" health={state.loops.plan} />
            <LoopRow name="dev" health={state.loops.dev} />
            <LoopRow name="doc" health={state.loops.doc} />
          </tbody>
        </table>
      </section>

      {/* Active slots */}
      {state.slots.length > 0 && (
        <section className="rounded border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Active slots ({state.slots.length})
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {state.slots.map((slot) => (
              <SlotCard key={slot.slot} slot={slot} />
            ))}
          </div>
        </section>
      )}

      {/* Log tail */}
      <section data-testid="log-pane" className="flex flex-1 flex-col rounded border border-gray-200 bg-gray-950 px-3 py-2 shadow-sm">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Dev loop logs
        </h2>
        <div className="flex-1 overflow-auto text-xs leading-5 text-green-300">
          {state.logs.map((line, i) => (
            <div key={i} className="whitespace-pre font-mono">
              {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </section>
    </div>
  );
}
