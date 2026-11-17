import { describe, expect, it } from 'vitest';

import {
  ScoringError,
  scoreAttempt,
  type ScoredResult,
  type ScoringQuestion,
  type SubmittedAnswer,
} from './scoring';

/**
 * Phase 7, A2: the scoring function on its own. No database, no HTTP, no clock — every expected
 * value is worked out by hand in hundredths, so a drift in the function cannot hide behind the
 * function.
 */

function question(
  id: string,
  options: readonly string[] = ['a', 'b'],
  correctOptionId: string | null = options[0] ?? null,
  marks = '2',
  negativeMarks = '0.5',
): ScoringQuestion {
  return Object.freeze({
    id,
    questionType: 'MCQ',
    marks,
    negativeMarks,
    optionIds: Object.freeze([...options]),
    correctOptionId,
  });
}

function answer(questionId: string, chosenOptionId: string): SubmittedAnswer {
  return Object.freeze({ questionId, chosenOptionId });
}

/** A paper of `count` default questions with ids `q1..qN`. */
function paper(count: number): ScoringQuestion[] {
  return Array.from({ length: count }, (_unused, index) => question(`q${index + 1}`));
}

/** Answers for that paper: the first `correct` questions right, the rest wrong. */
function answersFor(count: number, correct: number): SubmittedAnswer[] {
  return Array.from({ length: count }, (_unused, index) =>
    answer(`q${index + 1}`, index < correct ? 'a' : 'b'),
  );
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScoringError);
    return (error as ScoringError).code;
  }
  throw new Error('expected the scoring function to refuse');
}

/** Every invariant the `results` table's CHECK constraints impose, asserted on the output. */
function expectInvariants(result: ScoredResult): void {
  expect(result.correctCount + result.wrongCount).toBe(result.attemptedCount);
  expect(result.attemptedCount + result.unattemptedCount).toBe(result.totalQuestions);
  expect(result.correctCount + result.wrongCount + result.unattemptedCount).toBe(result.totalQuestions);
  expect(result.score).toMatch(/^-?\d+\.\d{2}$/);
  expect(result.totalMarks).toMatch(/^\d+\.\d{2}$/);

  const accuracy = Number(result.accuracy);
  expect(accuracy).toBeGreaterThanOrEqual(0);
  expect(accuracy).toBeLessThanOrEqual(1);
  if (result.attemptedCount === 0) {
    expect(result.accuracy).toBe('0.0000');
  }
}

