import { afterEach, describe, expect, it } from 'vitest';

import { mobileDisabledResponse } from './mobile-auth';

/**
 * The web half of the master switch. The API answers 404 on every OTP route while
 * `OTP_ENABLED=false`; every web route that posts to one has to answer 404 as well, or a
 * page that was never shown could still be reached by hand.
 */
describe('the web mobile switch', () => {
  afterEach(() => {
    delete process.env.OTP_ENABLED;
  });

  it('answers 404 while the switch is off, including when it is blank', () => {
    expect(mobileDisabledResponse()?.status).toBe(404);

    process.env.OTP_ENABLED = 'false';
    expect(mobileDisabledResponse()?.status).toBe(404);
  });

  it('gets out of the way when the switch is on', () => {
    process.env.OTP_ENABLED = 'true';
    expect(mobileDisabledResponse()).toBeNull();
  });
});
