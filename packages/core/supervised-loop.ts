export interface SupervisedLoopOpts<T> {
  runOnce: () => Promise<T>;
  delayMs: (result: T) => number;
  sleep?: (ms: number) => Promise<void>;
  onError?: (error: unknown) => void;
  stopOnError?: (error: unknown) => boolean;
  initialErrorDelayMs?: number;
  maxErrorDelayMs?: number;
}

const DEFAULT_ERROR_DELAY_MS = 1_000;
const DEFAULT_MAX_ERROR_DELAY_MS = 30_000;

export async function runSupervisedLoop<T>(
  opts: SupervisedLoopOpts<T>,
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const initialErrorDelayMs =
    opts.initialErrorDelayMs ?? DEFAULT_ERROR_DELAY_MS;
  const maxErrorDelayMs = opts.maxErrorDelayMs ?? DEFAULT_MAX_ERROR_DELAY_MS;
  let errorDelayMs = initialErrorDelayMs;

  while (true) {
    let nextDelayMs: number;
    try {
      const result = await opts.runOnce();
      errorDelayMs = initialErrorDelayMs;
      nextDelayMs = Math.max(0, opts.delayMs(result));
    } catch (error) {
      opts.onError?.(error);
      if (opts.stopOnError?.(error)) {
        throw error;
      }
      nextDelayMs = errorDelayMs;
      errorDelayMs = Math.min(errorDelayMs * 2, maxErrorDelayMs);
    }
    await sleep(nextDelayMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
