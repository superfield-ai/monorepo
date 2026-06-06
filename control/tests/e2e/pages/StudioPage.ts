/**
 * @file tests/e2e/pages/StudioPage.ts
 *
 * Top-level Playwright page object for the Studio UI.
 *
 * Encapsulates locators for:
 *   - The root studio-panel container
 *   - The cluster status indicator
 *   - The embedded app iframe
 *   - The reloading overlay (shown during hot-swaps)
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Structure" section.
 */

import type { Page, Locator, FrameLocator } from '@playwright/test';

/** Cluster health states from ClusterStatusController. */
type ClusterStatus = 'healthy' | 'restarting' | 'degraded' | 'unknown';

export class StudioPage {
  readonly page: Page;

  /** Root studio panel container */
  readonly studioPanel: Locator;

  /** Cluster status indicator element */
  readonly clusterStatusIndicator: Locator;

  /** The embedded app iframe element */
  readonly appIframe: Locator;

  /** Reloading overlay shown during hot-swaps */
  readonly reloadingOverlay: Locator;

  constructor(page: Page) {
    this.page = page;
    this.studioPanel = page.locator('[data-testid="studio-panel"]');
    this.clusterStatusIndicator = page.locator('[data-testid="cluster-status-indicator"]');
    this.appIframe = page.locator('[data-testid="app-iframe"]');
    this.reloadingOverlay = page.locator('[data-testid="reloading-overlay"]');
  }

  /**
   * Navigate to the studio root URL.
   */
  async goto(url: string): Promise<void> {
    await this.page.goto(url);
  }

  /**
   * Return the current text content of the cluster status indicator.
   */
  async getClusterStatusText(): Promise<string> {
    return (await this.clusterStatusIndicator.textContent()) ?? '';
  }

  /**
   * Return the aria-label value of the cluster status indicator which
   * encodes the current status as "Cluster status: <status>".
   */
  async getClusterStatusLabel(): Promise<string> {
    return (await this.clusterStatusIndicator.getAttribute('aria-label')) ?? '';
  }

  /**
   * Wait until the cluster status indicator shows the given status.
   *
   * @param status   Expected cluster status string.
   * @param timeout  Maximum wait in milliseconds.
   */
  async waitForClusterStatus(
    status: ClusterStatus,
    timeout = 60_000,
  ): Promise<void> {
    await this.clusterStatusIndicator.waitFor({ state: 'visible', timeout });
    await this.page.waitForFunction(
      ([selector, expectedStatus]) => {
        const el = document.querySelector(selector as string);
        if (!el) return false;
        const label = el.getAttribute('aria-label') ?? '';
        return label.includes(expectedStatus as string);
      },
      ['[data-testid="cluster-status-indicator"]', status],
      { timeout },
    );
  }

  /**
   * Return a FrameLocator for the embedded app iframe.
   */
  appIframeLocator(): FrameLocator {
    return this.page.frameLocator('[data-testid="app-iframe"]');
  }

  /**
   * Return the src attribute of the app iframe.
   */
  async getIframeSrc(): Promise<string> {
    return (await this.appIframe.getAttribute('src')) ?? '';
  }
}
