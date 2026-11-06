import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../lib/authenticated-write';
import {
  BULK_DRAFT_COOKIE,
  BULK_DRAFT_MAX_AGE_SECONDS,
  BULK_DRAFT_MAX_BYTES,
  BULK_IDENTIFIERS_MAX,
  parseIdentifiersCsv,
  serialiseBulkDraft,
} from '../../../../../lib/coin-bulk';
import { previewBulk } from '../../../../../lib/coins-api';
import { webConfig } from '../../../../../lib/config';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';
import { errorMessage } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * Reads the uploaded CSV, asks the API who it reaches, and keeps that preview in one
 * httpOnly cookie for the confirmation screen. Nothing is credited here.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const back = '/admin/coins/bulk';
  const amountText = stringField(guard.form, 'amount').trim();
  const remark = stringField(guard.form, 'remark').trim();
  const file = guard.form.get('csv');

  if (!(file instanceof File) || file.size === 0) {
    return errorRedirect(back, 'Choose a CSV file to preview.');
  }

  if (!/^\d{1,7}$/.test(amountText) || Number.parseInt(amountText, 10) < 1) {
    return errorRedirect(back, 'Coins per account must be a whole number above zero.');
  }

  const identifiers = parseIdentifiersCsv(await file.text());

  if (identifiers.length === 0) {
    return errorRedirect(back, 'The first column of the CSV holds no email address or mobile number.');
  }

  if (identifiers.length > BULK_IDENTIFIERS_MAX) {
    return errorRedirect(back, `A preview reads at most ${String(BULK_IDENTIFIERS_MAX)} rows; split the file.`);
  }

  const amount = Number.parseInt(amountText, 10);
  const outcome = await callWithSession(request, (accessToken) => previewBulk(accessToken, { identifiers, amount }));

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  if (outcome.result.status !== 200 || outcome.result.body === null) {
    const response = errorRedirect(back, errorMessage(outcome.result.body));

    if (outcome.tokens !== undefined) {
      setSessionCookies(response, outcome.tokens);
    }

    return response;
  }

  const preview = outcome.result.body;
  const value = serialiseBulkDraft({
    amount: preview.amount,
    remark,
    matched: preview.matched.map((person) => ({ id: person.id, label: person.email ?? person.mobile ?? person.fullName })),
    unmatched: [...preview.unmatched],
    totalCoins: preview.totalCoins,
    createdAt: Date.now(),
  });

  if (value.length > BULK_DRAFT_MAX_BYTES) {
    return errorRedirect(back, 'That preview is too large for one confirmation; split the CSV into smaller files.');
  }

  const response = redirectTo(`${back}?preview=1`);

  response.cookies.set({
    name: BULK_DRAFT_COOKIE,
    value,
    httpOnly: true,
    sameSite: 'lax',
    secure: webConfig().nodeEnv === 'production',
    path: '/',
    maxAge: BULK_DRAFT_MAX_AGE_SECONDS,
  });

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
