/**
 * Phase 7, A2 — scoring, and the only place in the codebase that turns answers into marks.
 *
 * A pure function of a frozen version's questions and the answers a student submitted: no
 * database, no Prisma, no clock, no randomness, no I/O. The caller reads the correct option from
 * the database and hands it in; this function never reads a key itself.
 *
 * Arithmetic is exact. Every marks value is carried in hundredths as a bigint, because the
 * columns are `NUMERIC(6, 2)` (marks) and a binary float cannot hold a 0.25 negative marking
 * without drift once a paper is long enough (decision 0076). Values leave the function as
 * strings in the form Prisma's `Decimal` columns take, so inserting the output cannot trip a
 * CHECK on the way in.
 */

/** The only question type this function scores. A `NUMERICAL` question is refused (0075/0076). */
const SINGLE_CORRECT_TYPE = 'MCQ';

/** A non-negative decimal with at most two places, in Prisma's decimal string form. */
const MARKS_PATTERN = /^\d{1,4}(?:\.\d{1,2})?$/;

const HUNDREDTHS = 100n;
const MARKS_DECIMALS = 2;

/** `results.accuracy` is `NUMERIC(6, 4)`: four places, rounded half up (decision 0076). */
const ACCURACY_SCALE = 10_000n;
const ACCURACY_DECIMALS = 4;

export type ScoringErrorCode =
  | 'UNKNOWN_QUESTION'
  | 'DUPLICATE_ANSWER'
  | 'UNKNOWN_OPTION'
  | 'NOT_SINGLE_CORRECT'
  | 'INVALID_MARKS'
  | 'INVALID_QUESTION';

/**
 * A refusal carries a stable code and a message that names ids only — never which option is
 * correct. Refusal beats ignoring: an answer for a question outside the paper, a duplicate, a
 * foreign option or an unscorable question means tampering or a builder bug, and silently
 * scoring around it would hide both.
 */
export class ScoringError extends Error {
  readonly code: ScoringErrorCode;

  constructor(code: ScoringErrorCode, message: string) {
    super(message);
    this.name = 'ScoringError';
    this.code = code;
  }
}

/**
 * One question of the frozen version, as plain data. The caller passes the version's marks for
 * the question (`marks_per_question`), so a paper with per-question marks works unchanged.
 */
export interface ScoringQuestion {
  readonly id: string;
  readonly questionType: string;
  /** The marks a correct answer earns, a non-negative decimal with up to two places. */
  readonly marks: string;
  /** The marks a wrong answer loses, a non-negative decimal with up to two places. */
  readonly negativeMarks: string;
  readonly optionIds: readonly string[];
  /** The single correct option, loaded by the caller; `null` when the question has none. */
  readonly correctOptionId: string | null;
}

/** One answer the student submitted. A question with no row here is unattempted. */
export interface SubmittedAnswer {
  readonly questionId: string;
  readonly chosenOptionId: string;
}

/** Exactly the columns `results` needs, in Prisma's field names. */
export interface ScoredResult {
  readonly score: string;
  readonly correctCount: number;
  readonly wrongCount: number;
  readonly unattemptedCount: number;
  readonly attemptedCount: number;
  readonly totalQuestions: number;
  readonly totalMarks: string;
  readonly accuracy: string;
}

interface ScorableQuestion {
  readonly marks: bigint;
  readonly negativeMarks: bigint;
  readonly optionIds: ReadonlySet<string>;
  readonly correctOptionId: string;
}

function parseMarks(value: string, field: string): bigint {
  const text = value.trim();
  if (!MARKS_PATTERN.test(text)) {
    throw new ScoringError('INVALID_MARKS', `${field} must be a non-negative number with up to two decimals`);
  }

  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * HUNDREDTHS + BigInt(fraction.padEnd(MARKS_DECIMALS, '0'));
}

function formatScaled(value: bigint, scale: bigint, decimals: number): string {
  const negative = value < 0n;
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  return `${negative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(decimals, '0')}`;
}

function formatHundredths(value: bigint): string {
  return formatScaled(value, HUNDREDTHS, MARKS_DECIMALS);
}

/**
 * `correct / attempted` at four places, rounded half up, in exact integer arithmetic:
 * `floor((2 × correct × 10000 + attempted) / (2 × attempted))`. Zero attempted is zero, never a
 * division error.
 */
function formatAccuracy(correct: number, attempted: number): string {
  if (attempted === 0) {
    return formatScaled(0n, ACCURACY_SCALE, ACCURACY_DECIMALS);
  }

  const scaled = (BigInt(correct) * ACCURACY_SCALE * 2n + BigInt(attempted)) / (2n * BigInt(attempted));
  return formatScaled(scaled, ACCURACY_SCALE, ACCURACY_DECIMALS);
}

/**
 * Scores a submitted set of answers against the frozen version.
 *
 * A correct choice earns that question's marks, a wrong choice loses that question's negative
 * marks, and an unattempted question scores zero. The score is not floored at zero: a paper the
 * student did badly on can score below it (assumed, owner to confirm, decision 0076).
 */
export function scoreAttempt(
  questions: readonly ScoringQuestion[],
  answers: readonly SubmittedAnswer[],
): ScoredResult {
  const byId = new Map<string, ScorableQuestion>();
  let totalMarks = 0n;

  for (const question of questions) {
    if (byId.has(question.id)) {
      throw new ScoringError('INVALID_QUESTION', `question ${question.id} appears twice in the version`);
    }
    if (question.questionType !== SINGLE_CORRECT_TYPE) {
      throw new ScoringError(
        'NOT_SINGLE_CORRECT',
        `question ${question.id} is not single-correct and cannot be scored`,
      );
    }

    const marks = parseMarks(question.marks, 'marks');
    const negativeMarks = parseMarks(question.negativeMarks, 'negativeMarks');
    const optionIds = new Set(question.optionIds);

    if (optionIds.size !== question.optionIds.length) {
      throw new ScoringError('INVALID_QUESTION', `question ${question.id} lists an option twice`);
    }
    if (question.correctOptionId === null || !optionIds.has(question.correctOptionId)) {
      throw new ScoringError('NOT_SINGLE_CORRECT', `question ${question.id} has no single correct option`);
    }

    byId.set(question.id, {
      marks,
      negativeMarks,
      optionIds,
      correctOptionId: question.correctOptionId,
    });
    totalMarks += marks;
  }

  const answered = new Set<string>();
  let score = 0n;
  let correct = 0;
  let wrong = 0;

  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (question === undefined) {
      throw new ScoringError('UNKNOWN_QUESTION', `question ${answer.questionId} is not in this paper`);
    }
    if (answered.has(answer.questionId)) {
      throw new ScoringError('DUPLICATE_ANSWER', `question ${answer.questionId} is answered twice`);
    }
    answered.add(answer.questionId);

    if (!question.optionIds.has(answer.chosenOptionId)) {
      throw new ScoringError(
        'UNKNOWN_OPTION',
        `option ${answer.chosenOptionId} is not an option of question ${answer.questionId}`,
      );
    }

    if (answer.chosenOptionId === question.correctOptionId) {
      correct += 1;
      score += question.marks;
    } else {
      wrong += 1;
      score -= question.negativeMarks;
    }
  }

  const attempted = correct + wrong;

  return {
    score: formatHundredths(score),
    correctCount: correct,
    wrongCount: wrong,
    unattemptedCount: questions.length - attempted,
    attemptedCount: attempted,
    totalQuestions: questions.length,
    totalMarks: formatHundredths(totalMarks),
    accuracy: formatAccuracy(correct, attempted),
  };
}
