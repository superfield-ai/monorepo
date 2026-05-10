/**
 * Unit tests for packages/control/src/screenshot-capture.ts
 *
 * Tests exercise the capture logic in isolation using injected Playwright
 * stub (`_chromium`).  No real browser is launched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  captureScreenshot,
  type PlaywrightChromiumLike,
  type PlaywrightBrowserLike,
  type PlaywrightPageLike,
} from "../../src/screenshot-capture";

let workdir: string;
let originalRepoRoot: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "screenshot-test-"));
  originalRepoRoot = process.env.SUPERFIELD_REPO_ROOT;
  process.env.SUPERFIELD_REPO_ROOT = workdir;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalRepoRoot === undefined) delete process.env.SUPERFIELD_REPO_ROOT;
  else process.env.SUPERFIELD_REPO_ROOT = originalRepoRoot;
});

/** Build a minimal stub chromium launcher. */
function makeStubChromium(
  screenshotBuf: Buffer = Buffer.from("PNG"),
): PlaywrightChromiumLike {
  const page: PlaywrightPageLike = {
    goto: async (_url, _opts) => {},
    screenshot: async (opts) => {
      // Write an empty file to opts.path if provided
      if (opts?.path) {
        writeFileSync(opts.path, screenshotBuf);
      }
      return screenshotBuf;
    },
  };
  const browser: PlaywrightBrowserLike = {
    newPage: async () => page,
    close: async () => {},
  };
  return {
    launch: async (_opts) => browser,
  };
}

describe("captureScreenshot", () => {
  it("creates session directory and writes turn-1.png on first capture", async () => {
    const chromium = makeStubChromium();
    const result = await captureScreenshot({
      sessionId: "sess-abc",
      repoRoot: workdir,
      targetUrl: "http://localhost:3000/",
      _chromium: chromium,
    });
    expect(result).not.toBeNull();
    expect(result).toMatch(/turn-1\.png$/);
    expect(existsSync(result!)).toBe(true);
  });

  it("increments turn index on subsequent captures", async () => {
    const chromium = makeStubChromium();
    const opts = {
      sessionId: "sess-incr",
      repoRoot: workdir,
      targetUrl: "http://localhost:3000/",
      _chromium: chromium,
    };
    const first = await captureScreenshot(opts);
    const second = await captureScreenshot(opts);
    expect(first).toMatch(/turn-1\.png$/);
    expect(second).toMatch(/turn-2\.png$/);
  });

  it("returns null when chromium launcher is unavailable", async () => {
    // Pass null as _chromium to simulate missing Playwright
    const result = await captureScreenshot({
      sessionId: "sess-no-pw",
      repoRoot: workdir,
      targetUrl: "http://localhost:3000/",
      _chromium: null as unknown as PlaywrightChromiumLike,
    });
    expect(result).toBeNull();
  });

  it("returns null when browser.goto throws", async () => {
    const page: PlaywrightPageLike = {
      goto: async () => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      },
      screenshot: async () => Buffer.from(""),
    };
    const browser: PlaywrightBrowserLike = {
      newPage: async () => page,
      close: async () => {},
    };
    const chromium: PlaywrightChromiumLike = {
      launch: async () => browser,
    };
    const result = await captureScreenshot({
      sessionId: "sess-fail",
      repoRoot: workdir,
      targetUrl: "http://localhost:9999/",
      _chromium: chromium,
    });
    expect(result).toBeNull();
  });

  it("uses SCREENSHOT_URL env var when targetUrl is not set", async () => {
    const capturedUrls: string[] = [];
    const page: PlaywrightPageLike = {
      goto: async (url) => {
        capturedUrls.push(url);
      },
      screenshot: async (opts) => {
        if (opts?.path) writeFileSync(opts.path, Buffer.from("PNG"));
        return Buffer.from("PNG");
      },
    };
    const browser: PlaywrightBrowserLike = {
      newPage: async () => page,
      close: async () => {},
    };
    const chromium: PlaywrightChromiumLike = { launch: async () => browser };

    const prev = process.env.SCREENSHOT_URL;
    process.env.SCREENSHOT_URL = "http://my-app:8080/preview";
    try {
      await captureScreenshot({
        sessionId: "sess-env",
        repoRoot: workdir,
        _chromium: chromium,
      });
    } finally {
      if (prev === undefined) delete process.env.SCREENSHOT_URL;
      else process.env.SCREENSHOT_URL = prev;
    }
    expect(capturedUrls[0]).toBe("http://my-app:8080/preview");
  });
});
