import { NextResponse } from 'next/server';

import { attemptRefusalCode, startAttempt } from '../../../../lib/attempts-api';
import { callWithSession } from '../../../../lib/authenticated-write';
import { guardFormPost, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 7, A4: start one attempt and hand its paper to the page.
 *
 * The paper exists only in this response and the client's memory: no-store means no cache keeps
 * it, and this handler never logs the body. A `attempt_already_started` is a 409 the page turns
 * into "this attempt cannot be resumed" — the paper is never re-delivered here.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const enrollmentId = stringField(guard.form, 'enrollmentId').trim();
  if (!UUID.test(enrollmentId)) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE });
  }

  const outcome = await callWithSession(request, (accessToken) => startAttempt(accessToken, enrollmentId));

  if (!outcome.signedIn) {
    const response = NextResponse.json({ error: 'signed_out' }, { status: 401, headers: NO_STORE });
    clearSessionCookies(response);
    return response;
  }

  const { result } = outcome;
  let response: NextResponse;

  if (result.status === 201 && result.body !== null) {
    response = NextResponse.json(result.body, { status: 201, headers: NO_STORE });
  } else if (result.status === 409) {
    response = NextResponse.json({ error: attemptRefusalCode(result.body) ?? 'unknown' }, { status: 409, headers: NO_STORE });
  } else if (result.status === 400) {
    response = NextResponse.json({ error: attemptRefusalCode(result.body) ?? 'invalid' }, { status: 400, headers: NO_STORE });
  } else if (result.status === 404) {
    response = NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  } else {
    response = NextResponse.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  }

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
