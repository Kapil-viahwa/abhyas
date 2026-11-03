import { describe, expect, it } from 'vitest';

import { SmsDeliveryError } from './errors';
import {
  BlockedAddressError,
  assertGatewayUrl,
  expandIpv6,
  isBlockedAddress,
  isNumericHost,
  parseIpv4,
  resolvePublicAddress,
  type DnsRecord,
} from './ssrf-guard';

function lookupReturning(...records: readonly (DnsRecord | string)[]): (hostname: string) => Promise<readonly DnsRecord[]> {
  return async () => records.map((record) => (typeof record === 'string' ? { address: record, family: 4 } : record));
}

describe('the SSRF guard around the SMS gateway', () => {
  it('refuses every private, loopback, link-local, CGNAT and metadata address', () => {
    for (const address of [
      '127.0.0.1',
      '127.10.20.30',
      '10.0.0.5',
      '192.168.1.10',
      '172.16.0.9',
      '172.31.255.255',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.254',
      '0.0.0.0',
      '192.0.0.8',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '::127.0.0.1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows public addresses, including the ranges just outside the blocked ones', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '203.0.113.10',
      '100.63.255.255',
      '100.128.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '2001:4860:4860::8888',
      '2606:4700::1111',
    ]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('fails closed on an address it cannot classify', () => {
    expect(isBlockedAddress('not-an-address')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  it('parses the shapes it claims to parse, and nothing else', () => {
    expect(parseIpv4('127.0.0.1')).toEqual([127, 0, 0, 1]);
    expect(parseIpv4('127.1')).toBeNull();
    expect(parseIpv4('256.0.0.1')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();

    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('1:2:3')).toBeNull();
    expect(expandIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
  });

  it('knows the numeric host forms IPv4 accepts', () => {
    for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '::1', '::ffff:127.0.0.1']) {
      expect(isNumericHost(host), host).toBe(true);
    }
    for (const host of ['sms.example.com', 'localhost', '']) {
      expect(isNumericHost(host), host).toBe(false);
    }
  });

  it('refuses every numeric form of a private address in a production gateway URL', () => {
    for (const url of [
      'https://127.1/send',
      'https://2130706433/send',
      'https://0x7f000001/send',
      'https://0177.0.0.1/send',
      'https://[::ffff:127.0.0.1]/send',
      'https://[::ffff:10.0.0.1]/send',
      'https://169.254.169.254/latest/meta-data',
      'https://[fd00::1]/send',
    ]) {
      expect(() => assertGatewayUrl(url, 'production'), url).toThrow(SmsDeliveryError);
    }
  });

  it('refuses a scheme that is not http or https, in every environment', () => {
    expect(() => assertGatewayUrl('file:///etc/passwd', 'test')).toThrow(/http or https/);
    expect(() => assertGatewayUrl('gopher://sms.example.com/', 'production')).toThrow(/http or https/);
  });

  it('keeps the https rule in production and lets the mock gateway use http in tests', () => {
    expect(() => assertGatewayUrl('http://sms.example.com/send', 'production')).toThrow(/must use https in production/);
    expect(() => assertGatewayUrl('http://127.0.0.1:8090/send', 'test')).not.toThrow();
    expect(() => assertGatewayUrl('https://sms.example.com/send', 'production')).not.toThrow();
  });

  it('refuses a name when any of its answers is private, before it connects', async () => {
    const lookup = lookupReturning('203.0.113.10', '10.0.0.5');

    await expect(resolvePublicAddress('sms.example.com', { nodeEnv: 'production', lookup })).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it('returns the first public answer and is the only lookup the send makes', async () => {
    let calls = 0;
    const lookup = async (): Promise<readonly DnsRecord[]> => {
      calls += 1;
      return [
        { address: '203.0.113.10', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ];
    };

    const answer = await resolvePublicAddress('sms.example.com', { nodeEnv: 'production', lookup });

    expect(answer.address).toBe('203.0.113.10');
    expect(calls).toBe(1);
  });

  it('allows a loopback answer only outside production, where the mock gateway lives', async () => {
    const lookup = lookupReturning('127.0.0.1');

    const answer = await resolvePublicAddress('127.0.0.1', { nodeEnv: 'test', lookup });
    expect(answer.address).toBe('127.0.0.1');

    await expect(resolvePublicAddress('127.0.0.1', { nodeEnv: 'production', lookup })).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it('turns a resolution failure into a delivery error that names no host', async () => {
    const lookup = async (): Promise<readonly DnsRecord[]> => {
      throw new Error('ENOTFOUND sms.example.com');
    };

    await expect(resolvePublicAddress('sms.example.com', { nodeEnv: 'production', lookup })).rejects.toThrow(
      /could not be resolved/,
    );
    await expect(
      resolvePublicAddress('sms.example.com', {
        nodeEnv: 'production',
        lookup: async () => [] as readonly DnsRecord[],
      }),
    ).rejects.toThrow(/resolved to nothing/);
  });
});
