/**
 * Silent refresh, server-side: run one authenticated call, and if the access token has
 * expired exchange the refresh cookie for a new pair and try once more. The new pair
 * goes back to the browser as cookies on the response the caller is about to return.
 */

import type { ApiResult } from './upstream';
import { apiCall } from './upstream';
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieFromRequest, type SessionTokens } from './session';

export interface SessionCallOutcome<T> {
  readonly result: ApiResult<T>;
  /** Present when the refresh cookie was used, so the caller can set the new cookies. */
  readonly tokens?: SessionTokens;
  /** False when there is no usable session left: the caller should send the person to /login. */
  readonly signedIn: boolean;
}

interface RotatedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export async function callWithSession<T>(
  request: Request,
  run: (accessToken: string) => Promise<ApiResult<T>>,
): Promise<SessionCallOutcome<T>> {
  const accessToken = cookieFromRequest(request, ACCESS_COOKIE);
  if (accessToken === undefined || accessToken === '') {
    return { result: { status: 401, body: null }, signedIn: false };
  }

  const first = await run(accessToken);
  if (first.status !== 401) {
    return { result: first, signedIn: true };
  }

  const refreshToken = cookieFromRequest(request, REFRESH_COOKIE);
  if (refreshToken === undefined || refreshToken === '') {
    return { result: first, signedIn: false };
  }

  const rotated = await apiCall<RotatedTokens>('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });

  if (rotated.status !== 200 || rotated.body === null) {
    // The family is revoked or expired: the cookies are worthless now.
    return { result: first, signedIn: false };
  }

  const retried = await run(rotated.body.accessToken);

  return {
    result: retried,
    tokens: { accessToken: rotated.body.accessToken, refreshToken: rotated.body.refreshToken },
    signedIn: true,
  };
}
