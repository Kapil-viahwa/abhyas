import { NextResponse } from 'next/server';

import { webConfig } from '../../../../lib/config';
import { redirectTo } from '../../../../lib/route-handler';
import { ACCESS_COOKIE, cookieFromRequest } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Streams the CSV the API produced, with the session that is allowed to see it.
 *
 * This route fetches the API itself rather than through `apiCall`, because the answer is
 * a document, not JSON. A missing or expired session sends the person to sign in: a
 * download link that silently produces an error page is worse than a login form.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const accessToken = cookieFromRequest(request, ACCESS_COOKIE);
  if (accessToken === undefined || accessToken === '') {
    return redirectTo('/login');
  }

  const search = new URL(request.url).search;

  try {
    const response = await fetch(`${webConfig().apiInternalUrl}/v1/admin/audit/export${search}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });

    if (response.status !== 200) {
      return NextResponse.json({ error: 'Could not export the audit trail' }, { status: 502 });
    }

    const csv = await response.text();

    return new NextResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="abhyas-audit.csv"',
      },
    });
  } catch {
    return NextResponse.json({ error: 'The API is unreachable' }, { status: 503 });
  }
}
