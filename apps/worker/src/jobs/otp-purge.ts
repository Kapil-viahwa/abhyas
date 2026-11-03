/**
 * The OTP retention job.
 *
 * An `otp_requests` row is a hashed code with a five-minute life; once it is used or expired
 * it exists only as history, and history that names a destination hash is still worth
 * deleting quickly. The purge keeps one short window for debugging a support ticket and
 * removes everything older, so the table cannot grow without bound.
 *
 * The query is built here as a plain function so it can be tested against a fake client
 * without a database, and the scheduler in `main.ts` only decides when to call it.
 */

export const OTP_RETENTION_MINUTES = 60;

export interface OtpPurgeClient {
  otpRequest: {
    deleteMany(args: {
      where: { OR: Array<{ consumedAt: { not: null; lt: Date } } | { expiresAt: { lt: Date } }> };
    }): Promise<{ count: number }>;
  };
}

/** Deletes used and expired requests older than the retention window. */
export async function purgeOtpRequests(
  client: OtpPurgeClient,
  now: Date = new Date(),
  retentionMinutes: number = OTP_RETENTION_MINUTES,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionMinutes * 60_000);

  const result = await client.otpRequest.deleteMany({
    where: {
      OR: [{ consumedAt: { not: null, lt: cutoff } }, { expiresAt: { lt: cutoff } }],
    },
  });

  return result.count;
}
