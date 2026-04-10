/**
 * Unit tests for packages/core/retry.ts
 *
 * Issue #8: retry/backoff with circuit breaker for transient agent failures.
 */
import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../../retry.ts";

// --- withRetry ---

describe("withRetry", () => {
  it("returns immediately when the function succeeds on the first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { initialDelayMs: 0 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and returns when a later attempt succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "success";
    });

    const result = await withRetry(fn, { maxAttempts: 5, initialDelayMs: 0 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting all attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 0 }),
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("applies exponential backoff between retries", async () => {
    const delays: number[] = [];
    const sleepSpy = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "ok";
    });

    await withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      backoffFactor: 2,
      sleep: sleepSpy,
    });

    expect(delays).toEqual([100, 200]);
  });

  it("defaults to 3 attempts, 1000ms initial delay, factor 2", async () => {
    // Just verify defaults don't throw for a succeeding fn
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, { initialDelayMs: 0 });
    expect(result).toBe(42);
  });
});

// --- CircuitBreaker ---

describe("CircuitBreaker", () => {
  it("passes through when the circuit is closed", async () => {
    const cb = new CircuitBreaker({ tripAt: 3, resetMs: 10_000 });
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await cb.call(fn);
    expect(result).toBe("ok");
  });

  it("resets failure count on success", async () => {
    const cb = new CircuitBreaker({ tripAt: 3, resetMs: 10_000 });
    const failing = vi.fn().mockRejectedValue(new Error("err"));
    const passing = vi.fn().mockResolvedValue("ok");

    await expect(cb.call(failing)).rejects.toThrow();
    await expect(cb.call(failing)).rejects.toThrow();
    await cb.call(passing); // success resets counter
    // should not trip yet after 2 failures reset by 1 success
    expect(cb.isOpen).toBe(false);
  });

  it("opens the circuit after tripAt consecutive failures", async () => {
    const cb = new CircuitBreaker({ tripAt: 3, resetMs: 10_000 });
    const fn = vi.fn().mockRejectedValue(new Error("err"));

    await expect(cb.call(fn)).rejects.toThrow("err");
    await expect(cb.call(fn)).rejects.toThrow("err");
    await expect(cb.call(fn)).rejects.toThrow("err");

    expect(cb.isOpen).toBe(true);
  });

  it("throws CircuitBreakerOpenError when the circuit is open", async () => {
    const cb = new CircuitBreaker({ tripAt: 2, resetMs: 10_000 });
    const fn = vi.fn().mockRejectedValue(new Error("err"));

    await expect(cb.call(fn)).rejects.toThrow();
    await expect(cb.call(fn)).rejects.toThrow();
    await expect(cb.call(fn)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });

  it("rejects immediately when the circuit is open", async () => {
    const cb = new CircuitBreaker({ tripAt: 2, resetMs: 10_000 });
    const fn = vi.fn().mockRejectedValue(new Error("err"));

    await expect(cb.call(fn)).rejects.toThrow();
    await expect(cb.call(fn)).rejects.toThrow();
    // Circuit now open — next call should reject without calling fn
    const callsBefore = fn.mock.calls.length;
    await expect(cb.call(fn)).rejects.toThrow(/circuit open/i);
    expect(fn.mock.calls.length).toBe(callsBefore); // fn not called again
  });

  it("allows calls through after the reset window", async () => {
    const cb = new CircuitBreaker({ tripAt: 2, resetMs: 50 });
    const fn = vi.fn().mockRejectedValue(new Error("err"));

    await expect(cb.call(fn)).rejects.toThrow();
    await expect(cb.call(fn)).rejects.toThrow();
    expect(cb.isOpen).toBe(true);

    // Wait for reset window
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cb.isOpen).toBe(false);

    const passing = vi.fn().mockResolvedValue("ok");
    const result = await cb.call(passing);
    expect(result).toBe("ok");
  });
});

// --- withRetry + CircuitBreaker integration ---

describe("withRetry + CircuitBreaker", () => {
  it("circuit open → withRetry throws immediately, no sleep", async () => {
    const cb = new CircuitBreaker({ tripAt: 2, resetMs: 60_000 });
    const fn = vi.fn().mockRejectedValue(new Error("err"));
    const sleepSpy = vi.fn().mockResolvedValue(undefined);

    // Trip the circuit
    await expect(cb.call(fn)).rejects.toThrow();
    await expect(cb.call(fn)).rejects.toThrow();
    expect(cb.isOpen).toBe(true);

    // withRetry should rethrow CircuitBreakerOpenError immediately
    await expect(
      withRetry(() => cb.call(fn), {
        maxAttempts: 5,
        initialDelayMs: 1000,
        sleep: sleepSpy,
      }),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError);

    // No sleep should have been called
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("circuit closed, transient failure → retries as before", async () => {
    const cb = new CircuitBreaker({ tripAt: 10, resetMs: 60_000 });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    const sleepSpy = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(() => cb.call(fn), {
      maxAttempts: 5,
      initialDelayMs: 100,
      sleep: sleepSpy,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it("circuit transitions closed→open mid-retry → remaining retries abort immediately", async () => {
    const cb = new CircuitBreaker({ tripAt: 2, resetMs: 60_000 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    const sleepSpy = vi.fn().mockResolvedValue(undefined);

    // Circuit trips after 2 failures, then 3rd attempt sees open circuit
    await expect(
      withRetry(() => cb.call(fn), {
        maxAttempts: 5,
        initialDelayMs: 100,
        sleep: sleepSpy,
      }),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError);

    // fn called twice (tripping the circuit), then circuit.call throws open error
    expect(fn).toHaveBeenCalledTimes(2);
    // Sleep called between attempt 1→2 and 2→3, but not after the open error
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });
});
