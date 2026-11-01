import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';

import { webConfig } from '../../../lib/config';

export const dynamic = 'force-dynamic';

/**
 * The single route the API is allowed to call. It proves itself with the shared
 * `REVALIDATE_SECRET` before anything is dropped, so an unauthenticated caller cannot
 * make the public pages re-render at will.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const presented = request.headers.get('x-revalidate-secret') ?? '';

  if (presented === '' || presented !== webConfig().revalidateSecret) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 401 });
  }

  let tag = 'catalog';
  try {
    const body = (await request.json()) as { tag?: unknown };
    if (typeof body.tag === 'string' && body.tag.trim() !== '') {
      tag = body.tag.trim();
    }
  } catch {
    // An empty body revalidates the catalog, which is the only tag that exists.
  }

  revalidateTag(tag);
  return NextResponse.json({ revalidated: true, tag });
}
