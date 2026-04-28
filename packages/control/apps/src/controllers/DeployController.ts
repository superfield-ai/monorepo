/**
 * @file DeployController.ts
 *
 * Pure-TS controller for the deployment health view (D1 / C-9.5).
 *
 * Owns no React; exposes a subscribe/getState/refresh/rollback API used by the
 * DeployView component. All network access is routed through the typed
 * fetchJson / openEventSource wrappers — never raw fetch.
 */

import { fetchJson, openEventSource } from "../lib/net";
import type { AppError } from "../lib/errors";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SecretCheck {
  readonly name: string;
  readonly present: boolean;
  readonly detail: string;
}

export interface CiRun {
  readonly env: string;
  readonly workflow: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  readonly createdAt: string;
}

export interface DeployState {
  readonly envs: readonly string[];
  readonly envsSource: "github" | "fallback" | "loading";
  readonly envsError: AppError | null;
  readonly selectedEnv: string;
  readonly doctorByEnv: Readonly<Record<string, readonly DoctorCheck[]>>;
  readonly doctorErrors: Readonly<Record<string, AppError>>;
  readonly secretsByEnv: Readonly<Record<string, readonly SecretCheck[]>>;
  readonly ciRuns: readonly CiRun[];
  readonly loadingDoctor: ReadonlySet<string>;
  readonly loadingSecrets: ReadonlySet<string>;
  readonly rolloutLog: readonly string[];
  readonly rolloutActive: boolean;
}

const INITIAL: DeployState = {
  envs: [],
  envsSource: "loading",
  envsError: null,
  selectedEnv: "dev",
  doctorByEnv: {},
  doctorErrors: {},
  secretsByEnv: {},
  ciRuns: [],
  loadingDoctor: new Set(),
  loadingSecrets: new Set(),
  rolloutLog: [],
  rolloutActive: false,
};

export type DeployListener = (state: DeployState) => void;

interface EnvsResponse {
  envs: string[];
  source: "github" | "fallback" | string;
}
interface DoctorResponse {
  env: string;
  checks: DoctorCheck[];
  allOk: boolean;
}
interface SecretsResponse {
  env: string;
  checks: SecretCheck[];
}
interface CiResponse {
  runs: CiRun[];
  source: string;
}

export class DeployController {
  private state: DeployState = INITIAL;
  private readonly listeners = new Set<DeployListener>();
  private readonly base: string;

  constructor(base = "") {
    this.base = base;
  }

  subscribe(listener: DeployListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): DeployState {
    return this.state;
  }

  selectEnv(env: string): void {
    if (env === this.state.selectedEnv) return;
    this.set({ selectedEnv: env });
    void this.loadDoctor(env);
    void this.loadSecrets(env);
  }

  async refreshAll(): Promise<void> {
    await this.loadEnvs();
    const targetEnvs = this.state.envs;
    await Promise.all([
      ...targetEnvs.map((e) => this.loadDoctor(e)),
      ...targetEnvs.map((e) => this.loadSecrets(e)),
      this.loadCi(),
    ]);
  }

  async loadEnvs(): Promise<void> {
    const result = await fetchJson<EnvsResponse>(
      `${this.base}/studio/deploy/envs`,
    );
    if (!result.ok) {
      this.set({ envsError: result.error });
      return;
    }
    const envsSource: DeployState["envsSource"] =
      result.value.source === "github" ? "github" : "fallback";
    // Only use envs that were actually discovered from GitHub Actions variables.
    // The fallback ["dev","staging","prod"] represents "not configured", not real envs.
    const envs = envsSource === "github" ? result.value.envs : [];
    const selected = envs.includes(this.state.selectedEnv)
      ? this.state.selectedEnv
      : (envs[0] ?? this.state.selectedEnv);
    this.set({ envs, envsSource, envsError: null, selectedEnv: selected });
  }

