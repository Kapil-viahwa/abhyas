/**
 * Phase 7, A3a: the only two shapes an attempt may show of a paper.
 *
 * `paperQuestion` is the start response's projection: a whitelist, field by field, of exactly
 * what a student needs to answer — the stem, the options and the marks. It cannot carry
 * `is_correct`, `numerical_answer`, an explanation, a creator or a status, whatever the row it
 * is handed contains, because it reads only these fields. `reviewQuestion` is its post-end
 * counterpart and the only place an answer key or an explanation leaves the server.
 */

import { sanitizeStoredContent } from '../questions/sanitize';

export interface PaperOptionView {
  readonly id: string;
  readonly position: number;
  readonly optionHtml: string;
  readonly latex: string | null;
}

export interface PaperQuestionView {
  readonly questionId: string;
  readonly position: number;
  readonly questionType: string;
  readonly contentHtml: string;
  readonly latex: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly options: readonly PaperOptionView[];
}

export interface ReviewOptionView extends PaperOptionView {
  readonly isCorrect: boolean;
  readonly isChosen: boolean;
}

/** The post-end review: the key and the explanation, for the caller's own ended attempt only. */
export interface ReviewQuestionView {
  readonly questionId: string;
  readonly position: number;
  readonly questionType: string;
  readonly contentHtml: string;
  readonly explanationHtml: string | null;
  readonly latex: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly chosenOptionId: string | null;
  readonly correctOptionId: string | null;
  readonly options: readonly ReviewOptionView[];
}

export interface ProjectableOption {
  readonly id: string;
  readonly position: number;
  readonly optionHtml: string;
  readonly latex: string | null;
}

export interface ProjectableQuestionVersion {
  readonly questionType: string;
  readonly contentHtml: string;
  readonly latex: string | null;
  readonly marks: { toString(): string };
  readonly negativeMarks: { toString(): string };
}

/** Exactly the fields the start response may carry, and no others. */
export function paperQuestion(
  position: number,
  questionId: string,
  version: ProjectableQuestionVersion,
  options: readonly ProjectableOption[],
): PaperQuestionView {
  return {
    questionId,
    position,
    questionType: version.questionType,
    contentHtml: sanitizeStoredContent(version.contentHtml),
    latex: version.latex,
    marks: version.marks.toString(),
    negativeMarks: version.negativeMarks.toString(),
    options: options.map((option) => ({
      id: option.id,
      position: option.position,
      optionHtml: sanitizeStoredContent(option.optionHtml),
      latex: option.latex,
    })),
  };
}

export interface ReviewableOption extends ProjectableOption {
  readonly isCorrect: boolean;
}

export interface ReviewableQuestionVersion extends ProjectableQuestionVersion {
  readonly explanationHtml: string | null;
}

/** The post-end review: the one shape that may carry the key and the explanation. */
export function reviewQuestion(
  position: number,
  questionId: string,
  version: ReviewableQuestionVersion,
  options: readonly ReviewableOption[],
  chosenBy: (optionId: string) => boolean,
): ReviewQuestionView {
  const correct = options.find((option) => option.isCorrect)?.id ?? null;

  return {
    questionId,
    position,
    questionType: version.questionType,
    contentHtml: sanitizeStoredContent(version.contentHtml),
    explanationHtml: version.explanationHtml === null ? null : sanitizeStoredContent(version.explanationHtml),
    latex: version.latex,
    marks: version.marks.toString(),
    negativeMarks: version.negativeMarks.toString(),
    chosenOptionId: options.find((option) => chosenBy(option.id))?.id ?? null,
    correctOptionId: correct,
    options: options.map((option) => ({
      id: option.id,
      position: option.position,
      optionHtml: sanitizeStoredContent(option.optionHtml),
      latex: option.latex,
      isCorrect: option.isCorrect,
      isChosen: chosenBy(option.id),
    })),
  };
}
