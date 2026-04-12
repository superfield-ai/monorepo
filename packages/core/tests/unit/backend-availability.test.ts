import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  BackendAvailabilityStore,
  DEFAULT_BACKOFF_MS,
} from "../../backend-availability.ts";

describe("BackendAvailabilityStore", () => {
  let store: BackendAvailabilityStore;

  beforeEach(() => {
    store = new BackendAvailabilityStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isAvailable", () => {
    it("returns true for an unknown backend", () => {
      expect(store.isAvailable("claude")).toBe(true);
    });

    it("returns false immediately after markUnavailable", () => {
      store.markUnavailable("claude");
      expect(store.isAvailable("claude")).toBe(false);
    });

    it("returns true after the backoff window elapses", () => {
      store.markUnavailable("claude", 1_000);
      vi.advanceTimersByTime(1_000);
      expect(store.isAvailable("claude")).toBe(true);
    });

    it("returns false before the backoff window elapses", () => {
      store.markUnavailable("claude", 1_000);
      vi.advanceTimersByTime(999);
      expect(store.isAvailable("claude")).toBe(false);
    });

    it("is independent per backend", () => {
      store.markUnavailable("claude");
      expect(store.isAvailable("claude")).toBe(false);
      expect(store.isAvailable("codex")).toBe(true);
      expect(store.isAvailable("opencode")).toBe(true);
    });
  });

  describe("markUnavailable", () => {
    it("uses DEFAULT_BACKOFF_MS when no backoff is supplied", () => {
      store.markUnavailable("claude");
      expect(store.retryAfterMs("claude")).toBeGreaterThan(DEFAULT_BACKOFF_MS - 100);
      expect(store.retryAfterMs("claude")).toBeLessThanOrEqual(DEFAULT_BACKOFF_MS);
    });

    it("does not shorten an existing window when called again with a smaller backoff", () => {
      store.markUnavailable("claude", 10_000);
      const firstWindow = store.retryAfterMs("claude");
      store.markUnavailable("claude", 1_000); // shorter — should be ignored
      expect(store.retryAfterMs("claude")).toBeCloseTo(firstWindow, -2);
    });

    it("extends the window when called again with a larger backoff", () => {
      store.markUnavailable("claude", 1_000);
      store.markUnavailable("claude", 10_000);
      expect(store.retryAfterMs("claude")).toBeGreaterThan(5_000);
    });
  });

  describe("clearAvailable", () => {
    it("makes the backend available again immediately", () => {
      store.markUnavailable("claude");
      store.clearAvailable("claude");
      expect(store.isAvailable("claude")).toBe(true);
    });

    it("is a no-op for a backend that was never marked unavailable", () => {
      store.clearAvailable("codex"); // should not throw
      expect(store.isAvailable("codex")).toBe(true);
    });
  });

  describe("retryAfterMs", () => {
    it("returns 0 for an available backend", () => {
      expect(store.retryAfterMs("claude")).toBe(0);
    });

    it("returns remaining ms after marking unavailable", () => {
      store.markUnavailable("claude", 5_000);
      expect(store.retryAfterMs("claude")).toBeGreaterThan(4_000);
      expect(store.retryAfterMs("claude")).toBeLessThanOrEqual(5_000);
    });

    it("returns 0 after the window elapses", () => {
      store.markUnavailable("claude", 1_000);
      vi.advanceTimersByTime(1_001);
      expect(store.retryAfterMs("claude")).toBe(0);
    });
  });
});
