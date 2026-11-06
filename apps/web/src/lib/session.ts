/**
 * Where the session lives: three cookies, none of them visible to page JavaScript.
 *
 * - `abhyas_access` — the opaque access token, 15 minutes.
 * - `abhyas_refresh` — the opaque refresh token, 30 days, rotated on every use.
 * - `abhyas_csrf` — a random double-submit value, set by middleware, echoed into every
 *   form. It is not a credential; it only proves the form came from this site.
 *
 * Nothing is ever put in localStorage or sessionStorage, and no page receives a token
 * as data: the only code that reads these cookies is a route handler or a server
 * component.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { NextResponse } from 'next/server';

import { webConfig } from './config';
import { apiCall } from './upstream';

export const ACCESS_COOKIE = 'abhyas_access';
export const REFRESH_COOKIE = 'abhyas_refresh';
export const CSRF_COOKIE = 'abhyas_csrf';

/** The form field every write posts the CSRF value in. */
export const CSRF_FIELD = 'csrfToken';

export const ACCESS_MAX_AGE_SECONDS = 15 * 60;
export const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface Profile {
  readonly id: string;
  /** Null for an account created with a mobile number that has not linked an email yet. */
  readonly email: string | null;
  readonly fullName: string;
  readonly roleCode: string;
  readonly permissions: readonly string[];
}

export interface SessionRow {
  readonly id: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly deviceLabel: string | null;
  readonly issuedAt: string;
  readonly lastUsedAt: string;
  readonly current: boolean;
}

/** Reads one cookie from a raw request, for route handlers (no cookies() there). */
export function cookieFromRequest(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') ?? '';

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }

  return undefined;
}

export function csrfFromRequest(request: Request): string | undefined {
  return cookieFromRequest(request, CSRF_COOKIE);
}

function baseCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: webConfig().nodeEnv === 'production',
    path: '/',
    maxAge,
  };
}

export function setSessionCookies(response: NextResponse, tokens: SessionTokens): void {
  response.cookies.set({ name: ACCESS_COOKIE, value: tokens.accessToken, ...baseCookieOptions(ACCESS_MAX_AGE_SECONDS) });
  response.cookies.set({
    name: REFRESH_COOKIE,
    value: tokens.refreshToken,
    ...baseCookieOptions(REFRESH_MAX_AGE_SECONDS),
  });
}

export function clearSessionCookies(response: NextResponse): void {
  response.cookies.set({ name: ACCESS_COOKIE, value: '', ...baseCookieOptions(0) });
  response.cookies.set({ name: REFRESH_COOKIE, value: '', ...baseCookieOptions(0) });
}

/** What a server component sees. */
export async function tokensFromCookies(): Promise<Partial<SessionTokens>> {
  const store = await cookies();

  return {
    accessToken: store.get(ACCESS_COOKIE)?.value,
    refreshToken: store.get(REFRESH_COOKIE)?.value,
  };
}

export async function csrfFromCookies(): Promise<string> {
  // Middleware injects the value as a header so a first visit renders with the very
  // token it is also setting as a cookie (a response cookie is not readable yet).
  const fromHeader = (await headers()).get('x-abhyas-csrf');
  if (fromHeader !== null && fromHeader !== '') {
    return fromHeader;
  }

  const store = await cookies();
  return store.get(CSRF_COOKIE)?.value ?? '';
}

export interface LoadedSession {
  readonly profile: Profile;
  readonly accessToken: string;
}

/**
 * The server-side gate every signed-in page uses.
 *
 * Three outcomes: signed in (profile + access token), anonymous (to /login), or an
 * expired access token with a usable refresh cookie — which is sent through
 * /api/auth/refresh-and-return, the one place cookies can be written before a page
 * renders.
 */
export async function loadSession(nextPath: string): Promise<LoadedSession> {
  const { accessToken, refreshToken } = await tokensFromCookies();

  if (accessToken !== undefined && accessToken !== '') {
    const me = await apiCall<Profile>('/v1/auth/me', { method: 'GET', accessToken });

    if (me.status === 200 && me.body !== null) {
      return { profile: me.body, accessToken };
    }
  }

  if (refreshToken !== undefined && refreshToken !== '') {
    redirect(`/api/auth/refresh-and-return?next=${encodeURIComponent(nextPath)}`);
  }

  redirect(`/login?next=${encodeURIComponent(nextPath)}`);
}

export async function loadRoleSession(nextPath: string, roles: readonly string[]): Promise<LoadedSession> {
  const session = await loadSession(nextPath);

  if (!roles.includes(session.profile.roleCode)) {
    redirect('/account?denied=1');
  }

  return session;
}

/**
 * A page that needs one capability, checked here before anything is rendered.
 *
 * The API refuses every route this gates anyway; this is what stops a page rendering an
 * empty shell — or a form that cannot work — to somebody who may not use it.
 */
export async function loadPermissionSession(nextPath: string, permission: string): Promise<LoadedSession> {
  const session = await loadSession(nextPath);

  if (!session.profile.permissions.includes(permission)) {
    redirect('/account?denied=1');
  }

  return session;
}

export async function loadSessions(accessToken: string): Promise<readonly SessionRow[]> {
  const result = await apiCall<{ sessions: SessionRow[] }>('/v1/auth/sessions', { method: 'GET', accessToken });
  return result.status === 200 && result.body !== null ? result.body.sessions : [];
}

/** Where each role lands after signing in. */
export function landingPath(roleCode: string): string {
  if (roleCode === 'ADMIN') {
    return '/admin';
  }
  if (roleCode === 'EDITOR') {
    return '/editor';
  }
  return '/account';
}
