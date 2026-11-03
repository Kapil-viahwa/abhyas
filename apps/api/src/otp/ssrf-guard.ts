import { lookup as dnsLookup } from 'node:dns/promises';

import { SmsDeliveryError } from './errors';

/**
 * The SSRF guard for the SMS gateway.
 *
 * A gateway URL is configuration, and configuration is attacker-controlled the day someone
 * pastes the wrong value. Two gates, both used by `HttpSmsProvider`:
 *
 * 1. At boot: the URL must be https in production, and its host may not name a private,
 *    loopback, link-local, CGNAT, multicast, unspecified or cloud-metadata address —
 *    including the numeric forms IPv4 accepts (`127.1`, `0x7f000001`, `2130706433`) and
 *    IPv4-mapped IPv6 (`::ffff:127.0.0.1`).
 * 2. At send time: DNS is resolved once, *every* answer is checked, and the address that
 *    passed is pinned into the connection, so a second lookup cannot swap in another host
 *    and a redirect cannot be followed somewhere else.
 *
 * The check is on addresses, never on hostname text alone: a name that resolves inside our
 * own network is exactly as dangerous as a literal that is written as one.
 */
export const GATEWAY_REFUSAL = 'The SMS gateway must not be a private, loopback or link-local address';

export class BlockedAddressError extends SmsDeliveryError {
  constructor(message: string = GATEWAY_REFUSAL) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

/** Loopback, private, link-local, CGNAT and other literal host names. */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^localhost\./i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^0\./,
];

export type Ipv4 = readonly [number, number, number, number];

export function parseIpv4(value: string): Ipv4 | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    octets.push(octet);
  }

  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

/**
 * Expands an IPv6 address into its eight 16-bit groups, so the range checks below read as
 * ranges rather than as string prefixes. Returns null for anything that is not IPv6.
 */
export function expandIpv6(value: string): readonly number[] | null {
  const trimmed = value.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? '';
  if (!trimmed.includes(':')) {
    return null;
  }

  // A trailing dotted quad (`::ffff:127.0.0.1`) is two more groups.
  let text = trimmed;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const embedded = parseIpv4(tail);
    if (embedded === null) {
      return null;
    }
    const [a, b, c, d] = embedded;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }

  const headText = halves[0] ?? '';
  const tailText = halves.length === 2 ? halves[1] ?? '' : '';

  const toGroups = (part: string): string[] | null => {
    if (part === '') {
      return [];
    }
    const groups = part.split(':');
    return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) ? groups : null;
  };

  const head = toGroups(headText);
  const rest = toGroups(tailText);
  if (head === null || rest === null) {
    return null;
  }

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) {
      return null;
    }
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...rest];
  } else {
    if (head.length !== 8) {
      return null;
    }
    groups = head;
  }

  return groups.map((group) => parseInt(group, 16));
}

function isBlockedIpv4([first, second, third]: Ipv4): boolean {
  // 0.0.0.0/8 is "this network" and includes the unspecified address.
  if (first === 0) {
    return true;
  }
  if (first === 10) {
    return true;
  }
  // 100.64.0.0/10: carrier-grade NAT, widespread on Indian mobile networks.
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 127) {
    return true;
  }
  // 169.254.0.0/16 is link-local and carries the cloud metadata services.
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 0 && third === 0) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast.
  return first >= 224;
}

function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  const emptyPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  const embedded: Ipv4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];

  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible) are judged as the IPv4
  // address they carry.
  if (emptyPrefix && (g5 === 0xffff || g5 === 0)) {
    const [a, b, c, d] = embedded;
    if (a === 0 && b === 0 && c === 0 && d === 0) {
      return true; // :: the unspecified address
    }
    if (a === 0 && b === 0 && c === 0 && d === 1) {
      return true; // ::1 loopback
    }
    return isBlockedIpv4(embedded);
  }

  // fc00::/7 unique local (the IPv6 private range).
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }
  // fe80::/10 link-local.
  if ((g0 & 0xffc0) === 0xfe80) {
    return true;
  }
  // ff00::/8 multicast.
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

/** True for any address the platform may not dial out to. Unparseable means blocked. */
export function isBlockedAddress(address: string): boolean {
  const value = address.trim();
  const v4 = parseIpv4(value);
  if (v4 !== null) {
    return isBlockedIpv4(v4);
  }

  const v6 = expandIpv6(value);
  if (v6 !== null) {
    return isBlockedIpv6(v6);
  }

  // Fail closed: an address we cannot classify is one we do not connect to.
  return true;
}

/**
 * Numeric host forms. `URL` already normalises most of them (`http://127.1/` becomes
 * `127.0.0.1`), but the check stays explicit so the rule does not rest on that behaviour.
 */
export function isNumericHost(hostname: string): boolean {
  const value = hostname.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (value === '') {
    return false;
  }
  if (value.includes(':')) {
    return true;
  }
  if (parseIpv4(value) !== null) {
    return true;
  }
  return /^[0-9.]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
}

export function assertGatewayUrl(url: string, nodeEnv: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SmsDeliveryError('The SMS gateway URL is not a valid URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SmsDeliveryError('The SMS gateway must be an http or https URL');
  }

  if (nodeEnv !== 'production') {
    return parsed;
  }

  if (parsed.protocol !== 'https:') {
    throw new SmsDeliveryError('The SMS gateway must use https in production');
  }

  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');

  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    throw new BlockedAddressError();
  }

  // A literal address is judged exactly as a resolved one would be. A *name* is judged at
  // send time, when it is resolved; refusing names at boot would refuse every gateway.
  if (isNumericHost(hostname) && isBlockedAddress(hostname)) {
    throw new BlockedAddressError();
  }

  return parsed;
}

export interface DnsRecord {
  readonly address: string;
  readonly family: number;
}

export type DnsLookup = (hostname: string) => Promise<readonly DnsRecord[]>;

const defaultLookup: DnsLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export interface ResolveOptions {
  readonly nodeEnv: string;
  readonly lookup?: DnsLookup;
}

/**
 * Resolves the gateway once and returns the first answer, refusing if *any* answer is an
 * address the platform may not reach. The caller connects to the returned address through a
 * pinned `lookup`, so the name is never resolved a second time.
 *
 * The check is skipped outside production, where the tests point the provider at a mock
 * gateway on loopback. `validateEnv` and the boot refusal keep that development-only.
 */
export async function resolvePublicAddress(
  hostname: string,
  options: ResolveOptions,
): Promise<DnsRecord> {
  const lookup = options.lookup ?? defaultLookup;

  let records: readonly DnsRecord[];
  try {
    records = await lookup(hostname);
  } catch {
    throw new SmsDeliveryError('The SMS gateway host could not be resolved');
  }

  const [first] = records;
  if (first === undefined) {
    throw new SmsDeliveryError('The SMS gateway host resolved to nothing');
  }

  if (options.nodeEnv === 'production') {
    for (const record of records) {
      if (isBlockedAddress(record.address)) {
        throw new BlockedAddressError();
      }
    }
  }

  return first;
}