  async loadDoctor(env: string): Promise<void> {
    const loadingDoctor = new Set(this.state.loadingDoctor);
    loadingDoctor.add(env);
    this.set({ loadingDoctor });

    const result = await fetchJson<DoctorResponse>(
      `${this.base}/studio/deploy/doctor/${encodeURIComponent(env)}`,
    );
    const nextLoading = new Set(this.state.loadingDoctor);
    nextLoading.delete(env);

    if (!result.ok) {
      const doctorErrors = { ...this.state.doctorErrors, [env]: result.error };
      this.set({ loadingDoctor: nextLoading, doctorErrors });
      return;
    }
    const doctorByEnv = {
      ...this.state.doctorByEnv,
      [env]: result.value.checks,
    };
    const doctorErrors = { ...this.state.doctorErrors };
    delete doctorErrors[env];
    this.set({ loadingDoctor: nextLoading, doctorByEnv, doctorErrors });
  }

  async loadSecrets(env: string): Promise<void> {
    const loadingSecrets = new Set(this.state.loadingSecrets);
    loadingSecrets.add(env);
    this.set({ loadingSecrets });

    const result = await fetchJson<SecretsResponse>(
      `${this.base}/studio/deploy/secrets/${encodeURIComponent(env)}`,
    );
    const nextLoading = new Set(this.state.loadingSecrets);
    nextLoading.delete(env);

    if (!result.ok) {
      this.set({ loadingSecrets: nextLoading });
      return;
    }
    const secretsByEnv = {
      ...this.state.secretsByEnv,
      [env]: result.value.checks,
    };
    this.set({ loadingSecrets: nextLoading, secretsByEnv });
  }

  async loadCi(): Promise<void> {
    const result = await fetchJson<CiResponse>(`${this.base}/studio/deploy/ci`);
    if (!result.ok) return;
    this.set({ ciRuns: result.value.runs });
  }

  /**
   * Initiate a confirmed rollback. Posts to /studio/deploy/rollback/:env to
   * obtain a jobId, then subscribes to GET /studio/deploy/rollback-log?job=…
   * via openEventSource and pipes lines into rolloutLog.
   *
   * Returns a Promise that resolves once the SSE stream emits `done` or `error`.
   */
  async rollback(env: string): Promise<void> {
    this.set({ rolloutLog: [], rolloutActive: true });
    const result = await fetchJson<{ jobId: string }>(
      `${this.base}/studio/deploy/rollback/${encodeURIComponent(env)}`,
      { method: "POST", body: { confirm: true } },
    );
    if (!result.ok) {
      this.appendLog(`error: ${result.error.message}`);
      this.set({ rolloutActive: false });
      return;
    }
    const { jobId } = result.value;
    await new Promise<void>((resolve) => {
      const handle = openEventSource({
        url: `${this.base}/studio/deploy/rollback-log?job=${encodeURIComponent(jobId)}`,
        onMessage: (ev) => this.appendLog(String(ev.data)),
        events: {
          done: (ev) => {
            this.appendLog(`done: ${String(ev.data)}`);
            handle.close();
            this.set({ rolloutActive: false });
            resolve();
          },
          error: (ev) => {
            this.appendLog(`error: ${String(ev.data)}`);
            handle.close();
            this.set({ rolloutActive: false });
            resolve();
          },
        },
        onError: (errorPayload) => {
          this.appendLog(`stream error: ${errorPayload.message}`);
          handle.close();
          this.set({ rolloutActive: false });
          resolve();
        },
      });
    });
  }

  private appendLog(line: string): void {
    this.set({ rolloutLog: [...this.state.rolloutLog, line] });
  }

  /** Test seam — public for vitest. */
  _replaceState(partial: Partial<DeployState>): void {
    this.set(partial);
  }

  private set(partial: Partial<DeployState>): void {
    this.state = { ...this.state, ...partial };
    for (const fn of this.listeners) fn(this.state);
  }
}
