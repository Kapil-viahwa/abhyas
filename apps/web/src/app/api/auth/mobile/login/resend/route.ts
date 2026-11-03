import { NextResponse } from 'next/server';

import { handleCodeRequest } from '../../../../../../lib/mobile-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  return handleCodeRequest(request, { purpose: 'LOGIN', formPath: '/login/mobile', resent: true });
}
