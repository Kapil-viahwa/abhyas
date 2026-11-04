import { describe, expect, it } from 'vitest';

import { DISPOSABLE_EMAIL_DOMAINS, isDisposableEmail } from './disposable-email';

/**
 * The signup protection that works without OTP: a throwaway inbox must not earn the signup
 * grant, and a student's own domain must never be caught by accident.
 */
describe('the disposable email blocklist', () => {
  it('refuses a listed domain and any subdomain of it', () => {
    expect(isDisposableEmail('student@mailinator.com')).toBe(true);
    expect(isDisposableEmail('anything.at.all@inbox.mailinator.com')).toBe(true);
    expect(isDisposableEmail('Student@YOPMAIL.COM')).toBe(true);
  });

  it('allows an ordinary address', () => {
    expect(isDisposableEmail('student@example.com')).toBe(false);
    expect(isDisposableEmail('student@gmail.com')).toBe(false);
    expect(isDisposableEmail('student@notmailinator.com')).toBe(false);
  });

  it('judges the domain only, never the local part', () => {
    expect(isDisposableEmail('mailinator.com@example.com')).toBe(false);
    expect(isDisposableEmail('temp-mail.org@student.example.ac.in')).toBe(false);
  });

  it('fails closed on anything that is not an address', () => {
    expect(isDisposableEmail('')).toBe(false);
    expect(isDisposableEmail('not-an-address')).toBe(false);
    expect(isDisposableEmail('@mailinator.com')).toBe(false);
  });

  it('keeps the list usable: lower-case, unique, and bare domains', () => {
    expect(new Set(DISPOSABLE_EMAIL_DOMAINS).size).toBe(DISPOSABLE_EMAIL_DOMAINS.length);
    for (const domain of DISPOSABLE_EMAIL_DOMAINS) {
      expect(domain).toBe(domain.trim().toLowerCase());
      expect(domain).not.toContain('@');
      expect(domain).toContain('.');
    }
  });
});
