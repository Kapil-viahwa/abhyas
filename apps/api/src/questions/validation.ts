import { BadRequestException } from '@nestjs/common';

import { parseUuid } from '../auth/validation';
import { ContentRejectedError, sanitizeLatex, sanitizeOptionalContent, sanitizeQuestionContent } from './sanitize';

export const MAX_OPTIONS = 6;
export const MIN_OPTIONS = 2;
export const QUESTION_TYPES = ['MCQ', 'NUMERICAL'] as const;
export const LANGUAGES = ['EN', 'HI'] as const;
export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export const QUESTION_STATUSES = ['DRAFT', 'PUBLISHED'] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type QuestionLanguage = (typeof LANGUAGES)[number];
export type QuestionDifficulty = (typeof DIFFICULTIES)[number];

export interface OptionInput {
  readonly optionHtml: string;
  readonly isCorrect: boolean;
  readonly imageId: string | null;
}

export interface QuestionInput {
  readonly examId: string;
  readonly subjectId: string;
  readonly topicId: string | null;
  readonly questionType: QuestionType;
  readonly language: QuestionLanguage;
  readonly difficulty: QuestionDifficulty;
  readonly contentHtml: string;
  readonly explanationHtml: string | null;
  readonly latex: string | null;
  readonly numericalAnswer: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly options: readonly OptionInput[];
}

export interface QuestionListQuery {
  readonly search: string | undefined;
  readonly examId: string | undefined;
  readonly subjectId: string | undefined;
  readonly topicId: string | undefined;
  readonly difficulty: QuestionDifficulty | undefined;
  readonly status: 'DRAFT' | 'PUBLISHED' | undefined;
  readonly language: QuestionLanguage | undefined;
  readonly createdBy: string | undefined;
  readonly page: number;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('A JSON object body is required');
  }
  return body as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new BadRequestException(`${field} is required`);
  }
  const upper = String(value).trim().toUpperCase() as T;
  if (!allowed.includes(upper)) {
    throw new BadRequestException(`${field} must be one of ${allowed.join(', ')}`);
  }
  return upper;
}

function content<T>(produce: () => T): T {
  try {
    return produce();
  } catch (error) {
    if (error instanceof ContentRejectedError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

function decimal(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const text = String(value).trim();
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(text)) {
    throw new BadRequestException(`${field} must be a number with up to two decimals`);
  }
  return text;
}

function parseOptions(value: unknown, questionType: QuestionType): OptionInput[] {
  if (questionType === 'NUMERICAL') {
    if (Array.isArray(value) && value.length > 0) {
      throw new BadRequestException('A numerical question takes no options');
    }
    return [];
  }

  if (!Array.isArray(value)) {
    throw new BadRequestException('options must be a list');
  }

  const options = value.map((entry, index) => {
    const record = asRecord(entry);
    return {
      optionHtml: content(() => sanitizeQuestionContent(record.optionHtml, `option ${index + 1}`)),
      isCorrect: record.isCorrect === true,
      imageId:
        record.imageId === undefined || record.imageId === null || record.imageId === ''
          ? null
          : parseUuid(String(record.imageId), 'image id'),
    } satisfies OptionInput;
  });

  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new BadRequestException(`An MCQ needs between ${MIN_OPTIONS} and ${MAX_OPTIONS} options`);
  }
  if (options.filter((option) => option.isCorrect).length !== 1) {
    throw new BadRequestException('An MCQ needs exactly one correct option');
  }

  return options;
}

export function parseQuestionBody(body: unknown): QuestionInput {
  const record = asRecord(body);
  const questionType = oneOf(record.questionType, QUESTION_TYPES, 'questionType');

  const numericalAnswerRaw = record.numericalAnswer;
  let numericalAnswer: string | null = null;
  if (questionType === 'NUMERICAL') {
    if (numericalAnswerRaw === undefined || numericalAnswerRaw === null || String(numericalAnswerRaw).trim() === '') {
      throw new BadRequestException('A numerical question needs numericalAnswer');
    }
    numericalAnswer = String(numericalAnswerRaw).trim();
    if (!/^-?[0-9]+(\.[0-9]{1,6})?$/.test(numericalAnswer)) {
      throw new BadRequestException('numericalAnswer must be a plain number');
    }
  }

  return {
    examId: parseUuid(String(record.examId ?? ''), 'exam id'),
    subjectId: parseUuid(String(record.subjectId ?? ''), 'subject id'),
    topicId:
      record.topicId === undefined || record.topicId === null || record.topicId === ''
        ? null
        : parseUuid(String(record.topicId), 'topic id'),
    questionType,
    language: oneOf(record.language, LANGUAGES, 'language', 'EN'),
    difficulty: oneOf(record.difficulty, DIFFICULTIES, 'difficulty', 'MEDIUM'),
    contentHtml: content(() => sanitizeQuestionContent(record.contentHtml, 'question text')),
    explanationHtml: content(() => sanitizeOptionalContent(record.explanationHtml, 'explanation')),
    latex: content(() => sanitizeLatex(record.latex)),
    numericalAnswer,
    marks: decimal(record.marks, 'marks', '1'),
    negativeMarks: decimal(record.negativeMarks, 'negativeMarks', '0'),
    options: parseOptions(record.options, questionType),
  };
}

function optionalString(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

export function parseQuestionQuery(query: Record<string, string | string[] | undefined>): QuestionListQuery {
  const pageRaw = optionalString(query.page);
  const page = pageRaw === undefined ? 1 : Number.parseInt(pageRaw, 10);

  return {
    search: optionalString(query.search),
    examId: optionalString(query.examId) === undefined ? undefined : parseUuid(String(optionalString(query.examId)), 'exam id'),
    subjectId:
      optionalString(query.subjectId) === undefined
        ? undefined
        : parseUuid(String(optionalString(query.subjectId)), 'subject id'),
    topicId:
      optionalString(query.topicId) === undefined
        ? undefined
        : parseUuid(String(optionalString(query.topicId)), 'topic id'),
    difficulty:
      optionalString(query.difficulty) === undefined
        ? undefined
        : oneOf(optionalString(query.difficulty), DIFFICULTIES, 'difficulty'),
    status: optionalString(query.status) === undefined ? undefined : oneOf(optionalString(query.status), QUESTION_STATUSES, 'status'),
    language:
      optionalString(query.language) === undefined ? undefined : oneOf(optionalString(query.language), LANGUAGES, 'language'),
    createdBy:
      optionalString(query.createdBy) === undefined
        ? undefined
        : parseUuid(String(optionalString(query.createdBy)), 'creator id'),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

export function parseImportFileBody(body: unknown): { dataBase64: string; fileName: string; zipBase64: string | null } {
  const record = asRecord(body);
  const dataBase64 = record.dataBase64;
  if (typeof dataBase64 !== 'string' || dataBase64.trim() === '') {
    throw new BadRequestException('dataBase64 is required');
  }

  const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
  if (!/\.(csv|xlsx)$/i.test(fileName)) {
    throw new BadRequestException('The file must be a .csv or .xlsx');
  }

  const zipRaw = record.zipBase64;
  if (zipRaw !== undefined && zipRaw !== null && zipRaw !== '' && typeof zipRaw !== 'string') {
    throw new BadRequestException('zipBase64 must be text');
  }

  return {
    dataBase64: dataBase64.trim(),
    fileName,
    zipBase64: typeof zipRaw === 'string' && zipRaw.trim() !== '' ? zipRaw.trim() : null,
  };
}
