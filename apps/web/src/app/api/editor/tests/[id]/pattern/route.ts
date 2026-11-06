import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../../lib/authenticated-write';
import { guardFormPost, redirectTo, stringField } from '../../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../../lib/session';
import { updateTest, type TestPatternInput } from '../../../../../../lib/tests-api';
import { errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Which input the API's message is about, so the page puts it under that field. */
function fieldFor(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('title')) {
    return 'title';
  }
  if (lower.includes('duration')) {
    return 'durationMinutes';
  }
  if (lower.includes('marksperquestion')) {
    return 'marksPerQuestion';
  }
  if (lower.includes('negativemarksperquestion')) {
    return 'negativeMarksPerQuestion';
  }
  if (lower.includes('maxattempts')) {
    return 'maxAttempts';
  }
  return '';
}

/**
 * Save the pattern. Editing a published paper opens a new draft version in the API; this
 * handler does not need to know that, and it never touches the published row.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const title = stringField(guard.form, 'title').trim();
  const durationText = stringField(guard.form, 'durationMinutes').trim();
  const marksText = stringField(guard.form, 'marksPerQuestion').trim();
  const negativeText = stringField(guard.form, 'negativeMarksPerQuestion').trim();
  const maxAttemptsText = stringField(guard.form, 'maxAttempts').trim();

  const body: TestPatternInput = {
    ...(title === '' ? {} : { title }),
    ...(durationText === '' ? {} : { durationMinutes: Number.parseInt(durationText, 10) }),
    ...(marksText === '' ? {} : { marksPerQuestion: marksText }),
    ...(negativeText === '' ? {} : { negativeMarksPerQuestion: negativeText }),
    ...(maxAttemptsText === '' ? { maxAttempts: null } : { maxAttempts: Number.parseInt(maxAttemptsText, 10) }),
  };

  const outcome = await callWithSession(request, (accessToken) => updateTest(accessToken, id, body));

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const back = `/editor/tests/${encodeURIComponent(id)}`;

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?saved=1`)
      : redirectTo(
          `${back}?error=${encodeURIComponent(errorMessage(outcome.result.body))}&field=${encodeURIComponent(fieldFor(errorMessage(outcome.result.body)))}&title=${encodeURIComponent(title)}&durationMinutes=${encodeURIComponent(durationText)}&marksPerQuestion=${encodeURIComponent(marksText)}&negativeMarksPerQuestion=${encodeURIComponent(negativeMarksText)}&maxAttempts=${encodeURIComponent(maxAttemptsText)}`,
        );

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
