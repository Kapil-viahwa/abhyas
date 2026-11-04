/**
 * The admin's view of the API, called from server components and route handlers only.
 *
 * Nothing here is reachable from the browser: these functions take an access token
 * that lives in an httpOnly cookie, and return plain data for a page or a redirect.
 */

import { apiCall } from './upstream';

export interface EditorFlags {
  readonly manage_questions: boolean;
  readonly manage_tests: boolean;
  readonly publish_tests: boolean;
}

export interface UserSummary {
  readonly id: string;
  /** Null for an account created with a mobile number that has not linked an email yet. */
  readonly email: string | null;
  readonly fullName: string;
  readonly roleCode: string;
  readonly status: string;
  readonly emailVerifiedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly editorFlags: EditorFlags;
}

export interface UserDetail extends UserSummary {
  readonly activeSessions: number;
}

export interface UserList {
  readonly items: readonly UserSummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

export interface UserListQuery {
  readonly search?: string;
  readonly role?: string;
  readonly status?: string;
  readonly page?: number;
}

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DISABLED'] as const;
export const USER_ROLES = ['ADMIN', 'EDITOR', 'USER'] as const;

const EMPTY_LIST: UserList = { items: [], total: 0, page: 1, pageSize: 20, pages: 1 };

export async function listUsers(accessToken: string, query: UserListQuery): Promise<UserList> {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') {
    params.set('search', query.search);
  }
  if (query.role !== undefined && query.role !== '') {
    params.set('role', query.role);
  }
  if (query.status !== undefined && query.status !== '') {
    params.set('status', query.status);
  }
  if (query.page !== undefined && query.page > 1) {
    params.set('page', String(query.page));
  }

  const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
  const result = await apiCall<UserList>(`/v1/admin/users${suffix}`, { method: 'GET', accessToken });

  return result.status === 200 && result.body !== null ? result.body : EMPTY_LIST;
}

export async function getUser(accessToken: string, id: string): Promise<UserDetail | null> {
  const result = await apiCall<UserDetail>(`/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 ? result.body : null;
}

export interface CreateEditorInput {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
  readonly flags: EditorFlags;
}

export function createEditor(accessToken: string, clientIp: string | undefined, input: CreateEditorInput) {
  return apiCall<UserDetail>('/v1/admin/users/editors', {
    method: 'POST',
    accessToken,
    clientIp,
    body: {
      email: input.email,
      fullName: input.fullName,
      password: input.password,
      manage_questions: input.flags.manage_questions,
      manage_tests: input.flags.manage_tests,
      publish_tests: input.flags.publish_tests,
    },
  });
}

export function updateEditorFlags(
  accessToken: string,
  id: string,
  flags: EditorFlags,
  clientIp: string | undefined,
) {
  return apiCall<UserDetail>(`/v1/admin/users/${encodeURIComponent(id)}/editor-flags`, {
    method: 'PATCH',
    accessToken,
    clientIp,
    body: {
      manage_questions: flags.manage_questions,
      manage_tests: flags.manage_tests,
      publish_tests: flags.publish_tests,
    },
  });
}

export function changeUserStatus(accessToken: string, id: string, status: string, clientIp: string | undefined) {
  return apiCall<UserDetail>(`/v1/admin/users/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    accessToken,
    clientIp,
    body: { status },
  });
}

export function changeUserRole(accessToken: string, id: string, roleCode: string, clientIp: string | undefined) {
  return apiCall<{ userId: string; roleCode: string; sessionsRevoked: number }>(
    `/v1/admin/users/${encodeURIComponent(id)}/role`,
    {
      method: 'PATCH',
      accessToken,
      clientIp,
      body: { roleCode },
    },
  );
}

/** The codes an editor's ticked flags represent, for showing what a person can do. */
export function flagLabels(flags: EditorFlags): readonly string[] {
  const labels: string[] = [];
  if (flags.manage_questions) {
    labels.push('Questions');
  }
  if (flags.manage_tests) {
    labels.push('Tests');
  }
  if (flags.publish_tests) {
    labels.push('Publish');
  }
  return labels;
}
