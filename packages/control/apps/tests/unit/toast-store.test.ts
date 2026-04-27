/**
 * Unit tests for the toast queue (E8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toastStore } from "../../src/lib/toast-store";

describe("toastStore", () => {
  beforeEach(() => {
    toastStore.__resetForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    toastStore.__resetForTest();
  });

  it("returns the new id from show()", () => {
    const id = toastStore.show({ severity: "info", title: "hi" });
    expect(id).toBe("t1");
    expect(toastStore.getAll()).toHaveLength(1);
  });

  it("notifies subscribers on show and dismiss", () => {
    const calls: number[] = [];
    const unsub = toastStore.subscribe((t) => calls.push(t.length));
    expect(calls).toEqual([0]);
    const id = toastStore.show({ severity: "warn", title: "x" });
    expect(calls).toEqual([0, 1]);
    toastStore.dismiss(id);
    expect(calls).toEqual([0, 1, 0]);
    unsub();
  });

  it("auto-dismisses when timeoutMs elapses", () => {
    toastStore.show({ severity: "info", title: "x", timeoutMs: 1000 });
    expect(toastStore.getAll()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(toastStore.getAll()).toHaveLength(0);
  });

  it("clear empties the queue", () => {
    toastStore.show({ severity: "info", title: "a" });
    toastStore.show({ severity: "info", title: "b" });
    toastStore.clear();
    expect(toastStore.getAll()).toHaveLength(0);
  });

  it("dismiss is a no-op for unknown id", () => {
    toastStore.show({ severity: "info", title: "a" });
    toastStore.dismiss("unknown");
    expect(toastStore.getAll()).toHaveLength(1);
  });
});
