/** Queue names and job names are shared vocabulary between the API and the worker. */
export const MAINTENANCE_QUEUE = 'maintenance';

export const PING_JOB = 'system.ping';

/** Phase 2c: deletes spent and expired OTP rows on a fixed interval. */
export const OTP_PURGE_JOB = 'otp.purge';

export const COIN_BULK_DRAIN_JOB = 'coin-bulk-drain';

/** Phase 5, item 4a: compares every wallet with its ledger, once a night. */
export const COIN_RECONCILIATION_JOB = 'coin-reconciliation';
