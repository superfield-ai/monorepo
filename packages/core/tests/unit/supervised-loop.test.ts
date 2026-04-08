import { describe, expect, it, vi } from "vitest";
import { runSupervisedLoop } from "../../supervised-loop.ts";

describe("runSupervisedLoop", () => {
  it("retries after an unexpected error and then resumes the normal delay", async () => {
    const stop = new Error("stop");
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
      if (sleepCalls.length === 2) throw stop;
    });
    const onError = vi.fn();
    const runOnce = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("idle");

    await expect(
      runSupervisedLoop({
        runOnce,
        delayMs: () => 25,
        sleep,
        onError,
      }),
    ).rejects.toBe(stop);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toEqual([1000, 25]);
  });

  it("caps the error backoff and resets it after a successful iteration", async () => {
    const stop = new Error("stop");
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
      if (sleepCalls.length === 4) throw stop;
    });
    const runOnce = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom-1"))
      .mockRejectedValueOnce(new Error("boom-2"))
      .mockResolvedValueOnce("idle")
      .mockRejectedValueOnce(new Error("boom-3"));

    await expect(
      runSupervisedLoop({
        runOnce,
        delayMs: () => 10,
        sleep,
        initialErrorDelayMs: 1000,
        maxErrorDelayMs: 2000,
      }),
    ).rejects.toBe(stop);

    expect(sleepCalls).toEqual([1000, 2000, 10, 1000]);
  });
});
