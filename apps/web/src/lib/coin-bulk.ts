/**
 * A bulk assignment's draft: the preview an Administrator is about to confirm.
 *
 * It lives in one short-lived httpOnly cookie, and it is convenience, not authority. The
 * confirm step posts to the API, which re-reads every account, re-checks the caps and moves
 * the coins itself. A draft that is stale, malformed or too large is refused here, and the
 * API would refuse a bad amount or an unknown account either way.
 */

import { cookies } from 'next/headers';

export const BULK_DRAFT_COOKIE = 'abhyas_coin_bulk';
export const BULK_DRAFT_MAX_AGE_SECONDS = 15 * 60;
/** Comfortably below the 4 KB a browser keeps for one cookie, with room for the other two. */
export const BULK_DRAFT_MAX_BYTES = 3_500;
export const BULK_IDENTIFIERS_MAX = 500;

export interface BulkDraftRow {
  readonly id: string;
  readonly label: string;
}

export interface BulkDraft {
  readonly amount: number;
  readonly remark: string;
  readonly matched: readonly BulkDraftRow[];
  readonly unmatched: readonly string[];
  readonly totalCoins: number;
  readonly createdAt: number;
}

/**
 * The first column of each line, a header skipped, blanks dropped and repeats collapsed.
 * One address, one grant, whatever case it was typed in.
 */
export function parseIdentifiersCsv(text: string): string[] {
  const seen = new Set<string>();
  const identifiers: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === '') {
      continue;
    }

    const first = line.split(',')[0]?.trim().replace(/^"|"$/g, '') ?? '';

    if (first === '') {
      continue;
    }

    if (identifiers.length === 0 && /^(e-?mail|identifier|mobile|phone|address)$/i.test(first)) {
      continue;
    }

    const key = first.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    identifiers.push(first);
  }

  return identifiers;
}

export function serialiseBulkDraft(draft: BulkDraft): string {
  return encodeURIComponent(JSON.stringify(draft));
}

export function parseBulkDraft(raw: string | undefined): BulkDraft | null {
  if (raw === undefined || raw === '') {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Partial<BulkDraft>;

  if (
    typeof candidate.amount !== 'number' ||
    typeof candidate.remark !== 'string' ||
    typeof candidate.totalCoins !== 'number' ||
    typeof candidate.createdAt !== 'number' ||
    !Array.isArray(candidate.matched) ||
    !Array.isArray(candidate.unmatched)
  ) {
    return null;
  }

  const matched = candidate.matched.filter(
    (row): row is BulkDraftRow =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as BulkDraftRow).id === 'string' &&
      typeof (row as BulkDraftRow).label === 'string',
  );
  const unmatched = candidate.unmatched.filter((entry): entry is string => typeof entry === 'string');

  if (matched.length === 0 || matched.length !== candidate.matched.length || unmatched.length !== candidate.unmatched.length) {
    return null;
  }

  return {
    amount: candidate.amount,
    remark: candidate.remark,
    matched,
    unmatched,
    totalCoins: candidate.totalCoins,
    createdAt: candidate.createdAt,
  };
}

export function draftExpired(draft: BulkDraft, now: number = Date.now()): boolean {
  return now - draft.createdAt > BULK_DRAFT_MAX_AGE_SECONDS * 1000;
}

/** The draft this browser is holding, if it still parses and has not expired. */
export async function readBulkDraft(): Promise<BulkDraft | null> {
  const store = await cookies();
  const draft = parseBulkDraft(store.get(BULK_DRAFT_COOKIE)?.value);

  return draft !== null && !draftExpired(draft) ? draft : null;
}
