/** Queue names and job names are shared vocabulary between the API and the worker. */
export const MAINTENANCE_QUEUE = 'maintenance';

export const PING_JOB = 'system.ping';

/** Phase 2c: deletes spent and expired OTP rows on a fixed interval. */
export const OTP_PURGE_JOB = 'otp.purge';
