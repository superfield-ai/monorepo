/**
 * @file tests/e2e/specs/chat-turn.spec.ts
 *
 * Layer 4 Browser E2E — Chat turn.
 *
 * Scenario: Type message, click Send; message in history; loading indicator
 * during stub run; reply appears; commit count increases by one.
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Test scenarios" table — "chat-turn" row.
 */

import { test, expect } from '../fixtures/studio.fixture.js';
import { ChatPage } from '../pages/ChatPage.js';

test.describe('chat-turn', () => {
  test('sent message appears in history', async ({ studioPage }) => {
    const chatPage = new ChatPage(studioPage.page);

    const testMessage = 'hello from browser e2e test';
    await chatPage.sendMessage(testMessage);

    // The user message should appear in the history.
    const userMsgs = chatPage.userMessages();
    await expect(userMsgs.first()).toBeVisible();
    await expect(userMsgs.first()).toContainText(testMessage);
  });

  test('loading indicator is shown while waiting for reply', async ({ studioPage }) => {
    const chatPage = new ChatPage(studioPage.page);

    await chatPage.chatInput.fill('trigger streaming test');
    await chatPage.chatSubmit.click();

    // Either a streaming cursor or the send button becomes disabled during the turn.
    // The submit button should be disabled while the request is in flight.
    await expect(chatPage.chatSubmit).toBeDisabled();
  });

  test('reply appears after stub completes', async ({ studioPage }) => {
    const chatPage = new ChatPage(studioPage.page);

    await chatPage.sendMessage('what do you think?');
    await chatPage.waitForReply(60_000);

    const replyCount = await chatPage.getAssistantMessageCount();
    expect(replyCount).toBeGreaterThanOrEqual(1);
  });

  test('commit count increases by one after turn completes', async ({ studioPage }) => {
    const chatPage = new ChatPage(studioPage.page);

    const commitsBefore = await chatPage.getCommitCount();

    await chatPage.sendMessage('add a comment to the config file');
    await chatPage.waitForTurnComplete(60_000);

    const commitsAfter = await chatPage.getCommitCount();
    expect(commitsAfter).toBe(commitsBefore + 1);
  });
});
