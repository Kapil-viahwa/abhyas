import { describe, expect, it } from 'vitest';

import {
  notSingleCorrectMessage,
  notSingleCorrectReason,
  notSingleCorrectSentence,
  type NotSingleCorrectReason,
} from './single-correct';

/**
 * The one definition of what a paper may contain (decision 0077). The builder's three paths
 * call it; this file pins the four reasons and the words, and that no word names a correct
 * option.
 */

describe('the single-correct rule', () => {
  it('accepts an option-based question with exactly one correct option', () => {
    expect(
      notSingleCorrectReason({ questionType: 'MCQ', options: [{ isCorrect: false }, { isCorrect: true }] }),
    ).toBeNull();
    expect(
      notSingleCorrectReason({
        questionType: 'MCQ',
        options: [{ isCorrect: true }, { isCorrect: false }, { isCorrect: false }],
      }),
    ).toBeNull();
  });

  it('refuses a question that is not option-based', () => {
    expect(notSingleCorrectReason({ questionType: 'NUMERICAL', options: [] })).toBe('NOT_OPTION_BASED');
  });

  it('refuses an option-based question with fewer than two options', () => {
    expect(notSingleCorrectReason({ questionType: 'MCQ', options: [{ isCorrect: true }] })).toBe(
      'FEWER_THAN_TWO_OPTIONS',
    );
    expect(notSingleCorrectReason({ questionType: 'MCQ', options: [] })).toBe('FEWER_THAN_TWO_OPTIONS');
  });

  it('refuses an option-based question with no correct option', () => {
    expect(
      notSingleCorrectReason({ questionType: 'MCQ', options: [{ isCorrect: false }, { isCorrect: false }] }),
    ).toBe('NO_CORRECT_OPTION');
  });

  it('refuses an option-based question with several correct options', () => {
    expect(
      notSingleCorrectReason({ questionType: 'MCQ', options: [{ isCorrect: true }, { isCorrect: true }] }),
    ).toBe('SEVERAL_CORRECT_OPTIONS');
  });

  it('names the position and the question but never an option', () => {
    const reasons: readonly NotSingleCorrectReason[] = [
      'NOT_OPTION_BASED',
      'FEWER_THAN_TWO_OPTIONS',
      'NO_CORRECT_OPTION',
      'SEVERAL_CORRECT_OPTIONS',
    ];
    const questionId = '6d1f2a34-0b7c-4a9e-8f10-2b3c4d5e6f70';

    for (const reason of reasons) {
      const message = notSingleCorrectMessage(3, questionId, reason);

      expect(message.startsWith(`Question 3 (${questionId}) cannot be scored: `)).toBe(true);
      expect(message).toContain(notSingleCorrectSentence(reason));
      expect(message).not.toMatch(/option [0-9]/);
      expect(message).not.toContain('isCorrect');
    }
  });

  it('gives every reason its own sentence', () => {
    const sentences = new Set([
      notSingleCorrectSentence('NOT_OPTION_BASED'),
      notSingleCorrectSentence('FEWER_THAN_TWO_OPTIONS'),
      notSingleCorrectSentence('NO_CORRECT_OPTION'),
      notSingleCorrectSentence('SEVERAL_CORRECT_OPTIONS'),
    ]);

    expect(sentences.size).toBe(4);
  });
});
