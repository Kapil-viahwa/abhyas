/**
 * The administrator's coin tools, called from server code only.
 *
 * The pages and their route handlers hold an access token in an httpOnly cookie and never
 * expose it. Every function here therefore runs on the server, and the API checks
 * `coins.write` on each route whatever this tier believes about the person.
 */

import { apiCall } from './upstream';

export interface CoinRecipient {
  readonly id: string;
  readonly email: string | null;
  readonly mobile: string | null;
  readonly fullName: string;
  readonly status: string;
}

export interface CoinLedgerItem {
  readonly id: string;
  readonly type: string;
  readonly amount: number;
  readonly previousBalance: number;
  readonly newBalance: number;
  readonly createdAt: string;
}

export interface CoinLedgerPage {
  readonly items: readonly CoinLedgerItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly balance: number;
  readonly totalEarned: number;
  readonly totalSpent: number;
}

export interface BulkPreview {
  readonly matched: readonly CoinRecipient[];
  readonly unmatched: readonly string[];
  readonly amount: number;
  readonly totalCoins: number;
}

export interface BulkJobRow {
  readonly userId: string;
  readonly email: string | null;
  readonly status: string;
  readonly errorMessage: string | null;
}

export interface BulkJob {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly remark: string;
  readonly totalUsers: number;
  readonly creditedUsers: number;
  readonly failedUsers: number;
  readonly createdAt: string;
  readonly rows: readonly BulkJobRow[];
}

/** What a write may prove about the person making it. */
export interface CoinProof {
  readonly password?: string | undefined;
  readonly code?: string | undefined;
}

export const COIN_LEDGER_TYPES = [
  '',
  'SIGNUP_GRANT',
  'DAILY_REWARD',
  'ADMIN_CREDIT',
  'ADMIN_DEBIT',
  'ENROLLMENT',
] as const;

export const COIN_PAGE_SIZE = 20;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

/** The API's refusal code, so a screen can ask for a proof instead of showing an error. */
export function reauthRequired(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }

  return (body as { code?: unknown }).code === 'reauth_required';
}

function proofBody(proof: CoinProof): Record<string, string> | undefined {
  const body: Record<string, string> = {};

  if (proof.password !== undefined && proof.password !== '') {
    body.password = proof.password;
  }
  if (proof.code !== undefined && proof.code !== '') {
    body.code = proof.code;
  }

  return Object.keys(body).length === 0 ? undefined : body;
}

export async function searchCoinRecipients(accessToken: string, query: string): Promise<readonly CoinRecipient[]> {
  const result = await apiCall<CoinRecipient[]>(`/v1/admin/coins/recipients?q=${encodeURIComponent(query)}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 && result.body !== null ? result.body : [];
}

/** One account's ledger, or null when the API knows no such account. */
export async function coinLedger(
  accessToken: string,
  userId: string,
  query: { readonly type?: string; readonly page?: number },
): Promise<CoinLedgerPage | null> {
  const params = new URLSearchParams();

  if (query.type !== undefined && query.type !== '') {
    params.set('type', query.type);
  }
  if (query.page !== undefined && query.page > 1) {
    params.set('page', String(query.page));
  }
  params.set('pageSize', String(COIN_PAGE_SIZE));

  const result = await apiCall<CoinLedgerPage>(`/v1/admin/coins/${encodeURIComponent(userId)}/ledger?${params.toString()}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 ? result.body : null;
}

export function adjustCoins(
  accessToken: string,
  input: {
    readonly key: string;
    readonly userId: string;
    readonly amount: number;
    readonly remark: string;
    readonly proof: CoinProof;
    readonly clientIp?: string | undefined;
  },
) {
  const reauth = proofBody(input.proof);

  return apiCall<CoinLedgerItem>('/v1/admin/coins/adjust', {
    method: 'POST',
    accessToken,
    clientIp: input.clientIp,
    headers: { 'idempotency-key': input.key },
    body: {
      userId: input.userId,
      amount: input.amount,
      remark: input.remark,
      ...(reauth === undefined ? {} : { reauth }),
    },
  });
}

export function previewBulk(accessToken: string, input: { readonly identifiers: readonly string[]; readonly amount: number }) {
  return apiCall<BulkPreview>('/v1/admin/coins/bulk/preview', {
    method: 'POST',
    accessToken,
    body: { identifiers: [...input.identifiers], amount: input.amount },
  });
}

export function startBulk(
  accessToken: string,
  input: {
    readonly key: string;
    readonly userIds: readonly string[];
    readonly amount: number;
    readonly remark: string;
    readonly proof: CoinProof;
    readonly clientIp?: string | undefined;
  },
) {
  const reauth = proofBody(input.proof);

  return apiCall<{ id: string; totalUsers: number; totalCoins: number }>('/v1/admin/coins/bulk', {
    method: 'POST',
    accessToken,
    clientIp: input.clientIp,
    headers: { 'idempotency-key': input.key },
    body: {
      userIds: [...input.userIds],
      amount: input.amount,
      remark: input.remark,
      ...(reauth === undefined ? {} : { reauth }),
    },
  });
}

export async function bulkJob(accessToken: string, id: string): Promise<BulkJob | null> {
  const result = await apiCall<BulkJob>(`/v1/admin/coins/bulk/${encodeURIComponent(id)}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 ? result.body : null;
}

/** The web route that streams one account's ledger as CSV, keeping the session cookie. */
export function ledgerExportPath(userId: string, type: string): string {
  const params = new URLSearchParams({ kind: 'ledger', userId });

  if (type !== '') {
    params.set('type', type);
  }

  return `/api/admin/coins/download?${params.toString()}`;
}

/** The web route that streams one bulk job's report as CSV. */
export function bulkReportPath(id: string): string {
  return `/api/admin/coins/download?${new URLSearchParams({ kind: 'report', id }).toString()}`;
}
