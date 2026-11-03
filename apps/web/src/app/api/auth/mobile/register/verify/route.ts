import { NextResponse } from 'next/server';

import { handleCodeVerify } from '../../../../../../lib/mobile-auth';
import { stringField } from '../../../../../../lib/route-handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  return handleCodeVerify(request, {
    endpoint: '/v1/auth/mobile/register',
    formPath: '/register/mobile',
    body: (form) => ({
      destination: stringField(form, 'destination').trim(),
      code: stringField(form, 'code').trim(),
      fullName: stringField(form, 'fullName').trim(),
    }),
    back: (form) =>
      new URLSearchParams({
        sent: '1',
        destination: stringField(form, 'destination').trim(),
        name: stringField(form, 'fullName').trim(),
      }),
  });
}
