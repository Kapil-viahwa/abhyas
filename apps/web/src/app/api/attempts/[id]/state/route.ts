import { NextResponse } from 'next/server';

import { attemptState } from '../../../../../lib/attempts-api';
import { callWithSession } from '../../../../../lib/authenticated-write';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The countdown's re-sync: state only, never the paper. */
export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE });
  }

  const outcome = await callWithSession(request, (accessToken) => attemptState(accessToken, id));

  if (!outcome.signedIn) {
    const response = NextResponse.json({ error: 'signed_out' }, { status: 401, headers: NO_STORE });
    clearSessionCookies(response);
    return response;
  }

  const { result } = outcome;
  let response: NextResponse;

  if (result.status === 200 && result.body !== null) {
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
