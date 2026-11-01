import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../lib/authenticated-write';
import { createEditor, type UserDetail } from '../../../../../lib/admin-api';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';
import { clientIpFrom, errorMessage } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Creates an editor. The API decides who may do this; this handler only carries the form. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const outcome = await callWithSession(request, (accessToken) =>
    createEditor(accessToken, clientIpFrom(request), {
      email: stringField(guard.form, 'email').trim().toLowerCase(),
      fullName: stringField(guard.form, 'fullName').trim(),
      password: stringField(guard.form, 'password'),
      flags: {
        manage_questions: stringField(guard.form, 'manage_questions') === 'on',
        manage_tests: stringField(guard.form, 'manage_tests') === 'on',
        publish_tests: stringField(guard.form, 'publish_tests') === 'on',
      },
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  if (outcome.result.status !== 201 || outcome.result.body === null) {
    return errorRedirect('/admin/users/new', errorMessage(outcome.result.body));
  }

  const created = outcome.result.body as UserDetail;
  const response = redirectTo(`/admin/users/${created.id}?created=1`);
  if (outcome.tokens !== undefined) {
    // The refresh rotated the pair, so the new cookies ride on this response.
    setSessionCookies(response, outcome.tokens);
  }
  return response;
}
