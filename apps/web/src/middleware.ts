import { NextResponse, type NextRequest } from 'next/server';

/**
 * Two jobs, both of which need to run before a page renders:
 *
 * 1. Make sure the double-submit CSRF value exists and is visible to *this* render.
 *    The cookie is set once; the value is also injected as a request header, because
 *    a cookie written on the response is not readable while the same request renders.
 *    The value is random and carries no information.
 * 2. Send an already signed-in person away from the sign-in and registration pages:
 *    arriving at /login with a live session is a confusing dead end.
 *
 * Nothing else happens here on purpose. The refresh cookie is exchanged for a new
 * access token in a route handler (where cookies can be written) or through
 * /api/auth/refresh-and-return, never in middleware, which does not see the API's
 * runtime configuration.
 */

export const CSRF_COOKIE = 'abhyas_csrf';
export const CSRF_HEADER = 'x-abhyas-csrf';
export const SESSION_COOKIE = 'abhyas_access';

export function middleware(request: NextRequest): NextResponse {
  const existing = request.cookies.get(CSRF_COOKIE)?.value;
  const csrf = existing ?? crypto.randomUUID();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSRF_HEADER, csrf);

  const path = request.nextUrl.pathname;
  const signedIn = request.cookies.get(SESSION_COOKIE) !== undefined;

  if (signedIn && (path === '/login' || path === '/register')) {
    const url = request.nextUrl.clone();
    url.pathname = '/account';
    url.search = '';
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  if (existing === undefined) {
    response.cookies.set({
      name: CSRF_COOKIE,
      value: csrf,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
