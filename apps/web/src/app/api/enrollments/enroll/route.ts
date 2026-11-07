import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { enrollInTest, refusalCode } from '../../../../lib/student-tests-api';

export const dynamic = 'force-dynamic';

/**
 * Enroll in one paper.
 *
 * The page sends one `Idempotency-Key` per render and this handler never invents another: on a
 * refusal the key goes back to the page in the redirect, so a retry is the same request to the
 * API and cannot write a second debit. The refusal is classified by the API's own `code`, not
 * by its status — an unaffordable enrollment and a malformed one are both a 400 — and the page
 * turns the code into a sentence. No API text is ever put in the URL.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const testId = stringField(guard.form, 'testId').trim();
  const key = stringField(guard.form, 'idempotencyKey').trim();

  if (testId === '' || key === '') {
    return redirectTo('/tests?error=not_for_sale');
  }

  const outcome = await callWithSession(request, (accessToken) => enrollInTest(accessToken, testId, key));

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const back = `/tests/${encodeURIComponent(testId)}`;
  const response =
    outcome.result.status === 201
      ? redirectTo(`${back}?enrolled=1`)
      : redirectTo(`${back}?error=${encodeURIComponent(refusalCode(outcome.result.body) ?? 'unknown')}&key=${encodeURIComponent(key)}`);

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
