import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { readAttemptCounts, readAttemptState, seedStartedAttempt } from './attempts-fixture';
import { setCoinSetting } from './coin-settings';
import { publishSeededPaper, seedAuthor, seedBuilderFixture } from './tests-fixture';

/**
 * Phase 7, A3b: the REAL worker ends an expired attempt.
 *
 * The stack's worker registers the attempt-expiry sweep every 30 seconds and calls the API's
 * internal route, so this spec only has to leave an expired attempt behind and wait for the
 * database to say it happened. It never reads the attempt through a student-facing API — a lazy
 * read would finalise it and the test would pass for the wrong reason.
 *
 * The attempt is seeded in SQL with a deadline already in the past (the A1 triggers are disabled
 * for that one backdating transaction) and the grace window is pinned to 0, then restored. The
 * fixture uses unique names and emails for every run and leaves no student session behind.
 */

const marker = randomUUID().slice(0, 8);
const GRACE_SETTING = 'attempt_submit_grace_seconds';

test.describe('the attempt expiry sweeper in the worker', () => {
  test('finalises an expired attempt with source SWEEPER, not LAZY', async () => {
    test.setTimeout(180_000);

    setCoinSetting(GRACE_SETTING, 0);

    try {
      const author = seedAuthor(marker);
      const bank = seedBuilderFixture({
        editorId: author.authorId,
        marker,
        alphaText: `Sweeper alpha question ${marker}`,
        betaText: `Sweeper beta question ${marker}`,
      });
      const paper = publishSeededPaper({
        authorId: author.authorId,
        examId: bank.examId,
        questionIds: [bank.alphaQuestionId, bank.betaQuestionId],
        title: `Sweeper paper ${marker}`,
        durationMinutes: 45,
      });

      const attempt = seedStartedAttempt({
        testId: paper.testId,
        marker,
        email: `e2e-sweeper-${marker}@example.com`,
      });

      // Poll the database itself, with an explicit timeout, for the worker's sweep.
      await expect
        .poll(() => readAttemptState(attempt.attemptId), { timeout: 150_000, intervals: [2_000] })
        .toBe('AUTO_SUBMITTED|SWEEPER');

      const counts = readAttemptCounts(attempt.attemptId);
      expect(counts.enrollmentStatus).toBe('EXPIRED');
      expect(counts.resultScore).toBe('0');
      expect(counts.answers).toBe('0');
    } finally {
      setCoinSetting(GRACE_SETTING, 5);
    }
  });
});
