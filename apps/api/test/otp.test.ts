import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The OTP migration's constraints, proven against Postgres rather than trusted.
 *
 * These are the rules that keep a code table honest: a destination that is a real E.164
 * number, a purpose from the closed list, an expiry after creation, an attempt counter that
 * cannot run away, hashes in one shape, and one verified mobile per person.
 */

const HASH = 'a'.repeat(64);

describe('otp tables', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('otp');
  }, 120_000);

  afterAll(async () => {
    await db?.dispose();
  }, 60_000);

  async function insertOtp(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = {
      destination: '+919876543210',
      destinationHash: HASH,
      purpose: 'LOGIN',
      codeHmac: HASH,
      attempts: 0,
      ...overrides,
    };

    await db.client.$executeRawUnsafe(
      `INSERT INTO otp_requests ("destination", "destination_hash", "purpose", "code_hmac", "attempts", "expires_at")
       VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')`,
      row.destination,
      row.destinationHash,
      row.purpose,
      row.codeHmac,
      row.attempts,
    );
  }

  it('accepts a well-formed request', async () => {
    await expect(insertOtp()).resolves.toBeUndefined();
  });

  it('refuses a destination that is not E.164', async () => {
    await expect(insertOtp({ destination: '9876543210' })).rejects.toThrow(/otp_requests_destination_e164/);
    await expect(insertOtp({ destination: '+0123456789' })).rejects.toThrow(/otp_requests_destination_e164/);
  });

  it('refuses a purpose outside the closed list', async () => {
    await expect(insertOtp({ purpose: 'RESET' })).rejects.toThrow(/otp_requests_purpose_valid/);
  });

  it('refuses an attempt counter past its ceiling', async () => {
    await expect(insertOtp({ attempts: 11 })).rejects.toThrow(/otp_requests_attempts_range/);
  });

  it('refuses a request that is already expired when it is created', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        `INSERT INTO otp_requests ("destination", "destination_hash", "purpose", "code_hmac", "expires_at", "created_at")
         VALUES ('+919876543210', $1, 'LOGIN', $1, now() - interval '1 minute', now())`,
        HASH,
      ),
    ).rejects.toThrow(/otp_requests_expiry_after_creation/);
  });

  it('refuses a hash that is not a 64-character digest', async () => {
    await expect(insertOtp({ codeHmac: 'not-a-hash' })).rejects.toThrow(/otp_requests_code_hmac_shape/);
    await expect(insertOtp({ destinationHash: 'short' })).rejects.toThrow(/otp_requests_destination_hash_shape/);
  });

  it('refuses a negative cost in the SMS ledger', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        `INSERT INTO sms_cost_ledger ("provider", "destination_hash", "cost") VALUES ('fake', $1, -1)`,
        HASH,
      ),
    ).rejects.toThrow(/sms_cost_ledger_cost_range/);
  });

  it('accepts a zero cost, which is what the fake provider records', async () => {
    await expect(
      db.client.$executeRawUnsafe(
        `INSERT INTO sms_cost_ledger ("provider", "destination_hash", "cost") VALUES ('fake', $1, 0)`,
        HASH,
      ),
    ).resolves.toBeGreaterThan(0);
  });

  it('keeps one verified mobile per person, with a partial unique index', async () => {
    const indexes = await db.client.$queryRawUnsafe<
      Array<{ indexname: string; indexdef: string }>
    >(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_first_verified_mobile_key'`);

    expect(indexes).toHaveLength(1);
    // Unique, and partial exactly on the rows that hold a phone, so any number of accounts
    // may stay without one.
    expect(indexes[0]?.indexdef).toContain('UNIQUE');
    expect(indexes[0]?.indexdef).toContain('WHERE (first_verified_mobile IS NOT NULL)');
  });
});
