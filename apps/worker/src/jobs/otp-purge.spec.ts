import { describe, expect, it } from 'vitest';

import { OTP_RETENTION_MINUTES, purgeOtpRequests, type OtpPurgeClient } from './otp-purge';

function fakeClient(): { client: OtpPurgeClient; calls: Array<Parameters<OtpPurgeClient['otpRequest']['deleteMany']>[0]> } {
  const calls: Array<Parameters<OtpPurgeClient['otpRequest']['deleteMany']>[0]> = [];
  return {
    calls,
    client: {
      otpRequest: {
        deleteMany: async (args) => {
          calls.push(args);
          return { count: 3 };
        },
      },
    },
  };
}

describe('otp purge', () => {
  it('deletes used and expired requests older than the retention window', async () => {
    const { client, calls } = fakeClient();
    const now = new Date('2026-03-01T12:00:00.000Z');

    const deleted = await purgeOtpRequests(client, now);

    expect(deleted).toBe(3);
    const cutoff = new Date(now.getTime() - OTP_RETENTION_MINUTES * 60_000).toISOString();

    // Both halves are older than the cutoff: a request used a minute ago is still history
    // worth keeping for a support ticket, one used an hour ago is not.
    expect(calls[0]?.where.OR[0]).toEqual({ consumedAt: { not: null, lt: new Date(cutoff) } });
    expect(calls[0]?.where.OR[1]).toEqual({ expiresAt: { lt: new Date(cutoff) } });
  });

  it('takes the retention window as a parameter, so the scheduler decides it', async () => {
    const { client, calls } = fakeClient();
    const now = new Date('2026-03-01T12:00:00.000Z');

    await purgeOtpRequests(client, now, 5);

    const cutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(calls[0]?.where.OR[1]).toEqual({ expiresAt: { lt: new Date(cutoff) } });
  });
});
