/**
 * Shared guard for the web's own write endpoints.
 *
 * Every write is a form post to a route handler, and every one of them passes the same
 * two checks before anything reaches the API:
 *
 * 1. **Origin** — the request must name an origin this deployment trusts. A browser
 *    always sends `Origin` on a form post; a request without one is refused rather
 *    than guessed about.
 * 2. **Double submit** — the value from the `abhyas_csrf` cookie must appear in the
 *    form. A cross-site page can make the browser send the cookie but cannot read it,
 *    so it cannot fill the field.
 */

import { NextResponse } from 'next/server';

import { webConfig } from './config';
import { CSRF_FIELD, csrfFromRequest } from './session';

export type WriteGuard =
  | { readonly ok: true; readonly form: FormData }
  | { readonly ok: false; readonly response: NextResponse };

function refused(): WriteGuard {
  return {
    ok: false,
    response: NextResponse.json({ error: 'Request refused: cross-site or missing token' }, { status: 403 }),
  };
}

export async function guardFormPost(request: Request): Promise<WriteGuard> {
  const origin = request.headers.get('origin');
  const trusted = new Set([webConfig().webUrl, new URL(request.url).origin]);

  if (origin === null || !trusted.has(origin)) {
    return refused();
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refused();
  }

  const submitted = form.get(CSRF_FIELD);
  const cookieValue = csrfFromRequest(request);

  if (typeof submitted !== 'string' || cookieValue === undefined || submitted !== cookieValue) {
    return refused();
  }

  return { ok: true, form };
}

export function redirectTo(path: string, status: 303 | 307 = 303): NextResponse {
  return NextResponse.redirect(new URL(path, webConfig().webUrl), status);
}

export function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export function errorRedirect(path: string, message: string): NextResponse {
  return redirectTo(`${path}?error=${encodeURIComponent(message)}`);
}
