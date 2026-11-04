import { describe, expect, it } from 'vitest';

import { resolveClientAddress, trustProxyOption } from './trust-proxy';

/**
 * The one conversion between the validated `TRUST_PROXY` and Fastify's adapter option.
 *
 * The policies themselves are proven in `packages/shared/src/env.spec.ts` and, against the
 * real bootstrap, in `test/client-ip.test.ts`. What matters here is that nothing is lost on
 * the way through: unset stays "believe nothing", a hop count survives, and an address list
 * is copied rather than shared with the frozen config.
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

/**
 * The address every per-IP limit, audit row and session record counts by (decisions 0052/0055).
 *
 * The bootstrap resolves it once per request with the policy the process booted with, and
 * hands the resolver exactly one header's value. The rules are tested here directly: what is
 * believed, what is dropped, and the direction every one of them fails in. The proof that the
 * header the boot does *not* name is never read lives in `test/client-ip.test.ts`, where two
 * boots differ only in which header they name.
 */
describe('resolving the client address', () => {
  it('ignores the header unless a proxy is named', () => {
    expect(
      resolveClientAddress(false, {
        socketAddress: '127.0.0.1',
        headerValue: '198.51.100.7',
      }),
    ).toBe('127.0.0.1');

    // Twenty-one addresses in the header still make one visitor behind one socket.
    expect(
      resolveClientAddress(false, {
        socketAddress: '127.0.0.1',
        headerValue: '203.0.113.1, 198.51.100.7, 10.0.0.1',
      }),
    ).toBe('127.0.0.1');
  });

  it('reads the entry at the named hop from the right, so a prepended fake is ignored', () => {
    expect(
      resolveClientAddress(1, {
        socketAddress: '127.0.0.1',
        headerValue: '1.1.1.1, 198.51.100.7',
      }),
    ).toBe('198.51.100.7');

    expect(
      resolveClientAddress(2, {
        socketAddress: '10.0.0.9',
        headerValue: '1.1.1.1, 198.51.100.7',
      }),
    ).toBe('1.1.1.1');
  });

  it('reads a single address as a chain of one, which is what x-real-ip carries', () => {
    expect(
      resolveClientAddress(1, {
        socketAddress: '127.0.0.1',
        headerValue: '203.0.113.9',
      }),
    ).toBe('203.0.113.9');
  });

  it('walks a named proxy list outwards from the socket', () => {
    const policy = ['10.0.0.0/8'];

    expect(
      resolveClientAddress(policy, {
        socketAddress: '10.1.2.3',
        headerValue: '198.51.100.7',
      }),
    ).toBe('198.51.100.7');

    // Two named hops; the client prepended a fake in front of the address the edge wrote.
    expect(
      resolveClientAddress(policy, {
        socketAddress: '10.1.2.3',
        headerValue: '1.1.1.1, 198.51.100.7, 10.2.3.4',
      }),
    ).toBe('198.51.100.7');

    // A socket that is not a named proxy believes nothing: it is the client itself.
    expect(
      resolveClientAddress(policy, {
        socketAddress: '203.0.113.9',
        headerValue: '198.51.100.7',
      }),
    ).toBe('203.0.113.9');
  });

  it('believes the furthest stated address only when everything is trusted', () => {
    expect(
      resolveClientAddress(true, {
        socketAddress: '127.0.0.1',
        headerValue: '198.51.100.7, 10.0.0.4',
      }),
    ).toBe('198.51.100.7');
  });

  it('drops every value that is not exactly one address', () => {
    const hostile = [
      'not-an-address',
      '999.999.999.999',
      '=HYPERLINK("http://example.com")',
      '<script>alert(1)</script>',
      '203.0.113.9\n198.51.100.7',
      '1'.repeat(4000),
    ];

    for (const value of hostile) {
      // The socket is the client when nothing usable was stated, never the header.
      expect(resolveClientAddress(1, { socketAddress: '127.0.0.1', headerValue: value })).toBe('127.0.0.1');
    }
  });

  it('has no address at all when neither the socket nor the header names one', () => {
    expect(resolveClientAddress(false, { headerValue: '198.51.100.7' })).toBeUndefined();
    expect(resolveClientAddress(1, { headerValue: 'not-an-address' })).toBeUndefined();
    expect(resolveClientAddress(1, { socketAddress: ':not-an-address:' })).toBeUndefined();
  });
});

