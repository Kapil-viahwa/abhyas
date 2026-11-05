/**
 * The identity a signup grant is paid against.
 *
 * Gmail ignores dots in the local part and everything from a `+` onwards, so
 * `a+1@gmail.com`, `a+1@googlemail.com` and `a.b@gmail.com` are one inbox. Treating them
 * as one identity is what stops one person earning the signup grant several times with the
 * same mailbox; it is used for grant eligibility only and never changes the address an
 * account signs in with.
 */

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function normaliseEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) {
    return null;
  }

  const text = email.trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) {
    return null;
  }

  const local = text.slice(0, at);
  const domain = text.slice(at + 1);

  if (!GMAIL_DOMAINS.has(domain)) {
    return `${local}@${domain}`;
  }

  const localPart = (local.split('+')[0] ?? '').replace(/\./g, '');

  return `${localPart}@gmail.com`;
}
