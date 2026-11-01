import type { NodeEnv } from '@abhyas/shared';

/**
 * The public base URL of the web app, used for links the API puts in email.
 *
 * Read from WEB_URL and never from a request header: a Host header is attacker
 * controlled, and using it would turn a verification mail into a phishing link.
 */
export const DEFAULT_WEB_URL = 'http://localhost:3000';

export function webUrlFor(nodeEnv: NodeEnv, value: string | undefined): string {
  const raw = (value ?? '').trim();

  if (raw === '') {
    if (nodeEnv === 'production') {
      throw new Error('WEB_URL is required in production so email links cannot point at localhost');
    }
    return DEFAULT_WEB_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('WEB_URL must be an absolute http(s) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('WEB_URL must be an absolute http(s) URL');
  }

  if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error('WEB_URL must use https in production: a verification link carries a token');
  }

  return raw.replace(/\/+$/, '');
}
