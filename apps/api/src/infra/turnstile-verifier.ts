import { Logger } from '@nestjs/common';
import { request } from 'node:https';

import type { NodeEnv } from '@abhyas/shared';

/**
 * Bot protection behind one seam. The auth endpoints call `verify()` and never see
 * a provider: production uses Cloudflare's `siteverify` over `node:https`, while
 * development and CI use a test verifier that refuses to exist in production.
 * `validateEnv` already refuses Cloudflare test secrets in production, so the two
 * gates cannot disagree.
 */
export const TURNSTILE_VERIFIER = 'TURNSTILE_VERIFIER';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's documented always-pass test secret; refused in production by validateEnv. */
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

/** The token the app sends in development, where no Cloudflare widget is mounted. */
export const TURNSTILE_TEST_TOKEN = 'abhyas-test-turnstile-token';

export interface TurnstileVerifier {
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

export class TurnstileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnstileError';
  }
}

/** Development, test and CI only. */
export class TestTurnstileVerifier implements TurnstileVerifier {
  constructor(nodeEnv: NodeEnv) {
    if (nodeEnv === 'production') {
      throw new TurnstileError('The test Turnstile verifier is refused in production');
    }
  }

  async verify(token: string): Promise<boolean> {
    return token.trim() === TURNSTILE_TEST_TOKEN;
  }
}

interface SiteVerifyResponse {
  readonly statusCode: number;
  readonly body: string;
}

function postForm(endpoint: string, body: string, timeoutMs = 5_000): Promise<SiteVerifyResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: text }));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Turnstile siteverify timed out'));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export class CloudflareTurnstileVerifier implements TurnstileVerifier {
  private readonly logger = new Logger(CloudflareTurnstileVerifier.name);
  private readonly secret: string;

  constructor(secretKey: string) {
    const secret = secretKey.trim();
    if (secret === '') {
      throw new TurnstileError('TURNSTILE_SECRET_KEY is required to verify challenges');
    }
    if (/^[123]x0{20,}/i.test(secret)) {
      throw new TurnstileError('Cloudflare test secrets are refused by the production Turnstile verifier');
    }
    this.secret = secret;
  }

  async verify(token: string, remoteIp?: string): Promise<boolean> {
    const response = token.trim();
    if (response === '') {
      return false;
    }

    const form = new URLSearchParams({ secret: this.secret, response });
    if (remoteIp !== undefined && remoteIp.trim() !== '') {
      form.set('remoteip', remoteIp.trim());
    }

    try {
      const result = await postForm(TURNSTILE_VERIFY_URL, form.toString());
      if (result.statusCode < 200 || result.statusCode >= 300) {
        this.logger.warn(`Turnstile siteverify answered ${result.statusCode}`);
        return false;
      }
      const payload = JSON.parse(result.body) as { success?: unknown };
      return payload.success === true;
    } catch (error) {
      // A verifier outage must not become an open door.
      this.logger.warn(`Turnstile siteverify failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

export function createTurnstileVerifier(nodeEnv: NodeEnv, secretKey: string): TurnstileVerifier {
  if (nodeEnv === 'production') {
    return new CloudflareTurnstileVerifier(secretKey);
  }
  return new TestTurnstileVerifier(nodeEnv);
}
