/**
 * Settings, the audit viewer and the dashboard counts, read from server code only.
 */

import { apiCall } from './upstream';

export interface SettingRow {
  readonly key: string;
  readonly valueType: string;
  readonly valueText: string | null;
  readonly valueInt: number | null;
  readonly valueBool: boolean | null;
  readonly minInt: number | null;
  readonly maxInt: number | null;
  readonly description: string | null;
  readonly updatedAt: string;
}

export interface DashboardCounts {
  readonly users: number;
  readonly editors: number;
  readonly administrators: number;
  readonly activeSessions: number;
  readonly categories: number;
  readonly exams: number;
}

export interface AuditRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly actorRole: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly ip: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface AuditPage {
  readonly items: readonly AuditRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

export interface AuditQuery {
  readonly actorId?: string;
  readonly action?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
}

function auditParams(query: AuditQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.actorId !== undefined && query.actorId !== '') {
    params.set('actorId', query.actorId);
  }
  if (query.action !== undefined && query.action !== '') {
    params.set('action', query.action);
  }
  if (query.from !== undefined && query.from !== '') {
    params.set('from', query.from);
  }
  if (query.to !== undefined && query.to !== '') {
    params.set('to', query.to);
  }
  if (query.page !== undefined && query.page > 1) {
    params.set('page', String(query.page));
  }
  return params;
}

export async function listSettings(accessToken: string): Promise<readonly SettingRow[]> {
  const result = await apiCall<{ settings: SettingRow[] }>('/v1/admin/settings', { method: 'GET', accessToken });
  return result.status === 200 && result.body !== null ? result.body.settings : [];
}

export function updateSetting(accessToken: string, key: string, value: string) {
  return apiCall<SettingRow>(`/v1/admin/settings/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    accessToken,
    body: { value },
  });
}

export async function dashboardCounts(accessToken: string): Promise<DashboardCounts | null> {
  const result = await apiCall<DashboardCounts>('/v1/admin/dashboard', { method: 'GET', accessToken });
  return result.status === 200 ? result.body : null;
}

export async function searchAudit(accessToken: string, query: AuditQuery): Promise<AuditPage> {
  const suffix = auditParams(query).toString();
  const result = await apiCall<AuditPage>(`/v1/admin/audit${suffix === '' ? '' : `?${suffix}`}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 && result.body !== null
    ? result.body
    : { items: [], total: 0, page: 1, pageSize: 25, pages: 1 };
}

/** The query string the CSV link carries, so the export matches what the page shows. */
export function auditExportPath(query: AuditQuery): string {
  const params = auditParams({ ...query, page: undefined }).toString();
  return `/api/admin/audit-export${params === '' ? '' : `?${params}`}`;
}

export function settingValue(setting: SettingRow): string {
  if (setting.valueType === 'integer') {
    return String(setting.valueInt ?? '');
  }
  if (setting.valueType === 'boolean') {
    return setting.valueBool === true ? 'true' : 'false';
  }
  return setting.valueText ?? '';
}
