/**
 * Web-side configuration, read on the server only.
 *
 * The browser never receives an API base URL, a secret or a token: every value here
 * is used by a route handler or a server component. `TURNSTILE_SITE_KEY` is the one
 * value that is deliberately public (it is rendered into the widget), and production
 * refuses a Cloudflare test key, so a development shortcut cannot ship.
 */

export type WebNodeEnv = 'development' | 'test' | 'production';

export interface WebConfig {
  readonly nodeEnv: WebNodeEnv;
  readonly apiInternalUrl: string;
  readonly webUrl: string;
  readonly turnstileSiteKey: string;
  /** True when the site key is one of Cloudflare's always-pass test keys. */
  readonly turnstileTestMode: boolean;
  /** Accepted on /api/revalidate, the one route the API is allowed to call. */
  readonly revalidateSecret: string;
  /**
   * How many proxy hops in front of this tier to read the client's address from, or `null`
   * (the default) when none is named and no header is believed at all. A browser can send
   * its own `X-Forwarded-For`, so only the entries the trusted edge wrote are read, and
   * production refuses anything that is not an explicit hop count (decision 0052).
   */
  readonly forwardedIpHops: number | null;
  /** True when `forwardedIpHops` names an edge. */
  readonly trustForwardedIp: boolean;
  /**
   * True when the API serves the mobile OTP routes. The mobile screens and their web
   * routes are hidden and answer 404 when this is false, so the switch cannot be flipped
   * in the API alone and leave a screen that posts into nothing.
   */
  readonly otpEnabled: boolean;
}

const DEFAULT_REVALIDATE_SECRET = 'dev-only-revalidate-secret';
const MIN_REVALIDATE_SECRET_LENGTH = 16;

/** Cloudflare's documented always-pass site key. */
export const TURNSTILE_TEST_SITE_KEY = '1x0000000000000000000000000000000AA';

/** The same pattern the API's environment validator refuses in production. */
const TURNSTILE_TEST_SITE_KEY_PATTERN = /^[123]x0{20,}/i;

/**
 * The token the API's development verifier accepts. It is pre-filled into the form
 * only while the site key is a test key, so the CI flow does not depend on
 * challenges.cloudflare.com being reachable — and a production build with a real site
 * key never pre-fills anything.
 */
export const TURNSTILE_TEST_TOKEN = 'abhyas-test-turnstile-token';

export function webConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as WebNodeEnv;
  const configuredSiteKey = env.TURNSTILE_SITE_KEY?.trim() ?? '';
  const apiInternalUrl = (env.API_INTERNAL_URL?.trim() || 'http://localhost:3001').replace(/\/+$/, '');
  const webUrl = (env.WEB_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');

  if (nodeEnv === 'production') {
    if (configuredSiteKey === '') {
      throw new Error('TURNSTILE_SITE_KEY is required in production: the sign-in and signup forms need a real widget');
    }
    if (TURNSTILE_TEST_SITE_KEY_PATTERN.test(configuredSiteKey)) {
      throw new Error('Cloudflare test site keys are refused in production');
    }
    if (!webUrl.startsWith('https://')) {
      throw new Error('WEB_URL must use https in production: it is the origin trusted for cookie writes');
    }
  }

  const turnstileSiteKey = configuredSiteKey === '' ? TURNSTILE_TEST_SITE_KEY : configuredSiteKey;
  const revalidateSecret = env.REVALIDATE_SECRET?.trim() ?? '';

  // The address a browser claims for itself is only believed when the thing in front of this
  // tier is named. Here that is a hop count: this tier cannot see who connected, so the only
  // thing it can be configured with is how many proxies it stands behind. The second switch
  // exists for the browser suite (a fresh address per test) and is refused in production.
  const trustForwardedForTests = (env.TRUST_FORWARDED_IP_FOR_TESTS ?? '').trim().toLowerCase() === 'true';
  if (nodeEnv === 'production' && trustForwardedForTests) {
    throw new Error('TRUST_FORWARDED_IP_FOR_TESTS is refused in production: a client cannot choose its own address');
  }

  const forwardedIpHops = parseForwardedIpHops(env.TRUST_PROXY, nodeEnv) ?? (trustForwardedForTests ? 1 : null);
  const trustForwardedIp = forwardedIpHops !== null;

  if (nodeEnv === 'production') {
    if (revalidateSecret === '') {
      throw new Error('REVALIDATE_SECRET is required in production: the API must prove itself before a page is dropped');
    }
    if (revalidateSecret.length < MIN_REVALIDATE_SECRET_LENGTH) {
      throw new Error(`REVALIDATE_SECRET must be at least ${MIN_REVALIDATE_SECRET_LENGTH} characters`);
    }
  }

  return {
    nodeEnv,
    apiInternalUrl,
    webUrl,
    turnstileSiteKey,
    turnstileTestMode: TURNSTILE_TEST_SITE_KEY_PATTERN.test(turnstileSiteKey),
    revalidateSecret: revalidateSecret === '' ? DEFAULT_REVALIDATE_SECRET : revalidateSecret,
    otpEnabled: (env.OTP_ENABLED ?? '').trim().toLowerCase() === 'true',
    forwardedIpHops,
    trustForwardedIp,
  };
}

/**
 * How many proxy hops to read the client's address from.
 *
 * `TRUST_PROXY` on this tier is not "believe the forwarding header": a browser can send its
 * own `X-Forwarded-For` and `X-Real-IP`, so only the entries the trusted edge itself wrote
 * are read. This tier cannot see the socket's peer, so the edge is named as a hop count
 * rather than an address, and production refuses anything that is not one (decision 0052).
 */
export function parseForwardedIpHops(raw: string | undefined, nodeEnv: WebNodeEnv): number | null {
  const value = (raw ?? '').trim();

  if (value === '') {
    return null;
  }

  if (/^[0-9]+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 10) {
      throw new Error('TRUST_PROXY: a hop count must be between 1 and 10');
    }

    return hops;
  }

  if (nodeEnv === 'production') {
    throw new Error('TRUST_PROXY is refused in production: name how many proxy hops stand in front of this tier (1-10)');
  }

  if (value === 'true' || value === '*') {
    // A development convenience: exactly one proxy in front, typically the compose edge.
    return 1;
  }

  throw new Error('TRUST_PROXY: name how many proxy hops stand in front of this tier (1-10)');
}
