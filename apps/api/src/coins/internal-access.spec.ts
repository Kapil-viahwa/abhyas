import { describe, expect, it } from 'vitest';

import { parseAllowedAddress } from '@abhyas/shared';

import { addressAllowed, internalFailureKey, secretMatches } from './internal-access';

const networks = ['172.31.0.20/32', '10.1.2.0/24', '::1/128'].map((entry) => parseAllowedAddress(entry)!);

describe('the internal door', () => {
  it('accepts exactly the addresses production names', () => {
    expect(addressAllowed(networks, '172.31.0.20')).toBe(true);
    expect(addressAllowed(networks, '10.1.2.7')).toBe(true);
    expect(addressAllowed(networks, '::1')).toBe(true);

    expect(addressAllowed(networks, '172.31.0.21')).toBe(false);
    expect(addressAllowed(networks, '10.1.3.7')).toBe(false);
    expect(addressAllowed(networks, undefined)).toBe(false);
    expect(addressAllowed(networks, 'not-an-address')).toBe(false);
  });

  it('judges an IPv4-mapped address as the IPv4 address it carries', () => {
    expect(addressAllowed(networks, '::ffff:172.31.0.20')).toBe(true);
    expect(addressAllowed(networks, '::ffff:172.31.0.21')).toBe(false);
  });

  it('compares the secret in constant time and refuses an empty or missing one', () => {
    expect(secretMatches('shipped-secret', 'shipped-secret')).toBe(true);
    expect(secretMatches(['shipped-secret'], 'shipped-secret')).toBe(true);
    expect(secretMatches('shipped-secret', 'revalidate-secret')).toBe(false);
    expect(secretMatches(undefined, 'shipped-secret')).toBe(false);
    expect(secretMatches('anything', '')).toBe(false);
  });

  it('counts failures per source address', () => {
    expect(internalFailureKey('172.31.0.20')).toBe('coins:internal_failures:172.31.0.20');
    expect(internalFailureKey(undefined)).toBe('coins:internal_failures:unknown');
  });
});
