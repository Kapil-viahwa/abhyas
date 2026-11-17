import { NextResponse } from 'next/server';

import { attemptForEnrollment, type AttemptState } from '../../../../../lib/attempts-api';
import { callWithSession } from '../../../../../lib/authenticated-write';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 7, A4: does this enrollment have an attempt, and how long is left of it?
 *
 * The browser has no other way to learn that a start succeeded when the start response was lost
 * or refused: the paper is delivered once and never again, and the attempt's id lives only in
 * the start response. This answers the state alone — status, timestamps and remaining seconds —
 * so a page can show "already started, cannot be resumed" without ever holding the paper. It is
 * self-only and another student's enrollment is a 404, exactly as the API route underneath it.
 */
export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE });
  }

  const outcome = await callWithSession<{ attempt: AttemptState | null }>(request, async (accessToken) => {
    const envelope = await attemptForEnrollment(accessToken, id);

    if (envelope.kind === 'missing') {
      return { status: 404, body: null };
    }
    if (envelope.kind === 'unauthorised') {
      // Handed back so `callWithSession` refreshes the access cookie and tries once more.
      return { status: 401, body: null };
    }
    if (envelope.kind === 'unavailable') {
      return { status: 503, body: null };
    }

    return { status: 200, body: { attempt: envelope.attempt } };
  });

  if (!outcome.signedIn) {
    const response = NextResponse.json({ error: 'signed_out' }, { status: 401, headers: NO_STORE });
    clearSessionCookies(response);
    return response;
  }

  const { result } = outcome;
  let response: NextResponse;

  if (result.status === 200) {
    response = NextResponse.json(result.body, { status: 200, headers: NO_STORE });
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
