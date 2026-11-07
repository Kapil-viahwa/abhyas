import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../../lib/authenticated-write';
import { guardFormPost, redirectTo, stringField } from '../../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../../lib/session';
import { getTest, setTestQuestions, type TestView } from '../../../../../../lib/tests-api';
import { errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * Add, remove or move one question on the paper.
 *
 * All three end in the same call: the API's `PUT .../questions` takes the paper's whole
 * ordered list and replaces it in one transaction, which is what keeps positions 1..n and
 * unique. This handler reads the current order first, computes the new one, and lets the API
 * refuse anything the editor may not use (an unpublished, foreign or other-exam question).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const action = stringField(guard.form, 'action');
  const questionId = stringField(guard.form, 'questionId').trim();
  const direction = stringField(guard.form, 'direction');
  const back = `/editor/tests/${encodeURIComponent(id)}`;

  const outcome = await callWithSession<TestView>(request, async (accessToken) => {
    const test = await getTest(accessToken, id);
    if (test === null) {
      return { status: 404, body: null };
    }

    const current = test.questions.map((question) => question.questionId);
    let next: string[];

    if (action === 'add') {
      next = current.includes(questionId) ? current : [...current, questionId];
    } else if (action === 'remove') {
      next = current.filter((value) => value !== questionId);
    } else if (action === 'move') {
      const index = current.indexOf(questionId);
      const target = direction === 'up' ? index - 1 : index + 1;
      next = [...current];
      if (index >= 0 && target >= 0 && target < current.length) {
        const moved = next[index];
        const displaced = next[target];
        if (moved !== undefined && displaced !== undefined) {
          next[index] = displaced;
          next[target] = moved;
        }
      }
    } else {
      return { status: 400, body: null };
    }

    if (next.length === 0) {
      return { status: 400, body: null };
    }

    return setTestQuestions(accessToken, id, next);
  });

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?saved=1`)
      : redirectTo(`${back}?error=${encodeURIComponent(errorMessage(outcome.result.body))}`);

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
