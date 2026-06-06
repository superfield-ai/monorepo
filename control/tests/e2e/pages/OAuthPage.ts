/**
 * @file tests/e2e/pages/OAuthPage.ts
 *
 * Playwright page object for the Studio OAuth panel.
 *
 * Encapsulates locators and helpers for:
 *   - The Connect / Initiate OAuth button
 *   - The OAuth URL display
 *   - The confirmation code input
 *   - The Submit code button
 *   - The connected status indicator
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Structure" section.
 */

import type { Page, Locator } from '@playwright/test';

export class OAuthPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * The "Connect" button that initiates the OAuth flow (visible when disconnected).
   */
  initiateButton(): Locator {
    return this.page.locator('button', { hasText: 'Connect' });
  }

  /**
   * The OAuth authorization URL code element shown after initiation.
   */
  oauthUrlDisplay(): Locator {
    return this.page.locator('code');
  }

  /**
   * The confirmation code input shown after OAuth URL is displayed.
   */
  confirmationCodeInput(): Locator {
    return this.page.locator('input[placeholder="Confirmation code"]');
  }

  /**
   * The Submit button for entering the confirmation code.
   */
  submitCodeButton(): Locator {
    return this.page.locator('button', { hasText: 'Submit' });
  }

  /**
   * The "Claude Code Connected" status text shown after successful OAuth.
   */
  connectedStatus(): Locator {
    return this.page.locator('span', { hasText: 'Claude Code Connected' });
  }

  /**
   * Click Initiate / Connect to start the OAuth flow.
   */
  async clickInitiate(): Promise<void> {
    await this.initiateButton().click();
  }

  /**
   * Wait until the OAuth authorization URL is displayed.
   *
   * @param timeout Maximum wait in milliseconds.
   */
  async waitForOAuthUrl(timeout = 30_000): Promise<void> {
    await this.oauthUrlDisplay().waitFor({ state: 'visible', timeout });
  }

  /**
   * Return the displayed OAuth authorization URL text.
   */
  async getOAuthUrl(): Promise<string> {
    return (await this.oauthUrlDisplay().textContent()) ?? '';
  }

  /**
   * Enter a confirmation code and click Submit.
   *
   * @param code  The confirmation code to enter.
   */
  async submitCode(code: string): Promise<void> {
    await this.confirmationCodeInput().fill(code);
    await this.submitCodeButton().click();
  }

  /**
   * Wait until the panel shows the connected status.
   *
   * @param timeout Maximum wait in milliseconds.
   */
  async waitForConnected(timeout = 30_000): Promise<void> {
    await this.connectedStatus().waitFor({ state: 'visible', timeout });
  }
}
