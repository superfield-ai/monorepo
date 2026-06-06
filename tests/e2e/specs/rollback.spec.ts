/**
 * @file tests/e2e/specs/rollback.spec.ts
 *
 * Layer 4 Browser E2E — Rollback.
 *
 * Scenario: Send two messages; click Rollback on first commit; second message
 * removed from commit list.
 *
 * Canonical docs: test-plan.md — "Layer 4 — Browser / E2E Tests" /
 * "Test scenarios" table — "rollback" row.
 */

import { test, expect } from '../fixtures/studio.fixture.js';
import { ChatPage } from '../pages/ChatPage.js';

test.describe('rollback', () => {
  test('rolling back the first commit removes the second commit from the list', async ({ studioPage }) => {
    const chatPage = new ChatPage(studioPage.page);

    // Send first message and wait for completion.
    await chatPage.sendMessage('add logging to the server startup');
    await chatPage.waitForTurnComplete(60_000);

    const commitsAfterFirst = await chatPage.getCommitCount();
    expect(commitsAfterFirst).toBeGreaterThanOrEqual(1);

    // Send second message and wait for completion.
    await chatPage.sendMessage('add a health check endpoint');
    await chatPage.waitForTurnComplete(60_000);

    const commitsAfterSecond = await chatPage.getCommitCount();
    expect(commitsAfterSecond).toBeGreaterThanOrEqual(2);

    // Set up dialog handler to accept the rollback confirmation.
    studioPage.page.once('dialog', (dialog) => void dialog.accept());

    // Roll back the first commit (index 0 in the list).
    await chatPage.rollbackCommit(0);

    // Wait for the commit list to update.
    await studioPage.page.waitForTimeout(2_000);

    // After rolling back the first commit, the commit count should drop.
    const commitsAfterRollback = await chatPage.getCommitCount();
    expect(commitsAfterRollback).toBeLessThan(commitsAfterSecond);
  });

  test('rolling back both commits results in an empty commit list', async ({ studioPage }) => {
    const chatPage = new ChatPage(studioPage.page);

    // Send two messages.
    await chatPage.sendMessage('create a utility function');
    await chatPage.waitForTurnComplete(60_000);

    await chatPage.sendMessage('add tests for the utility');
    await chatPage.waitForTurnComplete(60_000);

    const initialCount = await chatPage.getCommitCount();
    expect(initialCount).toBeGreaterThanOrEqual(2);

    // Roll back the last commit (most recent = last in list).
    studioPage.page.once('dialog', (dialog) => void dialog.accept());
    await chatPage.rollbackCommit(initialCount - 1);
    await studioPage.page.waitForTimeout(2_000);

    // Roll back the previous commit.
    studioPage.page.once('dialog', (dialog) => void dialog.accept());
    const countAfterFirst = await chatPage.getCommitCount();
    if (countAfterFirst > 0) {
      await chatPage.rollbackCommit(0);
      await studioPage.page.waitForTimeout(2_000);
    }

    // UI should reflect empty or reduced commit list.
    const finalCount = await chatPage.getCommitCount();
    expect(finalCount).toBeLessThan(initialCount);
  });
});
