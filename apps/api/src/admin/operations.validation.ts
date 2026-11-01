import { BadRequestException } from '@nestjs/common';

/**
 * Settings input. The row carries its own type and bounds; this module only has to read
 * the value as the type the row declares, and let the database refuse anything outside
 * the bounds it also carries.
 */

export type SettingValueType = 'string' | 'integer' | 'boolean';

export interface SettingPatch {
  readonly valueText?: string;
  readonly valueInt?: number;
  readonly valueBool?: boolean;
}

export function parseSettingPatch(body: unknown, valueType: string): SettingPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('A JSON object body is required');
  }

  const record = body as Record<string, unknown>;

  if (valueType === 'integer') {
    const raw = record.valueInt ?? record.value;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isInteger(value)) {
      throw new BadRequestException('Enter a whole number');
    }
    return { valueInt: value };
  }

  if (valueType === 'boolean') {
    const raw = record.valueBool ?? record.value;
    if (typeof raw === 'boolean') {
      return { valueBool: raw };
    }
    if (raw === 'true' || raw === 'on') {
      return { valueBool: true };
    }
    if (raw === 'false' || raw === 'off') {
      return { valueBool: false };
    }
    throw new BadRequestException('Choose true or false');
  }

  const raw = record.valueText ?? record.value;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestException('Enter a value');
  }
  return { valueText: raw.trim() };
}

export interface AuditQueryInput {
  readonly actorId?: string;
  readonly action?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly page: number;
  readonly pageSize: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const AUDIT_DEFAULT_PAGE_SIZE = 25;
export const AUDIT_MAX_PAGE_SIZE = 100;
export const AUDIT_MAX_EXPORT_ROWS = 5000;

function firstString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return '';
}

function parseDate(value: unknown, label: string): Date | undefined {
  const raw = firstString(value).trim();
  if (raw === '') {
    return undefined;
  }
  if (!DATE_PATTERN.test(raw)) {
    throw new BadRequestException(`${label} must be a date like 2026-01-31`);
  }

  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${label} must be a date like 2026-01-31`);
  }
  return parsed;
}

/** `/audit` filters. A malformed filter is a typo, so it is a 400 rather than a guess. */
export function parseAuditQuery(query: Record<string, unknown>): AuditQueryInput {
  const actor = firstString(query.actorId).trim();
  if (actor !== '' && !UUID_PATTERN.test(actor)) {
    throw new BadRequestException('Choose a valid actor');
  }

  const actionRaw = firstString(query.action).trim();
  if (actionRaw !== '' && !ACTION_PATTERN.test(actionRaw)) {
    throw new BadRequestException('Choose a valid action filter');
  }

  const pageRaw = Number.parseInt(firstString(query.page), 10);
  const pageSizeRaw = Number.parseInt(firstString(query.pageSize), 10);

  return {
    actorId: actor === '' ? undefined : actor,
    action: actionRaw === '' ? undefined : actionRaw,
    from: parseDate(query.from, 'From'),
    to: parseDate(query.to, 'To'),
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1,
    pageSize:
      Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
        ? Math.min(pageSizeRaw, AUDIT_MAX_PAGE_SIZE)
        : AUDIT_DEFAULT_PAGE_SIZE,
  };
}
