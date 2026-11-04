import { describe, expect, it } from 'vitest';

import { trustProxyOption } from './trust-proxy';

/**
 * The one conversion between the validated `TRUST_PROXY` and Fastify's adapter option.
 *
 * The policies themselves are proven in `packages/shared/src/env.spec.ts` and, against the
 * real adapter, in `test/client-ip.test.ts`. What matters here is that nothing is lost on the
 * way through: unset stays "believe nothing", a hop count survives, and an address list is
 * copied rather than shared with the frozen config.
 */
describe('the trustProxy adapter option', () => {
  it('keeps every policy the configuration names', () => {
    expect(trustProxyOption(false)).toBe(false);
    expect(trustProxyOption(true)).toBe(true);
    expect(trustProxyOption(2)).toBe(2);
    expect(trustProxyOption(['172.31.0.10/32'])).toEqual(['172.31.0.10/32']);
  });

  it('copies an address list out of the read-only configuration', () => {
    const configured: readonly string[] = ['172.31.0.10/32', '10.1.2.3'];

    const option = trustProxyOption(configured);

    expect(option).toEqual(['172.31.0.10/32', '10.1.2.3']);
    expect(option).not.toBe(configured);
  });
});
