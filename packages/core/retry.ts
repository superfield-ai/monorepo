/**
 * Retry / circuit-breaker utilities for transient agent failures.
 * Used by the dev loop to guard against agent CLI rate limits and
 * transient process-spawn errors.
 */

import { SuperfieldError } from "./errors.ts";

/**
 * Thrown by CircuitBreaker.call() when the circuit is open.
 * withRetry rethrows this immediately without sleeping or decrementing attempts.
 */
export class CircuitBreakerOpenError extends SuperfieldError {
  constructor(message: string) {
    super("internal", message);
  }
}

export interface RetryOpts {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Delay before the first retry in ms. Default: 1000 */
  initialDelayMs?: number;
  /** Multiplier applied to the delay after each failure. Default: 2 */
  backoffFactor?: number;
  /** Injectable sleep function for testing. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Calls `fn` up to `maxAttempts` times, waiting an exponentially increasing
 * delay between each failure. Returns the first successful result or throws
 * the last error after all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialDelayMs = opts.initialDelayMs ?? 1000;
  const backoffFactor = opts.backoffFactor ?? 2;
  const sleepFn = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        throw err;
      }
      lastError = err;
      if (attempt < maxAttempts) {
        await sleepFn(delayMs);
        delayMs = Math.floor(delayMs * backoffFactor);
      }
    }
  }

  throw lastError;
}

export interface CircuitBreakerOpts {
  /** Number of consecutive failures before the circuit trips. Default: 5 */
  tripAt?: number;
  /** How long (ms) the circuit stays open before allowing calls again. Default: 5min */
  resetMs?: number;
}

/**
 * Simple state-machine circuit breaker.
 *
 * States:
 *   closed  — normal operation; consecutive failures tracked
 *   open    — all calls rejected immediately until `resetMs` has elapsed
 *
 * A successful call in the closed state resets the failure counter.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly tripAt: number;
  private readonly resetMs: number;

  constructor(opts: CircuitBreakerOpts = {}) {
    this.tripAt = opts.tripAt ?? 5;
    this.resetMs = opts.resetMs ?? 5 * 60 * 1000;
  }

  /** True when the circuit is open and calls are rejected without execution. */
  get isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  /** Current consecutive failure count (0 when circuit is open or reset). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /**
   * Calls `fn` if the circuit is closed. Tracks failures; trips after
   * `tripAt` consecutive failures and resets after `resetMs`.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) {
      throw new CircuitBreakerOpenError(
        `Circuit open — too many consecutive failures. Retrying after ${new Date(this.openUntil).toISOString()}.`,
      );
    }

    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.tripAt) {
        this.openUntil = Date.now() + this.resetMs;
        this.failures = 0;
      }
      throw err;
    }
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
