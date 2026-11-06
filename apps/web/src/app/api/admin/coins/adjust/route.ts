import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../lib/authenticated-write';
import { adjustCoins, isUuid, reauthRequired } from '../../../../../lib/coins-api';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';
import { clientIpFrom, errorMessage } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** One coin adjustment, resending the same Idempotency-Key if the API asks for a proof. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const userId = stringField(guard.form, 'userId').trim();
  const key = stringField(guard.form, 'idempotencyKey').trim();
  const amountText = stringField(guard.form, 'amount').trim();
  const remark = stringField(guard.form, 'remark').trim();
  const password = stringField(guard.form, 'password');
  const code = stringField(guard.form, 'code').trim();

  const back = `/admin/coins/${encodeURIComponent(userId)}`;

  if (!isUuid(userId) || !isUuid(key) || !/^-?\d{1,7}$/.test(amountText)) {
    return errorRedirect(back, 'Send the form again: the account, the amount or the request key was not readable.');
  }

  const outcome = await callWithSession(request, (accessToken) =>
    adjustCoins(accessToken, {
      key,
      userId,
      amount: Number.parseInt(amountText, 10),
      remark,
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

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?adjusted=1`)
      : redirectTo(
          `${back}?key=${encodeURIComponent(key)}${asksProof ? '&reauth=1' : ''}&amount=${encodeURIComponent(amountText)}&remark=${encodeURIComponent(remark)}&error=${encodeURIComponent(message)}`,
        );

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
