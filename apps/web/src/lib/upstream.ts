/**
 * The only door to the API. Called from server code, never from the browser, so no
 * API URL and no token is ever shipped to a page.
 */

import { webConfig } from './config';

export interface ApiCallOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly accessToken?: string | undefined;
  /** The end user's address, forwarded so the API's per-IP limits follow the person. */
  readonly clientIp?: string | undefined;
  /**
   * Cache the response under these Next cache tags instead of treating it as uncached.
   * Public catalog pages use this so /api/revalidate can drop them after a write.
   */
  readonly tags?: readonly string[] | undefined;
}

export interface ApiResult<T> {
  readonly status: number;
  readonly body: T | null;
}

export async function apiCall<T>(path: string, options: ApiCallOptions): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.accessToken !== undefined && options.accessToken !== '') {
    headers.authorization = `Bearer ${options.accessToken}`;
  }
  if (options.clientIp !== undefined && options.clientIp !== '') {
    headers['x-forwarded-for'] = options.clientIp;
  }

  try {
    const init: RequestInit & { next?: { tags: readonly string[] } } = {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    };

    if (options.tags !== undefined && options.tags.length > 0) {
      // Cached under a tag so /api/revalidate can drop it after a catalog write.
      init.next = { tags: options.tags };
    } else {
      init.cache = 'no-store';
    }

    const response = await fetch(`${webConfig().apiInternalUrl}${path}`, init);

    const text = await response.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { message: text };
      }
    }

    return { status: response.status, body: body as T | null };
  } catch {
    // A dead API must become a clean error page, not a stack trace in the browser.
    return { status: 503, body: null };
  }
}

/** The API's message, when it sent one, without trusting its shape. */
export function errorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
    if (Array.isArray(message)) {
      const joined = message.filter((part): part is string => typeof part === 'string').join(' ');
      if (joined !== '') {
        return joined;
      }
    }
  }

  return 'Something went wrong. Please try again.';
}

/** The end user's address as the proxy chain reported it, if it reported one. */
export function clientIpFrom(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first !== '') {
      return first;
    }
  }

  const realIp = request.headers.get('x-real-ip');
  return realIp === null || realIp === '' ? undefined : realIp;
}
