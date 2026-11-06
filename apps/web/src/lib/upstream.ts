/**
 * The only door to the API. Called from server code, never from the browser, so no
 * API URL and no token is ever shipped to a page.
 */

import { isIP } from 'node:net';

import { webConfig } from './config';

export interface ApiCallOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly accessToken?: string | undefined;
  /** The end user's address, forwarded so the API's per-IP limits follow the person. */
  readonly clientIp?: string | undefined;
  /**
   * Extra request headers, such as a form's `Idempotency-Key`. `accept`, `authorization`,
   * `content-type` and the client-address header are always this tier's own and win.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Cache the response under these Next cache tags instead of treating it as uncached.
   * Public catalog pages use this so /api/revalidate can drop them after a write.
   */
  readonly tags?: readonly string[] | undefined;
  /** Overrides the 10 s ceiling; only tests should pass this. */
  readonly timeoutMs?: number | undefined;
}

/** The one sentence an unreadable or unexpected API answer becomes. */
export const GENERIC_API_MESSAGE = 'Something went wrong. Please try again.';

export interface ApiResult<T> {
  readonly status: number;
  readonly body: T | null;
}

/** How long the web tier waits for the API before it gives up and renders an error page. */
export const API_CALL_TIMEOUT_MS = 10_000;

/** The most of an API response this tier will read: anything larger is refused, not buffered. */
export const API_CALL_MAX_RESPONSE_BYTES = 1_048_576;

/** A misconfiguration, not a request failure: it never reaches the API. */
export class ApiCallConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCallConfigurationError';
  }
}

/**
 * Reads a body up to the cap, and answers `null` when it is larger.
 *
 * `response.text()` would buffer however much the API (or something pretending to be it) sent,
 * so the body is streamed through the reader and abandoned the moment it passes the ceiling.
 */
async function readCapped(response: Response): Promise<string | null> {
  const body = response.body;

  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > API_CALL_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

export async function apiCall<T>(path: string, options: ApiCallOptions): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...options.headers, accept: 'application/json' };
  const cached = options.tags !== undefined && options.tags.length > 0;
  const authenticated = options.accessToken !== undefined && options.accessToken !== '';

  if (cached && authenticated) {
    // Cached under a tag means shared between visitors: a response built from one person's
    // token would hand their data to everyone who asks for the same page.
    throw new ApiCallConfigurationError('apiCall: a response cached under tags cannot be built from an access token');
  }

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (authenticated) {
    headers.authorization = `Bearer ${String(options.accessToken)}`;
  }
  if (options.clientIp !== undefined && options.clientIp !== '') {
    // Forwarded under the one header the API is configured to read, never both (decision 0055).
    headers[webConfig().clientIpHeader] = options.clientIp;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? API_CALL_TIMEOUT_MS);

  try {
    const init: RequestInit & { next?: { tags?: string[] } } = {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    };

    if (cached) {
      // Cached under a tag so /api/revalidate can drop it after a catalog write.
      // `force-cache` is explicit: a page may be rendered per request and still read
      // the payload from the data cache until the tag is revalidated.
      init.cache = 'force-cache';
      init.next = { tags: [...(options.tags ?? [])] };
    } else {
      init.cache = 'no-store';
    }

    const response = await fetch(`${webConfig().apiInternalUrl}${path}`, init);
    const declared = Number(response.headers.get('content-length') ?? '');

    if (Number.isFinite(declared) && declared > API_CALL_MAX_RESPONSE_BYTES) {
      return { status: 502, body: { message: 'The API response was too large.' } as unknown as T };
    }

    const text = await readCapped(response);

    if (text === null) {
      return { status: 502, body: { message: 'The API response was too large.' } as unknown as T };
    }

    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // Never hand raw response text to a page: an upstream that answers HTML, a stack
        // trace or a proxy error page has said something about itself that a visitor should
        // not read, and it is not our message anyway (decision 0058).
        body = { message: GENERIC_API_MESSAGE };
      }
    }

    return { status: response.status, body: body as T | null };
  } catch {
    // A dead or slow API must become a clean error page, not a stack trace in the browser.
    return { status: 503, body: null };
  } finally {
    clearTimeout(timer);
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

  return GENERIC_API_MESSAGE;
}

/**
 * The end user's address, as the edge proxy stated it.
 *
 * Only read when this tier is configured to stand behind a named number of proxy hops
 * (`TRUST_PROXY`), or, in development and CI only, when TRUST_FORWARDED_IP_FOR_TESTS lets
 * the browser suite choose a fresh address per test. Otherwise a browser could name any
 * address it liked and step out of the API's per-IP counters, so no address is forwarded at
 * all (decision 0052).
 *
 * Exactly one header is read — the one `TRUST_CLIENT_IP_HEADER` names — and there is no
 * fallback to the other (decision 0055). `X-Real-IP` carries one address; a value of
 * `X-Forwarded-For` with commas is read from the right, so a chain the browser prepended a
 * fake address to still resolves to the one the trusted proxy wrote.
 */
export function clientIpFrom(request: Request): string | undefined {
  const config = webConfig();
  const hops = config.forwardedIpHops;

  if (hops === null) {
    return undefined;
  }

  return statedAddress(request.headers.get(config.clientIpHeader), hops);
}

/** The address a header states `hops` from the right, or `undefined` when it names none. */
function statedAddress(value: string | null, hops: number): string | undefined {
  if (value === null) {
    return undefined;
  }

  const chain = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  const index = chain.length - hops;

  return index < 0 ? undefined : clientAddress(chain[index]);
}

/**
 * An address this tier is willing to forward: exactly one IPv4 or IPv6 address.
 *
 * A header value is whatever the edge — or a browser pretending to be one — wrote. Garbage,
 * a list, an oversized value, a newline or a spreadsheet formula must never reach the API,
 * where it would become a rate-limit key, an audit row or a log line.
 */
export function clientAddress(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const candidate = value.trim();

  return candidate !== '' && isIP(candidate) !== 0 ? candidate : undefined;
}