describe('phase 7 scoring', () => {
  describe('score and counts', () => {
    it('scores every correct answer', () => {
      const result = scoreAttempt(paper(3), answersFor(3, 3));

      expect(result).toEqual({
        score: '6.00',
        correctCount: 3,
        wrongCount: 0,
        unattemptedCount: 0,
        attemptedCount: 3,
        totalQuestions: 3,
        totalMarks: '6.00',
        accuracy: '1.0000',
      });
    });

    it('subtracts the negative marks of every wrong answer', () => {
      const result = scoreAttempt(paper(4), answersFor(4, 0));

      expect(result).toEqual({
        score: '-2.00',
        correctCount: 0,
        wrongCount: 4,
        unattemptedCount: 0,
        attemptedCount: 4,
        totalQuestions: 4,
        totalMarks: '8.00',
        accuracy: '0.0000',
      });
    });

    it('scores nothing when nothing was attempted', () => {
      const result = scoreAttempt(paper(3), []);

      expect(result).toEqual({
        score: '0.00',
        correctCount: 0,
        wrongCount: 0,
        unattemptedCount: 3,
        attemptedCount: 0,
        totalQuestions: 3,
        totalMarks: '6.00',
        accuracy: '0.0000',
      });
    });

    it('scores an empty version as zero', () => {
      const result = scoreAttempt([], []);

      expect(result).toEqual({
        score: '0.00',
        correctCount: 0,
        wrongCount: 0,
        unattemptedCount: 0,
        attemptedCount: 0,
        totalQuestions: 0,
        totalMarks: '0.00',
        accuracy: '0.0000',
      });
    });

    it('scores a mixed paper', () => {
      const result = scoreAttempt(paper(3), [answer('q1', 'a'), answer('q2', 'b')]);

      expect(result.score).toBe('1.50');
      expect(result.correctCount).toBe(1);
      expect(result.wrongCount).toBe(1);
      expect(result.unattemptedCount).toBe(1);
      expect(result.attemptedCount).toBe(2);
      expect(result.totalQuestions).toBe(3);
      expect(result.totalMarks).toBe('6.00');
      expect(result.accuracy).toBe('0.5000');
    });

    it('scores a single-question version', () => {
      const right = scoreAttempt([question('q1')], [answer('q1', 'a')]);
      expect(right.score).toBe('2.00');
      expect(right.accuracy).toBe('1.0000');

      const wrong = scoreAttempt([question('q1')], [answer('q1', 'b')]);
      expect(wrong.score).toBe('-0.50');
      expect(wrong.accuracy).toBe('0.0000');
    });
  });

  describe('exact arithmetic', () => {
    it('adds fractional marks and fractional negatives without drift', () => {
      const questions = Array.from({ length: 16 }, (_unused, index) =>
        question(`q${index + 1}`, ['a', 'b'], 'a', '0.25', '0.25'),
      );
      const answers = answersFor(16, 7);

      const result = scoreAttempt(questions, answers);

      // 7 × 0.25 = 1.75 earned, 9 × 0.25 = 2.25 lost.
      expect(result.score).toBe('-0.50');
      expect(result.totalMarks).toBe('4.00');
      expect(result.accuracy).toBe('0.4375');
      expectInvariants(result);
    });

    it('keeps tenths exact where binary floats drift', () => {
      const questions = [
        question('q1', ['a', 'b'], 'a', '0.10', '0.20'),
        question('q2', ['a', 'b'], 'a', '0.10', '0.20'),
        question('q3', ['a', 'b'], 'a', '0.10', '0.20'),
        question('q4', ['a', 'b'], 'a', '0.10', '0.20'),
      ];
      const answers = [
        answer('q1', 'a'),
        answer('q2', 'a'),
        answer('q3', 'a'),
        answer('q4', 'b'),
      ];

      // 0.30 earned, 0.20 lost: 0.1 + 0.2 in binary floats is not 0.30 or 0.10.
      expect(scoreAttempt(questions, answers).score).toBe('0.10');
    });

    it("uses each question's own marks and negative marks", () => {
      const questions = [
        question('q1', ['a', 'b'], 'a', '2', '0.5'),
        question('q2', ['a', 'b'], 'a', '0.5', '0.5'),
        question('q3', ['a', 'b'], 'a', '1.25', '0.25'),
      ];
      const answers = [answer('q1', 'a'), answer('q2', 'b')];

      const result = scoreAttempt(questions, answers);

      expect(result.score).toBe('1.50');
      expect(result.totalMarks).toBe('3.75');
      expect(result.attemptedCount).toBe(2);
      expect(result.accuracy).toBe('0.5000');
    });
  });

  describe('accuracy rounding', () => {
    it('rounds half up at the fourth decimal', () => {
      expect(scoreAttempt(paper(3), answersFor(3, 1)).accuracy).toBe('0.3333');
      expect(scoreAttempt(paper(3), answersFor(3, 2)).accuracy).toBe('0.6667');
      expect(scoreAttempt(paper(2), answersFor(2, 1)).accuracy).toBe('0.5000');
      expect(scoreAttempt(paper(6), answersFor(6, 1)).accuracy).toBe('0.1667');
      expect(scoreAttempt(paper(6), answersFor(6, 5)).accuracy).toBe('0.8333');
      expect(scoreAttempt(paper(1), answersFor(1, 1)).accuracy).toBe('1.0000');
    });

    it('never divides by zero', () => {
      expect(scoreAttempt(paper(2), []).accuracy).toBe('0.0000');
      expect(scoreAttempt([], []).accuracy).toBe('0.0000');
    });
  });

  describe('refusals', () => {
    it('refuses an answer for a question that is not in the paper', () => {
      expect(codeOf(() => scoreAttempt(paper(1), [answer('elsewhere', 'a')]))).toBe('UNKNOWN_QUESTION');
    });

    it('refuses two answers for the same question', () => {
      expect(codeOf(() => scoreAttempt(paper(1), [answer('q1', 'a'), answer('q1', 'b')]))).toBe(
        'DUPLICATE_ANSWER',
      );
    });

    it('refuses an option of another question', () => {
      expect(codeOf(() => scoreAttempt(paper(1), [answer('q1', 'elsewhere')]))).toBe('UNKNOWN_OPTION');
    });

    it('refuses a question that is not single-correct', () => {
      const numerical: ScoringQuestion = Object.freeze({
        id: 'n1',
        questionType: 'NUMERICAL',
        marks: '2',
        negativeMarks: '0',
        optionIds: Object.freeze([]),
        correctOptionId: null,
      });

      const code = codeOf(() => scoreAttempt([numerical], []));
      expect(code).toBe('NOT_SINGLE_CORRECT');
    });

    it('refuses a question with no single correct option', () => {
      expect(codeOf(() => scoreAttempt([question('q1', ['a', 'b'], null)], []))).toBe('NOT_SINGLE_CORRECT');
      expect(codeOf(() => scoreAttempt([question('q1', ['a', 'b'], 'c')], []))).toBe('NOT_SINGLE_CORRECT');
    });

    it('refuses a question that lists an option twice', () => {
      expect(codeOf(() => scoreAttempt([question('q1', ['a', 'a'])], []))).toBe('INVALID_QUESTION');
      expect(codeOf(() => scoreAttempt([question('q1'), question('q1')], []))).toBe('INVALID_QUESTION');
    });

    it('refuses negative, non-finite or over-precise marks', () => {
      expect(codeOf(() => scoreAttempt([question('q1', ['a'], 'a', '-1')], []))).toBe('INVALID_MARKS');
      expect(codeOf(() => scoreAttempt([question('q1', ['a'], 'a', '1.234')], []))).toBe('INVALID_MARKS');
      expect(codeOf(() => scoreAttempt([question('q1', ['a'], 'a', 'Infinity')], []))).toBe('INVALID_MARKS');
      expect(codeOf(() => scoreAttempt([question('q1', ['a'], 'a', '')], []))).toBe('INVALID_MARKS');
      expect(codeOf(() => scoreAttempt([question('q1', ['a'], 'a', '1', 'NaN')], []))).toBe('INVALID_MARKS');
    });

    it('names the question or option but never the answer key', () => {
      expect(() => scoreAttempt([question('q1', ['a', 'b'], 'a')], [answer('q1', 'elsewhere')])).toThrow(
        ScoringError,
      );

      try {
        scoreAttempt([question('q1', ['a', 'b'], 'a')], [answer('q1', 'elsewhere')]);
      } catch (error) {
        expect((error as ScoringError).message).toContain('q1');
        expect((error as ScoringError).message).toContain('elsewhere');
      }
    });
  });

  describe('purity', () => {
    it('leaves its inputs untouched', () => {
      const questions = Object.freeze(paper(2));
      const answers = Object.freeze([answer('q1', 'a')]);
      const before = JSON.stringify({ questions, answers });

      scoreAttempt(questions, answers);

      expect(JSON.stringify({ questions, answers })).toBe(before);
    });

    it('is deterministic', () => {
      const questions = paper(5);
      const answers = answersFor(5, 3);

      expect(scoreAttempt(questions, answers)).toEqual(scoreAttempt(questions, answers));
    });

    it('produces a result that satisfies every results-table invariant', () => {
      const scenarios: readonly [readonly ScoringQuestion[], readonly SubmittedAnswer[]][] = [
        [[], []],
        [paper(1), []],
        [paper(1), answersFor(1, 1)],
        [paper(3), answersFor(3, 0)],
        [paper(7), answersFor(7, 4)],
      ];

      for (const [questions, answers] of scenarios) {
        expectInvariants(scoreAttempt(questions, answers));
      }
    });
  });

  describe('generated versions', () => {
    /** A small deterministic PRNG (mulberry32), written here so no dependency is added. */
    function mulberry32(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    }

    function hundredthsText(value: bigint): string {
      const negative = value < 0n;
      const magnitude = negative ? -value : value;
      return `${negative ? '-' : ''}${(magnitude / 100n).toString()}.${(magnitude % 100n)
        .toString()
        .padStart(2, '0')}`;
    }

    const MARKS_CHOICES = [0n, 25n, 50n, 100n, 125n, 200n, 250n] as const;

    it('agrees with exact integer arithmetic over generated versions', () => {
      const random = mulberry32(20261108);

      for (let versionIndex = 0; versionIndex < 60; versionIndex += 1) {
        const questionCount = Math.floor(random() * 9);
        const questions: ScoringQuestion[] = [];
        const answers: SubmittedAnswer[] = [];

        let expectedScore = 0n;
        let expectedTotalMarks = 0n;
        let expectedCorrect = 0;
        let expectedWrong = 0;

        for (let index = 0; index < questionCount; index += 1) {
          const id = `v${versionIndex}-q${index}`;
          const marks = MARKS_CHOICES[Math.floor(random() * MARKS_CHOICES.length)] ?? 0n;
          const negativeMarks = MARKS_CHOICES[Math.floor(random() * MARKS_CHOICES.length)] ?? 0n;
          const options = [`${id}-a`, `${id}-b`, `${id}-c`];
          const correctOptionId = options[Math.floor(random() * options.length)] ?? `${id}-a`;

          questions.push(
            Object.freeze({
              id,
              questionType: 'MCQ',
              marks: hundredthsText(marks),
              negativeMarks: hundredthsText(negativeMarks),
              optionIds: Object.freeze(options),
              correctOptionId,
            }),
          );
          expectedTotalMarks += marks;

          const choice = random();
          if (choice < 0.5) {
            answers.push(answer(id, correctOptionId));
            expectedCorrect += 1;
            expectedScore += marks;
          } else if (choice < 0.8) {
            const wrongOption = options.find((option) => option !== correctOptionId) ?? `${id}-a`;
            answers.push(answer(id, wrongOption));
            expectedWrong += 1;
            expectedScore -= negativeMarks;
          }
        }

        const result = scoreAttempt(questions, answers);

        expect(result.score).toBe(hundredthsText(expectedScore));
        expect(result.totalMarks).toBe(hundredthsText(expectedTotalMarks));
        expect(result.correctCount).toBe(expectedCorrect);
        expect(result.wrongCount).toBe(expectedWrong);
        expect(result.attemptedCount).toBe(expectedCorrect + expectedWrong);
        expect(result.unattemptedCount).toBe(questionCount - expectedCorrect - expectedWrong);
        expect(result.totalQuestions).toBe(questionCount);
        expectInvariants(result);

        // Reordering the answers cannot change anything.
        expect(scoreAttempt(questions, [...answers].reverse())).toEqual(result);

        // A question answered twice is refused.
        const firstAnswer = answers[0];
        if (firstAnswer !== undefined) {
          expect(() => scoreAttempt(questions, [...answers, firstAnswer])).toThrow(ScoringError);
          expect(codeOf(() => scoreAttempt(questions, [...answers, firstAnswer]))).toBe('DUPLICATE_ANSWER');
        }
      }
    });
  });
});
