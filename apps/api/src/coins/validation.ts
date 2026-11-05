import { BadRequestException } from '@nestjs/common';

/**
 * Strict input for the coin tools.
 *
 * Every value here arrives from a browser an Administrator may not control, so nothing is
 * coerced: a JSON number is a number, an id is a UUID, a remark is text of a stated length
 * with control characters removed, and a list is a list of strings below a hard ceiling.
 * `Number("1e3")`, `Number(true)` and `Number([5])` are all numbers, which is exactly why
 * `Number(...)` is not used on anything a caller sends.
 */
export const COIN_HISTORY_TYPES = ['SIGNUP_GRANT', 'DAILY_REWARD', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'ENROLLMENT'] as const;

/** The absolute most one bulk request may name, whatever the setting says. */
export const COIN_HARD_BULK_CEILING = 5000;

export const COIN_REMARK_MIN_LENGTH = 3;
export const COIN_REMARK_MAX_LENGTH = 200;
export const COIN_MAX_AMOUNT = 1_000_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CoinReauthenticationProof {
  readonly password?: string;
  readonly code?: string;
}

export function parseUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new BadRequestException(`${label} must be a UUID`);
  }

  return value.trim().toLowerCase();
}

export function parseCoinAmount(value: unknown): number {
  if (typeof value !== 'number') {
    throw new BadRequestException('amount must be a JSON integer, not a string, boolean or array');
  }

  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new BadRequestException('amount must be a whole number');
  }

  if (value === 0) {
    throw new BadRequestException('amount must not be zero');
  }

  if (Math.abs(value) > COIN_MAX_AMOUNT) {
    throw new BadRequestException(`amount must be at most ${String(COIN_MAX_AMOUNT)} coins`);
  }

  return value;
}

export function parsePositiveCoins(value: unknown): number {
  const amount = parseCoinAmount(value);

  if (amount < 0) {
    throw new BadRequestException('amount must credit a positive number of coins');
  }

  return amount;
}

/** Text a person reads later: control characters removed, whitespace collapsed, length pinned. */
export function parseRemark(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('remark must be text');
  }

  // Control characters are removed by code point rather than by a regex: a regex that names
  // them is what `no-control-regex` forbids, and rightly so in every other file.
  const remark = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (remark.length < COIN_REMARK_MIN_LENGTH || remark.length > COIN_REMARK_MAX_LENGTH) {
    throw new BadRequestException(
      `remark must be between ${String(COIN_REMARK_MIN_LENGTH)} and ${String(COIN_REMARK_MAX_LENGTH)} characters`,
    );
  }

  return remark;
}

export function parseStringArray(
  value: unknown,
  options: { readonly label: string; readonly max: number; readonly maxLength: number },
): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${options.label} must be an array`);
  }

  if (value.length === 0) {
    throw new BadRequestException(`${options.label} needs at least one entry`);
  }

  if (value.length > options.max) {
    throw new BadRequestException(`${options.label} may name at most ${String(options.max)} entries`);
  }

  const entries = value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new BadRequestException(`${options.label} must contain text only`);
    }

    const trimmed = entry.trim();

    if (trimmed === '' || trimmed.length > options.maxLength) {
      throw new BadRequestException(`${options.label} contains an entry of an unusable length`);
    }

    return trimmed;
  });

  return [...new Set(entries)];
}

export function parseIdentifierArray(value: unknown, max: number): string[] {
  return parseStringArray(value, { label: 'identifiers', max, maxLength: 254 });
}

export function parseUserIdArray(value: unknown, max: number): string[] {
  const ids = parseStringArray(value, { label: 'userIds', max, maxLength: 36 }).map((id) => id.toLowerCase());

  return [...new Set(ids)].map((id) => parseUuid(id, 'userId'));
}

export function parseHistoryType(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || !(COIN_HISTORY_TYPES as readonly string[]).includes(value)) {
    throw new BadRequestException(`type must be one of ${COIN_HISTORY_TYPES.join(', ')}`);
  }

  return value;
}

export function parsePageNumber(value: unknown): number {
  const page = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);

  if (!Number.isInteger(page) || page < 1) {
    throw new BadRequestException('page must be a positive whole number');
  }

  return page;
}

export function parsePageSize(value: unknown): number {
  const size = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);

  if (!Number.isInteger(size) || size < 1 || size > 100) {
    throw new BadRequestException('pageSize must be between 1 and 100');
  }

  return size;
}

export function parseReauthenticationProof(value: unknown): CoinReauthenticationProof | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('reauth must be an object with a password or a code');
  }

  const input = value as { password?: unknown; code?: unknown };

  if (input.password !== undefined && typeof input.password !== 'string') {
    throw new BadRequestException('reauth.password must be text');
  }

  if (input.code !== undefined && typeof input.code !== 'string') {
    throw new BadRequestException('reauth.code must be text');
  }

  const password = typeof input.password === 'string' && input.password !== '' ? input.password : undefined;
  const code = typeof input.code === 'string' && input.code !== '' ? input.code : undefined;

  if (password === undefined && code === undefined) {
    return undefined;
  }

  return { ...(password !== undefined ? { password } : {}), ...(code !== undefined ? { code } : {}) };
}

export function parseIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;

  if (typeof key !== 'string' || !UUID_PATTERN.test(key.trim())) {
    throw new BadRequestException('Idempotency-Key must be a UUID header naming this submission');
  }

  return key.trim().toLowerCase();
}
