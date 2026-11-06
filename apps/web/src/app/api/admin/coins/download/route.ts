import { NextResponse } from 'next/server';

import { isUuid } from '../../../../../lib/coins-api';
import { webConfig } from '../../../../../lib/config';
import { redirectTo } from '../../../../../lib/route-handler';
import { ACCESS_COOKIE, cookieFromRequest } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

function badRequest(): NextResponse {
  return NextResponse.json({ error: 'Name the export and the account it belongs to' }, { status: 400 });
}

/**
 * Streams a CSV the API produced, with the session that is allowed to see it.
 *
 * A download link is a GET, so it cannot go through `apiCall` (that answers JSON). The
 * access token never leaves this tier: the browser only ever sees the document.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const accessToken = cookieFromRequest(request, ACCESS_COOKIE);

  if (accessToken === undefined || accessToken === '') {
    return redirectTo('/login');
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') ?? '';
  const type = (url.searchParams.get('type') ?? '').trim();

  let path: string;
  let filename: string;

  if (kind === 'report') {
    const id = (url.searchParams.get('id') ?? '').trim();

    if (!isUuid(id)) {
      return badRequest();
    }

    path = `/v1/admin/coins/bulk/${encodeURIComponent(id)}/report`;
    filename = `abhyas-coins-job-${id}.csv`;
  } else if (kind === 'ledger') {
    const userId = (url.searchParams.get('userId') ?? '').trim();

    if (!isUuid(userId)) {
      return badRequest();
    }

    path = `/v1/admin/coins/${encodeURIComponent(userId)}/ledger/export${
      type === '' ? '' : `?type=${encodeURIComponent(type)}`
    }`;
    filename = `abhyas-coins-${userId}.csv`;
  } else {
    return badRequest();
  }

  try {
    const response = await fetch(`${webConfig().apiInternalUrl}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });

    if (response.status === 401) {
      return redirectTo('/login?expired=1');
    }

    if (response.status !== 200) {
      return NextResponse.json({ error: 'Could not export those coins' }, { status: 502 });
    }

    const csv = await response.text();

    return new NextResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: 'The API is unreachable' }, { status: 503 });
  }
}
