import { BadRequestException } from '@nestjs/common';

import { parseUuid } from '../auth/validation';
import { MAX_QUESTIONS_PER_PAPER } from '../tests/validation';

/**
 * Phase 7, A3a: the attempt routes take no `userId` and no field they do not read.
 *
 * The account is the session's, so a `userId` in a body, a query or a path is refused by name
 * rather than ignored (the same rule the enrollment routes follow). The submit body is bounded
 * by the paper's own maximum and refuses a question answered twice before the service ever
 * sees it.
 */

export interface SubmitAnswerInput {
  readonly questionId: string;
  readonly chosenOptionId: string;
}

const START_FIELDS: readonly string[] = [];
const SUBMIT_FIELDS = ['answers'] as const;
const ANSWER_FIELDS = ['questionId', 'chosenOptionId'] as const;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('A JSON object body is required');
  }
  return body as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (key === 'userId') {
      throw new BadRequestException('userId is never accepted: the account comes from your session');
    }
    if (!allowed.includes(key)) {
      throw new BadRequestException(`${key} is not a field this endpoint accepts`);
    }
  }
}

/** No query parameter is read, and a `userId` is named rather than answered generically. */
export function parseAttemptQuery(query: Record<string, string | string[] | undefined>): void {
  for (const key of Object.keys(query)) {
    if (key === 'userId') {
      throw new BadRequestException('userId is never accepted: the account comes from your session');
    }
    throw new BadRequestException(`${key} is not a query parameter this endpoint accepts`);
  }
}

/** Starting takes no body at all; a `userId` or any field is refused. */
export function parseAttemptStartBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  const record = asRecord(body);
  rejectUnknown(record, START_FIELDS);
  if (Object.keys(record).length > 0) {
    throw new BadRequestException('Starting an attempt takes no body');
  }
}

export function parseSubmitBody(body: unknown): SubmitAnswerInput[] {
  const record = asRecord(body);
  rejectUnknown(record, SUBMIT_FIELDS);

  const value = record.answers;
  if (!Array.isArray(value)) {
    throw new BadRequestException('answers must be a list');
  }
  if (value.length > MAX_QUESTIONS_PER_PAPER) {
    throw new BadRequestException(`answers carries at most ${String(MAX_QUESTIONS_PER_PAPER)} entries`);
  }

  const answers = value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestException('Each answer must be an object');
    }
    const recordEntry = entry as Record<string, unknown>;
    for (const key of Object.keys(recordEntry)) {
      if (!ANSWER_FIELDS.includes(key as (typeof ANSWER_FIELDS)[number])) {
        throw new BadRequestException(`${key} is not a field an answer accepts`);
      }
    }

    return {
      questionId: parseUuid(recordEntry.questionId, 'question id'),
      chosenOptionId: parseUuid(recordEntry.chosenOptionId, 'option id'),
    };
  });

  if (new Set(answers.map((answer) => answer.questionId)).size !== answers.length) {
    throw new BadRequestException({ code: 'duplicate_answer', message: 'A question can be answered only once' });
  }

  return answers;
}
