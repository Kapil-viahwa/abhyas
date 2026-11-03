import { NextResponse } from 'next/server';

import { handleCodeVerify } from '../../../../../lib/mobile-auth';
import { stringField } from '../../../../../lib/route-handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  return handleCodeVerify(request, {
    endpoint: '/v1/auth/mobile/login',
    formPath: '/login/mobile',
    body: (form) => ({ destination: stringField(form, 'destination').trim(), code: stringField(form, 'code').trim() }),
    back: (form) => {
      const back = new URLSearchParams({ sent: '1', destination: stringField(form, 'destination').trim() });
      return back;
    },
  });
}
