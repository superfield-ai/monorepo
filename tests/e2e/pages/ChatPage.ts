/**
 * @file tests/e2e/pages/ChatPage.ts
 *
 * Playwright page object for the Studio chat panel.
 *
 * Encapsulates locators and helpers for:
 *   - The message input textarea
 *   - The send button
 *   - The chat message history list
 *   - Individual user/assistant messages
 *   - The rollback buttons on commits
 *   - The loading/streaming indicator
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Structure" section.
 */

import type { Page, Locator } from '@playwright/test';

export class ChatPage {
  readonly page: Page;

  /** Chat message input textarea */
  readonly chatInput: Locator;

  /** Send message button */
  readonly chatSubmit: Locator;

  /** The container for all chat messages */
  readonly chatMessages: Locator;

  /** The chat form wrapper */
  readonly chatForm: Locator;

  /** The commit history section (StudioChat) */
  readonly commitHistory: Locator;

  constructor(page: Page) {
    this.page = page;
    this.chatInput = page.locator('[data-testid="chat-input"]');
    this.chatSubmit = page.locator('[data-testid="chat-submit"]');
    this.chatMessages = page.locator('[data-testid="chat-messages"]');
    this.chatForm = page.locator('[data-testid="chat-form"]');
    this.commitHistory = page.locator('[data-testid="studio-panel"]');
  }

  /**
   * Type a message in the chat input and click Send.
   */
  async sendMessage(text: string): Promise<void> {
    await this.chatInput.fill(text);
    await this.chatSubmit.click();
  }

  /**
   * Return all user message elements.
   */
  userMessages(): Locator {
    return this.page.locator('[data-testid="message-user"]');
  }

  /**
   * Return all assistant message elements.
   */
  assistantMessages(): Locator {
    return this.page.locator('[data-testid="message-assistant"]');
  }

  /**
   * Return the streaming cursor element inside the current assistant message.
   */
  streamingCursor(): Locator {
    return this.page.locator('[aria-label="streaming"]');
  }

  /**
   * Wait until the loading indicator disappears (turn is complete).
   *
   * @param timeout Maximum wait in milliseconds.
   */
  async waitForTurnComplete(timeout = 60_000): Promise<void> {
    // Wait for the streaming cursor to disappear — it is present only during streaming.
    await this.page
      .locator('[aria-label="streaming"]')
      .waitFor({ state: 'detached', timeout })
      .catch(() => {
        // If streaming cursor was never shown (very fast response), that's fine.
      });
    // Also wait for the send button to be re-enabled.
    await this.chatSubmit.waitFor({ state: 'visible', timeout });
  }

  /**
   * Wait until at least one assistant message is visible.
   *
   * @param timeout Maximum wait in milliseconds.
   */
  async waitForReply(timeout = 60_000): Promise<void> {
    await this.assistantMessages().first().waitFor({ state: 'visible', timeout });
  }

  /**
   * Return all rollback button elements in the commit list.
   */
  rollbackButtons(): Locator {
    return this.page.locator('[aria-label="Rollback commit"]');
  }

  /**
   * Return commit entry elements in the session commit history.
   */
  commitEntries(): Locator {
    return this.page.locator('.group').filter({ has: this.page.locator('[aria-label="Rollback commit"]') });
  }

  /**
   * Click the rollback button on the nth commit (0-indexed).
   */
  async rollbackCommit(index: number): Promise<void> {
    const buttons = this.rollbackButtons();
    await buttons.nth(index).click();
    // Handle the confirmation dialog.
    this.page.on('dialog', (dialog) => dialog.accept());
  }

  /**
   * Return the count of assistant messages in the chat history.
   */
  async getAssistantMessageCount(): Promise<number> {
    return await this.assistantMessages().count();
  }

  /**
   * Return the count of commit entries in the session commits section.
   */
  async getCommitCount(): Promise<number> {
    return await this.rollbackButtons().count();
  }
}
