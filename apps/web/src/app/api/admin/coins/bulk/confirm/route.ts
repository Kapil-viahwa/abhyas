import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../../lib/authenticated-write';
import { BULK_DRAFT_COOKIE, draftExpired, parseBulkDraft } from '../../../../../../lib/coin-bulk';
import { isUuid, reauthRequired, startBulk } from '../../../../../../lib/coins-api';
import { webConfig } from '../../../../../../lib/config';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../../lib/route-handler';
import { clearSessionCookies, cookieFromRequest, setSessionCookies } from '../../../../../../lib/session';
import { clientIpFrom, errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

function clearDraft(response: NextResponse): void {
  response.cookies.set({
    name: BULK_DRAFT_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: webConfig().nodeEnv === 'production',
    path: '/',
    maxAge: 0,
  });
}

/**
 * Confirms the preview in this browser's draft: the API creates one job from the matched
 * accounts. The Idempotency-Key comes from the preview screen, so confirming twice is one job.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const back = '/admin/coins/bulk';
  const key = stringField(guard.form, 'idempotencyKey').trim();
  const password = stringField(guard.form, 'password');
  const code = stringField(guard.form, 'code').trim();

  const draft = parseBulkDraft(cookieFromRequest(request, BULK_DRAFT_COOKIE));

  if (draft === null || draftExpired(draft)) {
    const response = errorRedirect(back, 'That preview expired. Upload the CSV again.');
    clearDraft(response);
    return response;
  }

  if (!isUuid(key)) {
    return errorRedirect(`${back}?preview=1`, 'Send the form again: the request key was not readable.');
  }

  const outcome = await callWithSession(request, (accessToken) =>
    startBulk(accessToken, {
      key,
      userIds: draft.matched.map((row) => row.id),
      amount: draft.amount,
      remark: draft.remark,
      proof: { ...(password === '' ? {} : { password }), ...(code === '' ? {} : { code }) },
      clientIp: clientIpFrom(request),
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const message = errorMessage(outcome.result.body);
  const asksProof =
    reauthRequired(outcome.result.body) ||
    outcome.result.status === 403 ||
    (outcome.result.status === 400 && (password !== '' || code !== ''));

  let response: NextResponse;

  if (outcome.result.status === 201 && outcome.result.body !== null) {
    response = redirectTo(`/admin/coins/bulk/${outcome.result.body.id}?started=1`);
    clearDraft(response);
  } else {
    response = redirectTo(
      `${back}?preview=1&key=${encodeURIComponent(key)}${asksProof ? '&reauth=1' : ''}&error=${encodeURIComponent(message)}`,
    );
  }

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
