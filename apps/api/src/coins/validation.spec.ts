import { describe, expect, it } from 'vitest';

import {
  COIN_HARD_BULK_CEILING,
  COIN_HISTORY_TYPES,
  parseCoinAmount,
  parseHistoryType,
  parseIdempotencyKey,
  parseIdentifierArray,
  parsePageNumber,
  parsePageSize,
  parsePositiveCoins,
  parseReauthenticationProof,
  parseRemark,
  parseUserIdArray,
  parseUuid,
} from './validation';

const UUID = '3f21d0b2-9c4f-4a1b-9d6e-2f8a0c7b5e41';

describe('strict coin input', () => {
  it('accepts only a JSON integer for an amount, never a coerced string, boolean or array', () => {
    for (const hostile of ['1e3', '1000', '0x10', true, false, [5], {}, null, undefined, Number.NaN, 1.5, 0]) {
      expect(() => parseCoinAmount(hostile), String(hostile)).toThrow();
    }

    expect(parseCoinAmount(250)).toBe(250);
    expect(parseCoinAmount(-250)).toBe(-250);
    expect(() => parseCoinAmount(1_000_001)).toThrow(/at most 1000000/);
    expect(() => parsePositiveCoins(-1)).toThrow(/positive/);
    expect(parsePositiveCoins(100)).toBe(100);
  });

  it('accepts only a UUID where an id is expected', () => {
    for (const hostile of ['not-a-uuid', '', 5, null, [UUID]]) {
      expect(() => parseUuid(hostile, 'userId'), String(hostile)).toThrow(/userId must be a UUID/);
    }

    expect(parseUuid(UUID, 'userId')).toBe(UUID);
  });

  it('sanitises a remark and holds it to 3 to 200 characters', () => {
    expect(parseRemark('  Exam\u0000 week   goodwill  ')).toBe('Exam week goodwill');
    expect(() => parseRemark('ab')).toThrow(/between 3 and 200/);
    expect(() => parseRemark('x'.repeat(201))).toThrow(/between 3 and 200/);
    expect(() => parseRemark(['not', 'text'])).toThrow(/must be text/);
  });

  it('caps a list at its stated maximum and refuses non-text entries', () => {
    expect(() => parseIdentifierArray('a@example.com', 10)).toThrow(/must be an array/);
    expect(() => parseIdentifierArray([true], 10)).toThrow(/text only/);
    expect(() => parseIdentifierArray([], 10)).toThrow(/at least one/);
    expect(() => parseIdentifierArray(Array.from({ length: 11 }, (_, index) => `a${String(index)}@example.com`), 10)).toThrow(
      /at most 10/,
    );

    expect(parseIdentifierArray(['a@example.com', ' a@example.com '], 10)).toEqual(['a@example.com']);
  });

  it('accepts only UUIDs in a userId list, below the hard ceiling', () => {
    expect(parseUserIdArray([UUID, UUID.toUpperCase()], 10)).toEqual([UUID]);
    expect(() => parseUserIdArray(['nope'], 10)).toThrow(/userId must be a UUID/);
    expect(() => parseUserIdArray(Array.from({ length: COIN_HARD_BULK_CEILING + 1 }, () => UUID), COIN_HARD_BULK_CEILING)).toThrow(
      /at most 5000/,
    );
  });

  it('accepts only a known ledger type, and only whole page numbers', () => {
    expect(parseHistoryType(undefined)).toBeUndefined();
    expect(parseHistoryType('ADMIN_CREDIT')).toBe('ADMIN_CREDIT');
    expect(() => parseHistoryType('BOGUS')).toThrow(new RegExp(COIN_HISTORY_TYPES.join(', ')));
    expect(() => parseHistoryType(5)).toThrow();

    expect(parsePageNumber('2')).toBe(2);
    expect(() => parsePageNumber('0')).toThrow(/positive/);
    expect(parsePageSize('20')).toBe(20);
    expect(() => parsePageSize('500')).toThrow(/between 1 and 100/);
  });

  it('reads a proof only as text, and only when one is offered', () => {
    expect(parseReauthenticationProof(undefined)).toBeUndefined();
    expect(parseReauthenticationProof({})).toBeUndefined();
    expect(parseReauthenticationProof({ password: 'correct-horse' })).toEqual({ password: 'correct-horse' });
    expect(parseReauthenticationProof({ code: '123456' })).toEqual({ code: '123456' });
    expect(() => parseReauthenticationProof({ password: 5 })).toThrow(/must be text/);
    expect(() => parseReauthenticationProof({ password: 'x', code: 5 })).toThrow(/must be text/);
    expect(() => parseReauthenticationProof('password')).toThrow(/must be an object/);
  });

  it('requires the Idempotency-Key header to be a UUID', () => {
    expect(parseIdempotencyKey(UUID.toUpperCase())).toBe(UUID);
    expect(parseIdempotencyKey([UUID])).toBe(UUID);

    for (const hostile of [undefined, '', 'abc', ['abc', UUID]]) {
      expect(() => parseIdempotencyKey(hostile as string | string[] | undefined)).toThrow(/Idempotency-Key/);
    }
  });
});
