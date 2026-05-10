/**
 * @file screenshot-capture.ts
 *
 * Headless Playwright screenshot runner for the Studio per-turn capture
 * feature (issue #249).
 *
 * Saves PNG captures to:
 *   docs/studio-sessions/<sessionId>/<turn-N>.png
 *
 * relative to `repoRoot` (SUPERFIELD_REPO_ROOT or process.cwd()).
 *
 * The module is written so that Playwright is only required at runtime when
 * `captureScreenshot` is called.  When Playwright's chromium browser is not
 * installed the function logs a warning and resolves without writing a file.
 *
 * Environment variables:
 *   SCREENSHOT_URL   — URL to capture (default: http://127.0.0.1:<CONTROL_WEB_SERVICE_PORT>/)
 *                      Falls back to the web service URL derived from config.
 *   CONTROL_WEB_SERVICE_HOST / CONTROL_WEB_SERVICE_PORT — used to build the
 *                      fallback URL when SCREENSHOT_URL is not set.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ScreenshotOpts {
  /** Agent session ID — used as the directory name under docs/studio-sessions/. */
  sessionId: string;
  /**
   * Root directory of the target repo.  Screenshots are written relative to
   * this path.  Defaults to SUPERFIELD_REPO_ROOT or process.cwd().
   */
  repoRoot?: string;
  /**
   * URL of the app preview to screenshot.
   * Defaults to SCREENSHOT_URL env var or the web-service URL derived from
   * CONTROL_WEB_SERVICE_HOST / CONTROL_WEB_SERVICE_PORT.
   */
  targetUrl?: string;
  /**
   * Timeout in milliseconds to wait for the page to load.  Default 10 000.
   */
  timeoutMs?: number;
  /**
   * Injected Playwright `chromium` launcher (tests).  When omitted the real
   * `@playwright/test` chromium launcher is used.
   */
  _chromium?: PlaywrightChromiumLike;
}

/** Minimal subset of the Playwright chromium API needed by this module. */
export interface PlaywrightChromiumLike {
  launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowserLike>;
}

/** Minimal subset of the Playwright Browser API. */
export interface PlaywrightBrowserLike {
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

/** Minimal subset of the Playwright Page API. */
export interface PlaywrightPageLike {
  goto(
    url: string,
    opts?: { timeout?: number; waitUntil?: string },
  ): Promise<unknown>;
  screenshot(opts?: {
    path?: string;
    type?: string;
  }): Promise<Buffer | Uint8Array>;
}

/**
 * Resolve the target URL for the screenshot.
 *
 * Priority:
 *  1. `opts.targetUrl`
 *  2. `SCREENSHOT_URL` env var
 *  3. Derived from CONTROL_WEB_SERVICE_HOST / CONTROL_WEB_SERVICE_PORT
 */
function resolveTargetUrl(opts: ScreenshotOpts): string {
  if (opts.targetUrl) return opts.targetUrl;
  if (process.env.SCREENSHOT_URL) return process.env.SCREENSHOT_URL;
  const host = process.env.CONTROL_WEB_SERVICE_HOST ?? "127.0.0.1";
  const port = process.env.CONTROL_WEB_SERVICE_PORT ?? "80";
  return `http://${host}:${port}/`;
}

/**
 * Resolve the output directory for screenshots and ensure it exists.
 *
 *   <repoRoot>/docs/studio-sessions/<sessionId>/
 */
function resolveSessionDir(opts: ScreenshotOpts): string {
  const root =
    opts.repoRoot ?? process.env.SUPERFIELD_REPO_ROOT ?? process.cwd();
  const dir = resolve(root, "docs", "studio-sessions", opts.sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Compute the next turn index by scanning existing `<turn-N>.png` files.
 */
function nextTurnIndex(sessionDir: string): number {
  if (!existsSync(sessionDir)) return 1;
  const files = readdirSync(sessionDir).filter((f) =>
    /^turn-\d+\.png$/.test(f),
  );
  if (files.length === 0) return 1;
  const indices = files.map((f) => parseInt(f.replace(/[^\d]/g, ""), 10));
  return Math.max(...indices) + 1;
}

/**
 * Dynamically import Playwright's chromium launcher.
 * Returns null when Playwright is not installed.
 */
async function loadChromium(): Promise<PlaywrightChromiumLike | null> {
  try {
    const pw = await import("@playwright/test");
    // `pw.chromium` is the browser type; it exposes `launch()`.
    return pw.chromium as unknown as PlaywrightChromiumLike;
  } catch {
    return null;
  }
}

/**
 * Capture a headless screenshot of the app preview and write it to:
 *
 *   docs/studio-sessions/<sessionId>/turn-<N>.png
 *
 * Returns the absolute path written, or `null` when Playwright is unavailable
 * or the capture fails for any reason.
 *
 * This function never throws — all errors are returned as `null`.
 */
export async function captureScreenshot(
  opts: ScreenshotOpts,
): Promise<string | null> {
  let sessionDir: string;
  try {
    sessionDir = resolveSessionDir(opts);
  } catch (err) {
    console.warn(
      `[screenshot] failed to create session dir for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // When `_chromium` is explicitly set in opts (even to null), use it as the
  // injected launcher (test seam).  Otherwise fall back to dynamic import.
  const chromiumLauncher =
    "_chromium" in opts ? opts._chromium : await loadChromium();
  if (!chromiumLauncher) {
    console.warn(
      "[screenshot] @playwright/test not available — skipping screenshot capture",
    );
    return null;
  }

  const targetUrl = resolveTargetUrl(opts);
  const turnIndex = nextTurnIndex(sessionDir);
  const outPath = join(sessionDir, `turn-${turnIndex}.png`);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let browser: PlaywrightBrowserLike | null = null;
  try {
    browser = await chromiumLauncher.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(targetUrl, {
      timeout: timeoutMs,
      waitUntil: "networkidle",
    });
    await page.screenshot({ path: outPath, type: "png" });
    return outPath;
  } catch (err) {
    console.warn(
      `[screenshot] capture failed for ${opts.sessionId} turn-${turnIndex}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
