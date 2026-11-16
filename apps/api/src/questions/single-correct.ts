/**
 * What a test paper may contain: exactly the shape the attempt engine can score.
 *
 * The question bank also holds `NUMERICAL` questions, and they stay valid there for practice;
 * a *test* refuses them (decision 0077). The rule is defined here once and used at every place
 * that could put a question in front of a student — adding or replacing the paper's list,
 * submitting it and publishing it — so no path can carry an unscorable question into a frozen
 * version. The scoring function keeps its own refusal as defence in depth.
 */

export const SINGLE_CORRECT_QUESTION_TYPE = 'MCQ';

export const SINGLE_CORRECT_ERROR_CODE = 'question_not_single_correct';

/** The only option property the rule needs; a caller never has to hand over option bodies. */
export interface ScorableOption {
  readonly isCorrect: boolean;
}

export interface QuestionShape {
  readonly questionType: string;
  readonly options: readonly ScorableOption[];
}

export type NotSingleCorrectReason =
  | 'NOT_OPTION_BASED'
  | 'FEWER_THAN_TWO_OPTIONS'
  | 'NO_CORRECT_OPTION'
  | 'SEVERAL_CORRECT_OPTIONS';

/**
 * Why a question cannot be scored, or `null` when it can: an option-based single-answer
 * question with at least two options and exactly one marked correct.
 */
export function notSingleCorrectReason(question: QuestionShape): NotSingleCorrectReason | null {
  if (question.questionType !== SINGLE_CORRECT_QUESTION_TYPE) {
    return 'NOT_OPTION_BASED';
  }
  if (question.options.length < 2) {
    return 'FEWER_THAN_TWO_OPTIONS';
  }

  const correct = question.options.filter((option) => option.isCorrect).length;
  if (correct === 0) {
    return 'NO_CORRECT_OPTION';
  }
  if (correct > 1) {
    return 'SEVERAL_CORRECT_OPTIONS';
  }

  return null;
}

/** The clause a refusal uses. It never says which option is the correct one. */
export function notSingleCorrectSentence(reason: NotSingleCorrectReason): string {
  switch (reason) {
    case 'NOT_OPTION_BASED':
      return 'it is not a single-answer option question';
    case 'FEWER_THAN_TWO_OPTIONS':
      return 'it has fewer than two options';
    case 'NO_CORRECT_OPTION':
      return 'it has no correct option';
    case 'SEVERAL_CORRECT_OPTIONS':
      return 'it has more than one correct option';
  }
}

/** The sentence an editor reads, naming the paper position and the question but never the key. */
export function notSingleCorrectMessage(
  position: number,
  questionId: string,
  reason: NotSingleCorrectReason,
): string {
  return `Question ${String(position)} (${questionId}) cannot be scored: ${notSingleCorrectSentence(reason)}`;
}
