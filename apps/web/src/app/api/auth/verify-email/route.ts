import { NextResponse } from 'next/server';

import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { apiCall, clientIpFrom } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * The link in the verification mail. It posts the token — the token is the authority,
 * and no cookie is involved, which is why no CSRF field is needed here.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const token = stringField(guard.form, 'token').trim();
  if (token === '') {
    return errorRedirect('/verify-email', 'This verification link is incomplete.');
  }

  const result = await apiCall<{ status: string }>('/v1/auth/verify-email', {
    method: 'POST',
    clientIp: clientIpFrom(request),
    body: { token },
  });

  if (result.status === 200) {
    return redirectTo('/verify-email?status=verified');
  }

  return errorRedirect('/verify-email', 'This verification link is invalid or has expired.');
}
