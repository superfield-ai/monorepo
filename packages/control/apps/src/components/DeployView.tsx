/**
 * @file DeployView.tsx
 *
 * Deployment health view (D1 / C-9.5). The headline demo screen.
 *
 * Layout:
 *   - Env switcher pills (selected env highlighted with cyan tint)
 *   - Doctor matrix: rows = check name, cols = env. Red cells render an
 *     <InlineError> with retry that re-runs the doctor for that env.
 *   - Secrets-presence row: per-env required-secret audit, status pills.
 *   - CI strip: latest workflow run per env, click to open in GitHub.
 *   - Rollback button (per selected env) with confirm modal → SSE log pane.
 *     Prod requires a typed-name safety gate (E13). Confirm button uses the
 *     FAULT colour from the design system.
 *
 * Visuals follow the Superfield Control Room design language: near-void
 * backgrounds, sharp 1px borders, mono ALL-CAPS labels, status badges.
 * Behaviour, event handlers and `data-testid` values are preserved.
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

const SECTION_STYLE: React.CSSProperties = {
  background: "var(--bg-raised)",
  border: "1px solid var(--border-subtle)",
};

const SECTION_HEADER_STYLE: React.CSSProperties = {
  borderBottom: "1px solid var(--border-subtle)",
  padding: "var(--sp-2) var(--sp-3)",
};

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

  const envs = state.envs;
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
      style={{
        display: "flex",
        height: "100%",
        flexDirection: "column",
        gap: "var(--sp-4)",
        overflowY: "auto",
        background: "var(--bg-base)",
        color: "var(--fg-1)",
        padding: "var(--sp-4)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h2 className="h2" style={{ margin: 0 }}>
          DEPLOYMENT HEALTH
        </h2>
        <button
          type="button"
          data-testid="deploy-refresh"
          onClick={() => void controller.refreshAll()}
          style={ghostButton}
        >
          REFRESH
        </button>
      </header>

      {state.envsError ? (
        <InlineError
          title="RESOURCE FAULT — ENVIRONMENT LIST"
          error={state.envsError}
          onRetry={() => void controller.loadEnvs()}
        />
      ) : null}

      {state.envsSource === "fallback" ? (
        <EmptyState
          title="No deployment environments configured"
          hint="Set DEPLOY_HOST_DEV, DEPLOY_HOST_STAGING, or DEPLOY_HOST_PROD as GitHub Actions variables to enable the deploy matrix."
          testId="deploy-unconfigured"
        />
      ) : envs.length > 0 ? (
        <EnvSwitcher
          envs={envs}
          selected={state.selectedEnv}
          onSelect={(e) => controller.selectEnv(e)}
        />
      ) : null}

      {envs.length > 0 && <section data-testid="doctor-matrix" style={SECTION_STYLE}>
        <div style={SECTION_HEADER_STYLE}>
          <span className="label">DOCTOR CHECKS</span>
        </div>
        {checkNames.length === 0 ? (
          <div style={{ padding: "var(--sp-3)" }}>
            <EmptyState
              title="Doctor results not loaded"
              hint="Click Refresh, or check the studio debug view if this persists."
              testId="doctor"
            />
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "var(--bg-elevated)" }}>
              <tr>
                <th
                  className="label"
                  style={{
                    textAlign: "left",
                    padding: "var(--sp-2) var(--sp-3)",
                  }}
                >
                  CHECK
                </th>
                {envs.map((env) => (
                  <th
                    key={env}
                    className="label"
                    style={{
                      textAlign: "left",
                      padding: "var(--sp-2) var(--sp-3)",
                    }}
                    data-testid={`doctor-col-${env}`}
                  >
                    {env}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {checkNames.map((name) => (
                <tr
                  key={name}
                  style={{
                    borderTop: "1px solid var(--border-subtle)",
                    verticalAlign: "top",
                  }}
                >
                  <td
                    style={{
                      padding: "var(--sp-2) var(--sp-3)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                      color: "var(--fg-1)",
                      letterSpacing: "var(--ls-wider)",
                      textTransform: "uppercase",
                    }}
                  >
                    {name}
                  </td>
                  {envs.map((env) => {
                    const checks = state.doctorByEnv[env] ?? [];
                    const c = checks.find((x) => x.name === name);
                    return (
                      <td
                        key={env}
                        style={{ padding: "var(--sp-2) var(--sp-3)" }}
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
      </section>}

      {envs.length > 0 && <section style={SECTION_STYLE}>
        <div style={SECTION_HEADER_STYLE}>
          <span className="label">SECRETS PRESENCE</span>
        </div>
        <div
          style={{
            display: "grid",
            gap: "var(--sp-3)",
            padding: "var(--sp-3)",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          }}
        >
          {envs.map((env) => (
            <div
              key={env}
              data-testid={`secrets-card-${env}`}
              style={{
                background: "var(--bg-base)",
                border: "1px solid var(--border-subtle)",
                padding: "var(--sp-3)",
              }}
            >
              <div className="label" style={{ marginBottom: "var(--sp-2)" }}>
                {env}
              </div>
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--sp-1)",
                }}
              >
                {(state.secretsByEnv[env] ?? []).map((s) => (
                  <li
                    key={s.name}
                    data-testid={`secret-${env}-${s.name}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "var(--sp-2)",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                        color: "var(--fg-1)",
                      }}
                    >
                      {s.name}
                    </span>
                    <span
                      data-pill="true"
                      className={`badge ${s.present ? "badge-nominal" : "badge-critical"}`}
                    >
                      {s.present ? "present" : "missing"}
                    </span>
                  </li>
                ))}
                {(state.secretsByEnv[env] ?? []).length === 0 ? (
                  <li
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--fg-3)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    NO TELEMETRY
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      </section>}

      {envs.length > 0 && <section data-testid="ci-strip" style={SECTION_STYLE}>
        <div style={SECTION_HEADER_STYLE}>
          <span className="label">LATEST CI RUNS</span>
        </div>
        <div
          style={{
            display: "grid",
            gap: "var(--sp-3)",
            padding: "var(--sp-3)",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          }}
        >
          {envs.map((env) => {
            const run = runForEnv(env);
            return (
              <div
                key={env}
                data-testid={`ci-card-${env}`}
                style={{
                  background: "var(--bg-base)",
                  border: "1px solid var(--border-subtle)",
                  padding: "var(--sp-3)",
                }}
              >
                <div className="label" style={{ marginBottom: "var(--sp-1)" }}>
                  {env}
                </div>
                {run ? (
                  <a
                    href={run.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                      letterSpacing: "var(--ls-wider)",
                      textTransform: "uppercase",
                      color: run.ok
                        ? "var(--status-nominal)"
                        : "var(--status-critical)",
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                    }}
                  >
                    {run.label}
                  </a>
                ) : (
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--fg-3)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    No deploy-{env} workflow run found
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>}

      {envs.length > 0 && <section
        data-testid="rollback-section"
        style={{ ...SECTION_STYLE, padding: "var(--sp-3)" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--sp-2)",
          }}
        >
          <span className="label">ROLLBACK&nbsp;{state.selectedEnv}</span>
          <button
            type="button"
            data-testid="rollback-trigger"
            onClick={() => setConfirmOpen(true)}
            disabled={state.rolloutActive}
            style={{
              ...dangerButton,
              opacity: state.rolloutActive ? 0.5 : 1,
              cursor: state.rolloutActive ? "not-allowed" : "pointer",
            }}
          >
            ROLL BACK THIS ENVIRONMENT
          </button>
        </div>
        {state.rolloutLog.length > 0 ? (
          <pre
            data-testid="rollback-log"
            style={{
              maxHeight: 192,
              overflowY: "auto",
              background: "var(--bg-void)",
              padding: "var(--sp-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--accent-green)",
              border: "1px solid var(--border-subtle)",
              margin: 0,
            }}
          >
            {state.rolloutLog.join("\n")}
          </pre>
        ) : null}
      </section>}

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

const ghostButton: React.CSSProperties = {
  padding: "var(--sp-1) var(--sp-3)",
  background: "transparent",
  border: "1px solid var(--border-default)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
  cursor: "pointer",
};

const dangerButton: React.CSSProperties = {
  padding: "var(--sp-1) var(--sp-3)",
  background: "transparent",
  border: "1px solid var(--accent-red)",
  color: "var(--accent-red)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  letterSpacing: "var(--ls-wider)",
  textTransform: "uppercase",
  cursor: "pointer",
};

const dangerSolidButton: React.CSSProperties = {
  ...dangerButton,
  background: "var(--accent-red)",
  color: "var(--fg-inv)",
};

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
      style={{
        display: "inline-flex",
        gap: "var(--sp-1)",
        padding: 0,
      }}
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
            data-pill="true"
            onClick={() => onSelect(env)}
            className={`badge ${active ? "" : "badge-offline"}`}
            style={{
              fontSize: "var(--text-xs)",
              padding: "var(--sp-1) var(--sp-3)",
              cursor: "pointer",
              ...(active
                ? {
                    color: "var(--accent-cyan)",
                    background: "rgba(0, 200, 204, 0.08)",
                    borderColor: "var(--accent-cyan)",
                    boxShadow: "0 0 8px rgba(0, 200, 204, 0.18)",
                  }
                : {}),
            }}
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
  // Prod rollbacks require typing the env name to enable Confirm. Dev/staging
  // are click-confirm only — matching the product.md design constraint that
  // prod operations get an explicit safety gate.
  const requiresTypedConfirmation = env === "prod";
  const [typed, setTyped] = useState("");
  const confirmEnabled = !requiresTypedConfirmation || typed.trim() === env;

  return (
    <div
      data-testid="rollback-confirm"
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: "var(--z-modal)" as unknown as number,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-overlay)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          background: "var(--bg-raised)",
          border: "1px solid var(--accent-red)",
          padding: "var(--sp-4)",
          color: "var(--fg-1)",
          boxShadow: "var(--glow-red)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            marginBottom: "var(--sp-2)",
          }}
        >
          <span className="badge badge-critical" data-pill="true">
            FAULT GATE
          </span>
          <h3 className="h3" style={{ margin: 0 }}>
            ROLL BACK&nbsp;{env}?
          </h3>
        </div>
        <p style={{ marginTop: "var(--sp-2)", color: "var(--fg-2)" }}>
          This will run <code>kubectl rollout undo</code> for the application
          and worker deployments. The studio will surface each step in the live
          log.
        </p>
        {requiresTypedConfirmation ? (
          <label
            style={{
              marginTop: "var(--sp-4)",
              display: "block",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-2)",
              letterSpacing: "var(--ls-wider)",
              textTransform: "uppercase",
            }}
          >
            TYPE <code style={{ fontSize: "var(--text-xs)" }}>{env}</code> TO
            CONFIRM:
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="rollback-confirm-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              style={{
                marginTop: "var(--sp-1)",
                width: "100%",
                background: "var(--bg-void)",
                border: "1px solid var(--border-subtle)",
                color: "var(--fg-1)",
                padding: "var(--sp-1) var(--sp-2)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                outline: "none",
              }}
            />
          </label>
        ) : null}
        <div
          style={{
            marginTop: "var(--sp-4)",
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--sp-2)",
          }}
        >
          <button
            type="button"
            data-testid="rollback-cancel"
            onClick={onCancel}
            style={ghostButton}
          >
            CANCEL
          </button>
          <button
            type="button"
            data-testid="rollback-confirm-action"
            onClick={onConfirm}
            disabled={!confirmEnabled}
            style={{
              ...dangerSolidButton,
              opacity: !confirmEnabled ? 0.4 : 1,
              cursor: !confirmEnabled ? "not-allowed" : "pointer",
            }}
          >
            CONFIRM ROLLBACK
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
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--fg-3)",
          letterSpacing: "var(--ls-wider)",
          textTransform: "uppercase",
        }}
      >
        {loading ? "checking…" : "—"}
      </span>
    );
  }
  if (check.ok) {
    return (
      <span
        data-testid="doctor-ok"
        data-pill="true"
        className="badge badge-nominal"
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
