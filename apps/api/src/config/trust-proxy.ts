import { BlockList, isIP } from 'node:net';

import type { FastifyServerOptions } from 'fastify';

import type { AppEnv } from '@abhyas/shared';

/**
 * `TRUST_PROXY` as Fastify's adapter option.
 *
 * A hop count is a number at runtime — `proxy-addr`, the library behind the option, accepts
 * one and reads it as "trust this many hops" — but Fastify's own typings leave the number
 * out, so the cast is confined to this one conversion. An address list arrives readonly
 * because the validated configuration is immutable, and Fastify wants a mutable array, so
 * it is copied rather than handed on.
 */
export type FastifyTrustProxy = Exclude<FastifyServerOptions['trustProxy'], undefined | null>;

export function trustProxyOption(value: AppEnv['TRUST_PROXY']): FastifyTrustProxy {
  if (typeof value === 'number') {
    return value as unknown as FastifyTrustProxy;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return value.map((entry) => String(entry));
}

/**
 * The client address the API counts, stores and logs (decision 0052).
 *
 * Fastify resolves `request.ip` from the same policy, but every limit the platform enforces
 * keys on this value, so it is resolved here as well — once per request, from the boot's own
 * policy — rather than depending on framework internals that a version bump can change. The
 * resolver is pure, so all of it is unit tested in `trust-proxy.spec.ts` and again end to end
 * through the real bootstrap in `test/client-ip.test.ts`.
 *
 * The rules, in the one direction that is safe when they are wrong:
 * - `false`: no header is believed at all. The socket address is the client, however many
 *   addresses a header claims, and every visitor behind one socket shares one counter.
 * - `true`: the furthest stated address is the client. Development and CI only; a production
 *   boot refuses it.
 * - a hop count: the socket is hop zero, so the entry that many hops in is the client. For
 *   `X-Forwarded-For` that is read from the right, so a fake address prepended on the left is
 *   ignored; `X-Real-IP` carries a single address and behaves as a chain of one.
 * - an address list or CIDR blocks: the chain is walked from the socket outwards while each
 *   address is a named proxy; the first address that is not one is the client.
 *
 * Exactly one header is read, the one `TRUST_CLIENT_IP_HEADER` names (decision 0055); there
 * is no fallback to the other, because the header the edge does not write is the one a
 * browser can forge.
 *
 * Every candidate is validated with `net.isIP` before use. Garbage, a list, an oversized
 * value, a newline or a spreadsheet formula is dropped, so no such value can become a
 * rate-limit key, an audit row or a log line.
 */

/** The longest header value this reads: a "chain" longer than this is not an address chain. */
const MAX_ADDRESS_HEADER_LENGTH = 1_024;

/** One header as the server handed it over: a string, a repeated header, or nothing. */
export function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(',');
  }

  return undefined;
}

/** Exactly one IPv4 or IPv6 address, trimmed, or nothing at all. */
function singleAddress(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const candidate = value.trim();

  if (candidate.length === 0 || candidate.length > MAX_ADDRESS_HEADER_LENGTH) {
    return undefined;
  }

  return isIP(candidate) === 0 ? undefined : candidate;
}

/** The valid addresses of a `X-Forwarded-For` chain, in the order they were written. */
function statedChain(value: string | undefined): string[] {
  if (value === undefined || value.length > MAX_ADDRESS_HEADER_LENGTH) {
    return [];
  }

  const addresses: string[] = [];

  for (const part of value.split(',')) {
    const address = singleAddress(part);

    if (address !== undefined) {
      addresses.push(address);
    }
  }

  return addresses;
}

function familyOf(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 6 ? 'ipv6' : 'ipv4';
}

/** The configured proxies, as blocks the socket and each hop can be checked against. */
function proxyList(entries: readonly string[]): BlockList {
  const list = new BlockList();

  for (const entry of entries) {
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = familyOf(address);
    const maximum = family === 'ipv6' ? 128 : 32;
    const prefix = slash === -1 ? maximum : Number(entry.slice(slash + 1));

    list.addSubnet(address, prefix, family);
  }

  return list;
}

function isTrustedProxy(list: BlockList, address: string): boolean {
  return list.check(address, familyOf(address));
}

export interface ClientAddressInput {
  /** The address of the socket the request arrived on. */
  readonly socketAddress?: string | undefined;
  /**
   * The value of the one header the boot configured (`TRUST_CLIENT_IP_HEADER`), as written.
   *
   * There is deliberately no second field: reading both `X-Real-IP` and `X-Forwarded-For`
   * would let a caller supply whichever the edge does not overwrite (decision 0055). A value
   * with commas is a chain and is read from the right for a hop count; a single address is a
   * chain of one.
   */
  readonly headerValue?: string | undefined;
}

export function resolveClientAddress(
  policy: AppEnv['TRUST_PROXY'],
  input: ClientAddressInput,
): string | undefined {
  const socket = singleAddress(input.socketAddress);

  // The safe default, and the shipped one: the header is ignored entirely.
  if (policy === false) {
    return socket;
  }

  const peers = statedChain(input.headerValue);

  if (policy === true) {
    // Development and CI only (a production boot refuses it): the furthest address wins.
    return peers[0] ?? socket;
  }

  if (typeof policy === 'number') {
    if (peers.length === 0) {
      return socket;
    }

    // The socket is hop zero; the client is `policy` hops in, counted from the right.
    const chain = [...peers, ...(socket === undefined ? [] : [socket])];
    const index = chain.length - 1 - policy;

    return chain[index < 0 ? 0 : index];
  }

  const list = proxyList(policy);
  const chain = [...peers, ...(socket === undefined ? [] : [socket])];

  if (chain.length === 0) {
    return undefined;
  }

  let index = chain.length - 1;

  while (index > 0) {
    const candidate = chain[index];

    if (candidate === undefined || !isTrustedProxy(list, candidate)) {
      break;
    }

    index -= 1;
  }

  return chain[index];
}
