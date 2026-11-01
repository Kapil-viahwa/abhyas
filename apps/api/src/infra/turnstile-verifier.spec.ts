import { describe, expect, it } from 'vitest';

import {
  CloudflareTurnstileVerifier,
  TURNSTILE_TEST_SECRET,
  TURNSTILE_TEST_TOKEN,
  TestTurnstileVerifier,
  TurnstileError,
  createTurnstileVerifier,
} from './turnstile-verifier';

describe('turnstile verifier', () => {
  it('accepts the development token and rejects every other value', async () => {
    const verifier = new TestTurnstileVerifier('development');

    await expect(verifier.verify(TURNSTILE_TEST_TOKEN)).resolves.toBe(true);
    await expect(verifier.verify('')).resolves.toBe(false);
    await expect(verifier.verify('   ')).resolves.toBe(false);
    await expect(verifier.verify('made-up-token')).resolves.toBe(false);
  });

  it('refuses to exist in production, directly and through the factory', () => {
    expect(() => new TestTurnstileVerifier('production')).toThrow(TurnstileError);
    expect(() => createTurnstileVerifier('production', TURNSTILE_TEST_SECRET)).toThrow(TurnstileError);
  });

  it('uses the Cloudflare verifier in production', () => {
    expect(createTurnstileVerifier('production', 'live-secret-value')).toBeInstanceOf(CloudflareTurnstileVerifier);
    expect(createTurnstileVerifier('development', TURNSTILE_TEST_SECRET)).toBeInstanceOf(TestTurnstileVerifier);
  });

  it('rejects a missing secret and an empty token before calling Cloudflare', async () => {
    expect(() => new CloudflareTurnstileVerifier('')).toThrow(TurnstileError);

    const verifier = new CloudflareTurnstileVerifier('live-secret-value');
    await expect(verifier.verify('   ')).resolves.toBe(false);
  });
});
