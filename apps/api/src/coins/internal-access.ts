import { createHash, timingSafeEqual } from 'node:crypto';

import type { AllowedAddress } from '@abhyas/shared';

/**
 * Who may knock on the API's internal routes, and how often a wrong secret may be guessed.
 *
 * The bulk coin drain can move money, so the door has three locks rather than one: its own
 * secret (`INTERNAL_API_SECRET`, never the cache-revalidation one), a list of source
 * addresses that production writes explicitly, and a failure counter keyed by the address a
 * refused caller came from. A refusal is a 404 rather than a 401, so the route does not
 * confirm that it exists.
 */
export const INTERNAL_FAILURE_LIMIT = 5;
export const INTERNAL_FAILURE_WINDOW_SECONDS = 15 * 60;

export function internalFailureKey(address: string | undefined): string {
  return `coins:internal_failures:${address ?? 'unknown'}`;
}

/** Constant-time comparison of two secret strings, after hashing to equal length. */
export function secretMatches(presented: string | string[] | undefined, expected: string): boolean {
  if (expected === '' || presented === undefined) {
    return false;
  }

  const given = Array.isArray(presented) ? presented[0] : presented;

  if (given === undefined) {
    return false;
  }

  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();

  return timingSafeEqual(left, right);
}

/** True when `address` is one of the networks. IPv4 is compared as 32 bits, IPv6 as 128. */
export function addressAllowed(networks: readonly AllowedAddress[], address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }

  const candidate = bytes(address);

  if (candidate === null) {
    return false;
  }

  return networks.some((network) => {
    const base = bytes(network.address);

    if (base === null || base.length !== candidate.length) {
      return false;
    }

    let remaining = network.prefix;

    for (let index = 0; index < base.length; index += 1) {
      const bits = Math.min(8, remaining);

      if (bits <= 0) {
        return true;
      }

      const mask = (0xff << (8 - bits)) & 0xff;

      if ((base[index]! & mask) !== (candidate[index]! & mask)) {
        return false;
      }

      remaining -= bits;
    }

    return true;
  });
}

function bytes(value: string): number[] | null {
  const trimmed = value.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);

  if (mapped !== null) {
    return v4Bytes(mapped[1]!);
  }

  if (trimmed.includes('.')) {
    return v4Bytes(trimmed);
  }

  return v6Bytes(trimmed);
}

function v4Bytes(value: string): number[] | null {
  const parts = value.split('.');

  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return null;
  }

  const numbers = parts.map((part) => Number(part));

  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function v6Bytes(value: string): number[] | null {
  if (!value.includes(':') || !/^[0-9a-fA-F:]+$/.test(value)) {
    return null;
  }

  const halves = value.split('::');

  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const filled = halves.length === 2 ? 8 - head.length - tail.length : 0;

  if (filled < 0 || (halves.length === 1 && head.length !== 8)) {
    return null;
  }

  const groups = [...head, ...Array<string>(filled).fill('0'), ...tail];

  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) {
    return null;
  }

  const output: number[] = [];

  for (const group of groups) {
    const parsed = Number.parseInt(group, 16);
    output.push((parsed >> 8) & 0xff, parsed & 0xff);
  }

  return output;
}
