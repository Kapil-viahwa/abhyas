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
  };
}
