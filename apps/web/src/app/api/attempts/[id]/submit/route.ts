import { NextResponse } from 'next/server';

import { submitAttempt, type SubmittedAnswer } from '../../../../../lib/attempts-api';
import { callWithSession } from '../../../../../lib/authenticated-write';
import { guardFormPost, stringField } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ANSWERS = 100;

/** The answers the page holds, and nothing else: no timestamp and no account. */
function parseAnswers(value: string): SubmittedAnswer[] | null {
  let body: unknown;
  try {
    body = JSON.parse(value) as unknown;
  } catch {
    return null;
  }

  if (!Array.isArray(body) || body.length > MAX_ANSWERS) {
    return null;
  }

  const answers: SubmittedAnswer[] = [];
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes('questionId') || !keys.includes('chosenOptionId')) {
      return null;
    }
    const questionId = record.questionId;
    const chosenOptionId = record.chosenOptionId;
    if (typeof questionId !== 'string' || typeof chosenOptionId !== 'string') {
      return null;
    }
    if (!UUID.test(questionId) || !UUID.test(chosenOptionId)) {
      return null;
    }
    answers.push({ questionId, chosenOptionId });
  }

  return answers;
}

/**
 * Submit the answers the page holds. The API is idempotent per attempt, so a retried submit is
 * the same outcome; `attempt_expired` means the attempt had already ended without these answers
 * and the page goes to the result.
 *
 * The API's success body is a result **with the per-question review, the correct option and the
 * explanation**, and that body is deliberately not forwarded: the browser only needs to know the
 * answers were accepted, and a paper's key must not reach a client that has not asked for the
 * result page. The status is all this handler returns.
 */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;
  const answers = parseAnswers(stringField(guard.form, 'answers'));

  if (!UUID.test(id) || answers === null) {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE });
  }

  const outcome = await callWithSession(request, (accessToken) => submitAttempt(accessToken, id, answers));

  if (!outcome.signedIn) {
    const response = NextResponse.json({ error: 'signed_out' }, { status: 401, headers: NO_STORE });
    clearSessionCookies(response);
    return response;
  }

  const { result } = outcome;
  let response: NextResponse;

  if (result.status === 200) {
    response = NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
  } else if (result.status === 409) {
    const code = (result.body as { code?: unknown } | null)?.code;
    response = NextResponse.json(
      { error: typeof code === 'string' ? code : 'attempt_expired' },
      { status: 409, headers: NO_STORE },
    );
  } else if (result.status === 400) {
    response = NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE });
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
