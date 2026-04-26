/**
 * @file DeployView.tsx
 *
 * Deployment health view (D1 / C-9.5). The headline demo screen.
 *
 * Layout:
 *   - Env switcher pill (selected env highlighted)
 *   - Doctor matrix: rows = check name, cols = env. Red cells render an
 *     <InlineError> with retry that re-runs the doctor for that env.
 *   - Secrets-presence row: per-env required-secret audit.
 *   - CI strip: latest workflow run per env, click to open in GitHub.
 *   - Rollback button (per selected env) with confirm modal → SSE log pane.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DeployController,
  type DeployState,
} from "../controllers/DeployController";
import { InlineError } from "./InlineError";
import { EmptyState } from "./EmptyState";
import type { AppError } from "../lib/errors";

interface DeployViewProps {
  readonly controller?: DeployController;
}

export function DeployView({
  controller: ctrlProp,
}: DeployViewProps): JSX.Element {
  const controllerRef = useRef<DeployController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = ctrlProp ?? new DeployController();
  }
  const controller = controllerRef.current;

  const [state, setState] = useState<DeployState>(controller.getState());
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const unsub = controller.subscribe(setState);
    void controller.refreshAll();
    return unsub;
  }, [controller]);

  const envs = state.envs.length > 0 ? state.envs : ["dev", "staging", "prod"];
  const checkNames = useMemo<string[]>(() => {
    const names = new Set<string>();
    for (const env of envs) {
      for (const c of state.doctorByEnv[env] ?? []) names.add(c.name);
    }
    return [...names].sort();
  }, [state.doctorByEnv, envs]);

  const runForEnv = (env: string): CiRunDisplay | null => {
    const run = state.ciRuns.find((r) => r.env === env);
    if (!run) return null;
    return {
      label: run.conclusion ?? run.status,
      url: run.url,
      ok: run.conclusion === "success",
    };
  };

  return (
    <div
      data-testid="deploy-view"
      className="flex h-full flex-col gap-4 overflow-y-auto bg-zinc-950 p-4 text-zinc-100"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Deployment health</h2>
        <button
          type="button"
          data-testid="deploy-refresh"
          onClick={() => void controller.refreshAll()}
          className="rounded border border-zinc-600 px-3 py-1 text-xs hover:border-zinc-400"
        >
          Refresh
        </button>
      </header>

      {state.envsError ? (
        <InlineError
          title="Failed to list environments"
          error={state.envsError}
          onRetry={() => void controller.loadEnvs()}
        />
      ) : null}

      <EnvSwitcher
        envs={envs}
        selected={state.selectedEnv}
        onSelect={(e) => controller.selectEnv(e)}
      />

      <section
        data-testid="doctor-matrix"
        className="rounded border border-zinc-800"
      >
        <div className="border-b border-zinc-800 px-3 py-2 text-sm font-medium">
          Doctor checks
        </div>
        {checkNames.length === 0 ? (
          <div className="p-3">
            <EmptyState
              title="Doctor results not loaded"
              hint="Click Refresh, or check the studio debug view if this persists."
              testId="doctor"
            />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-xs uppercase text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Check</th>
                {envs.map((env) => (
                  <th
                    key={env}
                    className="px-3 py-2 text-left"
                    data-testid={`doctor-col-${env}`}
                  >
                    {env}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {checkNames.map((name) => (
                <tr key={name} className="border-t border-zinc-800 align-top">
                  <td className="px-3 py-2 font-mono text-xs">{name}</td>
                  {envs.map((env) => {
                    const checks = state.doctorByEnv[env] ?? [];
                    const c = checks.find((x) => x.name === name);
                    return (
                      <td
                        key={env}
                        className="px-3 py-2"
                        data-testid={`doctor-cell-${env}-${name}`}
                      >
                        {renderDoctorCell({
                          check: c,
                          envError: state.doctorErrors[env],
                          loading: state.loadingDoctor.has(env),
                          onRetry: () => void controller.loadDoctor(env),
                        })}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded border border-zinc-800">
        <div className="border-b border-zinc-800 px-3 py-2 text-sm font-medium">
          Secrets presence
        </div>
        <div className="grid gap-3 p-3 md:grid-cols-3">
          {envs.map((env) => (
            <div
              key={env}
              data-testid={`secrets-card-${env}`}
              className="rounded border border-zinc-800 bg-zinc-900/40 p-3"
            >
              <div className="mb-2 text-xs uppercase text-zinc-400">{env}</div>
              <ul className="space-y-1 text-sm">
                {(state.secretsByEnv[env] ?? []).map((s) => (
                  <li
                    key={s.name}
                    className="flex items-center justify-between gap-2"
                    data-testid={`secret-${env}-${s.name}`}
                  >
                    <span className="font-mono text-xs">{s.name}</span>
                    <span
                      className={
                        s.present
                          ? "rounded bg-emerald-900/50 px-2 py-0.5 text-xs text-emerald-200"
                          : "rounded bg-red-900/50 px-2 py-0.5 text-xs text-red-200"
                      }
                    >
                      {s.present ? "present" : "missing"}
                    </span>
                  </li>
                ))}
                {(state.secretsByEnv[env] ?? []).length === 0 ? (
                  <li className="text-xs text-zinc-500">No data yet</li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section
        data-testid="ci-strip"
        className="rounded border border-zinc-800"
      >
        <div className="border-b border-zinc-800 px-3 py-2 text-sm font-medium">
          Latest CI runs
        </div>
        <div className="grid gap-3 p-3 md:grid-cols-3">
          {envs.map((env) => {
            const run = runForEnv(env);
            return (
              <div
                key={env}
                data-testid={`ci-card-${env}`}
                className="rounded border border-zinc-800 bg-zinc-900/40 p-3"
              >
                <div className="mb-1 text-xs uppercase text-zinc-400">
                  {env}
                </div>
                {run ? (
                  <a
                    href={run.url}
                    target="_blank"
                    rel="noreferrer"
                    className={
                      run.ok
                        ? "text-sm text-emerald-300 underline-offset-2 hover:underline"
                        : "text-sm text-red-300 underline-offset-2 hover:underline"
                    }
                  >
                    {run.label}
                  </a>
                ) : (
                  <div className="text-xs text-zinc-500">
                    No deploy-{env} workflow run found
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section
        data-testid="rollback-section"
        className="rounded border border-zinc-800 p-3"
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">
            Rollback {state.selectedEnv}
          </div>
          <button
            type="button"
            data-testid="rollback-trigger"
            onClick={() => setConfirmOpen(true)}
            disabled={state.rolloutActive}
            className="rounded border border-red-600 bg-red-900/40 px-3 py-1 text-xs font-medium text-red-100 hover:bg-red-900/70 disabled:opacity-50"
          >
            Roll back this environment
          </button>
        </div>
        {state.rolloutLog.length > 0 ? (
          <pre
            data-testid="rollback-log"
            className="max-h-48 overflow-y-auto rounded bg-black/60 p-2 text-xs text-emerald-200"
          >
            {state.rolloutLog.join("\n")}
          </pre>
        ) : null}
      </section>

      {confirmOpen ? (
        <ConfirmModal
          env={state.selectedEnv}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            void controller.rollback(state.selectedEnv);
          }}
        />
      ) : null}
    </div>
  );
}

interface CiRunDisplay {
  readonly label: string;
  readonly url: string;
  readonly ok: boolean;
}

function EnvSwitcher({
  envs,
  selected,
  onSelect,
}: {
  readonly envs: readonly string[];
  readonly selected: string;
  readonly onSelect: (env: string) => void;
}): JSX.Element {
  return (
    <div
      role="tablist"
      data-testid="env-switcher"
      className="inline-flex rounded-full border border-zinc-700 bg-zinc-900 p-1 text-xs"
    >
      {envs.map((env) => {
        const active = env === selected;
        return (
          <button
            key={env}
            role="tab"
            type="button"
            aria-selected={active}
            data-testid={`env-pill-${env}`}
            onClick={() => onSelect(env)}
            className={
              active
                ? "rounded-full bg-blue-600 px-3 py-1 font-medium text-white"
                : "rounded-full px-3 py-1 text-zinc-300 hover:text-white"
            }
          >
            {env}
          </button>
        );
      })}
    </div>
  );
}

function ConfirmModal({
  env,
  onCancel,
  onConfirm,
}: {
  readonly env: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <div
      data-testid="rollback-confirm"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
    >
      <div className="w-full max-w-md rounded border border-zinc-700 bg-zinc-900 p-4 text-sm text-zinc-100">
        <h3 className="text-base font-semibold">Roll back {env}?</h3>
        <p className="mt-2 text-zinc-300">
          This will run <code>kubectl rollout undo</code> for the application
          and worker deployments. The studio will surface each step in the live
          log.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="rollback-cancel"
            onClick={onCancel}
            className="rounded border border-zinc-600 px-3 py-1 text-xs hover:border-zinc-400"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="rollback-confirm-action"
            onClick={onConfirm}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
          >
            Confirm rollback
          </button>
        </div>
      </div>
    </div>
  );
}

function renderDoctorCell({
  check,
  envError,
  loading,
  onRetry,
}: {
  readonly check: { readonly ok: boolean; readonly detail: string } | undefined;
  readonly envError: AppError | undefined;
  readonly loading: boolean;
  readonly onRetry: () => void;
}): JSX.Element {
  if (envError) {
    return (
      <InlineError
        title="Doctor failed"
        error={envError}
        onRetry={onRetry}
        retryLabel="Retry"
      />
    );
  }
  if (!check) {
    return (
      <span className="text-xs text-zinc-500">
        {loading ? "checking…" : "—"}
      </span>
    );
  }
  if (check.ok) {
    return (
      <span
        data-testid="doctor-ok"
        className="rounded bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-200"
        title={check.detail}
      >
        ok
      </span>
    );
  }
  return (
    <InlineError
      title="Check failed"
      error={{
        code: "server",
        message: check.detail,
        hint: "Re-run doctor after addressing the underlying issue.",
      }}
      onRetry={onRetry}
      retryLabel="Re-run"
    />
  );
}
