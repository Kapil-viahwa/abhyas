import { NextResponse } from 'next/server';

import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { apiCall, clientIpFrom, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Consumes the single-use reset link and sets the new password. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const token = stringField(guard.form, 'token').trim();
  const result = await apiCall<{ status: string }>('/v1/auth/reset-password', {
    method: 'POST',
    clientIp: clientIpFrom(request),
    body: { token, newPassword: stringField(guard.form, 'password') },
  });

  if (result.status === 200) {
    return redirectTo('/login?reset=1');
  }

  // The token stays in the form so a weak password can be fixed without losing it.
  return errorRedirect(
    `/reset-password?token=${encodeURIComponent(token)}`,
    result.status === 429
      ? 'Too many attempts. Please try again later.'
      : errorMessage(result.body),
  );
}
