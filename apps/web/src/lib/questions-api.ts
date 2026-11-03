/**
 * Server-side access to the question API. Nothing here runs in the browser: the access
 * token comes from an httpOnly cookie and the response is shaped for a page to render.
 */

import { apiCall } from './upstream';

export interface OptionView {
  readonly position: number;
  readonly optionHtml: string;
  readonly latex: string | null;
  readonly isCorrect: boolean;
  readonly imageId: string | null;
}

export interface VersionView {
  readonly version: number;
  readonly questionType: string;
  readonly language: string;
  readonly difficulty: string;
  readonly contentHtml: string;
  readonly explanationHtml: string | null;
  readonly latex: string | null;
  readonly numericalAnswer: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly publishedAt: string | null;
}

export interface QuestionView {
  readonly id: string;
  readonly examId: string;
  readonly subjectId: string;
  readonly topicId: string | null;
  readonly createdBy: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly updatedAt: string;
  readonly version: VersionView;
  readonly options: readonly OptionView[];
}

export interface QuestionListResult {
  readonly items: readonly QuestionView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

export interface QuestionFilters {
  readonly search?: string;
  readonly examId?: string;
  readonly subjectId?: string;
  readonly difficulty?: string;
  readonly status?: string;
  readonly language?: string;
  readonly page?: number;
}

function queryString(filters: QuestionFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && String(value) !== '') {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString();
  return suffix === '' ? '' : `?${suffix}`;
}

export async function listQuestions(accessToken: string, filters: QuestionFilters): Promise<QuestionListResult | null> {
  const result = await apiCall<QuestionListResult>(`/v1/questions${queryString(filters)}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 ? result.body : null;
}

export async function getQuestion(accessToken: string, id: string): Promise<QuestionView | null> {
  const result = await apiCall<QuestionView>(`/v1/questions/${encodeURIComponent(id)}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 ? result.body : null;
}

export interface CatalogOption {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly examId?: string;
  readonly subjectId?: string;
}

export interface CatalogChoices {
  readonly exams: readonly { id: string; name: string }[];
  readonly subjects: readonly { id: string; name: string; examId: string }[];
  readonly topics: readonly { id: string; name: string; subjectId: string }[];
}

interface CatalogTree {
  readonly categories: readonly {
    id: string;
    name: string;
    exams: readonly {
      id: string;
      name: string;
      subjects: readonly {
        id: string;
        name: string;
        topics: readonly { id: string; name: string }[];
      }[];
    }[];
  }[];
}

/** Flattens the catalog tree into the three pickers the editor needs. */
export async function catalogChoices(accessToken: string): Promise<CatalogChoices> {
  const result = await apiCall<CatalogTree>('/v1/catalog/tree', { method: 'GET', accessToken });

  if (result.status !== 200 || result.body === null) {
    return { exams: [], subjects: [], topics: [] };
  }

  const exams: { id: string; name: string }[] = [];
  const subjects: { id: string; name: string; examId: string }[] = [];
  const topics: { id: string; name: string; subjectId: string }[] = [];

  for (const category of result.body.categories) {
    for (const exam of category.exams) {
      exams.push({ id: exam.id, name: `${category.name} · ${exam.name}` });
      for (const subject of exam.subjects) {
        subjects.push({ id: subject.id, name: subject.name, examId: exam.id });
        for (const topic of subject.topics) {
          topics.push({ id: topic.id, name: topic.name, subjectId: subject.id });
        }
      }
    }
  }

  return { exams, subjects, topics };
}

/** The payload the browser form carries as JSON, validated again by the API. */
export interface QuestionDraftPayload {
  readonly examId: string;
  readonly subjectId: string;
  readonly topicId: string | null;
  readonly questionType: string;
  readonly language: string;
  readonly difficulty: string;
  readonly contentHtml: string;
  readonly explanationHtml: string | null;
  readonly latex: string | null;
  readonly numericalAnswer: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly options: readonly { optionHtml: string; latex: string | null; isCorrect: boolean; imageId: string | null }[];
}
