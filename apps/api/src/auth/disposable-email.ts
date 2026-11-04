/**
 * Throwaway inboxes.
 *
 * A disposable address costs nothing to create, so it is the cheapest way to take the
 * signup coin grant and the first-login reward over and over. The list is maintained in
 * the repository rather than fetched at runtime: a network list is one more moving part,
 * and a blocked domain is a decision somebody should be able to review in a diff.
 *
 * It is deliberately a blocklist, not an allowlist: a student with a private domain must
 * always be able to register, and the list only has to catch the throwaway services that
 * are actually abused.
 */

export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  '33mail.com',
  'anonbox.net',
  'burnermail.io',
  'discard.email',
  'discardmail.com',
  'dispostable.com',
  'dropmail.me',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'inboxkitten.com',
  'mail.tm',
  'mail7.io',
  'mailcatch.com',
  'maildrop.cc',
  'mailinator.com',
  'mailinator.net',
  'mailnesia.com',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'sharklasers.com',
  'spam4.me',
  'spamgourmet.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempail.com',
  'tempmail.com',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
];

/**
 * True when the address belongs to a throwaway provider, including a subdomain of one:
 * `anything.mailinator.com` is the same inbox farm as `mailinator.com`.
 *
 * Only the domain is examined. An address whose local part happens to read like a blocked
 * domain (`mailinator.com@example.com`) belongs to `example.com` and is not refused.
 */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 1) {
    return false;
  }

  const domain = email.slice(at + 1).trim().toLowerCase();
  if (domain === '') {
    return false;
  }

  return DISPOSABLE_EMAIL_DOMAINS.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}
